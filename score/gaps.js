// Phase 6: "부적합 데이터"(자동 수집이 확신 못 하는 것) 3개 축을 input/부적합_데이터_확인.xlsx
// 하나로 합친 왕복 입력물로 만들고, 미해결 항목이 남아있으면 채점을 거부하는 게이트.
//
// 3개 축(CLAUDE.md 신뢰도 tier 기준, H-1):
//   1) 게시글총수 — data/raw/<bandId>/incomplete_gaps.json의 type:'total-post-count-mismatch'
//      (밴드 단위, postNo 없음 — "이 글 자체를 놓쳤는지"는 확인하되 특정 학생에게 귀속할 방법이
//      없다. 게이트 확인 후 bandPostCounts만 보정된 값으로 덮어쓴다).
//   2) 게시글댓글 — 같은 파일의 나머지 타입(top-level/reply/displayed-count-mismatch). postNo와
//      postAuthor는 있지만 "빠진 댓글을 실제로 누가 썼는지"는 알 수 없어 마찬가지로 특정
//      학생에게 귀속하지 않는다 — 사람 확인(게이트)만 요구한다.
//   3) 학생댓글 — data/raw/<bandId>/_members/member_comment_counts_*.json(화면표시) vs raw
//      ndjson 실제 집계(captured). user_no가 명시적으로 있는 유일한 축이라, 여기만 해결되면
//      score/index.js가 해당 user_no의 commentCount/activeDays에 직접 반영한다
//      (applyMemberCommentCorrections).
const fs = require('fs');
const path = require('path');
const xlsx = require('../lib/xlsx');
const parser = require('./parser');

class GapsValidationError extends Error {}

const GAPS_FILENAME = '부적합_데이터_확인.xlsx';

const REASON_LABEL = {
  'post-modal-displayed-count-mismatch': '게시글 모달에 표시된 댓글 수와 불일치(신뢰도 높음)',
  'feed-scroll-card-count-mismatch': '피드 전체 스크롤로 센 게시글 수와 불일치(신뢰도 높음)',
  'retry-exhausted-vs-band-comment-count-field': '응답 재시도 실패 + 밴드 API 필드 기준 추정(신뢰도 낮음)',
  'parent-comment-count-field-mismatch': '밴드 API의 부모 댓글 comment_count 필드와 불일치(신뢰도 낮음)',
};

function reasonLabel(reason) {
  return REASON_LABEL[reason] || reason || '(사유 미상)';
}

function gapTypeLabel(type) {
  if (type === 'reply') return '대댓글';
  if (type === 'displayed-count-mismatch') return '모달표시댓글수';
  return '최상위댓글'; // 'top-level' 기본
}

// data/raw/<bandId>/incomplete_gaps.json 한 밴드분을 읽는다. 없으면(결손 기록 자체가 없음) null.
function loadBandGaps(rawDir, bandId) {
  const gapsFile = path.join(rawDir, String(bandId), 'incomplete_gaps.json');
  if (!fs.existsSync(gapsFile)) return null;
  const { gaps, updatedAtMs } = JSON.parse(fs.readFileSync(gapsFile, 'utf8'));
  return { gaps: gaps || [], updatedAtMs };
}

// raw ndjson에서 직접 집계한 멤버별 캡처 댓글 수(최상위+대댓글 합). parser.parseBandRaw가 이미
// 검증된 ndjson 파싱 로직을 갖고 있으므로 여기서 다시 구현하지 않는다.
function capturedCommentCountsByUserNo(rawDir, bandId) {
  const { activities } = parser.parseBandRaw(rawDir, bandId);
  const counts = new Map();
  for (const a of activities) {
    if (a.kind !== 'comment') continue;
    counts.set(a.userNo, (counts.get(a.userNo) || 0) + 1);
  }
  return counts;
}

