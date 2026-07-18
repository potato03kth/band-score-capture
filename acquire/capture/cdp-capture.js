const zlib = require('zlib');
const endpoints = require('./endpoints');

// band.us 응답은 gzip/br로 압축돼 오는데, Fetch.getResponseBody가 압축 해제 없이 원본
// 바이트를 그대로 돌려주는 경우가 실기동에서 확인됐다(모든 응답이 JSON.parse 실패로 이어짐).
// content-encoding 헤더를 보고 직접 압축을 풀어준다.
function decodeBody(buf, responseHeaders) {
  const enc = (responseHeaders || [])
    .find((h) => (h.name || '').toLowerCase() === 'content-encoding');
  const value = enc && enc.value && enc.value.toLowerCase();
  try {
    if (value === 'gzip') return zlib.gunzipSync(buf).toString('utf8');
    if (value === 'br') return zlib.brotliDecompressSync(buf).toString('utf8');
    if (value === 'deflate') return zlib.inflateSync(buf).toString('utf8');
  } catch (e) {
    // 이미 압축 해제된 상태였는데 인코딩 헤더만 남아있는 경우 등 — 원본 그대로 시도
  }
  return buf.toString('utf8');
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 타임아웃(${ms}ms)`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// CDP(webContents.debugger)로 네트워크 응답을 가로채 interceptor.handleCapture()로 넘긴다.
// preload 몽키패치와 인터페이스({url, method, status, bodyText})를 동일하게 맞춰
// interceptor.js/writer.js는 무변경으로 재사용한다(doc/m1-cdp-migration-plan.md §2).
//
// 실기동으로 확정된 최종 구성(2026-07-16, 우회 시행착오 기록 — 다음에 또 겪지 않도록 남긴다):
// 1. Network 도메인(responseReceived/loadingFinished 후 Network.getResponseBody)은 시점과
//    무관하게 100% "No resource with given identifier found"로 실패 → Fetch 도메인
//    (requestStage:'Response'로 응답을 실제로 일시정지시킨 뒤 그 자리에서 바디를 읽고
//    continueResponse로 흘려보냄)으로 전환.
// 2. Fetch 도메인만으로도 처음엔 매번 빈 바디(len=0)만 나왔다 — Network.enable을 버퍼 크기
//    인자 없이 호출하면 사실상 버퍼가 0이었던 것으로 보임 → Network.enable도 같이 켜고
//    maxTotalBufferSize/maxResourceBufferSize를 명시적으로 크게 지정.
// 3. data-host URL은 CORS preflight(OPTIONS)에도 그대로 걸려서 매 요청마다 캡처가 두 번
//    온다 — 첫 번째(항상 빈 바디)는 preflight, 두 번째가 실제 데이터다. interceptor.js가
//    빈 바디를 조용히 무시하므로 여기서 따로 구분할 필요는 없다.
// data-host가 아닌 요청은 패턴에 안 걸려 전혀 개입하지 않으므로 페이지의 다른 리소스
// (이미지·스크립트 등)엔 영향 없다.
const noopTracer = { enabled: false, record: () => {} };

async function attachCdpCapture(win, interceptor, { logger = console, tracer = null } = {}) {
  const trace = tracer || noopTracer;
  const dbg = win.webContents.debugger;
  // Network.requestWillBeSent(requestId) -> {url, kind, tsMs}. Fetch.requestPaused의
  // params.networkId로 짝지어 "요청이 나갔는지"와 "응답까지 걸린 시간"을 구분해 기록한다
  // (m1-live-findings.md §8-2 — 지금까지는 "응답을 못 받음"과 "요청 자체가 안 나감"을
  // 구분할 방법이 없었다). BSC_TRACE=1이 아니면 trace.record가 no-op이라 이 맵도 사실상
  // 안 쓰이지만, 오버헤드가 미미해 항상 채워둔다.
  const pendingNet = new Map();

  try {
    dbg.attach();
    logger.log && logger.log('[cdp] debugger attach 성공');
  } catch (err) {
    // 이미 attach된 상태(같은 webContents 재사용 시)면 여기로 올 수 있음 — 무시하고 계속 진행
    if (!/already attached/i.test(err.message || '')) {
      logger.error && logger.error(`[cdp] attach 실패: ${err.message}`);
      throw err;
    }
    logger.log && logger.log('[cdp] debugger 이미 attach됨 — 재사용');
  }

  const onMessage = async (_event, method, params) => {
    if (method === 'Network.requestWillBeSent') {
      const url = params.request && params.request.url;
      if (url && endpoints.isDataHost(url)) {
        pendingNet.set(params.requestId, { url, kind: endpoints.classifyUrl(url), tsMs: Date.now() });
        trace.record({ phase: 'request-sent', requestId: params.requestId, url, kind: endpoints.classifyUrl(url) });
      }
      return;
    }
    if (method === 'Network.loadingFailed') {
      const info = pendingNet.get(params.requestId);
      pendingNet.delete(params.requestId);
      if (info) {
        trace.record({
          phase: 'request-failed',
          requestId: params.requestId,
          url: info.url,
          kind: info.kind,
          errorText: params.errorText,
          canceled: params.canceled,
          durationMs: Date.now() - info.tsMs,
        });
      }
      return;
    }
    if (method === 'Network.loadingFinished') {
      // Fetch.requestPaused가 이미 소비했으면 no-op. 못 소비했으면(예: data-host지만
      // Fetch 패턴에 안 걸린 예외 케이스) 여기서 정리만 해 pendingNet이 안 새게 한다.
      pendingNet.delete(params.requestId);
      return;
    }
    if (method === 'Log.entryAdded') {
      const entry = params.entry || {};
      if (entry.level === 'error' || entry.level === 'warning') {
        trace.record({ phase: 'console-error', source: 'Log', level: entry.level, text: entry.text, url: entry.url });
      }
      return;
    }
    if (method === 'Runtime.exceptionThrown') {
      const details = params.exceptionDetails || {};
      trace.record({
        phase: 'console-error',
        source: 'exception',
        text: details.text,
        url: details.url,
        line: details.lineNumber,
      });
      return;
    }
    if (method === 'Runtime.consoleAPICalled') {
      if (params.type === 'error' || params.type === 'warning') {
        const argSnippets = (params.args || [])
          .map((a) => (a.value != null ? a.value : a.description))
          .filter((v) => v != null)
          .slice(0, 5);
        trace.record({ phase: 'console-error', source: 'console', level: params.type, args: argSnippets });
      }
      return;
    }
    if (method !== 'Fetch.requestPaused') return;
    const { requestId, request, responseStatusCode, responseHeaders, networkId } = params;
    const url = request.url;
    const netInfo = networkId ? pendingNet.get(networkId) : null;
    if (networkId) pendingNet.delete(networkId);

    try {
      if (responseStatusCode != null && endpoints.isDataHost(url)) {
        try {
          const result = await dbg.sendCommand('Fetch.getResponseBody', { requestId });
          const buf = result.base64Encoded
            ? Buffer.from(result.body, 'base64')
            : Buffer.from(result.body, 'utf8');
          const bodyText = decodeBody(buf, responseHeaders);
          if (process.env.BSC_DEBUG_UNCLASSIFIED === '1') {
            const encHeader = (responseHeaders || []).find((h) => (h.name || '').toLowerCase() === 'content-encoding');
            logger.log &&
              logger.log(
                `[cdp:DEBUG] ${url} base64Encoded=${result.base64Encoded} bufLen=${buf.length} content-encoding=${
                  encHeader ? encHeader.value : '(none)'
                } decodedLen=${bodyText.length}`
              );
          }
          trace.record({
            phase: 'response-received',
            requestId,
            networkId,
            url,
            kind: endpoints.classifyUrl(url),
            status: responseStatusCode,
            bodyLen: bodyText.length,
            durationMs: netInfo ? Date.now() - netInfo.tsMs : null,
          });
          interceptor.handleCapture({ url, method: request.method, status: responseStatusCode, bodyText });
        } catch (err) {
          // 그래도 실패하면(드물게) 조용히 스킵 — 저속 수집이라 이 요청 하나 놓쳐도 재시도 로직이 흡수함
          logger.warn && logger.warn(`[cdp] getResponseBody 실패(${url}): ${err.message}`);
          trace.record({
            phase: 'response-body-error',
            requestId,
            networkId,
            url,
            kind: endpoints.classifyUrl(url),
            status: responseStatusCode,
            error: err.message,
          });
        }
      }
    } finally {
      // 반드시 흘려보내야 한다 — 안 하면 이 요청을 기다리는 페이지가 멈춘다.
      try {
        await dbg.sendCommand('Fetch.continueResponse', { requestId });
      } catch (err) {
        // 이미 처리됐거나 타겟이 닫힌 경우 — 무시
      }
    }
  };

  dbg.on('message', onMessage);
  const onDetach = (_event, reason) => {
    logger.warn && logger.warn(`[cdp] debugger detach: ${reason}`);
  };
  dbg.on('detach', onDetach);

  const detach = () => {
    dbg.removeListener('message', onMessage);
    dbg.removeListener('detach', onDetach);
    try {
      dbg.detach();
    } catch (e) {
      // 이미 detach된 경우 무시
    }
  };

  // data-host만 패턴에 걸어 나머지 리소스(이미지·스크립트 등)는 아예 가로채지 않는다(비용 절감).
  const patterns = endpoints.DATA_HOSTS.flatMap((host) => [
    { urlPattern: `http://${host}/*`, requestStage: 'Response' },
    { urlPattern: `https://${host}/*`, requestStage: 'Response' },
  ]);

  // 실기동 확인(2026-07-16, 2차): Network.enable을 인자 없이 호출하면 버퍼 크기가 사실상 0에
  // 가까워 보여(모든 응답이 예외 없이 빈 문자열) 버퍼 크기를 명시적으로 크게 지정한다.
  logger.log && logger.log('[cdp] Network.enable + Fetch.enable 요청 중...');
  try {
    await withTimeout(
      dbg.sendCommand('Network.enable', {
        maxTotalBufferSize: 100 * 1024 * 1024,
        maxResourceBufferSize: 50 * 1024 * 1024,
      }),
      10000,
      'Network.enable'
    );
    await withTimeout(dbg.sendCommand('Fetch.enable', { patterns }), 10000, 'Fetch.enable');
    logger.log && logger.log('[cdp] Network.enable + Fetch.enable 완료 — 캡처 활성화됨');
  } catch (err) {
    // 타임아웃/실패해도 창을 영구히 멈추게 두지 않는다 — 캡처 없이라도 탐색은 진행시키고
    // 원인은 로그로 남겨 다음 세션에서 진단한다.
    logger.error && logger.error(`[cdp] enable 실패, 캡처 없이 진행: ${err.message}`);
  }

  if (trace.enabled) {
    // 콘솔 에러 수집은 트레이스 모드에서만 켠다 — 평소엔 도메인 추가 활성화 자체를 생략해
    // 오버헤드를 안 지운다(m1-live-findings.md §8-2).
    try {
      await withTimeout(dbg.sendCommand('Log.enable'), 5000, 'Log.enable');
      await withTimeout(dbg.sendCommand('Runtime.enable'), 5000, 'Runtime.enable');
      logger.log && logger.log(`[cdp] 트레이스 모드 활성화 — 콘솔 에러도 수집됨 (${trace.file})`);
    } catch (err) {
      logger.warn && logger.warn(`[cdp] Log/Runtime.enable 실패(트레이스의 콘솔 에러 수집만 영향): ${err.message}`);
    }
  }

  return { detach };
}

module.exports = { attachCdpCapture };
