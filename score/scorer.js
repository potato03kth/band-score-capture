// 규칙1·3: 필터링을 통과한 활동 레코드를 학생(user_no)별로 날짜 집계해 활동일수·점수를 낸다.
// Phase 8(input/score_logic.xlsx)로 일자별 채점 공식이 파라미터화됐다. 기본값
// (dailyActivityCap=Infinity, dailyScoreCap=1, postMultiplier=commentMultiplier=1)은 그
// 이전의 하드코딩 규칙("하루에 활동이 있으면 그날 최대 1점, 게시글/댓글 동일배점")과 정확히
// 같은 점수를 낸다 — 그 등가성이 lib/scoreLogic.js DEFAULTS와 score/scorer.test.js 회귀
// 테스트로 보장된다.
const rules = require('./rules');

// activities: rules.js/index.js로 이미 필터링된(측정기간 내 + 소거집합 아님, 과제글 제외
// 여부는 score_logic.xlsx의 과제글포함여부에 따라 호출부에서 이미 반영됨) 활동만 전달.
// 반환: Map<userNo, { userNo, activeDays, postCount, commentCount, score, records:[{dateStr,...activity}] }>
function scoreActivities(
  activities,
  { cap, dailyActivityCap = Infinity, dailyScoreCap = 1, postMultiplier = 1, commentMultiplier = 1 }
) {
  const byUser = new Map();
  for (const a of activities) {
    if (!byUser.has(a.userNo)) byUser.set(a.userNo, { byDate: new Map(), records: [] });
    const entry = byUser.get(a.userNo);
    const dateStr = rules.kstDateStr(a.createdAtMs);
    const record = { ...a, dateStr };
    entry.records.push(record);
    const dayRecords = entry.byDate.get(dateStr);
    if (dayRecords) dayRecords.push(record);
    else entry.byDate.set(dateStr, [record]);
  }

  const results = new Map();
  for (const [userNo, entry] of byUser) {
    const postCount = entry.records.filter((r) => r.kind === 'post').length;
    const commentCount = entry.records.filter((r) => r.kind === 'comment').length;

    let rawTotal = 0;
    for (const dayRecords of entry.byDate.values()) {
      // 일일활동상한: 그날 셀 활동 건수 자체를 시간순으로 자른다(배수 적용 전).
      const counted = Number.isFinite(dailyActivityCap)
        ? dayRecords.slice().sort((x, y) => x.createdAtMs - y.createdAtMs).slice(0, dailyActivityCap)
        : dayRecords;
      const rawDayScore = counted.reduce((sum, r) => sum + (r.kind === 'post' ? postMultiplier : commentMultiplier), 0);
      rawTotal += Math.min(rawDayScore, dailyScoreCap); // 일일점수상한
    }

    results.set(userNo, {
      userNo,
      activeDays: entry.byDate.size,
      postCount,
      commentCount,
      score: Math.min(rawTotal, cap), // 총점상한(1_설정.xlsx)
      records: entry.records.sort((x, y) => x.createdAtMs - y.createdAtMs),
    });
  }
  return results;
}

module.exports = { scoreActivities };
