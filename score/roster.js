// 규칙7·8·10: 학번↔실명↔user_no 매핑, 교수·조교 소거, 동명이인 감지.
// 학번 입력은 input/2_로스터.xlsx(노란칸)로 받는다 — 단, 1_설정.xlsx와 달리 파일이 없거나
// 학번이 비어있어도 **실행을 막지 않는다**(사용자 지시, 2026-07-20). 대신 결정적 합성
// 학번(TEST0001...)을 자동 부여해 그대로 진행한다. 교수가 나중에 학번을 채우면 다음 실행부터
// 그대로 반영된다.
const path = require('path');
const xlsx = require('../lib/xlsx');
const parser = require('./parser');
const rules = require('./rules');

const ROSTER_FILENAME = '2_로스터.xlsx';

// user_no별 최초·최신 활동을 raw 활동 레코드 전체(측정기간 필터링 없음)에서 뽑는다 — 채점이
// 아니라 "이 user_no가 누구인지" 식별을 돕는 참고용 힌트라서 기간과 무관하게 전체 이력을 본다.
// 활동이 없는 user_no는 Map에 아예 없다(0건 케이스는 호출부에서 null로 처리).
function computeActivityHints(rawDir, bands) {
  const hints = new Map(); // userNo -> { first: {dateStr, textPreview, kind}, last: {...} }
  for (const band of bands) {
    const { activities } = parser.parseBandRaw(rawDir, band.bandId);
    for (const a of activities) {
      const entry = { dateStr: rules.kstDateStr(a.createdAtMs), textPreview: a.textPreview, kind: a.kind };
      const existing = hints.get(a.userNo);
      if (!existing) {
        hints.set(a.userNo, { first: entry, firstMs: a.createdAtMs, last: entry, lastMs: a.createdAtMs });
      } else {
        if (a.createdAtMs < existing.firstMs) {
          existing.first = entry;
          existing.firstMs = a.createdAtMs;
        }
        if (a.createdAtMs > existing.lastMs) {
          existing.last = entry;
          existing.lastMs = a.createdAtMs;
        }
      }
    }
  }
  return hints;
}

// 밴드별 멤버 스냅샷을 모아, 소거집합(리더+조교)을 뺀 "채점 대상 후보" 목록을 만든다.
function collectCandidateMembers(rawDir, bands, { taUserNos }) {
  const candidates = []; // { bandId, bandName, userNo, name, firstActivity, lastActivity }
  const leaderUserNos = new Set(taUserNos);
  for (const band of bands) {
    const snapshot = parser.loadLatestMemberSnapshot(rawDir, band.bandId);
    if (!snapshot) continue;
    for (const m of snapshot.members) {
      if (m.role && m.role !== 'member') leaderUserNos.add(m.user_no);
    }
  }
  const hints = computeActivityHints(rawDir, bands);
  for (const band of bands) {
    const snapshot = parser.loadLatestMemberSnapshot(rawDir, band.bandId);
    if (!snapshot) continue;
    for (const m of snapshot.members) {
      if (leaderUserNos.has(m.user_no)) continue;
      const hint = hints.get(m.user_no);
      candidates.push({
        bandId: String(band.bandId),
        bandName: band.name,
        userNo: m.user_no,
        name: m.name,
        firstActivity: hint ? hint.first : null,
        lastActivity: hint ? hint.last : null,
      });
    }
  }
  return { candidates, leaderUserNos };
}

