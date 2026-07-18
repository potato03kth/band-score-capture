// 피드/댓글/대댓글을 저속으로 소진시키는 오케스트레이션.
//
// 실기동 확인(2026-07-16, 3분반 103239777)으로 밝혀진 사실 — 문서 추정과 다름, 매우 중요:
//   - 게시글 상세는 win.loadURL(post.web_url) 같은 하드 네비게이션으로는 댓글 API가 전혀 호출되지 않는다.
//     피드 화면 안에서 그 게시글의 링크(a[href*="/post/<postNo>"])를 클릭해야 모달이 열리며 댓글 API가 호출된다.
//   - 모달 닫기 버튼 class는 `.btnCloseLyPost`.
//   - 처음엔 "피드를 스크롤하며 각 글의 링크를 찾아 클릭"하는 방식으로 구현했으나, band.us가 피드를
//     가상 스크롤(virtualization)로 렌더링해 아직 화면에 안 그려진 글의 링크를 못 찾는 실패가 매우
//     잦았다(연속 다수 실패 실측 확인). 대신 **모달 안의 이전/다음 글 이동 화살표**
//     (`.btnNextPost`=과거로, `.btnPrevPost`=최신으로— 실측 확인. 가장 최신 글엔 `.btnPrevPost`가,
//     가장 오래된 글엔 `.btnNextPost`가 없다)를 쓰면, 피드 DOM의 가상화 상태와 무관하게 게시글을
//     순회할 수 있다. 그래서 **피드에서 가장 최신 글 하나만 클릭해 모달을 열고, 그 다음부터는 전부
//     `.btnNextPost`로 넘기며** 상세(get_post)·댓글(get_comments)을 CDP로 캡처하는 구조로 바꿨다.
//     post_no는 캡처된 응답 URL에서 그대로 뽑아내므로(interceptor.js), 어떤 글이 열렸는지 미리 알
//     필요가 없다.

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay(pacing) {
  const min = pacing.minDelayMs || 1500;
  const max = Math.max(min, pacing.maxDelayMs || 4000);
  return sleep(min + Math.random() * (max - min));
}

// band.us는 로그인 안 된 상태에서 접근하면 auth.band.us로 리다이렉트한다. 이 리다이렉트 체인 때문에
// 최초 loadURL()의 Promise가 ERR_ABORTED로 reject되는 것이 실측 확인됨 — 탐색 자체는 계속 진행되어
// 최종적으로 로그인 페이지가 정상 표시되므로 이건 오류가 아니라 정상 동작이다. 다른 코드(네트워크 단절 등)만 진짜 오류로 취급한다.
async function safeLoadURL(win, url, logger) {
  try {
    await win.loadURL(url);
  } catch (err) {
    if (err && /ERR_ABORTED/.test(err.message || '')) {
      logger.log && logger.log(`[collector] 탐색이 리다이렉트로 대체됨(정상, 무시): ${url}`);
      return;
    }
    throw err;
  }
}

// 피드 화면 DOM에서 가장 먼저(=가장 최신) 나오는 게시글 링크를 찾아 클릭한다. 이 함수는 모달
// 순회의 진입점에서 딱 한 번만 쓰인다 — 이후 게시글 이동은 전부 clickNextPost로 처리한다.
async function openFirstVisiblePostModal(win) {
  try {
    return await win.webContents.executeJavaScript(`
      (function () {
        var anchors = Array.prototype.slice.call(document.querySelectorAll('a[href*="/post/"]'));
        if (anchors.length === 0) return { ok: false, reason: 'not-found' };
        var visible = anchors.filter(function (a) { return a.offsetParent !== null; });
        var pool = visible.length > 0 ? visible : anchors;
        var preferred = pool.filter(function (a) { return (a.className || '').toString().trim() === 'text'; });
        var pick = preferred[0] || pool[0];
        pick.scrollIntoView({ block: 'center' });
        pick.click();
        return { ok: true, className: (pick.className || '').toString(), candidateCount: anchors.length };
      })();
    `);
  } catch (e) {
    return { ok: false, reason: 'exec-error', message: e.message };
  }
}

async function isModalOpen(win) {
  try {
    return await win.webContents.executeJavaScript(`!!document.querySelector('.btnCloseLyPost')`);
  } catch (e) {
    return false;
  }
}

async function closePostModal(win) {
  try {
    await win.webContents.executeJavaScript(`
      (function () {
        var btn = document.querySelector('.btnCloseLyPost');
        if (btn) { btn.click(); return true; }
        return false;
      })();
    `);
  } catch (e) {
    // 무시
  }
}