// data/raw/<bandId>/_members/member_comment_counts_*.json(최신) vs 캡처값을 대조한다.
// BSC_VERIFY_MEMBERS=1로 수집한 적이 없으면(파일 없음) null.
function loadMemberCommentComparison(rawDir, bandId) {
  const membersDir = path.join(rawDir, String(bandId), '_members');
  if (!fs.existsSync(membersDir)) return null;
  const files = fs
    .readdirSync(membersDir)
    .filter((f) => /^member_comment_counts_\d+\.json$/.test(f))
    .sort();
  if (files.length === 0) return null;
  const file = path.join(membersDir, files[files.length - 1]);
  const { results, capturedAtMs } = JSON.parse(fs.readFileSync(file, 'utf8'));
  const captured = capturedCommentCountsByUserNo(rawDir, bandId);

  const comparisons = results.map((r) => {
    const capturedCount = r.userNo != null && captured.has(r.userNo) ? captured.get(r.userNo) : 0;
    const displayedCount = r.found ? r.commentCount : null;
    const diff = displayedCount != null ? displayedCount - capturedCount : null;
    return {
      memberName: r.memberName || '',
      userNo: r.userNo,
      displayedCount,
      capturedCount,
      diff,
      found: !!r.found,
      stage: r.stage || null,
    };
  });
  return { comparisons, capturedAtMs };
}

// 여러 밴드의 결손을 모아 부적합_데이터_확인.xlsx의 3개 시트 데이터로 변환한다.
// 신뢰도tier가 낮을수록(신뢰도 높을수록) 먼저 보이도록 정렬(CLAUDE.md 신뢰도 체계 반영).
function collectGapSections(rawDir, bands) {
  const totalPostCount = [];
  const postComments = [];
  const memberComments = [];

  for (const band of bands) {
    const bandName = band.name;
    const bandId = String(band.bandId);

    const gapsData = loadBandGaps(rawDir, bandId);
    if (gapsData && gapsData.gaps.length > 0) {
      const sorted = gapsData.gaps.slice().sort((a, b) => (a.reasonTier || 9) - (b.reasonTier || 9));
      for (const g of sorted) {
        if (g.type === 'total-post-count-mismatch') {
          totalPostCount.push({
            bandName,
            bandId,
            reasonTier: g.reasonTier != null ? g.reasonTier : '',
            reason: reasonLabel(g.reason),
            expected: g.expected,
            captured: g.captured,
            missing: g.missing,
          });
        } else {
          postComments.push({
            bandName,
            bandId,
            reasonTier: g.reasonTier != null ? g.reasonTier : '',
            reason: reasonLabel(g.reason),
            typeLabel: gapTypeLabel(g.type),
            postNo: g.postNo != null ? g.postNo : '',
            postAuthor: g.postAuthor || '',
            postWebUrl: g.postWebUrl || '',
            parentCommentId: g.type === 'reply' ? g.parentCommentId : '',
            parentAuthor: g.type === 'reply' ? g.parentAuthor || '' : '',
            expected: g.expected,
            captured: g.captured,
            missing: g.missing,
          });
        }
      }
    }

    const memberData = loadMemberCommentComparison(rawDir, bandId);
    if (memberData) {
      const needsConfirmation = memberData.comparisons.filter((c) => !c.found || c.diff !== 0);
      needsConfirmation.sort((a, b) => {
        if (a.found !== b.found) return a.found ? 1 : -1; // 확인 실패(found:false)가 신뢰도 더 낮음 - 먼저
        return Math.abs(b.diff || 0) - Math.abs(a.diff || 0);
      });
      for (const c of needsConfirmation) {
        memberComments.push({
          bandName,
          bandId,
          memberName: c.memberName,
          userNo: c.userNo != null ? c.userNo : '',
          displayedCount: c.found ? c.displayedCount : `(확인 실패${c.stage ? ': ' + c.stage : ''})`,
          capturedCount: c.capturedCount,
          diff: c.found ? c.diff : '',
        });
      }
    }
  }

  return { totalPostCount, postComments, memberComments };
}