// 이미 채워진(또는 새로 만든) 2_로스터.xlsx를 읽어 user_no -> 학번 매핑을 만든다.
// 파일이 없으면 템플릿을 새로 만들되, 그 사실을 warning으로만 알리고 계속 진행한다.
async function loadRosterMapping(inputDir, candidates, logger = console) {
  const filePath = path.join(inputDir, ROSTER_FILENAME);
  const filled = new Map(); // userNo -> studentId

  if (!(await xlsx.fileExists(filePath))) {
    await xlsx.createRosterTemplate(filePath, candidates);
    logger.warn &&
      logger.warn(
        `[roster] ${ROSTER_FILENAME}이 없어 새로 만들었습니다(${candidates.length}명). 학번을 안 채워도 실행은 계속되며, 채워지지 않은 학생은 임시 학번으로 처리됩니다. 나중에 이 파일을 채워 저장하면 다음 실행부터 반영됩니다.`
      );
    return { filled, filePath, created: true };
  }

  const wb = await xlsx.readWorkbook(filePath);
  const sheet = wb.getWorksheet('로스터');
  if (!sheet) {
    logger.warn && logger.warn(`[roster] ${filePath}에 "로스터" 시트가 없어 무시하고 임시 학번으로 진행합니다.`);
    return { filled, filePath, created: false };
  }
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const userNoRaw = xlsx.readCell(row.getCell(2));
    const studentId = xlsx.readCell(row.getCell(6)); // 1밴드 2user_no 3실명 4최초활동 5최신활동 6학번
    const userNo = Number(userNoRaw);
    if (!Number.isFinite(userNo) || !studentId) return;
    filled.set(userNo, String(studentId).trim());
  });
  return { filled, filePath, created: false };
}

// 결정적 합성 학번 부여(NU5, PLAN.md): user_no 오름차순 정렬 후 TEST0001부터 순번 배정.
// 랜덤 금지 — 재실행해도 같은 user_no는 항상 같은 합성 학번을 받아야 dedup/재현이 안정적이다.
function assignSyntheticIds(userNos) {
  const sorted = [...new Set(userNos)].sort((a, b) => a - b);
  const map = new Map();
  sorted.forEach((userNo, i) => {
    map.set(userNo, `TEST${String(i + 1).padStart(4, '0')}`);
  });
  return map;
}

// candidates + 채워진 학번을 합쳐 최종 매핑을 만든다. 동명이인(같은 실명, 다른 user_no)은
// mappingStatus를 'ambiguous'로 표시하되 각자 고유 학번(실제 또는 합성)은 그대로 받는다 —
// 실행을 막지 않고, 교수가 CSV에서 눈으로 확인할 수 있게 표시만 한다(전체 워크플로는
// 4_동명이인_매핑.xlsx round-trip, 아직 미구현 — 필요해지면 다음에 추가).
function buildFinalMapping(candidates, filledMap) {
  const nameCounts = new Map();
  for (const c of candidates) nameCounts.set(c.name, (nameCounts.get(c.name) || 0) + 1);

  // 순번은 전체 후보 집합(candidates) 기준으로 매긴다 — 미기입자만 걸러내 순번을 매기면
  // 로스터를 점진적으로 채워나갈 때마다(교수가 한 번에 몇 명씩 학번을 채움) 아직 안 채운
  // 학생들의 TEST#### 순번이 재실행마다 밀려서 바뀐다(실측 확인된 버그 - NU5가 요구하는
  // "재실행해도 같은 user_no는 항상 같은 합성 학번" 보장이 깨짐). 채워진 사람의 실제 학번이
  // 우선 사용되므로 그 사람의 TEST#### 순번 슬롯은 그냥 안 쓰일 뿐이다(번호 조밀함보다 안정성 우선).
  const syntheticMap = assignSyntheticIds(candidates.map((c) => c.userNo));

  const result = new Map(); // userNo -> { userNo, name, bandId, bandName, studentId, mappingStatus }
  for (const c of candidates) {
    const studentId = filledMap.get(c.userNo) || syntheticMap.get(c.userNo);
    const mappingStatus = filledMap.has(c.userNo)
      ? nameCounts.get(c.name) > 1
        ? 'ambiguous'
        : 'matched'
      : nameCounts.get(c.name) > 1
        ? 'ambiguous-synthetic'
        : 'synthetic';
    result.set(c.userNo, { userNo: c.userNo, name: c.name, bandId: c.bandId, bandName: c.bandName, studentId, mappingStatus });
  }
  return result;
}

module.exports = {
  ROSTER_FILENAME,
  computeActivityHints,
  collectCandidateMembers,
  loadRosterMapping,
  assignSyntheticIds,
  buildFinalMapping,
};