// 모달이 열린 상태에서 "다음"(더 과거) 글로 넘긴다(실측 확인: .btnNextPost=과거 방향,
// 가장 오래된 글에서는 이 버튼이 사라진다 — 그게 순회 종료 판정 기준이 된다).
// 존재 여부만 본다 — offsetParent는 position:fixed 오버레이 요소에서 화면에 보여도 null이
// 되는 경우가 있어(실기동에서 확인: 최신 글에서도 오탐으로 "버튼 없음" 처리됨) 쓰지 않는다.
async function clickNextPost(win) {
  try {
    return await win.webContents.executeJavaScript(`
      (function () {
        var btn = document.querySelector('.btnNextPost');
        if (!btn) return { ok: false, reason: 'no-button' };
        btn.click();
        return { ok: true };
      })();
    `);
  } catch (e) {
    return { ok: false, reason: 'exec-error', message: e.message };
  }
}

// §20: 사용자가 실제 브라우저 DevTools로 직접 확인한 구조 — "이전 댓글"/"첫 댓글로" 트리거가
// 있는 글에는 항상 `.moreComment` 클래스를 가진 div가 있고, 없는 글에는 절대 없다(실측
// 확정, 텍스트 매칭보다 훨씬 신뢰도 높음). 텍스트 정규식 매칭을 전부 버리고 이 selector로
// 교체한다 — 이제 "찾음/못 찾음"이 곧 "더 로드할 게 있음/없음"의 확정적 신호가 된다.
// 실기동으로 확인(2026-07-17): document 전체에서 첫 `.moreComment`를 집으면 이미 모달을 닫은
// 이전 글이나 피드의 다른 카드에 남은 무관한 `.moreComment`를 잘못 잡아, 댓글을 이미 다 받은
// 글까지 "더 있다"고 착각해 헛클릭·타임아웃을 유발했다(post_no=46: 13/13 확보했는데도 실패
// 처리됨). 실제로 화면에 떠 있는(보이는) 것만, 그중에서도 DOM상 마지막(=모달처럼 나중에
// 붙는 오버레이일 가능성이 높음) 것을 고른다.
async function findLoadMoreTarget(win) {
  try {
    return await win.webContents.executeJavaScript(`
      (async function () {
        var all = Array.prototype.slice.call(document.querySelectorAll('.moreComment'));
        var visible = all.filter(function (el) {
          var r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && el.offsetParent !== null;
        });
        var container = visible.length ? visible[visible.length - 1] : null;
        if (!container) return { found: false, totalMoreCommentCount: all.length, visibleMoreCommentCount: visible.length };
        var clickable = container.querySelector('button, [role="button"], a') || container;
        var text = (clickable.textContent || '').trim().slice(0, 40);
        clickable.scrollIntoView({ block: 'center' });
        // scrollIntoView는 비동기 렌더 업데이트라 좌표가 즉시 안정되지 않을 수 있어 잠깐
        // 기다린 뒤에 최종 좌표를 읽는다.
        await new Promise(function (r) { setTimeout(r, 200); });
        var rect = clickable.getBoundingClientRect();
        var isVisible = rect.width > 0 && rect.height > 0;
        return {
          found: true,
          text: text,
          visible: isVisible,
          totalMoreCommentCount: all.length,
          visibleMoreCommentCount: visible.length,
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
        };
      })();
    `);
  } catch (e) {
    return { found: false, error: e.message };
  }
}