// 3개 섹션 각각의 "같은 결손"을 식별하는 키. incomplete_gaps.json/member_comment_counts는
// acquire를 다시 돌릴 때마다 그 시점 기준으로 통째로 다시 쓰인다(writer.js 주석) — 즉 이
// 엑셀의 원본 데이터 자체가 1_설정.xlsx/2_로스터.xlsx(교수가 한 번 정하면 안 바뀌어야 하는
// 입력)와 달리 재수집마다 바뀔 수 있다. 그래서 "이미 파일 있으면 안 건드림" 관례를 그대로
// 물려받으면 안 되고(재수집으로 새로 드러난 결손이 영영 확인 엑셀에 안 나타나 게이트가
// 조용히 뚫리는 실측 버그로 확인됨), 매번 최신 섹션으로 다시 만들되 기존에 채운
// manual_value/note만 아래 키로 이어받는다.
function totalPostCountKey(r) {
  return String(r.bandId);
}
function postCommentKey(r) {
  return `${r.bandId}:${r.typeLabel}:${r.postNo}:${r.parentCommentId || ''}`;
}
function memberCommentKey(r) {
  return `${r.bandId}:${r.userNo}`;
}

// 기존 확인 엑셀(있다면)에서 섹션별 { key -> {manualValue, note} }를 읽는다. 파일이 없으면 null.
// 시트 구성이 손상되었으면 readGapsResolution과 동일하게 GapsValidationError(사람이 직접
// 지우고 재생성하도록 안내) — 손상된 파일을 조용히 버리고 새로 만들면 그 안에 있었을지 모를
// manual_value를 말없이 잃을 위험이 있어, 그건 허용하지 않는다.
async function loadPriorConfirmations(filePath) {
  if (!(await xlsx.fileExists(filePath))) return null;
  const wb = await xlsx.readWorkbook(filePath);
  const totalSheet = wb.getWorksheet('게시글총수');
  const postSheet = wb.getWorksheet('게시글댓글');
  const memberSheet = wb.getWorksheet('학생댓글');
  if (!totalSheet || !postSheet || !memberSheet) {
    throw new GapsValidationError(
      `${filePath} 파일의 시트 구성이 손상되었습니다. "게시글총수"·"게시글댓글"·"학생댓글" 시트가 모두 있어야 합니다. 파일을 삭제한 뒤 다시 실행해 템플릿을 재생성하세요.`
    );
  }

  const totalPostCount = new Map();
  totalSheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const bandId = String(xlsx.readCell(row.getCell(2)));
    const manualValue = xlsx.readCell(row.getCell(8));
    if (manualValue === '' || manualValue == null) return;
    totalPostCount.set(bandId, { manualValue, note: xlsx.readCell(row.getCell(9)) });
  });

  const postComments = new Map();
  postSheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const key = `${xlsx.readCell(row.getCell(2))}:${xlsx.readCell(row.getCell(5))}:${xlsx.readCell(row.getCell(6))}:${xlsx.readCell(row.getCell(9)) || ''}`;
    const manualValue = xlsx.readCell(row.getCell(14));
    if (manualValue === '' || manualValue == null) return;
    postComments.set(key, { manualValue, note: xlsx.readCell(row.getCell(15)) });
  });

  const memberComments = new Map();
  memberSheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    if (xlsx.readCell(row.getCell(1)) === '합계') return;
    const key = `${xlsx.readCell(row.getCell(2))}:${xlsx.readCell(row.getCell(4))}`;
    const manualValue = xlsx.readCell(row.getCell(8));
    if (manualValue === '' || manualValue == null) return;
    memberComments.set(key, { manualValue, note: xlsx.readCell(row.getCell(9)) });
  });

  return { totalPostCount, postComments, memberComments };
}

