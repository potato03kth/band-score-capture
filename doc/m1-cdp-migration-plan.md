# m1-cdp-migration-plan.md — preload 몽키패치 → CDP 인터셉트 전환 계획

> **읽기 전에**: `doc/m1-live-findings.md`를 먼저 읽어라. 이 문서는 그 결론(댓글 API가 preload
> 몽키패치로는 안 잡힌다 → CDP로 전환해야 한다)을 실행하기 위한 **구체적 작업 계획**이다.
> 이 문서만 보고도 바로 구현을 시작할 수 있도록 코드 스켈레톤까지 포함한다.

## 0. 목표 요약

`acquire/preload.js`의 `window.fetch`/`XMLHttpRequest.prototype` 몽키패치 방식을 버리고,
Electron의 **CDP(Chrome DevTools Protocol) `webContents.debugger`** 로 네트워크 응답을 가로챈다.
이렇게 하면 band.us가 내부적으로 어떤 JS 래퍼(`XHRProto`, `ajax` 등)를 쓰든 상관없이,
브라우저 네트워크 계층에서 직접 보기 때문에 놓치는 요청이 없다.

**바꾸지 않아도 되는 것** (이미 검증 완료, 그대로 재사용):
- `acquire/capture/endpoints.js` — URL 분류 로직 그대로 재사용 가능
- `acquire/capture/interceptor.js` — `handleCapture({url, method, status, bodyText})` 인터페이스
  그대로 유지. 호출하는 쪽(제공자)만 preload IPC → CDP 이벤트로 바뀐다.
- `acquire/writer.js` — 전혀 안 바뀜
- `acquire/collector.js`의 `openPostModal`/`closePostModal`/`clickLoadMoreComments`/피드 스크롤
  로직 — UI 자동화 방식은 그대로 유효(실측 확인됨, `m1-live-findings.md` §1 참조). CDP는 "어떻게
  관찰하는가"만 바꾸지 "어떻게 조작하는가"는 안 바꾼다.
- `lib/`, `config/`, `input/` 관련 전부 — 무관

**바뀌는 것**:
- `acquire/preload.js` — XHR/fetch 몽키패치 코드 삭제(또는 파일 자체 삭제). preload가 더 필요
  없다면 `BrowserWindow` 생성 시 `webPreferences.preload` 옵션도 제거.
- `acquire/main.js` — `ipcMain.on('band:capture', ...)` 삭제, 대신 CDP 캡처 모듈을 붙임.
- 신규 파일 `acquire/capture/cdp-capture.js` — CDP attach/enable/이벤트 리스닝을 캡슐화.

## 1. CDP 기본 동작 원리 (Electron `webContents.debugger`)

```js
const dbg = win.webContents.debugger;
dbg.attach('1.3');                       // 프로토콜 버전 지정, 실패 시 예외
await dbg.sendCommand('Network.enable'); // 네트워크 이벤트 수신 시작
dbg.on('message', (event, method, params) => {
  if (method === 'Network.responseReceived') { /* 헤더/URL/status 도착 */ }
  if (method === 'Network.loadingFinished') { /* 본문을 이제 가져올 수 있음 */ }
});
const { body, base64Encoded } = await dbg.sendCommand('Network.getResponseBody', { requestId });
```

- `responseReceived`가 먼저 오고(메타데이터), 본문을 실제로 읽으려면 `loadingFinished`(또는
  `loadingFailed`) 이후 `Network.getResponseBody`를 **그 요청의 requestId로** 별도 호출해야 한다.
  너무 늦게 부르면(응답 캐시가 해제되면) 실패할 수 있으니 `loadingFinished` 받는 즉시 호출한다.
- `requestId`로 두 이벤트를 짝지어야 한다 — `responseReceived`에서 `{url, status}`를 임시 Map에
  저장해두고, `loadingFinished`에서 꺼내 쓰고 Map에서 지운다.
- **주의**: `webContents.debugger.attach()`와 `webContents.openDevTools()`는 **동시 사용 불가**
  (같은 CDP 세션 슬롯을 다투다 충돌/실패함). `acquire/main.js`에 있는 임시 진단용
  `BSC_DEVTOOLS=1` 분기는 CDP 전환 후 **CDP 캡처와는 상호 배타적으로만 쓸 것** — 즉 CDP 켜져
  있으면 `BSC_DEVTOOLS`는 무시하거나, 둘 중 하나만 켜지도록 명시적으로 막아라.