// 실기동으로 확인(2026-07-17, 3차): 본문이 길면(예: 사진 첨부 — 황인각 교수 글들이 전부 이
// 케이스였다) 댓글 영역이 화면 밖에 있어 `.moreComment`가 DOM에 아예 렌더링되지 않는다
// (totalMoreCommentCount:0으로 실측 확인 — "안 보임"이 아니라 "없음"). band.us가 뷰포트
// 기준으로 지연 렌더링(virtualization)하는 것으로 추정된다. §7에서 scrollIntoView/scrollTop
// 같은 합성 스크롤은 IntersectionObserver 기반 렌더링을 못 깨울 수 있다고 이미 확인했으므로,
// 클릭을 진짜 입력으로 바꿔 해결했던 것과 같은 방식으로 진짜(trusted) 휠 입력을 주입한다.
// 실기동으로 확인(2026-07-17, 4차): 진짜 스크롤 컨테이너(SECTION.lyWrap._scrollContainer)를
// 정확히 찾았는데도 scrollTop이 0에서 전혀 안 움직였다 — Electron의 sendInputEvent mouseWheel은
// DOM의 WheelEvent.deltaY 규약과 부호가 반대다(양수를 주면 위로 스크롤됨). 이미 맨 위(0)인
// 상태에서 계속 "위로"를 요청했으니 움직일 수 없었던 것 — 아래로 내리려면 음수를 줘야 한다.
async function realScrollWheel(win, x, y, deltaY) {
  try {
    win.webContents.sendInputEvent({ type: 'mouseWheel', x, y, deltaX: 0, deltaY: -deltaY, canScroll: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// 모달 안에서 실제로 스크롤 가능한(scrollHeight > clientHeight) 요소 중 가장 큰 걸 골라 그
// 상태를 읽는다 — 휠 입력을 어디(x,y)에 쏴야 그 요소가 스크롤되는지 알아야 하기 때문이다.
// 실기동으로 확인(2026-07-17, 4차): post_no=33/46 둘 다 scrollHeight가 6597로 동일하게
// 나왔다 — 서로 다른 글인데 값이 같다는 건 모달 내부가 아니라 배경 피드 전체 같은 무관한
// 엘리먼트를 잘못 잡고 있다는 신호다. 어떤 엘리먼트를 골랐는지(tag/class/후보 개수)와,
// scrollTop을 JS로 직접 대입해도 실제로 바뀌는지(진단용, 신뢰 입력과 무관)를 같이 남겨서
// "엘리먼트를 잘못 골랐다" vs "휠 입력이 그 엘리먼트에 안 먹힌다"를 구분한다.
async function getModalScrollState(win) {
  try {
    return await win.webContents.executeJavaScript(`
      (function () {
        // .btnCloseLyPost 자신의 클래스명에도 "ly"가 들어있어 closest()가 자기 자신을 매칭해버린다
        // (실기동으로 확인 — root가 버튼 자체로 좁혀져 스크롤 가능한 자식이 하나도 없었고, 결국
        // document.documentElement로 폴백돼 모달과 무관한 전체 페이지를 스크롤하고 있었다).
        // parentElement부터 올라가야 진짜 모달 루트를 찾는다.
        var closeBtn = document.querySelector('.btnCloseLyPost');
        var closeBtnMatchedRoot = closeBtn && closeBtn.parentElement ? closeBtn.parentElement.closest('[class*="ly" i]') : null;
        var root = closeBtnMatchedRoot || document.body;
        var all = Array.prototype.slice.call(root.querySelectorAll('*'));
        all.push(root);
        var scrollables = all.filter(function (el) {
          return el.scrollHeight > el.clientHeight + 20 && el.clientHeight > 100;
        });
        scrollables.sort(function (a, b) {
          return (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight);
        });
        var target = scrollables[0] || document.scrollingElement || document.documentElement;
        var rect = target.getBoundingClientRect();
        var cx = Math.min(Math.max(rect.left + rect.width / 2, 1), window.innerWidth - 1);
        var cy = Math.min(Math.max(rect.top + rect.height / 2, 1), window.innerHeight - 1);
        var beforeProbe = target.scrollTop;
        target.scrollTop = beforeProbe + 50;
        var afterProbe = target.scrollTop;
        target.scrollTop = beforeProbe; // 진단만 하고 원위치
        return {
          scrollTop: beforeProbe,
          scrollHeight: target.scrollHeight,
          clientHeight: target.clientHeight,
          atBottom: beforeProbe + target.clientHeight >= target.scrollHeight - 4,
          x: Math.round(cx),
          y: Math.round(cy),
          debugTag: target.tagName,
          debugClass: (target.className || '').toString().slice(0, 80),
          debugCandidateCount: scrollables.length,
          debugHasCloseBtnRoot: !!closeBtnMatchedRoot,
          debugRootClass: (root.className || '').toString().slice(0, 80),
          debugScrollTopWritable: afterProbe !== beforeProbe,
        };
      })();
    `);
  } catch (e) {
    return null;
  }
}

// 진짜 휠 스크롤을 한 스텝 내려보내고 결과 상태를 반환한다. `.moreComment`를 못 찾았을 때
// 곧바로 "완결"로 단정하기 전에, 혹시 아직 렌더링 안 된 것뿐인지 확인하는 용도.
async function scrollModalDownOnce(win, { deltaY = 700, pauseMs = 400 } = {}) {
  const before = await getModalScrollState(win);
  if (!before) return { scrolled: false, reason: 'no-scroll-state' };
  await realScrollWheel(win, before.x, before.y, deltaY);
  await sleep(pauseMs);
  const after = await getModalScrollState(win);
  return { scrolled: true, before, after };
}

// 실기동으로 확인(2026-07-17, 5차): 사용자가 실제 브라우저에서 재현 — post_no=33은 모달을 열자
// 마자(스크롤 없이) `.moreComment`가 바로 DOM에 있었고, 진짜 클릭 한 번으로 남은 댓글 31개가
// 전부(51/51) 로드됐다. 즉 스크롤/렌더링 지연이 원인이 아니었다 — commentPage 응답을 받은
// "바로 그 순간"에 findLoadMoreTarget을 호출하면, 밴드 자신의 JS가 그 응답을 받아 `.moreComment`
// 를 DOM에 반영하기 전이라 못 찾는 타이밍 레이스였을 가능성이 높다. 짧은 간격으로 몇 번 더
// 재확인해본다(스크롤 폴백보다 먼저 — 스크롤은 진짜 "화면 밖" 문제일 때만 필요).
async function pollForLoadMoreTarget(win, { retries = 5, intervalMs = 300 } = {}) {
  for (let i = 0; i < retries; i++) {
    const target = await findLoadMoreTarget(win);
    if (target.found) return { target, pollAttempts: i };
    await sleep(intervalMs);
  }
  const target = await findLoadMoreTarget(win);
  return { target, pollAttempts: retries };
}

// 대댓글이 클릭 트리거 없이 "항상 펼쳐져" 있다면(사용자 실측 확인), 최상위 댓글 페이지네이션이
// 끝난 뒤에도 아직 화면에 안 그려진(=렌더/네트워크 요청이 안 된) 답글이 남아있을 수 있다.
// 모달을 진짜 스크롤로 끝까지 내려 밴드 자신이 필요한 요청을 스스로 쏘게 만든다 — 이 함수는
// 뭘 캡처했는지 직접 확인하지 않는다(그건 이미 interceptor→writer 경로가 부수효과로 처리함).
async function scrollThroughModal(win, { postNo, trace, maxSteps = 40, deltaY = 700, pauseMs = 450 } = {}) {
  let prevScrollTop = -1;
  let stableStreak = 0;
  for (let step = 0; step < maxSteps; step++) {
    const state = await getModalScrollState(win);
    if (!state) break;
    trace.record({ phase: 'scrollThroughModal', postNo, step, ...state });
    if (state.atBottom || state.scrollTop === prevScrollTop) {
      stableStreak++;
      if (stableStreak >= 2) break;
    } else {
      stableStreak = 0;
    }
    prevScrollTop = state.scrollTop;
    await realScrollWheel(win, state.x, state.y, deltaY);
    await sleep(pauseMs);
  }
}

// 사용자 지적(m1-live-findings.md §19-3): element.click()이나 dispatchEvent(new MouseEvent(...))는
// 전부 isTrusted:false인 합성 이벤트다. 스크롤은 이미 sendInputEvent로 진짜(trusted) 입력을
// 시도해봤으면서 정작 클릭은 한 번도 진짜로 시도한 적이 없었다 — 밴드의 클릭 핸들러가
// isTrusted를 체크(또는 실제 포인터 다운/업 사이 시간·이동 같은 것)한다면 지금까지의 모든
// 클릭 실험(§13-6 포인터 시퀀스 포함 — 그것도 dispatchEvent라 여전히 untrusted였다)이 애초에
// 실패할 수밖에 없었다. Chromium 입력 파이프라인에 실제 마우스 다운/업을 주입한다.
async function realClickAt(win, x, y) {
  try {
    win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
    await sleep(40);
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    await sleep(70);
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    return { clicked: true, x, y };
  } catch (e) {
    return { clicked: false, error: e.message };
  }
}

function waitForEvent(interceptor, eventName, predicate, timeoutMs, label) {
  // CDP 캡처는 클릭/스크롤 직후 수백 ms 내로 응답이 오는데, 그 사이 randomDelay 같은
  // 페이싱 지연을 거치고 나서야 이 함수를 호출하면 이벤트가 이미 지나가버릴 수 있다.
  // interceptor가 최근 이벤트를 잠깐 버퍼링해두므로, 새 리스너를 걸기 전에 먼저 거기서
  // 찾아본다(doc/m1-cdp-migration-plan.md 후속 실기동에서 확인된 문제).
  // label은 트레이스 표기용(예: "commentPage:postNo=48:attempt=0") — 어느 호출이 버퍼/실시간
  // 리스너/타임아웃 중 무엇으로 resolve됐는지 사후 분석하기 위함(m1-live-findings.md §12-3).
  const trace = (interceptor.trace && interceptor.trace.record) ? interceptor.trace : { record: () => {} };
  const startedMs = Date.now();
  if (interceptor.takeRecent) {
    const buffered = interceptor.takeRecent(eventName, predicate, label);
    if (buffered) {
      trace.record({ phase: 'waitForEvent-resolved', eventName, label, via: 'buffer', latencyMs: Date.now() - startedMs });
      return Promise.resolve(buffered);
    }
  }
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      interceptor.off(eventName, handler);
      trace.record({ phase: 'waitForEvent-resolved', eventName, label, via: 'timeout', latencyMs: Date.now() - startedMs });
      resolve(null);
    }, timeoutMs);
    function handler(payload) {
      if (done) return;
      if (predicate && !predicate(payload)) return;
      done = true;
      clearTimeout(timer);
      interceptor.off(eventName, handler);
      // 버그 A(m1-live-findings.md §12-4) 수정: interceptor.emit()은 같은 이벤트를 라이브
      // 리스너(EventEmitter)와 recent 버퍼 양쪽에 동시에 흘려보내는데, 라이브 리스너로 여기서
      // 막 소비한 이 payload는 recent 버퍼 쪽에서는 여전히 consumed:false로 남아있다. 그대로
      // 두면 나중에(예: 다음 게시글로 넘어갈 때 등록하는 postDetail 리스너처럼 predicate가
      // postNo 등으로 좁혀지지 않고 bandId만 확인하는 경우) 다른 takeRecent() 호출이 이
      // "이미 처리 끝난 stale 이벤트"를 다시 집어가 실제로는 아무 진전이 없는데도 "새 이벤트"로
      // 오인하는 사고가 실기동에서 확인됐다(post_no=48이 두 번 처리되며 두 번째는 항상 timeout —
      // 진짜 데이터 유실이 아니라 이 이중 소비 경로 미동기화가 원인이었다). 참조 동일성으로 같은
      // payload 객체를 recent에서도 소비 처리해 재사용을 막는다.
      if (interceptor.takeRecent) {
        interceptor.takeRecent(eventName, (p) => p === payload, `${label || eventName}:reconcile-buffer`);
      }
      trace.record({ phase: 'waitForEvent-resolved', eventName, label, via: 'listener', latencyMs: Date.now() - startedMs });
      resolve(payload);
    }
    interceptor.on(eventName, handler);
  });
}

