// data/raw/<bandId>/incomplete_gaps.json을 읽어 "자동으로 못 모은 것"을 사람이 직접 확인할
// 체크리스트로 뽑는다. 원칙(사용자 지적, 2026-07-20): 자동 수집이 못 모으는 것 자체는 실패가
// 아니다 - 못 모았다는 사실과 정확히 무엇을 어디서 못 모았는지 모르는 게 실패다. 이 스크립트는
// "몰랐던 실패"를 없애기 위한 개발자용 진단 도구다(교수용 왕복 입력물은
// input/부적합_데이터_확인.xlsx - score/gaps.js가 만든다, Phase 6).
//
// 데이터 로딩은 score/gaps.js(loadBandGaps)를 그대로 재사용한다 - 이 스크립트는 콘솔
// 출력/CSV 포맷팅만 담당한다.
//
// 사용법: node scripts/list_incomplete_gaps.js [bandId]
// 출력:
//   1) 콘솔에 사람이 바로 읽을 체크리스트(글 URL 포함 - 클릭해서 바로 확인 가능), tier 낮은 순
//   2) out/verify/diag_gap_checklist_<bandId>.csv - 개발자/조교용 진단 CSV(교수용 입력물이
//      아님 - 교수가 채우는 실제 입력물은 input/부적합_데이터_확인.xlsx, Phase 6). 파일명에
//      diag_ 접두어를 붙인 이유: out/ 아래 다른 산출물(scores_*.csv 등)은 교수에게 그대로
//      전달되는 결과물이라 이 파일도 같은 것으로 오인되기 쉬움(Phase 7, doc/PLAN.md §H-2).

const fs = require('fs');
const path = require('path');
const gaps = require('../score/gaps');

const ROOT = path.join(__dirname, '..');
const bandId = process.argv[2] || '103239777';
const rawDir = path.join(ROOT, 'data', 'raw');
const outDir = path.join(ROOT, 'out', 'verify');
const outFile = path.join(outDir, `diag_gap_checklist_${bandId}.csv`);

function describe(g) {
  const reasonText = gaps.reasonLabel(g.reason);
  const base = `postNo=${g.postNo != null ? g.postNo : '-'}(작성자:${g.postAuthor || '?'}) - 기대 ${g.expected} vs 확보 ${g.captured}(부족 ${g.missing})`;
  if (g.type === 'reply') {
    return `[대댓글] ${base}, 부모댓글(id=${g.parentCommentId}, 작성자:${g.parentAuthor || '?'})\n  사유: ${reasonText}\n  ${g.postWebUrl || '(URL 없음)'}`;
  }
  if (g.type === 'total-post-count-mismatch') {
    return `[게시글 총수] ${base}\n  사유: ${reasonText}\n  ${g.postWebUrl || '(URL 없음)'}`;
  }
  if (g.type === 'displayed-count-mismatch') {
    return `[모달 표시 댓글 수] ${base}\n  사유: ${reasonText}\n  ${g.postWebUrl || '(URL 없음)'}`;
  }
  return `[게시글 댓글] ${base}\n  사유: ${reasonText}\n  ${g.postWebUrl || '(URL 없음)'}`;
}

function main() {
  const gapsData = gaps.loadBandGaps(rawDir, bandId);
  if (!gapsData) {
    console.log(`data/raw/${bandId}/incomplete_gaps.json 없음 - 아직 실기동 안 했거나(acquire 미실행), 결손이 한 번도 기록된 적 없음.`);
    return;
  }
  const { gaps: gapList, updatedAtMs } = gapsData;

  if (!gapList || gapList.length === 0) {
    console.log(`밴드 ${bandId}: 알려진 결손 없음(${new Date(updatedAtMs).toISOString()} 기준). 사람이 수동으로 확인할 항목이 없습니다.`);
    return;
  }

  const sorted = gapList.slice().sort((a, b) => (a.reasonTier || 9) - (b.reasonTier || 9));

  console.log(
    `밴드 ${bandId}: 알려진 결손 ${gapList.length}건(${new Date(updatedAtMs).toISOString()} 기준) - 아래 글로 직접 이동해 부족한 만큼 확인해 주세요.`
  );
  console.log('(신뢰도 높은 순으로 정렬됨 - 위쪽부터 먼저 확인하세요)\n');

  const rows = [
    [
      'reasonTier',
      'reason',
      'type',
      'post_no',
      'post_author',
      'post_url',
      'parent_comment_id',
      'parent_author',
      'expected',
      'captured',
      'missing',
      'manual_value',
      'note',
    ],
  ];
  for (const g of sorted) {
    console.log(describe(g) + '\n');
    rows.push([
      g.reasonTier != null ? g.reasonTier : '',
      g.reason || '',
      g.type,
      g.postNo != null ? g.postNo : '',
      g.postAuthor || '',
      g.postWebUrl || '',
      g.type === 'reply' ? g.parentCommentId : '',
      g.type === 'reply' ? g.parentAuthor || '' : '',
      g.expected,
      g.captured,
      g.missing,
      '', // manual_value - 사람이 직접 확인한 값을 채우는 칸
      '', // note - 확인한 내용/메모
    ]);
  }

  fs.mkdirSync(outDir, { recursive: true });
  const csv = rows.map((r) => r.map((v) => (typeof v === 'string' && v.includes(',') ? `"${v}"` : v)).join(',')).join('\n');
  fs.writeFileSync(outFile, csv, 'utf8');
  console.log(`--> ${outFile}에도 같은 내용을 CSV로 저장했습니다(manual_value/note 칸을 채워 기록하세요).`);
  console.log(`--> 교수용 왕복 입력물이 필요하면 node score/index.js를 실행하세요 - input/${gaps.GAPS_FILENAME}이 자동 생성됩니다.`);
}

main();
