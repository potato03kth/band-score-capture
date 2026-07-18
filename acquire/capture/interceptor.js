const { EventEmitter } = require('events');
const endpoints = require('./endpoints');

function isAuthError(json) {
  const msg = (json && json.result_data && json.result_data.message) || json?.message;
  return typeof msg === 'string' && msg.includes('권한이 없습니다');
}

// CDP 캡처(acquire/capture/cdp-capture.js)가 넘긴 {url, method, status, bodyText}를 받아 엔드포인트별로 파싱하고
// writer(원천 적재)에 넘긴 뒤, collector가 페이지네이션 판단에 쓸 이벤트를 방출한다.
// CDP 캡처가 워낙 빨라서(수백 ms 내 응답), collector가 클릭 등으로 요청을 유발한 뒤
// randomDelay 같은 페이싱 지연을 거치고 나서야 waitForEvent로 듣기 시작하면, 이벤트가
// 이미 지나간 뒤라 영영 놓친다(실기동 확인 — 댓글 최상위 페이지가 100% 이렇게 유실됐음).
// 최근 이벤트를 짧게 버퍼링해뒀다가 늦게 건 리스너도 찾아갈 수 있게 한다.
const RECENT_LIMIT = 200;
// 대댓글은 모달을 여는 시점에 한꺼번에 자동 로드되지만, collector는 최상위 댓글 페이지네이션을
// 다 끝낸 뒤에야 대댓글을 기다리기 시작한다(페이지가 여러 장이면 그 사이 페이싱 지연이 누적돼
// 수십 초가 걸릴 수 있음) — 넉넉하게 60초로 잡는다.
const RECENT_MAX_AGE_MS = 60000;

const noopTracer = { enabled: false, record: () => {} };