- 창을 닫거나 다음 밴드로 넘어갈 때 `dbg.detach()`를 호출해 정리한다(안 해도 프로세스 종료 시
  자동 정리되지만, 같은 프로세스에서 여러 밴드를 순차 처리하는 현재 구조상 재부착이 필요할 수
  있으니 명시적으로 관리하는 게 안전).

## 2. 신규 파일: `acquire/capture/cdp-capture.js`

```js
const endpoints = require('./endpoints');

// CDP로 네트워크 응답을 가로채 interceptor.handleCapture()로 넘긴다.
// preload 몽키패치와 인터페이스를 동일하게 맞춰 interceptor.js/writer.js는 무변경으로 재사용한다.
function attachCdpCapture(win, interceptor, { logger = console } = {}) {
  const dbg = win.webContents.debugger;
  const pending = new Map(); // requestId -> { url, status, resourceType }

  try {
    dbg.attach('1.3');
  } catch (err) {
    // 이미 attach된 상태(같은 webContents 재사용 시)면 여기로 올 수 있음 — 무시하고 계속 진행
    if (!/already attached/i.test(err.message || '')) {
      logger.error && logger.error(`[cdp] attach 실패: ${err.message}`);
      throw err;
    }
  }

  const onMessage = async (_event, method, params) => {
    if (method === 'Network.responseReceived') {
      pending.set(params.requestId, {
        url: params.response.url,
        status: params.response.status,
        resourceType: params.type,
      });
      return;
    }
    if (method === 'Network.loadingFailed') {
      pending.delete(params.requestId);
      return;
    }
    if (method !== 'Network.loadingFinished') return;

    const info = pending.get(params.requestId);
    pending.delete(params.requestId);
    if (!info) return;
    if (!endpoints.isDataHost(info.url)) return; // 관심 없는 호스트는 본문 요청도 생략(비용 절감)

    try {
      const result = await dbg.sendCommand('Network.getResponseBody', {
        requestId: params.requestId,
      });
      const bodyText = result.base64Encoded
        ? Buffer.from(result.body, 'base64').toString('utf8')
        : result.body;
      interceptor.handleCapture({ url: info.url, method: info.resourceType, status: info.status, bodyText });
    } catch (err) {
      // 캐시에서 이미 사라진 응답 등 — 저속 수집이라 흔치 않겠지만 조용히 스킵
      logger.warn && logger.warn(`[cdp] getResponseBody 실패(${info.url}): ${err.message}`);
    }
  };

  dbg.on('message', onMessage);
  dbg.on('detach', (_event, reason) => {
    logger.warn && logger.warn(`[cdp] debugger detach: ${reason}`);
  });

  return dbg
    .sendCommand('Network.enable')
    .then(() => ({
      detach: () => {
        dbg.removeListener('message', onMessage);
        try {
          dbg.detach();
        } catch (e) {
          // 이미 detach된 경우 무시
        }
      },
    }));
}

module.exports = { attachCdpCapture };
```

구현 시 확인할 것:
- `params.type`(리소스 타입: `XHR`, `Fetch`, `Document` 등)을 `method` 필드에 그대로 넣어뒀는데,
  `interceptor.js`는 이 필드를 실제로 안 쓰므로(로그에만 쓰일 뿐) 문제없다. 필요하면 나중에
  실제 HTTP 메서드(GET 등)로 바꿔도 됨 — `Network.requestWillBeSent`도 같이 구독하면 얻을 수 있음.
- `Network.enable`은 Promise를 반환하므로 `attachCdpCapture`도 async/Promise로 설계했다.
  `acquire/main.js`에서 `await attachCdpCapture(...)` 형태로 붙여야 한다.

## 3. `acquire/main.js` 수정 지점

현재 구조(수정 전):
```js
let activeInterceptor = null;
ipcMain.on('band:capture', (_event, payload) => {
  if (activeInterceptor) activeInterceptor.handleCapture(payload);
});
// ... for (const band of settings.bands) { ... interceptor = createInterceptor(...); activeInterceptor = interceptor; ... }
```