// 결손이 하나라도 있으면 최신 섹션으로 확인 엑셀을 (재)생성한다. 결손이 전혀 없으면 파일 자체를
// 만들지 않는다 — "결손 없음"과 "결손 미해결"을 파일 존재 여부로 혼동하지 않기 위함(H-3 6-3
// 주석 참고). 예전에는 결손이 있었지만 지금은 다 해결돼 파일만 남아있는 경우, 빈 섹션으로
// 갱신해 stale 미해결 행 때문에 게이트가 잘못 막지 않게 한다. 기존에 채운 manual_value/note는
// loadPriorConfirmations로 이어받으므로 재생성해도 사람이 이미 확인한 내용은 잃지 않는다.
async function ensureGapsWorkbook(inputDir, rawDir, bands) {
  const filePath = path.join(inputDir, GAPS_FILENAME);
  const sections = collectGapSections(rawDir, bands);
  const hasGaps = sections.totalPostCount.length + sections.postComments.length + sections.memberComments.length > 0;

  const prior = await loadPriorConfirmations(filePath);
  if (prior) {
    for (const r of sections.totalPostCount) Object.assign(r, prior.totalPostCount.get(totalPostCountKey(r)));
    for (const r of sections.postComments) Object.assign(r, prior.postComments.get(postCommentKey(r)));
    for (const r of sections.memberComments) Object.assign(r, prior.memberComments.get(memberCommentKey(r)));
  }

  if (!hasGaps) {
    if (prior) await xlsx.createGapsTemplate(filePath, sections); // 예전엔 결손 있었음 - 빈 상태로 갱신
    return { created: false, hasGaps: false, filePath };
  }
  await xlsx.createGapsTemplate(filePath, sections);
  return { created: !prior, hasGaps: true, filePath };
}

// 워크북을 읽어 섹션별 manual_value가 전부 채워졌는지 판단한다. 파일이 없으면(=결손이 한 번도
// 기록된 적 없음) 게이트 통과로 취급한다.
async function readGapsResolution(filePath) {
  if (!(await xlsx.fileExists(filePath))) {
    return {
      resolved: true,
      unresolvedCount: 0,
      bySection: {},
      corrections: { bandPostCountOverrides: new Map(), memberCommentDeltas: new Map() },
    };
  }

  const wb = await xlsx.readWorkbook(filePath);
  const totalSheet = wb.getWorksheet('게시글총수');
  const postSheet = wb.getWorksheet('게시글댓글');
  const memberSheet = wb.getWorksheet('학생댓글');
  if (!totalSheet || !postSheet || !memberSheet) {
    throw new GapsValidationError(
      `${filePath} 파일의 시트 구성이 손상되었습니다. "게시글총수"·"게시글댓글"·"학생댓글" 시트가 모두 있어야 합니다. 파일을 삭제한 뒤 다시 실행해 템플릿을 재생성하세요.`
    );
  }

  const bandPostCountOverrides = new Map();
  const memberCommentDeltas = new Map();
  const bySection = {};
  let unresolvedCount = 0;

  {
    let resolved = 0;
    let unresolved = 0;
    totalSheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      const bandId = String(xlsx.readCell(row.getCell(2)));
      const manualValue = xlsx.readCell(row.getCell(8));
      if (manualValue === '' || manualValue == null) {
        unresolved++;
        return;
      }
      resolved++;
      const n = Number(manualValue);
      if (Number.isFinite(n)) bandPostCountOverrides.set(bandId, n);
    });
    bySection.게시글총수 = { resolved, unresolved };
    unresolvedCount += unresolved;
  }

  {
    let resolved = 0;
    let unresolved = 0;
    postSheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      const manualValue = xlsx.readCell(row.getCell(14));
      if (manualValue === '' || manualValue == null) unresolved++;
      else resolved++;
    });
    bySection.게시글댓글 = { resolved, unresolved };
    unresolvedCount += unresolved;
  }

  {
    let resolved = 0;
    let unresolved = 0;
    memberSheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      const bandNameCell = xlsx.readCell(row.getCell(1));
      if (bandNameCell === '합계') return; // 6-2 실시간 합산 행은 데이터 행이 아니므로 건너뜀
      const userNoRaw = xlsx.readCell(row.getCell(4));
      const capturedRaw = xlsx.readCell(row.getCell(6));
      const manualValue = xlsx.readCell(row.getCell(8));
      if (manualValue === '' || manualValue == null) {
        unresolved++;
        return;
      }
      resolved++;
      const userNo = Number(userNoRaw);
      const manualN = Number(manualValue);
      const capturedN = Number(capturedRaw) || 0;
      if (Number.isFinite(userNo) && Number.isFinite(manualN)) {
        memberCommentDeltas.set(userNo, manualN - capturedN);
      }
    });
    bySection.학생댓글 = { resolved, unresolved };
    unresolvedCount += unresolved;
  }

  return {
    resolved: unresolvedCount === 0,
    unresolvedCount,
    bySection,
    corrections: { bandPostCountOverrides, memberCommentDeltas },
  };
}

