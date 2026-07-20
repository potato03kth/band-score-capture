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

// interceptor.screenshot는 main.js가 CDP attach 완료 후에야 실제 함수로 교체하므로(그 전엔
// no-op), 호출부는 항상 존재를 보장받지만 방어적으로 옵셔널 체이닝한다 — 단위 테스트 등에서
// interceptor를 직접 만들어 쓸 때 screenshot이 없을 수 있기 때문.
function shot(interceptor, label) {
  return interceptor.screenshot ? interceptor.screenshot(label).catch(() => null) : Promise.resolve(null);
}

// 화면을 직접 못 보는 세션(사람 부재, CLI 등)에서도 오래 걸리는 대기(로그인 등) 동안 무슨
// 일이 벌어지는지 사후에 재구성할 수 있도록, 대기 Promise가 끝날 때까지 주기적으로 스크린샷을
// 남긴다. 대기가 끝나면(성공/실패 무관) 폴링을 즉시 멈춘다.
async function withPeriodicScreenshots(promise, interceptor, { labelPrefix, intervalMs = 20000 } = {}) {
  let stopped = false;
  let i = 0;
  (async () => {
    while (!stopped) {
      await sleep(intervalMs);
      if (stopped) break;
      await shot(interceptor, `${labelPrefix}-${i++}`);
    }
  })();
  try {
    return await promise;
  } finally {
    stopped = true;
  }
}

function randomDelay(pacing) {
  const min = pacing.minDelayMs || 1500;
  const max = Math.max(min, pacing.maxDelayMs || 4000);
  return sleep(min + Math.random() * (max - min));
}

// 고정 sleep 대신 실제 조건(URL 변경, 요소 등장)이 될 때까지 폴링한다(§27-3-2: 탭 전환처럼
// 페이지 콘텐츠가 바뀌는 지점은 로딩 완료를 확인하고 넘어가야 함 — 사용자 라이브 관찰로 확인된
// 버그). evalExpr는 boolean으로 평가되는 JS 표현식 문자열.
async function pollUntil(win, evalExpr, { timeoutMs = 5000, intervalMs = 200 } = {}) {
  const start = Date.now();
  let last = false;
  while (Date.now() - start < timeoutMs) {
    try {
      last = await win.webContents.executeJavaScript(evalExpr);
    } catch (e) {
      last = false;
    }
    if (last) return { ok: true, elapsedMs: Date.now() - start };
    await sleep(intervalMs);
  }
  return { ok: false, elapsedMs: Date.now() - start };
}

