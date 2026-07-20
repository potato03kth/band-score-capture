// 신뢰도 체계(CLAUDE.md) 2단계 교차검증 3번 - "멤버별 댓글 수"(BSC_VERIFY_MEMBERS=1로 수집된
// data/raw/<bandId>/_members/member_comment_counts_*.json 중 최신 파일)와, raw ndjson에서
// 직접 집계한 멤버별 캡처 댓글 수(최상위+대댓글 합)를 대조한다.
//
// 사용법: node scripts/verify_member_comment_counts.js [bandId]
// 출력: out/verify/member_comment_counts_<bandId>.csv (member_name, user_no, displayed_count,
//   captured_count, diff)

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const bandId = process.argv[2] || '103239777';
const rawBandDir = path.join(ROOT, 'data', 'raw', String(bandId));
const membersDir = path.join(rawBandDir, '_members');
const outDir = path.join(ROOT, 'out', 'verify');
const outFile = path.join(outDir, `member_comment_counts_${bandId}.csv`);

function latestMemberCommentCountsFile() {
  if (!fs.existsSync(membersDir)) return null;
  const files = fs
    .readdirSync(membersDir)
    .filter((f) => /^member_comment_counts_\d+\.json$/.test(f))
    .sort();
  return files.length ? path.join(membersDir, files[files.length - 1]) : null;
}

function listDateDirs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
    .map((e) => e.name);
}

function capturedCountsByUserNo() {
  const counts = new Map(); // userNo -> count
  const names = new Map(); // userNo -> name
  for (const dateDir of listDateDirs(rawBandDir)) {
    const file = path.join(rawBandDir, dateDir, 'items.ndjson');
    if (!fs.existsSync(file)) continue;
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (rec.schemaType !== 'comment') continue;
      const author = rec.data && rec.data.author;
      if (!author || author.user_no == null) continue;
      const key = String(author.user_no);
      counts.set(key, (counts.get(key) || 0) + 1);
      if (!names.has(key)) names.set(key, author.name || '');
    }
  }
  return { counts, names };
}

function main() {
  const file = latestMemberCommentCountsFile();
  if (!file) {
    console.log(
      `${membersDir}에 member_comment_counts_*.json 없음 - BSC_VERIFY_MEMBERS=1로 실기동한 적이 없는 것으로 보입니다.`
    );
    return;
  }
  const { results, capturedAtMs } = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { counts, names } = capturedCountsByUserNo();

  const rows = [['member_name', 'user_no', 'displayed_count', 'captured_count', 'diff', 'stage_if_failed']];
  let mismatchCount = 0;
  let failedCount = 0;
  for (const r of results) {
    const key = r.userNo != null ? String(r.userNo) : null;
    const captured = key && counts.has(key) ? counts.get(key) : 0;
    const displayed = r.found ? r.commentCount : null;
    const diff = displayed != null ? displayed - captured : '';
    if (!r.found) failedCount++;
    else if (diff !== 0) mismatchCount++;
    rows.push([r.memberName || '', r.userNo || '', displayed != null ? displayed : '', captured, diff, r.found ? '' : r.stage || '']);
  }

  fs.mkdirSync(outDir, { recursive: true });
  const csv = rows.map((row) => row.map((v) => (typeof v === 'string' && v.includes(',') ? `"${v}"` : v)).join(',')).join('\n');
  fs.writeFileSync(outFile, csv, 'utf8');

  console.log(
    `밴드 ${bandId}: 멤버별 댓글 수 대조 완료(수집 시각 ${new Date(capturedAtMs).toISOString()}) - 총 ${results.length}명, 화면 표시값 확보 실패 ${failedCount}명, 불일치 ${mismatchCount}명`
  );
  console.log(`--> ${outFile}`);
}

main();
