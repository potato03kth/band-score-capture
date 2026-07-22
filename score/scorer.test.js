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

// --- Phase 8: score_logic.xlsx 파라미터화 ---

test('scoreActivities: 게시글배수/댓글배수를 다르게 주면 하루 점수가 배수만큼 반영된다', () => {
  const activities = [act(1, day1, { kind: 'post' }), act(1, day1 + 1000, { kind: 'comment' })];
  const results = scorer.scoreActivities(activities, { cap: 50, dailyScoreCap: 10, postMultiplier: 2, commentMultiplier: 3 });
  assert.equal(results.get(1).score, 5); // 게시글 1건*2 + 댓글 1건*3, 일일점수상한(10) 안 걸림
});

test('scoreActivities: 일일점수상한이 그날 점수를 자른다(배수 적용 후)', () => {
  const activities = [act(1, day1, { kind: 'comment' }), act(1, day1 + 1000, { kind: 'comment' }), act(1, day1 + 2000, { kind: 'comment' })];
  const results = scorer.scoreActivities(activities, { cap: 50, dailyScoreCap: 2, commentMultiplier: 1 });
  assert.equal(results.get(1).score, 2); // 댓글 3건*1=3이지만 일일점수상한 2에서 잘림
  assert.equal(results.get(1).commentCount, 3); // 집계용 댓글수 자체는 잘리지 않는다
});

test('scoreActivities: 일일활동상한이 그날 셀 활동 건수 자체를 자른다(배수 적용 전)', () => {
  const activities = [act(1, day1, { kind: 'comment' }), act(1, day1 + 1000, { kind: 'comment' }), act(1, day1 + 2000, { kind: 'comment' })];
  const results = scorer.scoreActivities(activities, { cap: 50, dailyActivityCap: 2, dailyScoreCap: 10, commentMultiplier: 1 });
  assert.equal(results.get(1).score, 2); // 3건 중 2건만 셈(일일활동상한) -> 배수1 -> 2점(일일점수상한 10엔 안 걸림)
});

test('scoreActivities: 여러 날에 걸쳐 일일점수상한이 매일 적용되고 총점상한이 최종 합을 자른다', () => {
  const activities = [
    act(1, day1, { kind: 'comment' }),
    act(1, day1 + 1000, { kind: 'comment' }),
    act(1, day2, { kind: 'comment' }),
  ];
  const results = scorer.scoreActivities(activities, { cap: 3, dailyScoreCap: 2, commentMultiplier: 1 });
  // day1: 댓글 2건 -> 2점(상한 안 걸림), day2: 댓글 1건 -> 1점, 합계 3 -> 총점상한 3 그대로
  assert.equal(results.get(1).score, 3);
});

test('scoreActivities: 기본값(옵션 생략)은 옛 하드코딩 규칙과 동일하다(회귀)', () => {
  const activities = [act(1, day1), act(1, day1 + 1000), act(1, day2)];
  const results = scorer.scoreActivities(activities, { cap: 50 });
  assert.equal(results.get(1).activeDays, 2);
  assert.equal(results.get(1).score, 2); // 하루에 몇 건이든 그날 최대 1점 * 2일
});

// --- scoreAssignments: 과제글(제출) 점수 — 활동점수와 완전히 별도 ---

test('scoreAssignments: 과제글 하나당 과제글당점수(n)만큼 오른다', () => {
  const activities = [act(1, day1, { kind: 'comment', postNo: 'a1' }), act(1, day2, { kind: 'comment', postNo: 'a2' })];
  const results = scorer.scoreAssignments(activities, { assignmentPostScore: 5, assignmentScoreCap: 20 });
  assert.equal(results.get(1).assignmentPostCount, 2);
  assert.equal(results.get(1).assignmentScore, 10);
});

test('scoreAssignments: 같은 과제글에 여러 번 댓글을 달아도 1개로만 친다(중복 제출 방지)', () => {
  const activities = [
    act(1, day1, { kind: 'comment', postNo: 'a1' }),
    act(1, day1 + 1000, { kind: 'comment', postNo: 'a1' }),
    act(1, day2, { kind: 'comment', postNo: 'a1' }),
  ];
  const results = scorer.scoreAssignments(activities, { assignmentPostScore: 5, assignmentScoreCap: 20 });
  assert.equal(results.get(1).assignmentPostCount, 1);
  assert.equal(results.get(1).assignmentScore, 5);
  assert.equal(results.get(1).records.length, 3); // 감사용 원본 댓글은 전부 남는다
});

test('scoreAssignments: 과제점수상한(m)을 넘으면 잘린다', () => {
  const activities = [1, 2, 3, 4, 5, 6].map((n) => act(1, day1 + n * 1000, { kind: 'comment', postNo: `a${n}` }));
  const results = scorer.scoreAssignments(activities, { assignmentPostScore: 5, assignmentScoreCap: 20 });
  assert.equal(results.get(1).assignmentPostCount, 6); // 집계 개수 자체는 안 잘림
  assert.equal(results.get(1).assignmentScore, 20); // 6*5=30이지만 상한 20에서 잘림
});

test('scoreAssignments: 기본값(옵션 생략)은 5점/20점(n=5,m=20)이다', () => {
  const activities = [act(1, day1, { kind: 'comment', postNo: 'a1' })];
  const results = scorer.scoreAssignments(activities);
  assert.equal(results.get(1).assignmentScore, 5);
});

test('scoreAssignments: 여러 유저는 독립적으로 집계된다', () => {
  const activities = [
    act(1, day1, { kind: 'comment', postNo: 'a1' }),
    act(2, day1, { kind: 'comment', postNo: 'a1' }),
    act(2, day2, { kind: 'comment', postNo: 'a2' }),
  ];
  const results = scorer.scoreAssignments(activities, { assignmentPostScore: 5, assignmentScoreCap: 20 });
  assert.equal(results.get(1).assignmentPostCount, 1);
  assert.equal(results.get(2).assignmentPostCount, 2);
});

test('scoreAssignments: 빈 활동 목록은 빈 Map을 반환한다', () => {
  const results = scorer.scoreAssignments([], { assignmentPostScore: 5, assignmentScoreCap: 20 });
  assert.equal(results.size, 0);
});