function makeCorrectionRecord(delta) {
  return {
    kind: 'comment',
    dateStr: '(수동보정)',
    postNo: null,
    textPreview: `수동 보정(사유: 학생별 댓글수 확인 - 부적합_데이터_확인.xlsx, 차이 ${delta > 0 ? '+' : ''}${delta}건)`,
  };
}

// 학생댓글 섹션의 확정된 보정치를 scorer.scoreActivities 출력(Map<userNo,{activeDays,postCount,
// commentCount,score,records}>)에 합성한다. commentCount는 delta만큼 조정하고, 원래 활동이
// 0건(활동일수 0)이던 학생이 실제로는 확인된 활동이 있었다면(delta>0) 활동일수를 최소 1로
// 끌어올린다 — 정확한 날짜는 알 수 없지만("몇 월 며칠"까지는 화면표시 댓글수만으로 복원 불가),
// tier-2로 확인된 실제 활동을 완전히 무시해 0점 처리하는 쪽이 더 큰 오류다. 반대로 delta<0인
// 경우(캡처가 과대측정)는 활동일수를 낮추지 않는다 — 어떤 특정 날짜/레코드가 잘못됐는지 알 수
// 없는 상태에서 점수를 깎는 것은 근거 없는 불이익이 되기 때문(보수적 선택).
function applyMemberCommentCorrections(scores, memberCommentDeltas, { cap }) {
  const result = new Map(scores);
  for (const [userNo, delta] of memberCommentDeltas) {
    if (!delta) continue;
    const existing = result.get(userNo);
    const record = makeCorrectionRecord(delta);
    if (existing) {
      const newCommentCount = Math.max(0, (existing.commentCount || 0) + delta);
      const newActiveDays = delta > 0 && existing.activeDays === 0 ? 1 : existing.activeDays;
      result.set(userNo, {
        ...existing,
        commentCount: newCommentCount,
        activeDays: newActiveDays,
        score: Math.min(newActiveDays, cap),
        records: [...existing.records, record],
      });
    } else {
      const newActiveDays = delta > 0 ? 1 : 0;
      result.set(userNo, {
        userNo,
        activeDays: newActiveDays,
        postCount: 0,
        commentCount: Math.max(0, delta),
        score: Math.min(newActiveDays, cap),
        records: [record],
      });
    }
  }
  return result;
}

// 게시글총수 섹션의 확정된 보정치(밴드 단위, 특정 학생에 귀속 불가)를 bandPostCounts(밴드요약
// 시트에 쓰이는 캡처된 게시글수)에 덮어쓴다.
function applyBandPostCountOverrides(bandPostCounts, overrides) {
  const result = new Map(bandPostCounts);
  for (const [bandId, value] of overrides) result.set(bandId, value);
  return result;
}

module.exports = {
  GAPS_FILENAME,
  GapsValidationError,
  REASON_LABEL,
  reasonLabel,
  gapTypeLabel,
  loadBandGaps,
  loadMemberCommentComparison,
  collectGapSections,
  loadPriorConfirmations,
  ensureGapsWorkbook,
  readGapsResolution,
  applyMemberCommentCorrections,
  applyBandPostCountOverrides,
};
