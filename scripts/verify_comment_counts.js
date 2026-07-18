// M1 acquire 완료 후 데이터 완전성 검증용 스크립트(doc/m1-live-findings.md §22 참고).
// data/raw/<bandId>/*/items.ndjson을 전부 읽어 post_no별로 실제 캡처된 댓글 수(최상위+답글)를
// 집계해 CSV로 뽑는다. 사용자가 브라우저에서 직접 센 댓글 개수와 이 CSV를 나란히 놓고
// 비교하기 위함 — band 자체의 comment_count/total 필드는 이미 신뢰 불가로 확인됐으므로
// (m1-live-findings.md §12-2/§20-1) 참고용으로만 같이 출력한다.
//
// 사용법: node scripts/verify_comment_counts.js [bandId]
//   기본 bandId=103239777(3분반). data/raw/<bandId>/에서 모든 날짜 폴더를 읽는다.
// 출력: out/verify/captured_comment_counts_<bandId>.csv (post_no, author, created_at_kst,
//   band_comment_count, captured_top_level, captured_replies, captured_total, manual_count,
//   diff) — manual_count/diff는 사용자가 직접 채워 넣을 빈 칸이다.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const bandId = process.argv[2] || '103239777';
const rawBandDir = path.join(ROOT, 'data', 'raw', String(bandId));
const outDir = path.join(ROOT, 'out', 'verify');
const outFile = path.join(outDir, `captured_comment_counts_${bandId}.csv`);

function kstDateStr(ms) {
  const d = new Date(ms + 9 * 3600 * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function listDateDirs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
    .map((e) => e.name);
}

function readAllRecords() {
  const records = [];
  for (const dateDir of listDateDirs(rawBandDir)) {
    const file = path.join(rawBandDir, dateDir, 'items.ndjson');
    if (!fs.existsSync(file)) continue;
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        records.push(JSON.parse(line));
      } catch {
        // 손상된 라인은 건너뜀
      }
    }
  }
  return records;
}

function main() {
  const records = readAllRecords();

  const posts = new Map(); // post_no -> {author, createdAtMs, commentCountField}
  const topLevelByPost = new Map(); // post_no -> Set(comment_id)
  const repliesByPost = new Map(); // post_no -> Set(parentCommentId:comment_id)

  for (const rec of records) {
    if (rec.schemaType === 'post') {
      const postNo = String(rec.data.post_no);
      posts.set(postNo, {
        author: (rec.data.author && rec.data.author.name) || '',
        createdAtMs: rec.data.created_at,
        commentCountField: rec.data.comment_count,
      });
    } else if (rec.schemaType === 'comment') {
      // 실기동으로 확인(2026-07-17): comment_id는 글마다 전역 유일하지 않다(다른 글의 댓글이
      // 같은 comment_id를 가질 수 있음 — writer.js의 dedup 버그와 동일 원인). parentCommentId만
      // 으로 역매핑하면 여기서도 같은 충돌이 나므로, 레코드 자체에 이미 박혀 있는 정확한
      // post_no(writer.js가 항상 채워 넣음)를 직접 쓴다.
      const postNo = String(rec.data.post_no);
      const commentId = String(rec.data.comment_id);
      if (rec.contentType === 'comment' && rec.parentCommentId != null) {
        const set = repliesByPost.get(postNo) || new Set();
        set.add(`${rec.parentCommentId}:${commentId}`);
        repliesByPost.set(postNo, set);
      } else {
        const set = topLevelByPost.get(postNo) || new Set();
        set.add(commentId);
        topLevelByPost.set(postNo, set);
      }
    }
  }

  const allPostNos = Array.from(posts.keys())
    .map(Number)
    .filter((n) => !Number.isNaN(n))
    .sort((a, b) => a - b);

  const rows = [['post_no', 'author', 'created_at_kst', 'band_comment_count', 'captured_top_level', 'captured_replies', 'captured_total', 'manual_count', 'diff']];
  for (const postNo of allPostNos) {
    const key = String(postNo);
    const p = posts.get(key);
    const topLevel = topLevelByPost.get(key) ? topLevelByPost.get(key).size : 0;
    const replies = repliesByPost.get(key) ? repliesByPost.get(key).size : 0;
    const total = topLevel + replies;
    rows.push([
      postNo,
      p.author,
      p.createdAtMs != null ? kstDateStr(p.createdAtMs) : '',
      p.commentCountField != null ? p.commentCountField : '',
      topLevel,
      replies,
      total,
      '', // manual_count — 사용자가 채워 넣을 칸
      '', // diff — manual_count 채운 뒤 수식으로 채우거나 재실행 시 자동 계산(아래 참고)
    ]);
  }

  fs.mkdirSync(outDir, { recursive: true });
  const csv = rows.map((r) => r.map((v) => (typeof v === 'string' && v.includes(',') ? `"${v}"` : v)).join(',')).join('\n');
  fs.writeFileSync(outFile, csv, 'utf8');

  console.log(`밴드 ${bandId}: 게시글 ${allPostNos.length}건 집계 완료 -> ${outFile}`);
  console.log('post_no\tauthor\tband_count\ttop_level\treplies\ttotal');
  for (const postNo of allPostNos) {
    const key = String(postNo);
    const p = posts.get(key);
    const topLevel = topLevelByPost.get(key) ? topLevelByPost.get(key).size : 0;
    const replies = repliesByPost.get(key) ? repliesByPost.get(key).size : 0;
    console.log(`${postNo}\t${p.author}\t${p.commentCountField ?? ''}\t${topLevel}\t${replies}\t${topLevel + replies}`);
  }
}

main();
