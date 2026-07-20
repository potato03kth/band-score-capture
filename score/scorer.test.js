const test = require('node:test');
const assert = require('node:assert/strict');

const scorer = require('./scorer');

function act(userNo, createdAtMs, extra = {}) {
  return { userNo, createdAtMs, kind: 'post', postNo: '1', ...extra };
}

// KST 기준 서로 다른 날짜가 되도록 정오(UTC+9 기준 안전 지대)로 잡는다.
const day1 = Date.UTC(2026, 5, 28, 3, 0, 0); // 2026-06-28 12:00 KST
const day2 = Date.UTC(2026, 5, 29, 3, 0, 0); // 2026-06-29 12:00 KST
const day3 = Date.UTC(2026, 5, 30, 3, 0, 0); // 2026-06-30 12:00 KST

test('scoreActivities: 같은 날 여러 활동은 활동일수 1로 집계된다', () => {
  const activities = [act(1, day1), act(1, day1 + 1000), act(1, day1 + 2000)];
  const results = scorer.scoreActivities(activities, { cap: 50 });
  assert.equal(results.get(1).activeDays, 1);
  assert.equal(results.get(1).score, 1);
});

test('scoreActivities: 서로 다른 날 활동은 날짜 수만큼 활동일수가 오른다', () => {
  const activities = [act(1, day1), act(1, day2), act(1, day3)];
  const results = scorer.scoreActivities(activities, { cap: 50 });
  assert.equal(results.get(1).activeDays, 3);
  assert.equal(results.get(1).score, 3);
});

test('scoreActivities: 활동일수가 cap을 넘으면 점수는 cap으로 제한된다', () => {
  const activities = [act(1, day1), act(1, day2), act(1, day3)];
  const results = scorer.scoreActivities(activities, { cap: 2 });
  assert.equal(results.get(1).activeDays, 3);
  assert.equal(results.get(1).score, 2);
});

test('scoreActivities: cap 미만이면 점수 = 활동일수', () => {
  const activities = [act(1, day1)];
  const results = scorer.scoreActivities(activities, { cap: 50 });
  assert.equal(results.get(1).score, 1);
});

test('scoreActivities: 여러 유저는 독립적으로 집계된다', () => {
  const activities = [act(1, day1), act(2, day1), act(2, day2)];
  const results = scorer.scoreActivities(activities, { cap: 50 });
  assert.equal(results.get(1).activeDays, 1);
  assert.equal(results.get(2).activeDays, 2);
});

test('scoreActivities: records는 dateStr이 붙고 시간순 정렬된다', () => {
  const activities = [act(1, day2), act(1, day1)];
  const results = scorer.scoreActivities(activities, { cap: 50 });
  const records = results.get(1).records;
  assert.equal(records.length, 2);
  assert.equal(records[0].createdAtMs, day1);
  assert.equal(records[1].createdAtMs, day2);
  assert.equal(records[0].dateStr, '2026-06-28');
  assert.equal(records[1].dateStr, '2026-06-29');
});

test('scoreActivities: 게시글/댓글 종류별로 postCount/commentCount를 센다', () => {
  const activities = [
    act(1, day1, { kind: 'post' }),
    act(1, day1 + 1000, { kind: 'post' }),
    act(1, day2, { kind: 'comment' }),
    act(1, day3, { kind: 'comment' }),
    act(1, day3 + 1000, { kind: 'comment' }),
  ];
  const results = scorer.scoreActivities(activities, { cap: 50 });
  assert.equal(results.get(1).postCount, 2);
  assert.equal(results.get(1).commentCount, 3);
});

test('scoreActivities: 활동이 없는 종류는 0으로 집계된다', () => {
  const activities = [act(1, day1, { kind: 'post' })];
  const results = scorer.scoreActivities(activities, { cap: 50 });
  assert.equal(results.get(1).postCount, 1);
  assert.equal(results.get(1).commentCount, 0);
});

test('scoreActivities: 빈 활동 목록은 빈 Map을 반환한다', () => {
  const results = scorer.scoreActivities([], { cap: 50 });
  assert.equal(results.size, 0);
});
