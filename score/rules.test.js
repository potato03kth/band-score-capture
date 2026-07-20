const test = require('node:test');
const assert = require('node:assert/strict');

const rules = require('./rules');
const { kstMidnightUtcMs, kstEndOfDayUtcMs } = require('../lib/settings');

test('inMeasureRange: 기간 제한이 없으면 항상 true', () => {
  assert.equal(rules.inMeasureRange(Date.now(), { measureStartMs: null, measureEndMs: null }), true);
});

test('inMeasureRange: 시작 경계(KST 00:00)는 포함이다', () => {
  const measureStartMs = kstMidnightUtcMs(2026, 6, 28);
  const bounds = { measureStartMs, measureEndMs: null };
  assert.equal(rules.inMeasureRange(measureStartMs, bounds), true);
  assert.equal(rules.inMeasureRange(measureStartMs - 1, bounds), false);
});

test('inMeasureRange: 종료 경계(KST 23:59:59.999)는 포함이다', () => {
  const measureEndMs = kstEndOfDayUtcMs(2026, 6, 28);
  const bounds = { measureStartMs: null, measureEndMs };
  assert.equal(rules.inMeasureRange(measureEndMs, bounds), true);
  assert.equal(rules.inMeasureRange(measureEndMs + 1, bounds), false);
});

test('inMeasureRange: 시작만 지정되면 그 이후는 끝없이 포함', () => {
  const measureStartMs = kstMidnightUtcMs(2026, 6, 28);
  const bounds = { measureStartMs, measureEndMs: null };
  assert.equal(rules.inMeasureRange(measureStartMs + 1000 * 3600 * 24 * 365, bounds), true);
});

test('inMeasureRange: 종료만 지정되면 그 이전은 끝없이 포함', () => {
  const measureEndMs = kstEndOfDayUtcMs(2026, 6, 28);
  const bounds = { measureStartMs: null, measureEndMs };
  assert.equal(rules.inMeasureRange(0, bounds), true);
});

test('inMeasureRange: 시작~종료 구간 밖(양쪽)은 false, 안쪽은 true', () => {
  const bounds = {
    measureStartMs: kstMidnightUtcMs(2026, 6, 28),
    measureEndMs: kstEndOfDayUtcMs(2026, 6, 29),
  };
  assert.equal(rules.inMeasureRange(kstMidnightUtcMs(2026, 6, 27), bounds), false);
  assert.equal(rules.inMeasureRange(kstMidnightUtcMs(2026, 6, 28), bounds), true);
  assert.equal(rules.inMeasureRange(kstEndOfDayUtcMs(2026, 6, 29), bounds), true);
  assert.equal(rules.inMeasureRange(kstEndOfDayUtcMs(2026, 6, 29) + 1, bounds), false);
});

const ctx = {
  professorUserNos: [9001],
  assignmentPrefixRegex: /^\[과제\d+\]/,
};

test('isAssignmentPost: 교수 작성 + [과제N] 머리말 → true', () => {
  const post = { author: { user_no: 9001 }, content: '[과제1] 이번 주 과제입니다' };
  assert.equal(rules.isAssignmentPost(post, ctx), true);
});

test('isAssignmentPost: 교수 작성이지만 머리말 없음 → false', () => {
  const post = { author: { user_no: 9001 }, content: '공지사항입니다' };
  assert.equal(rules.isAssignmentPost(post, ctx), false);
});

test('isAssignmentPost: 학생이 [과제N] 머리말을 붙여도 → false(작성자 조건 불충족)', () => {
  const post = { author: { user_no: 1234 }, content: '[과제1] 저도 붙여봤어요' };
  assert.equal(rules.isAssignmentPost(post, ctx), false);
});

test('isAssignmentPost: post/author가 없으면 → false', () => {
  assert.equal(rules.isAssignmentPost(null, ctx), false);
  assert.equal(rules.isAssignmentPost({ content: '[과제1] x' }, ctx), false);
  assert.equal(rules.isAssignmentPost({ author: { user_no: null }, content: '[과제1] x' }, ctx), false);
});

test('kstDateStr: UTC 자정 직전도 KST로는 다음날로 계산된다', () => {
  // 2026-06-27T15:05:00Z = 2026-06-28 00:05 KST
  const ms = Date.UTC(2026, 5, 27, 15, 5, 0);
  assert.equal(rules.kstDateStr(ms), '2026-06-28');
});

test('kstDateStr: KST 정오는 그날 그대로', () => {
  // 2026-06-28T03:00:00Z = 2026-06-28 12:00 KST
  const ms = Date.UTC(2026, 5, 28, 3, 0, 0);
  assert.equal(rules.kstDateStr(ms), '2026-06-28');
});