CDP로 바꾼 뒤 구조(제안):
```js
const { attachCdpCapture } = require('./capture/cdp-capture');

// ipcMain.on('band:capture', ...) 블록 삭제

// 창 생성 직후, 밴드 루프 진입 전에 한 번만 CDP를 attach하고,
// interceptor만 밴드마다 교체하는 두 가지 방식 중 하나를 고른다:
//
// (A) 밴드마다 attach/detach — 매 밴드 새 interceptor를 만드는 현재 구조와 가장 자연스럽게 맞음.
//     for (const band of settings.bands) {
//       const writer = createWriter(...);
//       const interceptor = createInterceptor({ writer, bandId: band.bandId, logger });
//       const cdp = await attachCdpCapture(win, interceptor, { logger });
//       try {
//         await collector.runBandCollection({ win, interceptor, writer, band, settings, config, logger });
//       } finally {
//         cdp.detach();
//       }
//     }
//
// (B) 한 번만 attach, interceptor 교체는 클로저 밖 변수로 — activeInterceptor 패턴을 유지하고
//     cdp-capture.js가 참조하는 interceptor를 { current } 객체로 감싸 교체 가능하게 만든다.
//     구현이 조금 더 복잡하니 (A)를 권장.
```
**(A)를 권장하는 이유**: 밴드 전환 시 완전히 새 attach를 하면 `pending` Map이 밴드 사이에서
꼬일 일이 없고, 에러 처리(재시도)도 밴드 단위로 깔끔하게 격리된다.

`BrowserWindow` 생성 시 `webPreferences.preload` 옵션은 (더 이상 필요 없다면) 제거하고,
`contextIsolation`/`nodeIntegration`/`sandbox` 값은 그대로 둬도 무방하다(CDP는 renderer
컨텍스트와 무관하게 동작하므로 preload 유무와 상관없음).

`BSC_DEVTOOLS=1` 진단 분기(`win.webContents.openDevTools(...)`)는 CDP 붙인 상태에서 쓰면
십중팔구 충돌하니, CDP 전환 완료 후에는 이 분기를 지우거나 최소한 CDP와 동시 실행되지
않도록 주석으로 명확히 표시할 것.

## 4. `acquire/preload.js` 처리

XHR/fetch 몽키패치와 관련 코드를 전부 제거한다. `contextBridge.exposeInMainWorld`로 열어둔
`__bandCaptureSend` 통로도 더 이상 쓰이지 않으면 지운다. **파일 자체를 지우고
`webPreferences.preload`도 같이 빼도 되고**, 혹시 나중에 다른 용도(예: 페이지에 커스텀 UI 주입)로
쓸 여지가 있으면 빈 파일로만 남겨도 된다 — 이건 취향 문제, 기능적으로는 완전 삭제해도 무방.

## 5. 검증 순서 (다음 세션에서 이 순서대로)

1. `node --check`로 신규/수정 파일 문법 확인.
2. `npm start`로 1회 기동 → 로그인(세션 재사용되면 자동) → 피드 백필까지 기존과 동일하게
   동작하는지 확인(회귀 없는지).
3. 게시글 하나를 자동 클릭했을 때 로그에 `commentPage` 기반 처리 로그(`postsCommentsComplete`
   카운트 등)가 늘어나는지 확인 — **이게 이번 전환의 성공 판정 기준**.
4. 성공하면 `data/raw/103239777/<날짜>/items.ndjson`에 `schemaType:"comment"` 레코드가 실제로
   쌓이는지 확인(`grep '"schemaType":"comment"'`).
5. 대댓글(`contentType:"comment"`) 레코드도 쌓이는지 확인 — 안 쌓이면 `m1-live-findings.md` §3의
   "이전 댓글 더보기" selector 미확정 문제로 넘어가서 그때 다시 진단(이제 CDP로 실제 요청 발생
   여부를 정확히 볼 수 있으니 훨씬 쉬울 것).
6. 멤버 목록 페이지(`/band/<id>/member` 추정)도 이번에 같이 재검증.
7. **재기동은 최소화할 것** — `m1-live-findings.md` §4 참조. 한 번 붙일 때 여러 체크리스트를
   한 번에 확인하고, 실패해도 바로 재기동하지 말고 로그/raw 파일부터 충분히 분석할 것.

## 6. 실패했을 때의 대안 (CDP도 안 되면)

거의 없겠지만 만약 CDP도 특정 이유로 응답을 못 잡으면(예: band.us가 Service Worker로 응답을
가로채 캐시에서 서빙하는 경우 — 이번 실측에서는 Service Worker 0개로 확인됐으므로 가능성 낮음),
최후 수단은 DOM 파싱(브리프의 "DOM은 최후 수단" 조항)이다. 모달이 열린 뒤 렌더링된 댓글
DOM 요소(작성자명·본문·시각)를 직접 읽는 방식인데, 이건 채점 로직이 API 필드명(`user_no`,
`comment_id` 등)에 의존하는 현재 설계와 충돌하므로 대대적인 재설계가 필요하다. 이 경로는
CDP를 먼저 충분히 시도한 뒤에만 고려할 것.
