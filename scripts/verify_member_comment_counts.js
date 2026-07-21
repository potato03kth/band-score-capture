// 신뢰도 체계(CLAUDE.md) 2단계 교차검증 3번 - "멤버별 댓글 수"(BSC_VERIFY_MEMBERS=1로 수집된
// data/raw/<bandId>/_members/member_comment_counts_*.json 중 최신 파일)와, raw ndjson에서
// 직접 집계한 멤버별 캡처 댓글 수(최상위+대댓글 합)를 대조한다. 개발자용 진단 도구다(교수용
// 왕복 입력물은 input/부적합_데이터_확인.xlsx - score/gaps.js가 만든다, Phase 6).
//
// 데이터 로딩/대조는 score/gaps.js(loadMemberCommentComparison)를 그대로 재사용한다 - 이
// 스크립트는 CSV 포맷팅만 담당한다.
//
// 사용법: node scripts/verify_member_comment_counts.js [bandId]
// 출력: out/verify/diag_member_comment_counts_<bandId>.csv (member_name, user_no,
//   displayed_count, captured_count, diff) - 개발자/조교용 진단 CSV. diag_ 접두어를 붙인
//   이유는 scripts/list_incomplete_gaps.js 상단 주석 참고(Phase 7).

const fs = require('fs');
const path = require('path');
const gaps = require('../score/gaps');

const ROOT = path.join(__dirname, '..');
const bandId = process.argv[2] || '103239777';
const rawDir = path.join(ROOT, 'data', 'raw');
const outDir = path.join(ROOT, 'out', 'verify');
const outFile = path.join(outDir, `diag_member_comment_counts_${bandId}.csv`);

function main() {
  const data = gaps.loadMemberCommentComparison(rawDir, bandId);
  if (!data) {
    console.log(
      `data/raw/${bandId}/_members에 member_comment_counts_*.json 없음 - BSC_VERIFY_MEMBERS=1로 실기동한 적이 없는 것으로 보입니다.`
    );
    return;
  }
  const { comparisons, capturedAtMs } = data;

  const rows = [['member_name', 'user_no', 'displayed_count', 'captured_count', 'diff', 'stage_if_failed']];
  let mismatchCount = 0;
  let failedCount = 0;
  for (const c of comparisons) {
    if (!c.found) failedCount++;
    else if (c.diff !== 0) mismatchCount++;
    rows.push([c.memberName, c.userNo || '', c.displayedCount != null ? c.displayedCount : '', c.capturedCount, c.diff != null ? c.diff : '', c.found ? '' : c.stage || '']);
  }

  fs.mkdirSync(outDir, { recursive: true });
  const csv = rows.map((row) => row.map((v) => (typeof v === 'string' && v.includes(',') ? `"${v}"` : v)).join(',')).join('\n');
  fs.writeFileSync(outFile, csv, 'utf8');

  console.log(
    `밴드 ${bandId}: 멤버별 댓글 수 대조 완료(수집 시각 ${new Date(capturedAtMs).toISOString()}) - 총 ${comparisons.length}명, 화면 표시값 확보 실패 ${failedCount}명, 불일치 ${mismatchCount}명`
  );
  console.log(`--> ${outFile}`);
}

main();
