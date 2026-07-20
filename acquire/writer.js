const fs = require('fs');
const path = require('path');

function kstDateStr(ms) {
  const d = new Date(ms + 9 * 3600 * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// 실기동으로 확인(2026-07-17): 최상위 댓글(content_type:"post")의 comment_id는 전역 유일이
// *아니다* — 서로 다른 글의 댓글이 같은 comment_id를 가질 수 있다(예: post_no=8의 실제
// comment_id=2와 post_no=27의 실제 comment_id=2는 완전히 다른 댓글인데 값만 겹침). comment_id만
// 으로 dedup하면 나중에 처리되는 글의 댓글이 먼저 그 번호를 차지한 다른 글의 댓글에 가려
// 조용히 유실된다 — 이게 "댓글이 트레이스에는 잡히는데 raw 파일엔 안 남는다"던 버그의 실제
// 원인이었다. 그래서 최상위 댓글도 postNo를 합쳐 키를 만든다.
// 답글(대댓글)의 comment_id는 부모 스레드마다 로컬 번호로 다시 시작하는데(그런 전역 필드가
// 없음), parentCommentId 자체도 최상위 댓글의 comment_id라 위와 같은 이유로 글마다 겹칠 수
// 있다 — 그래서 답글도 postNo까지 합쳐야 서로 다른 글의 답글 스레드가 우연히 같은
// (parentCommentId, commentId) 조합을 가질 때 서로를 가리는 걸 막을 수 있다.
function commentDedupKey(contentType, parentCommentId, commentId, postNo) {
  if (contentType === 'comment' && parentCommentId != null) {
    return `r:${postNo}:${parentCommentId}:${commentId}`;
  }
  return `p:${postNo}:${commentId}`;
}

function ensureDirSync(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function listDateDirs(bandDir) {
  if (!fs.existsSync(bandDir)) return [];
  return fs
    .readdirSync(bandDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
    .map((e) => e.name);
}

// data/raw/<bandId>/<YYYY-MM-DD(KST, 콘텐츠 created_at 기준)>/items.ndjson — append-only.
// dedup은 post_no/comment_id 기준(recon-findings §R-1). 재실행 시 기존 파일을 스캔해
// 인메모리 인덱스를 재구성하므로 여러 번 실행해도 중복 라인이 쌓이지 않는다(P6 멱등 요구).
function createWriter({ rawDir, bandId }) {
  const bandDir = path.join(rawDir, String(bandId));
  ensureDirSync(bandDir);

  const dedupPosts = new Set();
  const dedupComments = new Set();
  const commentsByPost = new Map(); // post_no -> Set(comment_id)  (최상위 댓글, content_type "post")
  const repliesByParent = new Map(); // "postNo:parentCommentId" -> Set(comment_id) (대댓글, content_type "comment")
  const postCommentCount = new Map(); // post_no -> comment_count(피드/상세 응답에 실린 총계)

  function indexRecord(rec) {
    if (rec.schemaType === 'post') {
      dedupPosts.add(String(rec.data.post_no));
      if (typeof rec.data.comment_count === 'number') {
        postCommentCount.set(String(rec.data.post_no), rec.data.comment_count);
      }
    } else if (rec.schemaType === 'comment') {
      dedupComments.add(commentDedupKey(rec.contentType, rec.parentCommentId, rec.data.comment_id, rec.data.post_no));
      if (rec.contentType === 'comment' && rec.parentCommentId != null) {
        const parentKey = `${rec.data.post_no}:${rec.parentCommentId}`;
        const set = repliesByParent.get(parentKey) || new Set();
        set.add(String(rec.data.comment_id));
        repliesByParent.set(parentKey, set);
      } else {
        const set = commentsByPost.get(String(rec.data.post_no)) || new Set();
        set.add(String(rec.data.comment_id));
        commentsByPost.set(String(rec.data.post_no), set);
      }
    }
  }

  for (const dateDir of listDateDirs(bandDir)) {
    const file = path.join(bandDir, dateDir, 'items.ndjson');
    if (!fs.existsSync(file)) continue;
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        indexRecord(JSON.parse(line));
      } catch {
        // 손상된 라인은 건너뛴다(append-only 파일은 손으로 편집하지 않는 것이 전제)
      }
    }
  }

  function appendLine(ms, record) {
    const dir = path.join(bandDir, kstDateStr(ms));
    ensureDirSync(dir);
    fs.appendFileSync(path.join(dir, 'items.ndjson'), JSON.stringify(record) + '\n', 'utf8');
  }

  function writePost(post, meta = {}) {
    const key = String(post.post_no);
    if (dedupPosts.has(key)) return { isNew: false };
    const record = {
      schemaType: 'post',
      capturedAtMs: Date.now(),
      sourceUrl: meta.sourceUrl || null,
      bandId: String(bandId),
      data: post,
    };
    appendLine(post.created_at, record);
    indexRecord(record);
    return { isNew: true };
  }

  function writeComment(comment, meta = {}) {
    const { contentType, parentCommentId, postNo, sourceUrl } = meta;
    const effectivePostNo = comment.post_no != null ? comment.post_no : postNo;
    const key = commentDedupKey(contentType, parentCommentId, comment.comment_id, effectivePostNo);
    if (dedupComments.has(key)) return { isNew: false };
    const record = {
      schemaType: 'comment',
      capturedAtMs: Date.now(),
      sourceUrl: sourceUrl || null,
      bandId: String(bandId),
      contentType: contentType || 'post', // "post" = 최상위 댓글, "comment" = 대댓글
      parentCommentId: parentCommentId != null ? String(parentCommentId) : null,
      data: { ...comment, post_no: effectivePostNo },
    };
    appendLine(comment.created_at, record);
    indexRecord(record);
    return { isNew: true };
  }

  function writeMembersSnapshot(members) {
    const ts = Date.now();
    const dir = path.join(bandDir, '_members');
    ensureDirSync(dir);
    const file = path.join(dir, `members_${ts}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify({ bandId: String(bandId), capturedAtMs: ts, members }, null, 2),
      'utf8'
    );
    return file;
  }

  function writeCollectionStatus(status) {
    const file = path.join(bandDir, 'collection_status.json');
    fs.writeFileSync(
      file,
      JSON.stringify({ bandId: String(bandId), updatedAtMs: Date.now(), ...status }, null, 2),
      'utf8'
    );
    return file;
  }

  // "수집 못 했다는 사실을 모르는 것"이 진짜 실패라는 원칙(사용자 지적, 2026-07-20) — 매 실행마다
  // 그 시점 기준 알려진 결손 전체를 덮어써서 남긴다(append가 아님 — 다음 실행에서 고쳐지면
  // 이 파일에서도 사라져야 "아직도 안 고쳐진 것"과 "이미 고쳐진 것"을 혼동하지 않는다).
  // scripts/list_incomplete_gaps.js가 이 파일을 읽어 사람이 수동으로 확인할 체크리스트를 뽑는다.
  function writeIncompleteGaps(gaps) {
    const file = path.join(bandDir, 'incomplete_gaps.json');
    fs.writeFileSync(
      file,
      JSON.stringify({ bandId: String(bandId), updatedAtMs: Date.now(), count: gaps.length, gaps }, null, 2),
      'utf8'
    );
    return file;
  }

  // 신뢰도 체계(CLAUDE.md) 2단계 교차검증 3번(멤버별 댓글 수, BSC_VERIFY_MEMBERS=1일 때만
  // 채워짐) 결과를 저장한다. writeMembersSnapshot(API로 받은 멤버 목록)과는 별개 파일 -
  // 이건 "화면에 표시된 멤버별 댓글 수" 스냅샷이다.
  function writeMemberCommentCounts(results) {
    const ts = Date.now();
    const dir = path.join(bandDir, '_members');
    ensureDirSync(dir);
    const file = path.join(dir, `member_comment_counts_${ts}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify({ bandId: String(bandId), capturedAtMs: ts, results }, null, 2),
      'utf8'
    );
    return file;
  }

  return {
    bandDir,
    writePost,
    writeComment,
    writeMembersSnapshot,
    writeMemberCommentCounts,
    writeCollectionStatus,
    writeIncompleteGaps,
    hasPost: (postNo) => dedupPosts.has(String(postNo)),
    hasComment: (postNo, commentId) => dedupComments.has(`p:${postNo}:${commentId}`),
    getTopCommentCount: (postNo) => (commentsByPost.get(String(postNo)) || new Set()).size,
    getReplyCount: (postNo, parentCommentId) => (repliesByParent.get(`${postNo}:${parentCommentId}`) || new Set()).size,
    getExpectedCommentCount: (postNo) => postCommentCount.get(String(postNo)),
  };
}

module.exports = { createWriter, kstDateStr };
