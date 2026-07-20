// 규칙1·3: 필터링을 통과한 활동 레코드를 학생(user_no)별로 날짜 집계해 활동일수·점수를 낸다.
const rules = require('./rules');

// activities: rules.js로 이미 필터링된(측정기간 내 + 과제글 제외 + 소거집합 아님) 활동만 전달.
// 반환: Map<userNo, { userNo, activeDays, score, records:[{dateStr,...activity}] }>
function scoreActivities(activities, { cap }) {
  const byUser = new Map();
  for (const a of activities) {
    if (!byUser.has(a.userNo)) byUser.set(a.userNo, { dates: new Set(), records: [] });
    const entry = byUser.get(a.userNo);
    const dateStr = rules.kstDateStr(a.createdAtMs);
    entry.dates.add(dateStr);
    entry.records.push({ ...a, dateStr });
  }

  const results = new Map();
  for (const [userNo, entry] of byUser) {
    const activeDays = entry.dates.size;
    const postCount = entry.records.filter((r) => r.kind === 'post').length;
    const commentCount = entry.records.filter((r) => r.kind === 'comment').length;
    results.set(userNo, {
      userNo,
      activeDays,
      postCount,
      commentCount,
      score: Math.min(activeDays, cap),
      records: entry.records.sort((x, y) => x.createdAtMs - y.createdAtMs),
    });
  }
  return results;
}

module.exports = { scoreActivities };