async function waitForLogin(interceptor, { logger = console, maxWaitMs = 15 * 60 * 1000 } = {}) {
  logger.log('[collector] 로그인 대기 중 — 창에서 직접 로그인하세요 (2FA 포함).');
  const result = await waitForEvent(interceptor, 'authOk', null, maxWaitMs, 'login');
  if (!result) {
    throw new Error('로그인 대기 시간을 초과했습니다. 창에서 로그인을 완료한 뒤 다시 실행하세요.');
  }
  logger.log('[collector] 로그인 확인됨 (인증된 API 응답 캡처).');
}

function inMeasureRange(createdAtMs, settings) {
  if (settings.measureStartMs != null && createdAtMs < settings.measureStartMs) return false;
  if (settings.measureEndMs != null && createdAtMs > settings.measureEndMs) return false;
  return true;
}

// 모달이 "이미 해당 post에 대해 열려 있다"고 가정하고 최상위 댓글을 소진한다. 예전엔 답글이
// `_commentCountBtn`("댓글N" 배지) 클릭으로 펼쳐야 하는 줄 알았으나(클릭해도 네트워크 요청이
// 안 생겨 "못 찾은 트리거"로 남겨뒀었음), 사용자 실측 확인(2026-07-17): 대댓글은 애초에 숨겨져
// 있지 않고 항상 펼쳐져 있다 — 클릭할 토글 자체가 없다. `latest_comment`로 일부만 딸려오고
// comment_count보다 적게 잡히던 건 "못 채우는 진짜 결손"이 아니라 화면에 아직 안 그려져서
// (스크롤 안 함) 밴드가 그 요청을 스스로 안 쏜 것뿐이었다 — 최상위 페이지네이션이 끝난 뒤
// scrollThroughModal로 모달을 끝까지 훑어 밴드가 필요한 요청을 스스로 쏘게 만든다.
// 모달을 열거나 닫는 책임은 호출자(walkPostsViaModal)에게 있다 — 다음 글로 넘어갈 때 모달을
// 다시 열 필요 없이 그대로 이어서 쓰기 때문이다.
async function collectCommentsInOpenModal(win, interceptor, writer, post, { pacing, logger }) {
  const postNo = post.post_no;
  const topByNo = new Map();
  let topLevelDone = false;
  let sawAny = false;
  let noProgressStreak = 0;
  const perAttemptTimeout = Math.max((pacing.maxDelayMs || 4000) + 3000, 6000);
  // §20: `.moreComment`가 확정적 신호가 된 이후로는 재시도가 "혹시 나중에 버튼이 나타날까"가
  // 아니라 "클릭했는데 응답이 늦는 경우"만 커버하면 되므로 3회로 되돌린다.
  const maxNoProgress = 3;
  const trace = (interceptor.trace && interceptor.trace.record) ? interceptor.trace : { record: () => {} };

  for (let attempt = 0; attempt < (pacing.maxScrollAttemptsPerPost || 40); attempt++) {
    const page = await waitForEvent(
      interceptor,
      'commentPage',
      (e) => String(e.postNo) === String(postNo) && e.contentType === 'post',
      perAttemptTimeout,
      `commentPage:postNo=${postNo}:attempt=${attempt}`
    );
    if (!page) {
      noProgressStreak++;
      if (noProgressStreak >= maxNoProgress) {
        if ((post.comment_count || 0) > 0) {
          logger.warn &&
            logger.warn(
              `[collector] post_no=${postNo}: 댓글 API 응답을 ${maxNoProgress}회 재시도 후에도 못 받음(comment_count=${post.comment_count}, 지금까지 확보=${topByNo.size}건).`
            );
        }
        break;
      }
      // 이미 클릭했는데 응답이 늦는 경우 대비 재시도 — .moreComment가 여전히 있으면 다시 클릭.
      let { target, pollAttempts } = await pollForLoadMoreTarget(win);
      trace.record({ phase: 'findLoadMoreTarget', postNo, attempt, reason: 'no-page-received', pollAttempts, ...target });
      if (!target.found) {
        // 실기동으로 확인(2026-07-17, 3차): 본문이 길면(사진 첨부 등) 댓글 영역이 아직 렌더링
        // 안 됐을 뿐 `.moreComment`가 없는 게 아닐 수 있다 — 곧바로 완료 처리하기 전에 진짜
        // 스크롤로 한 번 더 렌더를 유도해본다(post_no=33/46 등에서 51개 중 20개만 캡처되던
        // 문제의 원인).
        const scroll = await scrollModalDownOnce(win);
        trace.record({ phase: 'scrollModalDownOnce', postNo, attempt, reason: 'no-page-received', ...scroll });
        target = await findLoadMoreTarget(win);
        trace.record({ phase: 'findLoadMoreTarget', postNo, attempt, reason: 'no-page-received-after-scroll', ...target });
      }
      if (target.found) {
        const clickResult = await realClickAt(win, target.x, target.y);
        trace.record({ phase: 'realClickAt', postNo, attempt, reason: 'no-page-received', ...clickResult });
      } else {
        // 실기동으로 확인(2026-07-16): 첫 페이지가 이미 API상 완결(previousParams:null)인데도
        // 밴드 UI에 남아있던 `.moreComment`를 클릭해 없앤 경우, 그 뒤로는 새 commentPage가 올
        // 이유가 없다(더 가져올 데이터가 실제로 없으므로). 스크롤까지 해봐도 `.moreComment`가
        // 없으면 그 시점에 완료 처리한다 — maxNoProgress를 다 태우고 "실패"로 오분류하던 버그
        // 수정(post_no=46: 13/13 확보하고도 실패 처리됐었음).
        topLevelDone = true;
        break;
      }
      await randomDelay(pacing);
      continue;
    }
    noProgressStreak = 0;
    sawAny = true;
    for (const { comment } of page.comments) {
      topByNo.set(String(comment.comment_id), comment);
    }
    // §20: previousParams보다 `.moreComment` 존재 여부를 완결 신호로 우선한다 — API 커서는
    // "더 있음"이라고 해도 밴드 자체 UI가 트리거를 안 띄우면(댓글 삭제 등으로 밴드 쪽
    // 카운트와 커서가 어긋난 것으로 추정) 실제로는 더 못 가져온다는 게 실측으로 확정됐다
    // (m1-live-findings.md §19-4 — post_no=23은 35초 연속 전수 검색으로도 트리거가 단 한
    // 번도 존재하지 않았다). `.moreComment`가 없으면 previousParams와 무관하게 완결 처리한다.
    let { target, pollAttempts } = await pollForLoadMoreTarget(win);
    trace.record({ phase: 'findLoadMoreTarget', postNo, attempt, reason: 'need-next-page', previousParamsIsNull: page.previousParams === null, pollAttempts, ...target });
    if (!target.found) {
      // 위와 동일한 이유(본문이 길면 아직 렌더링 안 됐을 수 있음) — post_no=33이 API상
      // previousParamsIsNull:false(더 있음)인데도 여기서 바로 완결 처리되어 51개 중 20개만
      // 캡처되던 게 실기동으로 확인됨.
      const scroll = await scrollModalDownOnce(win);
      trace.record({ phase: 'scrollModalDownOnce', postNo, attempt, reason: 'need-next-page', ...scroll });
      target = await findLoadMoreTarget(win);
      trace.record({ phase: 'findLoadMoreTarget', postNo, attempt, reason: 'need-next-page-after-scroll', ...target });
    }
    if (!target.found) {
      topLevelDone = true;
      break;
    }
    const clickResult = await realClickAt(win, target.x, target.y);
    trace.record({ phase: 'realClickAt', postNo, attempt, reason: 'need-next-page', ...clickResult });
    await randomDelay(pacing);
  }

  // 사용자 지적(2026-07-17): 대댓글은 클릭으로 펼치는 게 아니라 처음부터 항상 펼쳐져 있다 —
  // 그렇다면 latest_comment로 안 딸려온 나머지는 "못 채우는 진짜 결손"이 아니라, 화면에 아직
  // 안 그려져서(스크롤 안 함) 밴드 자신도 그 요청을 안 쏜 것뿐일 수 있다. 최상위 페이지네이션이
  // 끝난 뒤 모달을 진짜 스크롤로 끝까지 훑어 밴드가 필요한 요청을 스스로 쏘게 만든다 — 뭘
  // 캡처했는지는 기존 interceptor→writer 경로가 부수효과로 이미 처리한다.
  await scrollThroughModal(win, { postNo, trace });

  const topComments = Array.from(topByNo.values());
  const parentsNeedingReplies = topComments.filter((c) => (c.comment_count || 0) > 0);
  const repliesStatus = parentsNeedingReplies.map((c) => {
    const captured = writer.getReplyCount(postNo, c.comment_id);
    return { parentCommentId: c.comment_id, expected: c.comment_count, captured, complete: captured >= c.comment_count };
  });
  const incompleteCount = repliesStatus.filter((r) => !r.complete).length;
  if (incompleteCount > 0) {
    logger.warn &&
      logger.warn(
        `[collector] post_no=${postNo}: 대댓글 미소진 부모 댓글 ${incompleteCount}건(스크롤 이후에도 latest_comment 만큼만 확보됨).`
      );
  }

  return { postNo, topLevelDone, topComments, repliesStatus };
}

