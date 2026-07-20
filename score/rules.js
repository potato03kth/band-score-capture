// 채점 규칙 판정(순수 함수만). PLAN.md D-3의 규칙2·4·5·6 담당.
// acquire/의 로직과는 별도로 유지한다(브리프 절대제약: 취득/채점 분리 — 밴드 UI가 바뀌어도
// 채점 로직은 안 건드리게 하기 위함).

function inMeasureRange(createdAtMs, { measureStartMs, measureEndMs }) {
  if (measureStartMs != null && createdAtMs < measureStartMs) return false;
  if (measureEndMs != null && createdAtMs > measureEndMs) return false;
  return true;
}

// 규칙5·R3: 과제글 = 작성자가 교수(professorUserNos) AND 머리말이 ^[과제n]. 둘 다 만족해야 한다.
// 학생이 [과제1]을 붙여 쓴 글, 교수가 머리말 없이 쓴 글은 과제글이 아니다.
function isAssignmentPost(post, { professorUserNos, assignmentPrefixRegex }) {
  if (!post || !post.author || post.author.user_no == null) return false;
  if (!professorUserNos.includes(post.author.user_no)) return false;
  return assignmentPrefixRegex.test(post.content || '');
}

// KST(UTC+9) 기준 날짜 문자열(YYYY-MM-DD). +1/day 집계의 "하루" 경계 기준.
function kstDateStr(createdAtMs) {
  const d = new Date(createdAtMs + 9 * 3600 * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

module.exports = { inMeasureRange, isAssignmentPost, kstDateStr };
