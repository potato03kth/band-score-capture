// raw ndjson(acquire/writer.js가 쌓은 것) → 정규화된 게시글 맵 + 활동 레코드 목록.
// 규칙9: 게시글은 created_at(최초 작성일) 기준. 규칙 판정(과제글 등)은 rules.js가 담당하고,
// 여기서는 raw 파일 구조를 읽어 순수 데이터로만 바꾼다(판단 없음).

const fs = require('fs');
const path = require('path');

function listDateDirs(bandDir) {
  if (!fs.existsSync(bandDir)) return [];
  return fs
    .readdirSync(bandDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
    .map((e) => e.name);
}

// posts: Map<post_no(string), postData>
// activities: [{ bandId, userNo, authorName, createdAtMs, kind:'post'|'comment', postNo, commentId, parentCommentId, textPreview }]
function parseBandRaw(rawDir, bandId) {
  const bandDir = path.join(rawDir, String(bandId));
  const posts = new Map();
  const activities = [];

  for (const dateDir of listDateDirs(bandDir)) {
    const file = path.join(bandDir, dateDir, 'items.ndjson');
    if (!fs.existsSync(file)) continue;
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue; // 손상된 라인은 건너뜀(append-only, 수기 편집 안 함이 전제)
      }
      if (rec.schemaType === 'post') {
        posts.set(String(rec.data.post_no), rec.data);
      } else if (rec.schemaType === 'comment') {
        const c = rec.data;
        if (!c.author || c.author.user_no == null) continue;
        activities.push({
          bandId: String(bandId),
          userNo: c.author.user_no,
          authorName: c.author.name,
          createdAtMs: c.created_at,
          kind: 'comment',
          postNo: String(c.post_no),
          commentId: c.comment_id,
          parentCommentId: rec.parentCommentId,
          textPreview: (c.body || '').slice(0, 60),
        });
      }
    }
  }

  // 게시글 작성 자체도 활동이다(R1: 학생이 쓴 게시글 자체도 규칙3의 "게시글 또는 댓글"에 포함).
  for (const [postNo, p] of posts) {
    if (!p.author || p.author.user_no == null) continue;
    activities.push({
      bandId: String(bandId),
      userNo: p.author.user_no,
      authorName: p.author.name,
      createdAtMs: p.created_at,
      kind: 'post',
      postNo,
      commentId: null,
      parentCommentId: null,
      textPreview: (p.content || '').slice(0, 60),
    });
  }

  return { posts, activities };
}

// 가장 최근 멤버 스냅샷(_members/members_<ts>.json) 하나를 읽는다.
function loadLatestMemberSnapshot(rawDir, bandId) {
  const dir = path.join(rawDir, String(bandId), '_members');
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^members_\d+\.json$/.test(f))
    .sort();
  if (files.length === 0) return null;
  const latest = files[files.length - 1];
  return JSON.parse(fs.readFileSync(path.join(dir, latest), 'utf8'));
}

module.exports = { parseBandRaw, loadLatestMemberSnapshot, listDateDirs };