// 피드에서 가장 최신 글 하나만 클릭해 모달을 열고, 그 다음부터는 `.btnNextPost`로 과거 방향으로
// 넘기며 각 글의 상세·댓글을 캡처한다. 완료 판정: ①`.btnNextPost`가 사라짐(가장 오래된 글 도달)
// 또는 ②현재 글의 created_at이 측정시작일보다 과거. 측정종료일보다 미래인 글은 스킵하되 순회는
// 계속한다(더 과거로 가면 범위 안에 들 수 있으므로).
async function walkPostsViaModal(win, interceptor, writer, { bandId, settings, pacing, logger }) {
  const perAttemptTimeout = Math.max((pacing.maxDelayMs || 4000) + 3000, 6000);
  const posts = [];
  const commentResults = [];
  let exhausted = false;
  const trace = (interceptor.trace && interceptor.trace.record) ? interceptor.trace : { record: () => {} };

  // 첫 글은 아직 post_no를 모르니(피드에서 "가장 위" 글을 그냥 클릭) 어떤 post_no든 매칭한다.
  let pendingDetail = waitForEvent(interceptor, 'postDetail', (e) => String(e.bandId) === String(bandId), perAttemptTimeout, 'postDetail:open-first');
  let openResult = await openFirstVisiblePostModal(win);
  trace.record({ phase: 'openFirstVisiblePostModal', attempt: 0, ...openResult });
  for (let i = 0; i < 3 && !openResult.ok && openResult.reason === 'not-found'; i++) {
    await sleep(800);
    pendingDetail = waitForEvent(interceptor, 'postDetail', (e) => String(e.bandId) === String(bandId), perAttemptTimeout, `postDetail:open-first-retry=${i}`);
    openResult = await openFirstVisiblePostModal(win);
    trace.record({ phase: 'openFirstVisiblePostModal', attempt: i + 1, ...openResult });
  }
  if (!openResult.ok) {
    logger.warn &&
      logger.warn(
        `[collector] 피드에서 첫 게시글 링크를 못 찾아 모달 순회를 시작하지 못함(사유: ${openResult.reason}${
          openResult.message ? ' - ' + openResult.message : ''
        }).`
      );
    return { exhausted: false, posts, commentResults };
  }
  await randomDelay(pacing);
  if (!(await isModalOpen(win))) {
    logger.warn && logger.warn('[collector] 첫 게시글 클릭 후 모달이 열리지 않음 — selector 재검증 필요.');
    return { exhausted: false, posts, commentResults };
  }

  const maxPosts = pacing.maxPostsPerBand || 2000; // 무한루프 방지용 안전 상한

  for (let i = 0; i < maxPosts; i++) {
    const detail = await pendingDetail;
    if (!detail) {
      logger.warn && logger.warn('[collector] 현재 모달의 게시글 상세(get_post) 캡처를 못 받음 — 순회 중단.');
      break;
    }
    const post = detail.post;
    posts.push(post);

    if (settings.measureStartMs != null && post.created_at < settings.measureStartMs) {
      exhausted = true;
      logger.log(`[collector] 모달 순회: post_no=${post.post_no}가 측정 시작일 이전 → 종료.`);
      break;
    }

    if (inMeasureRange(post.created_at, settings) && (post.comment_count || 0) > 0) {
      await randomDelay(pacing);
      commentResults.push(await collectCommentsInOpenModal(win, interceptor, writer, post, { pacing, logger }));
    }

    // 다음(더 과거) 글로 넘기기 전에 먼저 리스너를 걸어둔다(클릭 후에 걸면 응답을 놓칠 수 있음).
    pendingDetail = waitForEvent(interceptor, 'postDetail', (e) => String(e.bandId) === String(bandId), perAttemptTimeout, `postDetail:after=${post.post_no}`);
    await randomDelay(pacing);
    const clicked = await clickNextPost(win);
    trace.record({ phase: 'clickNextPost', postNo: post.post_no, ...clicked });
    if (!clicked.ok) {
      if (clicked.reason === 'no-button') {
        exhausted = true;
        logger.log(`[collector] 모달 순회: post_no=${post.post_no} 이후 다음 글 버튼 없음(가장 오래된 글) → 종료.`);
      } else {
        logger.warn &&
          logger.warn(
            `[collector] post_no=${post.post_no}: 다음 글로 넘기기 실패(사유: ${clicked.reason}${
              clicked.message ? ' - ' + clicked.message : ''
            }) → 순회 중단.`
          );
      }
      break;
    }
  }

  if (!exhausted && posts.length >= maxPosts) {
    logger.warn &&
      logger.warn(`[collector] 모달 순회가 안전 상한(${maxPosts}건)에 도달해 강제 종료됨 — 완전성 미보장.`);
  }
  if (settings.measureStartMs == null) {
    logger.warn &&
      logger.warn('[collector] 측정 시작일이 설정되지 않아 가장 오래된 글까지만 종료 조건으로 사용합니다.');
  }

  await closePostModal(win);
  await randomDelay(pacing);

  return { exhausted, posts, commentResults };
}