// band.us는 로그인 안 된 상태에서 접근하면 auth.band.us로 리다이렉트한다. 이 리다이렉트 체인 때문에
// 최초 loadURL()의 Promise가 ERR_ABORTED로 reject되는 것이 실측 확인됨 — 탐색 자체는 계속 진행되어
// 최종적으로 로그인 페이지가 정상 표시되므로 이건 오류가 아니라 정상 동작이다. 다른 코드(네트워크 단절 등)만 진짜 오류로 취급한다.
async function safeLoadURL(win, url, logger) {
  try {
    await win.loadURL(url);
  } catch (err) {
    // §27-6에서 실측: 이 환경에서는 실제 에러 메시지가 "Error:  (-3) loading '...'"로 나와
    // "ERR_ABORTED" 텍스트가 없을 때가 있다(설명 없이 코드(-3)만) - 코드 번호로도 매칭한다.
    if (err && /ERR_ABORTED|\(-3\)/.test(err.message || '')) {
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

// 신뢰도 체계(사용자 규정, 2026-07-20, CLAUDE.md 참고) 2단계: 게시글 모달이 화면에 직접
// 렌더링하는 "댓글 N개" 표시(.postCount>.postCountLeft>.faceComment>.comment 계열 클래스
// 체인)는 API의 comment_count 필드(이미 신뢰 불가로 확인됨, §12-2/§20-1)와 달리 사람이 실제로
// 보는 값이라 신뢰도가 높다. 정확한 DOM 계층은 다음 실기동에서 검증 필요 — 클래스 체인이
// 안 맞을 경우를 대비해 느슨한 하위 선택자(공백)로 먼저 시도하고, 텍스트에서 숫자만 뽑는다.
// 실기동으로 확인(2026-07-20): 문서 전체에서 `.postCount`를 찾으면 모달 뒤에 깔린 배경 피드
// 카드 등 무관한 요소를 잘못 잡아 항상 같은 값(예: "4")만 반환하는 버그가 있었다(전체 실행
// 내내 표시값이 안 바뀌는 것으로 발견됨). `.btnCloseLyPost` 기준으로 모달 스코프를 좁히고,
// 스코프 안에서도 화면에 실제로 보이는 요소만 걸러 고른다.
async function readDisplayedCommentCount(win) {
  try {
    return await win.webContents.executeJavaScript(`
      (function () {
        var closeBtn = document.querySelector('.btnCloseLyPost');
        var root = closeBtn && closeBtn.parentElement ? closeBtn.parentElement.closest('[class*="ly" i]') : null;
        var scope = root || document;
        var candidates = [
          '.postCount .postCountLeft .faceComment .comment',
          '.postCount .postCountLeft .faceComment',
          '.postCount .faceComment .comment',
          '.postCount .faceComment',
          '.postCount'
        ];
        for (var i = 0; i < candidates.length; i++) {
          var els = Array.prototype.slice.call(scope.querySelectorAll(candidates[i]))
            .filter(function (el) { return el.offsetParent !== null; });
          if (els.length === 0) continue;
          var el = els[0];
          var text = (el.textContent || '').trim();
          var m = text.match(/\\d[\\d,]*/);
          if (m) return { found: true, selector: candidates[i], scoped: !!root, matchCount: els.length, raw: text.slice(0, 40), count: parseInt(m[0].replace(/,/g, ''), 10) };
        }
        return { found: false, scoped: !!root };
      })();
    `);
  } catch (e) {
    return { found: false, error: e.message };
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
// 뭘 캡처했는지 직접 확인하지 않는다(그건 이미 interceptor-writer 경로가 부수효과로 처리함).
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

// 실기동으로 확인(2026-07-20): `latest_comment`로 딸려오는 답글 수보다 실제 답글이 많은
// 부모 댓글에는 `.moreReply._openReplyListBtn`("N개의 답글 더보기") 버튼이 붙는다 — 이건
// scrollThroughModal이 트리거하는 "화면 밖이라 렌더 안 됨" 문제와는 다른, 명시적 클릭이
// 필요한 별도의 UI 트리거다(post_no=14에서 실측 확인: 화면엔 이미 다 렌더돼 있는데 이 버튼을
// 안 누르면 답글 2개가 영영 안 잡힘). 사용자가 직접 DOM에서 selector를 확인해줬다.
async function findReplyExpandButtons(win) {
  try {
    return await win.webContents.executeJavaScript(`
      (function () {
        var closeBtn = document.querySelector('.btnCloseLyPost');
        var root = closeBtn && closeBtn.parentElement ? closeBtn.parentElement.closest('[class*="ly" i]') : null;
        var scope = root || document;
        var btns = Array.prototype.slice.call(scope.querySelectorAll('.moreReply._openReplyListBtn'));
        return btns
          .filter(function (b) { var r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 && b.offsetParent !== null; })
          .map(function (b) {
            var r = b.getBoundingClientRect();
            return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), text: (b.textContent || '').trim().slice(0, 30) };
          });
      })();
    `);
  } catch (e) {
    return [];
  }
}

// 버튼을 한 번에 하나씩만 클릭한다 — 클릭 한 번에 그 스레드의 답글이 DOM에 추가되면서
// 아래쪽 다른 버튼들의 좌표가 밀릴 수 있어, 클릭마다 좌표를 다시 구하는 게 안전하다
// (.btnNextPost/.moreComment와 동일하게 realClickAt으로 진짜 입력을 주입 — m1-live-findings.md
// §19-3, synthetic click은 밴드 핸들러가 무시할 수 있음이 이미 확인됨).
async function expandHiddenReplies(win, interceptor, postNo, { pacing, logger, trace }) {
  const maxRounds = 30;
  const perAttemptTimeout = Math.max((pacing.maxDelayMs || 4000) + 3000, 6000);
  let expandedCount = 0;
  for (let round = 0; round < maxRounds; round++) {
    const buttons = await findReplyExpandButtons(win);
    trace.record({ phase: 'findReplyExpandButtons', postNo, round, count: buttons.length });
    if (!buttons.length) break;
    const btn = buttons[0];
    const pending = waitForEvent(
      interceptor,
      'commentPage',
      (e) => String(e.postNo) === String(postNo) && e.contentType === 'comment',
      perAttemptTimeout,
      `replyExpand:postNo=${postNo}:round=${round}`
    );
    const clickResult = await realClickAt(win, btn.x, btn.y);
    trace.record({ phase: 'moreReplyClick', postNo, round, text: btn.text, ...clickResult });
    const page = await pending;
    if (!page) {
      logger.warn &&
        logger.warn(`[collector] post_no=${postNo}: "${btn.text}" 클릭 후 답글 응답을 못 받음(round=${round}) — 중단.`);
      break;
    }
    expandedCount++;
    await randomDelay(pacing);
  }
  if (expandedCount > 0) {
    logger.log && logger.log(`[collector] post_no=${postNo}: 답글 더보기 버튼 ${expandedCount}개 처리함.`);
  }
  return expandedCount;
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
  await shot(interceptor, 'login-wait-start');
  const result = await withPeriodicScreenshots(
    waitForEvent(interceptor, 'authOk', null, maxWaitMs, 'login'),
    interceptor,
    { labelPrefix: 'login-wait' }
  );
  if (!result) {
    await shot(interceptor, 'login-timeout');
    throw new Error('로그인 대기 시간을 초과했습니다. 창에서 로그인을 완료한 뒤 다시 실행하세요.');
  }
  logger.log('[collector] 로그인 확인됨 (인증된 API 응답 캡처).');
  await shot(interceptor, 'login-ok');
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
// §28-10(2026-07-20 실기동, 4분반): "더보기" 클릭 한 번에 밴드가 commentPage를 두 번 emit하는
// 경우가 실측 확인됐다(하나는 빈 중복, 하나는 진짜 페이지 - post_no=91 실측: 20+20+0으로
// 40개에서 멈춤, 진짜였던 11개짜리 마지막 페이지가 유실됨 - post.comment_count 필드도 마침
// 40으로 어긋나 있어 topLevelGap 안전망에도 안 걸리는 조용한 결손이었다). §27-1의 postDetail
// 이중 emit과 같은 클래스의 버그. 한 번의 "더보기" 사이클에서 이미 도착한 commentPage를 전부
// 드레인해 병합한다(comment_id 기준 Map이라 중복 병합은 안전).
async function drainCommentPages(interceptor, postNo, timeoutMs, label) {
  const pages = [];
  const first = await waitForEvent(
    interceptor,
    'commentPage',
    (e) => String(e.postNo) === String(postNo) && e.contentType === 'post',
    timeoutMs,
    `${label}:first`
  );
  if (!first) return pages;
  pages.push(first);
  for (;;) {
    const more = await waitForEvent(
      interceptor,
      'commentPage',
      (e) => String(e.postNo) === String(postNo) && e.contentType === 'post',
      400,
      `${label}:drain`
    );
    if (!more) break;
    pages.push(more);
  }
  return pages;
}

async function collectCommentsInOpenModal(win, interceptor, writer, post, { pacing, logger }) {
  const postNo = post.post_no;
  const topByNo = new Map();
  let topLevelDone = false;
  let sawAny = false;
  let noProgressStreak = 0;
  // "수집 못 했다는 사실 자체를 모르는 것"이 진짜 실패라는 원칙(사용자 지적, 2026-07-20) —
  // 로그 문자열 한 줄로만 남기면 raw 데이터만 보는 사람/스크립트는 이 결손의 존재조차 알 수
  // 없다. 최상위/대댓글 결손을 각각 구조화된 형태로 모아 runBandCollection이
  // writer.writeIncompleteGaps()로 파일에 남기도록 반환값에 포함시킨다.
  let topLevelGap = null;
  const perAttemptTimeout = Math.max((pacing.maxDelayMs || 4000) + 3000, 6000);
  // §20: `.moreComment`가 확정적 신호가 된 이후로는 재시도가 "혹시 나중에 버튼이 나타날까"가
  // 아니라 "클릭했는데 응답이 늦는 경우"만 커버하면 되므로 3회로 되돌린다.
  const maxNoProgress = 3;
  const trace = (interceptor.trace && interceptor.trace.record) ? interceptor.trace : { record: () => {} };

  for (let attempt = 0; attempt < (pacing.maxScrollAttemptsPerPost || 40); attempt++) {
    const pages = await drainCommentPages(interceptor, postNo, perAttemptTimeout, `commentPage:postNo=${postNo}:attempt=${attempt}`);
    if (pages.length > 1) {
      trace.record({ phase: 'drainCommentPages', postNo, attempt, drainedCount: pages.length, counts: pages.map((p) => p.count) });
    }
    const page = pages.length ? pages[pages.length - 1] : null;
    if (!page) {
      noProgressStreak++;
      if (noProgressStreak >= maxNoProgress) {
        if ((post.comment_count || 0) > 0) {
          logger.warn &&
            logger.warn(
              `[collector] post_no=${postNo}: 댓글 API 응답을 ${maxNoProgress}회 재시도 후에도 못 받음(comment_count=${post.comment_count}, 지금까지 확보=${topByNo.size}건).`
            );
          await shot(interceptor, `comments-stall-post-${postNo}`);
          topLevelGap = { expected: post.comment_count, captured: topByNo.size };
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
    for (const p of pages) {
      for (const { comment } of p.comments) {
        topByNo.set(String(comment.comment_id), comment);
      }
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
  // 안전망: 위 루프 안의 명시적 분기(재시도 소진/타깃 못 찾음) 어디에도 안 걸렸는데도
  // topLevelDone이 결국 true가 안 된 채(예: maxScrollAttemptsPerPost 소진) 루프를 빠져나온
  // 경우, topLevelGap이 비어 결손 자체가 기록에서 누락될 수 있다 — 여기서 한 번 더 확인한다.
  if (!topLevelDone && !topLevelGap && (post.comment_count || 0) > topByNo.size) {
    topLevelGap = { expected: post.comment_count, captured: topByNo.size };
  }

  // 사용자 지적(2026-07-17): 대댓글은 클릭으로 펼치는 게 아니라 처음부터 항상 펼쳐져 있다 —
  // 그렇다면 latest_comment로 안 딸려온 나머지는 "못 채우는 진짜 결손"이 아니라, 화면에 아직
  // 안 그려져서(스크롤 안 함) 밴드 자신도 그 요청을 안 쏜 것뿐일 수 있다. 최상위 페이지네이션이
  // 끝난 뒤 모달을 진짜 스크롤로 끝까지 훑어 밴드가 필요한 요청을 스스로 쏘게 만든다 — 뭘
  // 캡처했는지는 기존 interceptor-writer 경로가 부수효과로 이미 처리한다.
  // 실기동으로 확인(2026-07-20): scrollThroughModal로 끝까지 내려간 *뒤에만* 답글 더보기
  // 버튼을 찾으면, 맨 위쪽 댓글(최상위 페이지네이션 직후엔 화면에 이미 렌더돼 있던 상태)에
  // 붙은 버튼은 그 사이 밴드의 가상스크롤이 언마운트해버려서 못 찾는다(post_no=14 실측:
  // moreReplyClick 트레이스가 0건 — 시도 자체가 안 됨). 스크롤 전에 한 번 먼저 훑어 이미
  // 보이는 버튼부터 처리하고, 스크롤 후에 다시 훑어 그때 새로 드러난 버튼을 마저 처리한다.
  await expandHiddenReplies(win, interceptor, postNo, { pacing, logger, trace });
  await scrollThroughModal(win, { postNo, trace });
  await expandHiddenReplies(win, interceptor, postNo, { pacing, logger, trace });

  const topComments = Array.from(topByNo.values());
  const parentsNeedingReplies = topComments.filter((c) => (c.comment_count || 0) > 0);
  const repliesStatus = parentsNeedingReplies.map((c) => {
    const captured = writer.getReplyCount(postNo, c.comment_id);
    return {
      parentCommentId: c.comment_id,
      parentAuthor: (c.author && c.author.name) || null,
      expected: c.comment_count,
      captured,
      complete: captured >= c.comment_count,
    };
  });
  const incompleteCount = repliesStatus.filter((r) => !r.complete).length;
  if (incompleteCount > 0) {
    logger.warn &&
      logger.warn(
        `[collector] post_no=${postNo}: 대댓글 미소진 부모 댓글 ${incompleteCount}건(스크롤 이후에도 latest_comment 만큼만 확보됨).`
      );
  }

  // 신뢰도 체계 2단계 교차검증(CLAUDE.md 참고): 모달이 화면에 직접 표시하는 "댓글 N개"와
  // 우리가 실제로 확보한 총합(최상위+대댓글)을 비교한다. API의 comment_count 필드(3단계)보다
  // 신뢰도가 높으므로, 이게 안 맞으면 API 필드 불일치보다 더 무겁게 취급해야 한다.
  const capturedTotal = topComments.length + repliesStatus.reduce((sum, r) => sum + r.captured, 0);
  const displayed = await readDisplayedCommentCount(win);
  trace.record({ phase: 'readDisplayedCommentCount', postNo, capturedTotal, ...displayed });
  const displayedCountCheck =
    displayed.found && typeof displayed.count === 'number'
      ? { displayedCount: displayed.count, capturedTotal, match: displayed.count === capturedTotal }
      : null;
  if (displayedCountCheck && !displayedCountCheck.match) {
    logger.warn &&
      logger.warn(
        `[collector] post_no=${postNo}: 모달 표시 댓글 수(${displayedCountCheck.displayedCount})와 캡처된 총합(${capturedTotal})이 다름.`
      );
  }

  return { postNo, topLevelDone, topComments, repliesStatus, topLevelGap, displayedCountCheck };
}

// 신뢰도 체계(CLAUDE.md) 2단계 교차검증: 피드 화면을 실제로 끝까지 스크롤해 `div.cCard
// gContentCardShadow`(공지 `data-viewname="DAnnouncementItemView"` 제외, `display:none` 제외)
// 개수를 센다. 이건 우리 순회(.btnNextPost 반복)가 "가장 오래된 글까지 도달했다"고 판단한
// totalPosts와 별개의 경로로 얻는 총 게시글 수라 교차검증에 쓸 수 있다. 실기동으로 selector와
// 정확도까지 확인 완료(§26-5, m1-live-findings.md) - 카드 67개 중 공지 6개 제외 61개가 실제
// 순회 결과(61개)와 정확히 일치했다.
async function getFeedScrollState(win) {
  try {
    return await win.webContents.executeJavaScript(`
      (function () {
        var root = document.querySelector('.postWrap.viewTypeListWrap') || document.scrollingElement || document.documentElement;
        var rect = root.getBoundingClientRect();
        var cx = Math.min(Math.max(rect.left + rect.width / 2, 1), window.innerWidth - 1);
        var cy = Math.min(Math.max(window.innerHeight / 2, 1), window.innerHeight - 1);
        return {
          scrollTop: window.scrollY,
          scrollHeight: document.documentElement.scrollHeight,
          clientHeight: window.innerHeight,
          atBottom: window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 4,
          x: Math.round(cx),
          y: Math.round(cy),
        };
      })();
    `);
  } catch (e) {
    return null;
  }
}

// 실기동으로 확정(2026-07-20): `.postWrap.viewTypeListWrap`/`.-brunchOfPostType`는 실제 DOM에
// 없다(사용자가 설명한 클래스와 실측이 달랐음) - 실제 카드 class는 그냥 `cCard
// gContentCardShadow`뿐이고, 공지는 `data-viewname="DAnnouncementItemView"`로 구분된다.
// `_popularPostListRegion`("인기 게시글")이 존재하면 그 안의 카드는 "모든 게시글"과 중복일 수
// 있어 제외한다(실측 시점엔 비어있었지만 다른 밴드/시점엔 채워질 수 있음 - 방어적으로 유지).
// 실측 검증: 전체 카드 67개 중 공지 6개 제외 = 61개, 이게 `.btnNextPost` 순회로 확인한 실제
// 게시글 수(post_no 1~63, 51/57 결번 61개)와 정확히 일치했다.
async function countRenderedPostCards(win) {
  try {
    return await win.webContents.executeJavaScript(`
      (function () {
        var popularRegion = document.querySelector('._popularPostListRegion');
        var inPopular = popularRegion ? popularRegion.querySelectorAll('div.cCard.gContentCardShadow') : [];
        var popularSet = new Set(Array.prototype.slice.call(inPopular));
        var cards = Array.prototype.slice.call(document.querySelectorAll('div.cCard.gContentCardShadow'))
          .filter(function (el) { return !popularSet.has(el); });
        var visible = cards.filter(function (el) {
          if (el.getAttribute('data-viewname') === 'DAnnouncementItemView') return false;
          var style = window.getComputedStyle(el);
          if (style.display === 'none') return false;
          return true;
        });
        return { total: cards.length, counted: visible.length };
      })();
    `);
  } catch (e) {
    return { total: 0, counted: 0, error: e.message };
  }
}

async function countTotalPostsViaFeedScroll(win, { trace, maxSteps = 200, deltaY = 900, pauseMs = 350 } = {}) {
  let prevScrollTop = -1;
  let stableStreak = 0;
  let lastCount = await countRenderedPostCards(win);
  trace.record({ phase: 'feedScrollCount', step: -1, ...lastCount });
  for (let step = 0; step < maxSteps; step++) {
    const state = await getFeedScrollState(win);
    if (!state) break;
    if (state.atBottom || state.scrollTop === prevScrollTop) {
      stableStreak++;
      if (stableStreak >= 2) break;
    } else {
      stableStreak = 0;
    }
    prevScrollTop = state.scrollTop;
    win.webContents.sendInputEvent({ type: 'mouseWheel', x: state.x, y: state.y, deltaX: 0, deltaY: -deltaY, canScroll: true });
    await sleep(pauseMs);
    lastCount = await countRenderedPostCards(win);
    trace.record({ phase: 'feedScrollCount', step, ...state, ...lastCount });
  }
  return lastCount;
}

// 피드에서 가장 최신 글 하나만 클릭해 모달을 열고, 그 다음부터는 `.btnNextPost`로 과거 방향으로
// 넘기며 각 글의 상세·댓글을 캡처한다. 완료 판정: ①`.btnNextPost`가 사라짐(가장 오래된 글 도달)
// 또는 ②현재 글의 created_at이 측정시작일보다 과거. 측정종료일보다 미래인 글은 스킵하되 순회는
// 계속한다(더 과거로 가면 범위 안에 들 수 있으므로).
// §28-9(2026-07-20 실기동, 4분반): .btnNextPost가 다음 "글"이 아니라 공지사항으로 넘어가는
// 경우가 실측 확인됐다(get_announcement 호출, get_post는 안 옴) - postDetail만 기다리면
// 영원히 타임아웃돼 순회 전체가 조기 중단된다(51/98건에서 중단됨). postDetail과
// announcementDetail을 동시에 기다려 어느 쪽이 왔는지 구분한다.
function waitForNextPostOrAnnouncement(interceptor, bandId, seenPostNos, timeoutMs, label) {
  const postWait = waitForEvent(
    interceptor,
    'postDetail',
    (e) => String(e.bandId) === String(bandId) && !seenPostNos.has(String(e.post && e.post.post_no)),
    timeoutMs,
    `${label}:post`
  ).then((d) => (d ? { type: 'post', detail: d } : null));
  const announcementWait = waitForEvent(
    interceptor,
    'announcementDetail',
    (e) => String(e.bandId) === String(bandId),
    timeoutMs,
    `${label}:announcement`
  ).then((d) => (d ? { type: 'announcement', detail: d } : null));
  return Promise.race([postWait, announcementWait]);
}

async function walkPostsViaModal(win, interceptor, writer, { bandId, settings, pacing, logger }) {
  const perAttemptTimeout = Math.max((pacing.maxDelayMs || 4000) + 3000, 6000);
  const posts = [];
  const commentResults = [];
  const gaps = [];
  let exhausted = false;
  const trace = (interceptor.trace && interceptor.trace.record) ? interceptor.trace : { record: () => {} };
  // §27-1: 밴드가 같은 post_no의 get_post를 중복 emit할 때, 처리 시간이 길어지면(§26에서 추가된
  // expandHiddenReplies/scrollThroughModal/readDisplayedCommentCount) 그 지연 emit이 "다음 글"을
  // 기다리는 시점에 버퍼에서 소비돼 같은 글이 재처리되는 회귀가 있었다. 직전 글 post_no 하나만
  // 제외하는 1차 수정으로는 부족했다(버퍼에 여러 post_no의 중복 emit이 동시에 남아있어 서로를
  // 오가며 재소비되는 패턴 실측 확인) - 이번 walk에서 이미 처리한 post_no 전체를 Set으로
  // 누적해 제외한다.
  const seenPostNos = new Set();

  // 첫 글은 아직 post_no를 모르니(피드에서 "가장 위" 글을 그냥 클릭) 어떤 post_no든 매칭한다.
  let pendingWait = waitForNextPostOrAnnouncement(interceptor, bandId, seenPostNos, perAttemptTimeout, 'postDetail:open-first');
  let openResult = await openFirstVisiblePostModal(win);
  trace.record({ phase: 'openFirstVisiblePostModal', attempt: 0, ...openResult });
  for (let i = 0; i < 3 && !openResult.ok && openResult.reason === 'not-found'; i++) {
    await sleep(800);
    pendingWait = waitForNextPostOrAnnouncement(interceptor, bandId, seenPostNos, perAttemptTimeout, `postDetail:open-first-retry=${i}`);
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
    await shot(interceptor, 'modal-open-fail-not-found');
    return { exhausted: false, posts, commentResults, gaps };
  }
  await randomDelay(pacing);
  if (!(await isModalOpen(win))) {
    logger.warn && logger.warn('[collector] 첫 게시글 클릭 후 모달이 열리지 않음 — selector 재검증 필요.');
    await shot(interceptor, 'modal-open-fail-not-visible');
    return { exhausted: false, posts, commentResults, gaps };
  }
  await shot(interceptor, 'modal-open');

  const maxPosts = pacing.maxPostsPerBand || 2000; // 무한루프 방지용 안전 상한

  for (let i = 0; i < maxPosts; i++) {
    let result = await pendingWait;

    // §28-9: 공지사항을 만나면 카운트하지 않고(글이 아니므로) 자동으로 다음으로 건너뛴다.
    while (result && result.type === 'announcement') {
      const announcementId = result.detail && result.detail.announcementId;
      logger.log(`[collector] 모달 순회: 공지사항(id=${announcementId}) 발견 - 건너뜀.`);
      trace.record({ phase: 'walkSkipAnnouncement', announcementId });
      pendingWait = waitForNextPostOrAnnouncement(interceptor, bandId, seenPostNos, perAttemptTimeout, `postDetail:after-announcement=${announcementId}`);
      await randomDelay(pacing);
      const clickedAfterAnnouncement = await clickNextPost(win);
      trace.record({ phase: 'clickNextPost', afterAnnouncement: true, ...clickedAfterAnnouncement });
      if (!clickedAfterAnnouncement.ok) {
        if (clickedAfterAnnouncement.reason === 'no-button') {
          exhausted = true;
          logger.log(`[collector] 모달 순회: 공지사항(id=${announcementId}) 이후 다음 글 버튼 없음(가장 오래된 글) - 종료.`);
        }
        result = null;
        break;
      }
      result = await pendingWait;
    }

    if (!result) {
      if (!exhausted) {
        logger.warn && logger.warn('[collector] 현재 모달의 게시글 상세(get_post) 캡처를 못 받음 — 순회 중단.');
      }
      break;
    }
    const detail = result.detail;
    const post = detail.post;
    posts.push(post);
    seenPostNos.add(String(post.post_no));

    if (settings.measureStartMs != null && post.created_at < settings.measureStartMs) {
      exhausted = true;
      logger.log(`[collector] 모달 순회: post_no=${post.post_no}가 측정 시작일 이전 - 종료.`);
      break;
    }

    if (inMeasureRange(post.created_at, settings) && (post.comment_count || 0) > 0) {
      await randomDelay(pacing);
      const result = await collectCommentsInOpenModal(win, interceptor, writer, post, { pacing, logger });
      commentResults.push(result);

      // "못 모은 것"과 "못 모았다는 사실을 아는 것"은 다르다(사용자 지적) — 사람이 이 파일
      // 하나만 보고 어느 글의 어느 댓글을 직접 확인해야 하는지 알 수 있도록, URL까지 같이
      // 구조화해서 남긴다. reason은 어느 신뢰도 단계(CLAUDE.md의 신뢰도 체계)에서 걸렸는지
      // 표시한다 — 사람이 우선순위를 판단할 때 tier가 낮을수록(숫자가 작을수록) 신뢰도가
      // 높으므로 먼저 봐야 한다.
      if (result.topLevelGap) {
        gaps.push({
          type: 'top-level',
          reason: 'retry-exhausted-vs-band-comment-count-field',
          reasonTier: 3,
          postNo: post.post_no,
          postAuthor: (post.author && post.author.name) || null,
          postWebUrl: post.web_url || null,
          expected: result.topLevelGap.expected,
          captured: result.topLevelGap.captured,
          missing: result.topLevelGap.expected - result.topLevelGap.captured,
        });
      }
      for (const r of result.repliesStatus) {
        if (r.complete) continue;
        gaps.push({
          type: 'reply',
          reason: 'parent-comment-count-field-mismatch',
          reasonTier: 3,
          postNo: post.post_no,
          postAuthor: (post.author && post.author.name) || null,
          postWebUrl: post.web_url || null,
          parentCommentId: r.parentCommentId,
          parentAuthor: r.parentAuthor,
          expected: r.expected,
          captured: r.captured,
          missing: r.expected - r.captured,
        });
      }
      if (result.displayedCountCheck && !result.displayedCountCheck.match) {
        gaps.push({
          type: 'displayed-count-mismatch',
          reason: 'post-modal-displayed-count-mismatch',
          reasonTier: 2,
          postNo: post.post_no,
          postAuthor: (post.author && post.author.name) || null,
          postWebUrl: post.web_url || null,
          expected: result.displayedCountCheck.displayedCount,
          captured: result.displayedCountCheck.capturedTotal,
          missing: result.displayedCountCheck.displayedCount - result.displayedCountCheck.capturedTotal,
        });
      }
    }

    // 다음(더 과거) 글로 넘기기 전에 먼저 리스너를 걸어둔다(클릭 후에 걸면 응답을 놓칠 수 있음).
    // 실기동으로 확인(2026-07-20): 밴드가 같은 post_no에 대해 get_post를 두 번 연속 호출하는
    // 경우가 있다 - 예전엔 처리 속도가 빨라 문제가 안 됐지만, collectCommentsInOpenModal이
    // 느려지면서(스크롤+답글 더보기+표시값 읽기 추가) 그 사이 남은 "같은 글의 중복 emit"이
    // 버퍼에서 "다음 글"로 잘못 소비돼 같은 post_no가 반복 처리되는 회귀가 발견됐다(post_no
    // 23,31,32,33,43,45,46,47,48에서 재현). §27-1: "직전 글 post_no만 제외"하는 1차 수정은
    // 부족했다(post_no 47/48이 번갈아 재등장 - 버퍼에 여러 post_no의 중복 emit이 동시에 남아
    // 서로를 오가며 재소비됨). bandId만 보던 predicate에 "이번 walk에서 이미 처리한 post_no
    // 전체 집합에 없어야 한다"는 조건으로 강화한다.
    pendingWait = waitForNextPostOrAnnouncement(interceptor, bandId, seenPostNos, perAttemptTimeout, `postDetail:after=${post.post_no}`);
    await randomDelay(pacing);
    const clicked = await clickNextPost(win);
    trace.record({ phase: 'clickNextPost', postNo: post.post_no, ...clicked });
    if (!clicked.ok) {
      if (clicked.reason === 'no-button') {
        exhausted = true;
        logger.log(`[collector] 모달 순회: post_no=${post.post_no} 이후 다음 글 버튼 없음(가장 오래된 글) - 종료.`);
      } else {
        logger.warn &&
          logger.warn(
            `[collector] post_no=${post.post_no}: 다음 글로 넘기기 실패(사유: ${clicked.reason}${
              clicked.message ? ' - ' + clicked.message : ''
            }) - 순회 중단.`
          );
        await shot(interceptor, `walk-next-fail-post-${post.post_no}`);
      }
      break;
    }
  }
  await shot(interceptor, 'walk-end');

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

  return { exhausted, posts, commentResults, gaps };
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
    await shot(interceptor, 'members-fail');
    return null;
  }
  if (event.hasMore) {
    logger.warn &&
      logger.warn('[collector] has_more_member=true — 멤버 페이지네이션 트리거가 recon에서 미확정. 첫 페이지만 수집됨.');
  }
  return event.members;
}

// ============================================================================
// 신뢰도 체계(CLAUDE.md) 2단계 교차검증 3번: 멤버별 댓글 수(사용자 지적, 2026-07-20).
// 전 과정 실기동으로 selector 확정 완료(m1-live-findings.md §26-5). 비용이 크므로(멤버 수만큼
// 페이지 이동+스크롤 반복) BSC_VERIFY_MEMBERS=1일 때만 실행한다(runBandCollection에서 게이팅).
//
// 실측으로 확인한 흐름과 selector:
// - 멤버 목록(`/band/<id>/member`)의 각 행: `li[data-viewname="DMemberListItemView"]` 안의
//   `a.uProfile._btnProfile`(아이콘, 클릭하면 미니 프로필 팝업) - 이름은 그 안 `img[alt]`.
// - 팝업의 "작성글 보기": `a.writePost._btnGotoSearchMemberContent`.
// - 클릭하면 URL이 `/band/<id>/member/<memberKey>/post`로 바뀐다(멤버 API 응답엔 이
//   memberKey가 없어서 미리 URL을 만들어 바로 이동할 수는 없다 - 그래서 아이콘 클릭이 필요).
// - "댓글" 탭: 클릭하면 URL이 `.../post` -> `.../comment`로 바뀐다. §27-3-1에서 텍스트 매칭
//   (`a.navItem` 중 "댓글")으로 클릭하던 방식이 UI 언어가 세션마다 바뀌어(영어 "Comment") 실패
//   하는 게 실측 확인돼, 텍스트/클릭 없이 `.../post` URL을 `.../comment`로 바꿔 직접
//   이동하는 방식으로 교체했다(readOneMemberCommentCount).
// - 총 댓글 수를 보여주는 별도 라벨/배지는 없다 - 페이지를 끝까지 스크롤한 뒤
//   `a.cCommentOnly` 요소 개수를 세는 것 자체가 정답이다(실측: 강민지 18개 = raw 데이터
//   집계 18개, 황인각 1개 = raw 데이터 집계 1개, 둘 다 정확히 일치 확인).
// ============================================================================

async function findMemberProfileLinks(win) {
  try {
    return await win.webContents.executeJavaScript(`
      (function () {
        var rows = Array.prototype.slice.call(document.querySelectorAll('li[data-viewname="DMemberListItemView"]'));
        return rows.map(function (li) {
          var btn = li.querySelector('a.uProfile._btnProfile') || li.querySelector('a._btnProfile');
          var img = li.querySelector('img[alt]');
          if (!btn) return null;
          var rect = btn.getBoundingClientRect();
          return {
            name: img ? img.getAttribute('alt') : null,
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
          };
        }).filter(function (v) { return v; });
      })();
    `);
  } catch (e) {
    return [];
  }
}

// §27-3-3(사용자 라이브 관찰로 확인된 버그): 멤버 목록은 DOM에 57명이 전부 있지만(가상스크롤
// 아님), getBoundingClientRect()는 "스크롤 안 된 상태" 기준 좌표를 반환한다 - 화면 맨 위
// 7명을 넘어가는 멤버는 y좌표가 뷰포트 밖(화면에 안 보이는 아래쪽)을 가리켜 realClickAt이
// 허공을 클릭하게 된다. findMemberProfileLinks처럼 한 번에 전부 좌표를 구해두는 대신, 매
// 멤버 처리 직전에 인덱스로 해당 li를 찾아 scrollIntoView로 뷰포트 안에 넣은 뒤 그 시점의
// 좌표를 다시 읽는다.
async function findMemberProfileLinkAt(win, index) {
  try {
    return await win.webContents.executeJavaScript(`
      (async function (idx) {
        var rows = Array.prototype.slice.call(document.querySelectorAll('li[data-viewname="DMemberListItemView"]'));
        var totalCount = rows.length;
        var li = rows[idx];
        if (!li) return { found: false, totalCount: totalCount };
        var btn = li.querySelector('a.uProfile._btnProfile') || li.querySelector('a._btnProfile');
        var img = li.querySelector('img[alt]');
        if (!btn) return { found: false, totalCount: totalCount };
        btn.scrollIntoView({ block: 'center' });
        // scrollIntoView는 비동기 렌더 업데이트라 좌표가 즉시 안정되지 않을 수 있어 잠깐
        // 기다린 뒤에 최종 좌표를 읽는다(findLoadMoreTarget과 동일 패턴, §20 참고).
        await new Promise(function (r) { setTimeout(r, 250); });
        var rect = btn.getBoundingClientRect();
        return {
          found: true,
          totalCount: totalCount,
          name: img ? img.getAttribute('alt') : null,
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
        };
      })(${index});
    `);
  } catch (e) {
    return { found: false, error: e.message };
  }
}

// 스크롤이 필요한 화면(멤버 댓글 목록)은 모달이 아니라 일반 페이지라 window 레벨 스크롤을
// 쓴다(scrollThroughModal의 모달-스코프 방식과 다름 - 실측으로 확인된 올바른 방식).
// contentSelector가 있으면 스크롤 위치뿐 아니라 그 selector에 해당하는 요소 개수도 안정돼야
// 종료한다(§27-5) - 클릭 직후 첫 배치가 아직 비동기로 로딩 중일 때 스크롤 위치만 보고 "끝났다"
// 오판해 조기 종료하는 것을 막기 위함.
async function scrollWindowToBottom(win, { trace, label, maxSteps = 40, deltaY = 1200, pauseMs = 350, contentSelector = null } = {}) {
  let prevScrollY = -1;
  let prevContentCount = -1;
  let stableStreak = 0;
  for (let step = 0; step < maxSteps; step++) {
    const state = await win.webContents.executeJavaScript(`
      (function () {
        return {
          scrollY: window.scrollY,
          scrollHeight: document.documentElement.scrollHeight,
          innerHeight: window.innerHeight,
          atBottom: window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 4,
          contentCount: ${contentSelector ? `document.querySelectorAll(${JSON.stringify(contentSelector)}).length` : 'null'},
        };
      })();
    `);
    if (!state) break;
    trace.record({ phase: 'scrollWindowToBottom', label, step, ...state });
    const positionStable = state.atBottom || state.scrollY === prevScrollY;
    const contentStable = contentSelector ? state.contentCount === prevContentCount : true;
    if (positionStable && contentStable) {
      stableStreak++;
      if (stableStreak >= 3) break;
    } else {
      stableStreak = 0;
    }
    prevScrollY = state.scrollY;
    prevContentCount = state.contentCount;
    win.webContents.sendInputEvent({ type: 'mouseWheel', x: 600, y: 450, deltaX: 0, deltaY: -deltaY, canScroll: true });
    await sleep(pauseMs);
  }
}

// 멤버 한 명의 프로필을 열고(아이콘 클릭) -> "작성글 보기" -> "댓글" 탭 -> 끝까지 스크롤 ->
// `a.cCommentOnly` 개수를 센다. 실패해도 예외를 던지지 않고 { found:false, ... }를 반환해
// 다음 멤버로 넘어갈 수 있게 한다(멤버 한 명 실패로 전체가 멈추면 안 됨).
async function readOneMemberCommentCount(win, memberLink, { trace, logger } = {}) {
  const result = { x: memberLink.x, y: memberLink.y, linkText: memberLink.name };
  const clickProfile = await realClickAt(win, memberLink.x, memberLink.y);
  trace.record({ phase: 'memberVerify:openProfile', ...result, ...clickProfile });

  // §27-3-1/2(사용자 라이브 관찰): 고정 sleep 대신 "작성글 보기" 버튼이 실제로 나타날 때까지
  // 폴링한다 - 프로필 패널이 아직 안 뜬 상태에서 다음 단계로 넘어가는 게 탭 전환 실패의
  // 원인일 가능성이 컸다.
  const viewPostsReady = await pollUntil(win, `!!document.querySelector('a.writePost._btnGotoSearchMemberContent')`);
  trace.record({ phase: 'memberVerify:waitViewPostsButton', ...viewPostsReady });
  if (!viewPostsReady.ok) return { ...result, found: false, stage: 'view-posts-button-not-found' };

  const viewPostsClick = await win.webContents.executeJavaScript(`
    (function () {
      var btn = document.querySelector('a.writePost._btnGotoSearchMemberContent');
      if (!btn) return { found: false };
      var r = btn.getBoundingClientRect();
      return { found: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })();
  `);
  trace.record({ phase: 'memberVerify:findViewPosts', ...viewPostsClick });
  if (!viewPostsClick.found) return { ...result, found: false, stage: 'view-posts-button-not-found' };
  const clickViewPosts = await realClickAt(win, viewPostsClick.x, viewPostsClick.y);
  trace.record({ phase: 'memberVerify:clickViewPosts', ...clickViewPosts });

  // "작성글 보기" 클릭 후 URL이 .../post로 바뀔 때까지 대기(§26-5에서 실측 확인된 전환).
  const postPageLoaded = await pollUntil(win, `window.location.href.indexOf('/post') !== -1`);
  trace.record({ phase: 'memberVerify:waitPostPage', ...postPageLoaded, url: win.webContents.getURL() });
  if (!postPageLoaded.ok) return { ...result, found: false, stage: 'post-page-not-loaded' };

  // §27-3-1(사용자 라이브 재확인): "댓글" 탭을 텍스트로 찾아 클릭하는 방식은 밴드 UI가
  // 세션마다 다른 언어(영어 "Comment"/한국어 "댓글")로 렌더링될 수 있어 깨진다(실측: 영어
  // UI에서 "Post" 탭에 계속 머무름 - 사용자가 스크린샷으로 확인).
  // 1차 시도(§27-5): 텍스트 매칭 대신 .../post URL을 .../comment로 바꿔 하드 네비게이션했더니
  // 탭 전환 자체는 57/57 성공했지만, 멤버별 대조에서 33명이 표시값 0 또는 정확히 20에서 멈추는
  // (실제 캡처값보다 훨씬 작은) 새로운 결손이 발견됐다 - 하드 리로드가 밴드 SPA의 무한스크롤
  // 로딩 초기화를 깨는 것으로 추정(사람이 실측 대조 CSV로 지적). 되돌려서, 텍스트 대신
  // **탭 순서가 항상 게시글/사진/댓글(Post/Photo/Comment) 고정 3개라는 사실**을 이용해
  // 마지막 `a.navItem`을 클릭한다 - 언어 무관하면서도 정상 SPA 클릭 네비게이션을 유지해
  // 무한스크롤이 깨지지 않는다.
  const commentTabReady = await pollUntil(win, `document.querySelectorAll('a.navItem').length >= 3`);
  trace.record({ phase: 'memberVerify:waitCommentTabReady', ...commentTabReady });
  if (!commentTabReady.ok) return { ...result, found: false, stage: 'comment-tab-not-found' };

  const commentTabClick = await win.webContents.executeJavaScript(`
    (function () {
      var items = Array.prototype.slice.call(document.querySelectorAll('a.navItem'));
      var tab = items[items.length - 1];
      if (!tab) return { found: false, candidateCount: items.length };
      var r = tab.getBoundingClientRect();
      return { found: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })();
  `);
  trace.record({ phase: 'memberVerify:findCommentTab', ...commentTabClick });
  if (!commentTabClick.found) return { ...result, found: false, stage: 'comment-tab-not-found' };
  const clickCommentTab = await realClickAt(win, commentTabClick.x, commentTabClick.y);
  trace.record({ phase: 'memberVerify:clickCommentTab', ...clickCommentTab });

  const commentPageLoaded = await pollUntil(win, `window.location.href.indexOf('/comment') !== -1`);
  trace.record({ phase: 'memberVerify:waitCommentPage', ...commentPageLoaded, url: win.webContents.getURL() });
  if (!commentPageLoaded.ok) return { ...result, found: false, stage: 'comment-page-not-loaded' };

  // §27-5: 클릭 직후 바로 스크롤하면 첫 배치 비동기 로딩이 끝나기 전에 "더 이상 안 늘어남"으로
  // 오판할 수 있다(하드 네비게이션 때는 이게 원인이 아니었지만, 방어적으로 콘텐츠 개수 안정성도
  // 같이 확인하도록 강화 - scrollWindowToBottom의 contentSelector 옵션).
  await scrollWindowToBottom(win, { trace, label: `member:${memberLink.name}`, contentSelector: 'a.cCommentOnly' });

  const countResult = await win.webContents.executeJavaScript(`
    (function () { return { count: document.querySelectorAll('a.cCommentOnly').length }; })();
  `);
  trace.record({ phase: 'memberVerify:readCount', postCount: countResult.count });

  return { ...result, found: true, commentCount: countResult.count };
}

// §27-3-3 재확인(사용자 라이브 관찰, 2026-07-20): 멤버 목록은 §26-5 기록과 달리 57명이 한
// 번에 렌더링되지 않고, 스크롤해야 더 로드되는 지연 로딩이었다(30번째 부근에서 "스크롤 한 번
// 터짐" - 사용자 실측). 목록 끝에 "멤버 초대" 같은 텍스트 요소가 있지만, UI 언어가 세션마다
// 바뀌는 게 이미 §27-3-1에서 확인됐으므로(사용자 지적: "여기서만 영어지 실사용은 한국어일
// 것") 텍스트로 끝을 판별하지 않는다. 대신 scrollWindowToBottom과 동일한 검증된 방식으로
// "스크롤해도 더 이상 행 수가 안 늘어남" = 끝에 도달했다고 판단한다(언어 무관).
async function ensureMemberRowCount(win, minCount, { trace, maxSteps = 60, deltaY = 1200, pauseMs = 350 } = {}) {
  let prevCount = -1;
  let stableStreak = 0;
  let count = 0;
  for (let step = 0; step < maxSteps; step++) {
    count = await win.webContents.executeJavaScript(`document.querySelectorAll('li[data-viewname="DMemberListItemView"]').length`);
    trace.record({ phase: 'memberVerify:ensureRowCount', step, count, minCount });
    if (count >= minCount) return { ok: true, count };
    if (count === prevCount) {
      stableStreak++;
      if (stableStreak >= 3) return { ok: false, count, reason: 'list-end-reached' };
    } else {
      stableStreak = 0;
    }
    prevCount = count;
    win.webContents.sendInputEvent({ type: 'mouseWheel', x: 600, y: 450, deltaX: 0, deltaY: -deltaY, canScroll: true });
    await sleep(pauseMs);
  }
  return { ok: count >= minCount, count, reason: 'max-steps-reached' };
}

// 성공적으로 댓글 수를 읽은 뒤, 다음 멤버를 위해 목록으로 복귀한다. §27-6(사용자 제안):
// 매번 memberUrl을 새로 열면(safeLoadURL) 스크롤이 초기화돼 처음부터 다시 스크롤해야 했다
// (§27-3-3의 근본 원인). 대신 브라우저 히스토리를 뒤로 두 번(comment->post->list) 이동하면
// 같은 페이지 인스턴스로 돌아가 스크롤 위치가 보존된다 - 재스크롤이 필요 없다.
async function goBackToMemberList(win, { trace }) {
  win.webContents.goBack();
  const step1 = await pollUntil(win, `window.location.href.indexOf('/comment') === -1`);
  trace.record({ phase: 'memberVerify:goBack1', ...step1, url: win.webContents.getURL() });
  win.webContents.goBack();
  const step2 = await pollUntil(win, `/\\/member\\/?(?:[?#].*)?$/.test(window.location.href)`);
  trace.record({ phase: 'memberVerify:goBack2', ...step2, url: win.webContents.getURL() });
  return step2.ok;
}

// bandId 페이지가 아니라 이미 로드된 멤버 목록 화면을 기준으로 순회한다(호출자가
// safeLoadURL로 /band/<id>/member를 먼저 열어둬야 함). members는 collectMembers()가 이미
// API로 확보한 목록 - 이름/user_no를 결과에 붙이는 데만 쓰고, 실제 순회는 화면의 링크
// 순서(findMemberProfileLinks)를 따른다.
//
// §27-6(사용자 제안, 2026-07-20): 이전 버전은 매 멤버마다 memberUrl을 새로 열고 그 인덱스까지
// 처음부터 다시 스크롤했다 - 느리고, §27-3-3(지연 로딩)을 매번 다시 겪어야 했으며, 재로드
// 직후 클릭이 씹히는 것으로 보이는 실패("작성글 보기 버튼 못 찾음")도 관찰됐다. 대신 목록을
// 딱 한 번만 끝까지 스크롤해 전체 좌표를 확보하고, 각 멤버 처리 후에는 페이지를 새로 열지
// 않고 히스토리 뒤로가기로 복귀한다(goBackToMemberList) - 스크롤 위치가 보존되므로 저장해둔
// 좌표를 그대로 재사용할 수 있다. 실패해서 어느 단계까지 진행했는지 불확실할 때만 안전하게
// memberUrl을 다시 열고 재스크롤한다.
async function collectPerMemberCommentCounts(win, members, { pacing, logger, trace }) {
  const limit = members && members.length ? members.length : 0;
  if (limit === 0) {
    logger.warn && logger.warn('[collector] 멤버별 댓글 수 교차검증: API로 확보한 멤버 목록이 비어있어 건너뜀.');
    return [];
  }

  const bandUrl = win.webContents.getURL().split('/member')[0];
  const memberUrl = `${bandUrl}/member`;

  // §27-6 실측 정정: 뒤로가기(goBack)로 목록 URL엔 정상 복귀하지만, 목록 DOM은 그대로
  // 남아있지 않고 0개로 리셋돼 다시 렌더링된다(SPA가 뒤로가기 시 목록 컴포넌트를 재마운트하는
  // 것으로 보임) - "한 번만 스크롤해두면 된다"는 전제가 틀렸다. 그래도 goBack은 네트워크
  // 왕복이 없는 만큼 safeLoadURL 재로드보다 가볍고, 재로드 직후 클릭이 씹히는 것으로 보이는
  // 실패도 줄어들 여지가 있어 유지한다 - 대신 매 인덱스 처리 직전에 그 인덱스까지만
  // ensureMemberRowCount로 다시 채운다(어차피 이미 채워져 있으면 즉시 반환되므로 비용 없음).
  const results = [];
  for (let i = 0; i < limit; i++) {
    const rowsReady = await ensureMemberRowCount(win, i + 1, { trace });
    trace.record({ phase: 'memberVerify:waitRowReady', index: i, ...rowsReady });
    if (!rowsReady.ok && rowsReady.reason === 'list-end-reached') {
      logger.warn &&
        logger.warn(`[collector] 멤버별 댓글 수 교차검증: index=${i}에서 목록 끝(${rowsReady.count}명)에 도달 - 순회 종료.`);
      break;
    }
    const link = await findMemberProfileLinkAt(win, i);
    if (!link.found) {
      logger.warn && logger.warn(`[collector] 멤버별 댓글 수 교차검증: index=${i} 링크를 못 찾음 - 건너뜀.`);
      continue;
    }
    const r = await readOneMemberCommentCount(win, link, { trace, logger });
    const apiMember = members && members[i] ? members[i] : null;
    results.push({
      index: i,
      memberName: (apiMember && apiMember.name) || link.name || null,
      userNo: (apiMember && apiMember.user_no) || null,
      ...r,
    });

    if (r.found) {
      const backOk = await goBackToMemberList(win, { trace });
      if (!backOk) {
        logger.warn && logger.warn(`[collector] 멤버별 댓글 수 교차검증: "${link.name}" 이후 목록 복귀 실패 - 새로 엽니다.`);
        await safeLoadURL(win, memberUrl, logger);
        await randomDelay(pacing);
      }
    } else {
      logger.warn &&
        logger.warn(`[collector] 멤버별 댓글 수 교차검증: "${link.name}" 실패(단계: ${r.stage || '?'}) - 목록을 새로 엽니다.`);
      await safeLoadURL(win, memberUrl, logger);
      await randomDelay(pacing);
    }
    await randomDelay(pacing);
  }
  const successCount = results.filter((r) => r.found).length;
  logger.log(`[collector] 멤버별 댓글 수 교차검증 완료: ${successCount}/${limit}명 확보.`);
  return results;
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

  // 신뢰도 체계(CLAUDE.md) 2단계 교차검증: .btnNextPost 반복으로 얻은 총 게시글 수를, 피드를
  // 실제로 끝까지 스크롤해서 센 카드 개수와 대조한다. 가장 오래된 글까지 순회가 끝난
  // 경우(feedExhausted)에만 의미 있는 비교다 — 도중에 중단됐으면 당연히 적을 수 있으므로
  // 결손으로 취급하지 않는다.
  const trace = (interceptor.trace && interceptor.trace.record) ? interceptor.trace : { record: () => {} };
  await randomDelay(pacing);
  const feedCount = await countTotalPostsViaFeedScroll(win, { trace });
  logger.log(
    `[collector] 피드 스크롤 기반 전체 게시글 수(교차검증): ${feedCount.counted}건(원본 카드 ${feedCount.total}건, 공지/숨김 제외) vs 순회 확인 ${walkResult.posts.length}건`
  );
  if (walkResult.exhausted && feedCount.counted > 0 && feedCount.counted !== walkResult.posts.length) {
    walkResult.gaps.push({
      type: 'total-post-count-mismatch',
      reason: 'feed-scroll-card-count-mismatch',
      reasonTier: 2,
      postNo: null,
      postAuthor: null,
      postWebUrl: feedUrl,
      expected: feedCount.counted,
      captured: walkResult.posts.length,
      missing: feedCount.counted - walkResult.posts.length,
    });
  }

  await randomDelay(pacing);
  const members = await collectMembers(win, interceptor, band.bandId, { logger });
  if (members) writer.writeMembersSnapshot(members);

  // 신뢰도 체계 2단계 교차검증 3번(멤버별 댓글 수) - 멤버 수만큼 클릭+스크롤을 반복해 비용이
  // 크고 selector도 아직 실기동 미검증이라, 명시적으로 요청했을 때만(BSC_VERIFY_MEMBERS=1) 켠다.
  if (process.env.BSC_VERIFY_MEMBERS === '1' && members && members.length > 0) {
    logger.log('[collector] BSC_VERIFY_MEMBERS=1 - 멤버별 댓글 수 교차검증을 시작합니다(멤버 수만큼 시간이 걸립니다).');
    const memberUrl = `https://www.band.us/band/${band.bandId}/member`;
    try {
      await safeLoadURL(win, memberUrl, logger);
      await randomDelay(pacing);
      const memberCounts = await collectPerMemberCommentCounts(win, members, { pacing, logger, trace });
      writer.writeMemberCommentCounts(memberCounts);
    } catch (e) {
      logger.warn && logger.warn(`[collector] 멤버별 댓글 수 교차검증 중 오류(건너뜀): ${e.message}`);
    }
  }

  const status = {
    feedExhausted: walkResult.exhausted,
    totalPosts: walkResult.posts.length,
    postsInRange: inRangePosts.length,
    postsNeedingComments: postsNeedingComments.length,
    postsCommentsAttempted: walkResult.commentResults.length,
    postsCommentsComplete: walkResult.commentResults.filter((r) => r.topLevelDone).length,
    postsCommentsIncomplete: walkResult.commentResults.filter((r) => !r.topLevelDone).map((r) => r.postNo),
    postsRepliesIncomplete: walkResult.commentResults
      .filter((r) => r.repliesStatus.some((x) => !x.complete))
      .map((r) => r.postNo),
    incompleteGapsCount: walkResult.gaps.length,
    memberCount: members ? members.length : null,
    completedAtMs: Date.now(),
  };
  writer.writeCollectionStatus(status);
  const gapsFile = writer.writeIncompleteGaps(walkResult.gaps);
  logger.log(`[collector] 밴드 ${band.bandId}(${band.name}) 수집 상태:`, status);
  // "몰랐던 실패"를 없애는 게 핵심이라(사용자 지적, 2026-07-20), 결손이 하나라도 있으면
  // 일반 INFO 로그에 묻히지 않도록 별도 WARN으로 파일 경로까지 명시해 남긴다.
  if (walkResult.gaps.length > 0) {
    logger.warn &&
      logger.warn(
        `[collector] [경고] 알려진 결손 ${walkResult.gaps.length}건 - 사람이 직접 확인/수동 입력 필요: ${gapsFile}`
      );
  } else {
    logger.log(`[collector] 알려진 결손 0건 — 이번 실행 기준 데이터 완전성 확인됨.`);
  }
  return status;
}

module.exports = {
  runBandCollection,
  waitForLogin,
  walkPostsViaModal,
  collectCommentsInOpenModal,
  collectMembers,
  collectPerMemberCommentCounts,
  findMemberProfileLinks,
  findMemberProfileLinkAt,
  ensureMemberRowCount,
  goBackToMemberList,
  readOneMemberCommentCount,
  countTotalPostsViaFeedScroll,
  inMeasureRange,
  randomDelay,
};
