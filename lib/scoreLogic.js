// input/score_logic.xlsx 파싱(Phase 8, 확장성 목적, 최하위 우선순위). 1_설정.xlsx와 달리
// 미기입을 막지 않는다 — 모든 항목의 기본값("변경불필요")이 이미 유효한(=기존 규칙과 100%
// 동일한) 동작을 뜻하므로, 파일이 없거나 전부 "변경불필요"여도 그냥 옛 하드코딩 값으로
// 채점을 계속 진행한다(2_로스터.xlsx/부적합_데이터_확인.xlsx와 같은 "막지 않는" 부류).
const path = require('path');
const xlsx = require('./xlsx');

class ScoreLogicValidationError extends Error {}

const SCORE_LOGIC_FILENAME = 'score_logic.xlsx';
const SHEET_HEADERS = ['항목', '값', '설명'];
const SENTINEL = '변경불필요';

// 기존 하드코딩 동작과 100% 동일한 기본값(score/scorer.js가 지금까지 써온 값).
const DEFAULTS = {
  dailyActivityCap: Infinity, // 하루에 셀 활동 건수 제한 없음(기존엔 애초에 이런 개념이 없었음)
  dailyScoreCap: 1, // 기존 "하루 최대 1점"
  commentMultiplier: 1, // 기존 "게시글/댓글 동일배점"
  postMultiplier: 1,
  includeAssignmentPosts: false, // 기존 규칙4: 과제글 댓글은 항상 제외
  assignmentPostScore: 5, // 과제글(제출) 1개당 점수(n) — 활동점수와 별도 합산
  assignmentScoreCap: 20, // 과제점수 상한(m)
};

function findValue(sheet, itemLabel) {
  let found;
  let foundRow = false;
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const item = xlsx.readCell(row.getCell(1));
    if (item === itemLabel) {
      found = xlsx.readCell(row.getCell(2));
      foundRow = true;
    }
  });
  if (!foundRow) {
    throw new ScoreLogicValidationError(
      `"설정" 시트에서 "${itemLabel}" 항목을 찾을 수 없습니다. 파일을 삭제한 뒤 다시 실행해 템플릿을 재생성하세요.`
    );
  }
  return found;
}

function parsePositiveNumber(raw, label, { allowInfinity = false } = {}) {
  if (raw === SENTINEL || raw === '' || raw == null) return null; // null = "기본값 써라" 신호
  if (allowInfinity && raw === '무제한') return Infinity;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ScoreLogicValidationError(
      `"${label}" 값이 올바르지 않습니다. 0보다 큰 숫자 또는 "${SENTINEL}"를 입력하세요. 현재 값: ${JSON.stringify(raw)}`
    );
  }
  return n;
}

function parseIncludeAssignmentPosts(raw) {
  if (raw === SENTINEL || raw === '' || raw == null) return null;
  const v = String(raw).trim();
  if (v === '포함') return true;
  if (v === '제외') return false;
  throw new ScoreLogicValidationError(
    `"과제글포함여부" 값이 올바르지 않습니다. "포함" / "제외" / "${SENTINEL}" 중 하나를 입력하세요. 현재 값: ${JSON.stringify(raw)}`
  );
}

// 파일이 없으면 기본값 그대로 반환(막지 않음 — 위 파일 헤더 설명 참고). 있으면 읽어서 검증 +
// "변경불필요"가 아닌 항목만 기본값을 덮어쓴다.
async function loadScoreLogic(inputDir) {
  const filePath = path.join(inputDir, SCORE_LOGIC_FILENAME);
  if (!(await xlsx.fileExists(filePath))) {
    await xlsx.createScoreLogicTemplate(filePath);
    return { ...DEFAULTS, filePath, created: true };
  }

  const wb = await xlsx.readWorkbook(filePath);
  const sheet = wb.getWorksheet('설정');
  if (!sheet) {
    throw new ScoreLogicValidationError(
      `${filePath} 파일의 시트 구성이 손상되었습니다. "설정" 시트가 있어야 합니다. 파일을 삭제한 뒤 다시 실행해 템플릿을 재생성하세요.`
    );
  }
  const row1 = sheet.getRow(1);
  for (let i = 0; i < SHEET_HEADERS.length; i++) {
    const val = xlsx.readCell(row1.getCell(i + 1));
    if (val !== SHEET_HEADERS[i]) {
      throw new ScoreLogicValidationError(
        `${filePath}의 "설정" 시트 헤더가 손상되었습니다 (${i + 1}번째 열 기대값 "${SHEET_HEADERS[i]}", 실제 "${val}"). 파일을 삭제한 뒤 다시 실행해 템플릿을 재생성하세요.`
      );
    }
  }

  const dailyActivityCap = parsePositiveNumber(findValue(sheet, '일일활동상한'), '일일활동상한', { allowInfinity: true });
  const dailyScoreCap = parsePositiveNumber(findValue(sheet, '일일점수상한'), '일일점수상한');
  const commentMultiplier = parsePositiveNumber(findValue(sheet, '댓글배수'), '댓글배수');
  const postMultiplier = parsePositiveNumber(findValue(sheet, '게시글배수'), '게시글배수');
  const includeAssignmentPosts = parseIncludeAssignmentPosts(findValue(sheet, '과제글포함여부'));
  const assignmentPostScore = parsePositiveNumber(findValue(sheet, '과제글당점수'), '과제글당점수');
  const assignmentScoreCap = parsePositiveNumber(findValue(sheet, '과제점수상한'), '과제점수상한');

  return {
    filePath,
    created: false,
    dailyActivityCap: dailyActivityCap ?? DEFAULTS.dailyActivityCap,
    dailyScoreCap: dailyScoreCap ?? DEFAULTS.dailyScoreCap,
    commentMultiplier: commentMultiplier ?? DEFAULTS.commentMultiplier,
    postMultiplier: postMultiplier ?? DEFAULTS.postMultiplier,
    includeAssignmentPosts: includeAssignmentPosts ?? DEFAULTS.includeAssignmentPosts,
    assignmentPostScore: assignmentPostScore ?? DEFAULTS.assignmentPostScore,
    assignmentScoreCap: assignmentScoreCap ?? DEFAULTS.assignmentScoreCap,
  };
}

module.exports = {
  SCORE_LOGIC_FILENAME,
  ScoreLogicValidationError,
  SENTINEL,
  DEFAULTS,
  loadScoreLogic,
};