// 멤버 페이지 URL은 recon에서 확인되지 않은 추정값(band.us 관행 패턴) — 실패 시 로그로 명확히 알린다.
async function collectMembers(win, interceptor, bandId, { logger }) {
  const url = `https://www.band.us/band/${bandId}/member`;
  try {
    await safeLoadURL(win, url, logger);
  } catch (e) {
    logger.warn && logger.warn(`[collector] 멤버 페이지 로드 실패: ${url} (${e.message})`);
    return null;
  }
  const event = await waitForEvent(interceptor, 'memberPage', (e) => String(e.bandId) === String(bandId), 15000, 'memberPage');
  if (!event) {
    logger.warn &&
      logger.warn(`[collector] 멤버 목록 API 캡처 실패(URL 추정치: ${url}). 실제 멤버 페이지 진입 경로를 확인해야 함.`);
    return null;
  }
  if (event.hasMore) {
    logger.warn &&
      logger.warn('[collector] has_more_member=true — 멤버 페이지네이션 트리거가 recon에서 미확정. 첫 페이지만 수집됨.');
  }
  return event.members;
}

async function runBandCollection({ win, interceptor, writer, band, settings, config, logger = console }) {
  const pacing = config.pacing || {};

  const feedUrl = `https://www.band.us/band/${band.bandId}/post`;
  await safeLoadURL(win, feedUrl, logger);

  // 첫 밴드는 여기서 사람이 직접 로그인해야 authOk가 온다. 이후 밴드는 persist 세션이 재사용되어
  // 피드 요청이 곧바로 인증된 상태로 도착하므로 이 대기는 사실상 즉시 통과한다.
  await waitForLogin(interceptor, { logger });
  await randomDelay(pacing);

  const walkResult = await walkPostsViaModal(win, interceptor, writer, {
    bandId: band.bandId,
    settings,
    pacing,
    logger,
  });

  const inRangePosts = walkResult.posts.filter((p) => inMeasureRange(p.created_at, settings));
  const postsNeedingComments = inRangePosts.filter((p) => (p.comment_count || 0) > 0);

  logger.log(
    `[collector] 게시글 순회 완료: 전체 ${walkResult.posts.length}건, 기간 내 ${inRangePosts.length}건, 댓글 수집 대상 ${postsNeedingComments.length}건, 실제 댓글 수집 시도 ${walkResult.commentResults.length}건`
  );

  await randomDelay(pacing);
  const members = await collectMembers(win, interceptor, band.bandId, { logger });
  if (members) writer.writeMembersSnapshot(members);

  const status = {
    feedExhausted: walkResult.exhausted,
    totalPosts: walkResult.posts.length,
    postsInRange: inRangePosts.length,
    postsNeedingComments: postsNeedingComments.length,
    postsCommentsAttempted: walkResult.commentResults.length,
    postsCommentsComplete: walkResult.commentResults.filter((r) => r.topLevelDone).length,
    postsRepliesIncomplete: walkResult.commentResults
      .filter((r) => r.repliesStatus.some((x) => !x.complete))
      .map((r) => r.postNo),
    memberCount: members ? members.length : null,
    completedAtMs: Date.now(),
  };
  writer.writeCollectionStatus(status);
  logger.log(`[collector] 밴드 ${band.bandId}(${band.name}) 수집 상태:`, status);
  return status;
}

module.exports = {
  runBandCollection,
  waitForLogin,
  walkPostsViaModal,
  collectCommentsInOpenModal,
  collectMembers,
  inMeasureRange,
  randomDelay,
};