function createInterceptor({ writer, bandId, logger = console, tracer = null }) {
  const trace = tracer || noopTracer;
  const bus = new EventEmitter();
  const recent = [];

  // 모든 emit을 요약 필드로 트레이스에 남긴다(m1-live-findings.md §12-3 — 버그 A: interceptor는
  // emit했는데 collector의 waitForEvent가 못 받는 케이스를 재기동 없이 사후 분석하려면, emit
  // 시점 자체의 전체 감사 기록이 있어야 waitForEvent-start/resolved 트레이스와 시간순으로
  // 맞춰볼 수 있다). previousParams는 null 여부만(=완결 여부) 남기고 전체 객체는 생략한다.
  function emit(eventName, payload) {
    recent.push({ eventName, payload, consumed: false, tsMs: Date.now() });
    if (recent.length > RECENT_LIMIT) recent.shift();
    trace.record({
      phase: 'emit',
      eventName,
      postNo: payload && payload.postNo,
      contentType: payload && payload.contentType,
      parentCommentId: payload && payload.parentCommentId,
      count: payload && payload.count,
      total: payload && payload.total,
      previousParamsIsNull: payload && payload.previousParams !== undefined ? payload.previousParams === null : undefined,
      url: payload && payload.url,
    });
    bus.emit(eventName, payload);
  }

  // 아직 아무도 못 가져간(consumed:false) 최근 이벤트 중 predicate에 맞는 걸 찾아 소비한다.
  // 찾으면 그 이벤트를 이 호출이 "가져간" 것으로 표시해, 같은 이벤트가 나중의 다른
  // waitForEvent 호출에 중복으로 잡히지 않게 한다.
  // label은 트레이스 표기용(예: "commentPage:postNo=48:attempt=0") — 매칭 로직에는 안 쓰인다.
  // 매치 실패 시에도 같은 eventName의 미소비 항목이 버퍼에 몇 개나 있는지 남겨서, "아직 안
  // 왔음"(sameEventUnconsumedCount=0)과 "왔는데 predicate가 거부함"(>0)을 구분할 수 있게 한다.
  function takeRecent(eventName, predicate, label) {
    const now = Date.now();
    let match = null;
    for (const rec of recent) {
      if (rec.consumed || rec.eventName !== eventName) continue;
      if (now - rec.tsMs > RECENT_MAX_AGE_MS) continue;
      if (predicate && !predicate(rec.payload)) continue;
      rec.consumed = true;
      match = rec.payload;
      break;
    }
    const sameEvent = recent.filter((r) => r.eventName === eventName);
    trace.record({
      phase: 'takeRecent',
      eventName,
      label,
      matched: !!match,
      bufferSize: recent.length,
      sameEventCount: sameEvent.length,
      sameEventUnconsumedCount: sameEvent.filter((r) => !r.consumed).length,
      oldestSameEventAgeMs: sameEvent.length ? now - sameEvent[0].tsMs : null,
      newestSameEventAgeMs: sameEvent.length ? now - sameEvent[sameEvent.length - 1].tsMs : null,
    });
    return match;
  }

  function handleCapture({ url, bodyText }) {
    if (!endpoints.isDataHost(url)) return;
    const kind = endpoints.classifyUrl(url);
    if (!kind) {
      // BSC_DEBUG_UNCLASSIFIED=1일 때만: 분류 안 되는 data-host 호출이 뭘 나르는지 보는 진단용 로그
      // (m1-live-findings.md §2-4에서 부트스트랩 노이즈 목록을 이미 확인했으니 평소엔 꺼둔다).
      if (process.env.BSC_DEBUG_UNCLASSIFIED === '1') {
        const snippet = (bodyText || '').slice(0, 600);
        logger.log &&
          logger.log(`[interceptor:DEBUG] 미분류 data-host 호출: ${url} (bodyLen=${(bodyText || '').length}) snippet=${snippet}`);
      }
      return;
    }

    if (!bodyText) {
      // data-host URL은 CORS preflight(OPTIONS)에도 걸리는데 그 응답은 항상 빈 바디다 —
      // 정상 동작이니 조용히 넘긴다(실기동에서 확인: 실제 데이터는 뒤이은 두 번째 캡처로 온다).
      return;
    }

    let json;
    try {
      json = JSON.parse(bodyText);
    } catch {
      const len = bodyText.length;
      const snippet = bodyText.slice(0, 300);
      logger.warn && logger.warn(`[interceptor] JSON 파싱 실패: ${url} (len=${len}) snippet=${JSON.stringify(snippet)}`);
      return;
    }

    if (isAuthError(json)) {
      emit('authError', { url, json });
      return;
    }

    const data = json.result_data;
    if (!data) return;

    emit('authOk', { url });

    if (kind === 'feedList') handleFeedList(url, data);
    else if (kind === 'postDetail') handlePostDetail(url, data);
    else if (kind === 'commentList') handleCommentList(url, data);
    else if (kind === 'memberList') handleMemberList(url, data);
  }

  function handleFeedList(url, data) {
    const items = Array.isArray(data.items) ? data.items : [];
    const posts = [];
    for (const it of items) {
      const post = it && it.post ? it.post : it;
      if (!post || post.post_no == null) continue;
      const { isNew } = writer.writePost(post, { sourceUrl: url });
      posts.push({ post, isNew });
    }
    emit('feedPage', {
      bandId,
      url,
      count: posts.length,
      posts,
      nextParams: data.paging ? data.paging.next_params : undefined,
    });
  }

  function handlePostDetail(url, data) {
    const post = data.post || data;
    if (!post || post.post_no == null) return;
    const { isNew } = writer.writePost(post, { sourceUrl: url });
    emit('postDetail', { bandId, url, post, isNew });
  }

  function handleCommentList(url, data) {
    const contentKey = endpoints.parseContentKey(url);
    const contentType = contentKey ? contentKey.content_type : 'post';
    const postNo = contentKey ? contentKey.post_no : undefined;
    const parentCommentId = contentType === 'comment' ? contentKey.comment_id : null;

    const items = Array.isArray(data.items) ? data.items : [];
    const comments = [];
    let writeNewCount = 0;
    let writeDupCount = 0;
    for (const c of items) {
      if (!c || c.comment_id == null) continue;
      const { isNew } = writer.writeComment(c, { contentType, parentCommentId, postNo, sourceUrl: url });
      comments.push({ comment: c, isNew });
      if (isNew) writeNewCount++;
      else writeDupCount++;

      // 최상위 댓글(content_type:"post") 응답에는 각 댓글의 최근 답글이 latest_comment 배열로
      // 같이 딸려온다(실기동에서 발견 — 클릭/추가 요청 없이도 이만큼은 항상 확보된다). comment_count가
      // latest_comment 길이보다 크면 그게 이 댓글의 답글 전체는 아니라는 뜻이니, 나머지는 여전히
      // 클릭 기반 페이지네이션(collector.js clickReplyToggles)으로 채워야 한다.
      if (contentType === 'post' && Array.isArray(c.latest_comment)) {
        for (const r of c.latest_comment) {
          if (!r || r.comment_id == null) continue;
          writer.writeComment(r, {
            contentType: 'comment',
            parentCommentId: c.comment_id,
            postNo,
            sourceUrl: url,
          });
        }
      }
    }
    // writer.writeComment의 isNew 여부를 요약해 남긴다(2026-07-17 dedup 키 수정 검증용 —
    // 최상위 댓글이 postNo 없이 comment_id만으로 dedup되던 버그를 고쳤으니, 이 재기동에서
    // writeNewCount가 0이 아니어야 실제로 고쳐졌다는 뜻이다).
    trace.record({ phase: 'writeComment-summary', postNo, contentType, parentCommentId, writeNewCount, writeDupCount });
    // total/previousParams는 emit()의 공용 트레이스(phase:'emit')가 이미 남긴다 — 여기서
    // 따로 또 남기지 않는다(m1-live-findings.md §12-2에서 total은 완결 신호로 못 믿는다는 게
    // 확인됐고, 실제 완결 판단은 previousParamsIsNull만 본다).
    emit('commentPage', {
      bandId,
      url,
      contentType,
      postNo,
      parentCommentId,
      count: comments.length,
      comments,
      total: data.total,
      previousParams: data.paging ? data.paging.previous_params : undefined,
    });
  }

  function handleMemberList(url, data) {
    const members = Array.isArray(data.members) ? data.members : [];
    emit('memberPage', {
      bandId,
      url,
      members,
      memberCount: data.member_count,
      hasMore: data.has_more_member,
    });
  }

  return {
    handleCapture,
    takeRecent,
    trace,
    on: bus.on.bind(bus),
    once: bus.once.bind(bus),
    off: bus.off.bind(bus),
  };
}

module.exports = { createInterceptor };
