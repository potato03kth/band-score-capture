// data/raw/<bandId>/incomplete_gaps.json을 읽어 "자동으로 못 모은 것"을 사람이 직접 확인할
// 체크리스트로 뽑는다. 원칙(사용자 지적, 2026-07-20): 자동 수집이 못 모으는 것 자체는 실패가
// 아니다 - 못 모았다는 사실과 정확히 무엇을 어디서 못 모았는지 모르는 게 실패다. 이 스크립트는
// "몰랐던 실패"를 없애기 위한 마지막 단계용이다.
//
// 각 항목의 reasonTier는 CLAUDE.md의 신뢰도 체계 단계 번호다(작을수록 신뢰도 높음 - 먼저 볼 것):
//   2 = 사람이 화면에서 보는 값과 불일치(모달 표시 댓글 수, 피드 전체 카드 수)
//   3 = 밴드 API의 comment_count류 필드와 불일치(이미 신뢰 불가로 확인된 필드 - 우선순위 낮음)
//
// 사용법: node scripts/list_incomplete_gaps.js [bandId]
// 출력:
//   1) 콘솔에 사람이 바로 읽을 체크리스트(글 URL 포함 - 클릭해서 바로 확인 가능), tier 낮은 순
//   2) out/verify/manual_followup_<bandId>.csv - manual_value/note 빈 칸을 채워 수동 보정에 쓸 CSV

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const bandId = process.argv[2] || '103239777';
const gapsFile = path.join(ROOT, 'data', 'raw', String(bandId), 'incomplete_gaps.json');
const outDir = path.join(ROOT, 'out', 'verify');
const outFile = path.join(outDir, `manual_followup_${bandId}.csv`);

const REASON_LABEL = {
  'post-modal-displayed-count-mismatch': '게시글 모달에 표시된 댓글 수와 불일치(신뢰도 높음)',
  'feed-scroll-card-count-mismatch': '피드 전체 스크롤로 센 게시글 수와 불일치(신뢰도 높음)',
  'retry-exhausted-vs-band-comment-count-field': '응답 재시도 실패 + 밴드 API 필드 기준 추정(신뢰도 낮음)',
  'parent-comment-count-field-mismatch': '밴드 API의 부모 댓글 comment_count 필드와 불일치(신뢰도 낮음)',
};

function describe(g) {
  const reasonLabel = REASON_LABEL[g.reason] || g.reason || '(사유 미상)';
  const base = `postNo=${g.postNo != null ? g.postNo : '-'}(작성자:${g.postAuthor || '?'}) - 기대 ${g.expected} vs 확보 ${g.captured}(부족 ${g.missing})`;
  if (g.type === 'reply') {
    return `[대댓글] ${base}, 부모댓글(id=${g.parentCommentId}, 작성자:${g.parentAuthor || '?'})\n  사유: ${reasonLabel}\n  ${g.postWebUrl || '(URL 없음)'}`;
  }
  if (g.type === 'total-post-count-mismatch') {
    return `[게시글 총수] ${base}\n  사유: ${reasonLabel}\n  ${g.postWebUrl || '(URL 없음)'}`;
  }
  if (g.type === 'displayed-count-mismatch') {
    return `[모달 표시 댓글 수] ${base}\n  사유: ${reasonLabel}\n  ${g.postWebUrl || '(URL 없음)'}`;
  }
  return `[게시글 댓글] ${base}\n  사유: ${reasonLabel}\n  ${g.postWebUrl || '(URL 없음)'}`;
}

function main() {
  if (!fs.existsSync(gapsFile)) {
    console.log(`${gapsFile} 없음 - 아직 실기동 안 했거나(acquire 미실행), 결손이 한 번도 기록된 적 없음.`);
    return;
  }
  const { gaps, updatedAtMs } = JSON.parse(fs.readFileSync(gapsFile, 'utf8'));

  if (!gaps || gaps.length === 0) {
    console.log(`밴드 ${bandId}: 알려진 결손 없음(${new Date(updatedAtMs).toISOString()} 기준). 사람이 수동으로 확인할 항목이 없습니다.`);
    return;
  }

  const sorted = gaps.slice().sort((a, b) => (a.reasonTier || 9) - (b.reasonTier || 9));

  console.log(
    `밴드 ${bandId}: 알려진 결손 ${gaps.length}건(${new Date(updatedAtMs).toISOString()} 기준) - 아래 글로 직접 이동해 부족한 만큼 확인해 주세요.`
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
}

main();
