const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const gaps = require('./gaps');
const roster = require('./roster');
const parser = require('./parser');
const scorer = require('./scorer');
const csv = require('./csv');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bsc-test-'));
}

function writeGapsFile(rawDir, bandId, gapList, updatedAtMs = 1700000000000) {
  const dir = path.join(rawDir, String(bandId));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'incomplete_gaps.json'), JSON.stringify({ gaps: gapList, updatedAtMs }));
}

function writeMemberCommentCounts(rawDir, bandId, results, ts = '1700000000000') {
  const dir = path.join(rawDir, String(bandId), '_members');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `member_comment_counts_${ts}.json`),
    JSON.stringify({ results, capturedAtMs: Number(ts) })
  );
}

function writeNdjson(filePath, lines) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
}

test('loadBandGaps: 파일 없으면 null', () => {
  const dir = makeTmpDir();
  try {
    assert.equal(gaps.loadBandGaps(dir, '999'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadBandGaps: 있으면 gaps 배열과 updatedAtMs를 반환한다', () => {
  const dir = makeTmpDir();
  try {
    writeGapsFile(dir, '111', [{ type: 'reply', reasonTier: 3 }]);
    const result = gaps.loadBandGaps(dir, '111');
    assert.equal(result.gaps.length, 1);
    assert.equal(result.updatedAtMs, 1700000000000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadMemberCommentComparison: 파일 없으면 null', () => {
  const dir = makeTmpDir();
  try {
    assert.equal(gaps.loadMemberCommentComparison(dir, '999'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadMemberCommentComparison: 화면표시값과 raw ndjson 집계를 대조해 diff를 계산한다', () => {
  const dir = makeTmpDir();
  try {
    const bandId = '111';
    writeMemberCommentCounts(dir, bandId, [
      { memberName: '김철수', userNo: 1, found: true, commentCount: 5 },
      { memberName: '이영희', userNo: 2, found: false, stage: 'click-failed' },
    ]);
    writeNdjson(path.join(dir, bandId, '2026-06-28', 'items.ndjson'), [
      { schemaType: 'comment', parentCommentId: null, data: { post_no: 1, comment_id: 'c1', author: { user_no: 1, name: '김철수' }, created_at: 1, body: 'a' } },
      { schemaType: 'comment', parentCommentId: null, data: { post_no: 1, comment_id: 'c2', author: { user_no: 1, name: '김철수' }, created_at: 1, body: 'b' } },
    ]);
    const { comparisons } = gaps.loadMemberCommentComparison(dir, bandId);
    const byName = Object.fromEntries(comparisons.map((c) => [c.memberName, c]));
    assert.equal(byName['김철수'].displayedCount, 5);
    assert.equal(byName['김철수'].capturedCount, 2);
    assert.equal(byName['김철수'].diff, 3);
    assert.equal(byName['이영희'].found, false);
    assert.equal(byName['이영희'].displayedCount, null);
    assert.equal(byName['이영희'].diff, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('collectGapSections: total-post-count-mismatch는 게시글총수로, 나머지는 게시글댓글로 분류되고 reasonTier 오름차순 정렬된다', () => {
  const dir = makeTmpDir();
  try {
    writeGapsFile(dir, '111', [
      { type: 'reply', reason: 'parent-comment-count-field-mismatch', reasonTier: 3, postNo: 1, expected: 2, captured: 1, missing: 1, parentCommentId: 'c1', parentAuthor: 'X' },
      { type: 'total-post-count-mismatch', reason: 'feed-scroll-card-count-mismatch', reasonTier: 2, postNo: null, expected: 10, captured: 8, missing: 2 },
      { type: 'displayed-count-mismatch', reason: 'post-modal-displayed-count-mismatch', reasonTier: 2, postNo: 5, expected: 3, captured: 2, missing: 1 },
    ]);
    const bands = [{ bandId: '111', name: '1반' }];
    const sections = gaps.collectGapSections(dir, bands);

    assert.equal(sections.totalPostCount.length, 1);
    assert.equal(sections.totalPostCount[0].bandName, '1반');
    assert.equal(sections.totalPostCount[0].captured, 8);

    assert.equal(sections.postComments.length, 2);
    // reasonTier 2(displayed-count-mismatch)가 3(reply)보다 먼저 와야 한다
    assert.equal(sections.postComments[0].typeLabel, '모달표시댓글수');
    assert.equal(sections.postComments[1].typeLabel, '대댓글');
    assert.equal(sections.postComments[1].parentCommentId, 'c1');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('collectGapSections: 학생댓글은 diff가 0이 아니거나 found:false인 멤버만 포함한다', () => {
  const dir = makeTmpDir();
  try {
    const bandId = '111';
    writeMemberCommentCounts(dir, bandId, [
      { memberName: '일치학생', userNo: 1, found: true, commentCount: 0 },
      { memberName: '불일치학생', userNo: 2, found: true, commentCount: 5 },
      { memberName: '확인실패학생', userNo: 3, found: false, stage: 'x' },
    ]);
    const bands = [{ bandId, name: '1반' }];
    const sections = gaps.collectGapSections(dir, bands);
    const names = sections.memberComments.map((r) => r.memberName);
    assert.ok(!names.includes('일치학생'));
    assert.ok(names.includes('불일치학생'));
    assert.ok(names.includes('확인실패학생'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureGapsWorkbook: 결손이 전혀 없으면 파일을 만들지 않는다', async () => {
  const dir = makeTmpDir();
  try {
    const bands = [{ bandId: '111', name: '1반' }];
    const result = await gaps.ensureGapsWorkbook(dir, dir, bands);
    assert.equal(result.hasGaps, false);
    assert.equal(result.created, false);
    assert.equal(fs.existsSync(result.filePath), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureGapsWorkbook: 결손이 있으면 파일을 만들고, 재실행해도 이미 채운 manual_value는 이어받는다', async () => {
  const dir = makeTmpDir();
  try {
    writeGapsFile(dir, '111', [{ type: 'total-post-count-mismatch', reasonTier: 2, expected: 10, captured: 8, missing: 2 }]);
    const bands = [{ bandId: '111', name: '1반' }];

    const first = await gaps.ensureGapsWorkbook(dir, dir, bands);
    assert.equal(first.created, true);
    assert.equal(first.hasGaps, true);
    assert.equal(fs.existsSync(first.filePath), true);

    // manual_value를 채운 뒤 다시 ensureGapsWorkbook을 불러도(재생성되더라도) 그 값은 이어받아야 한다
    const xlsx = require('../lib/xlsx');
    const wb = await xlsx.readWorkbook(first.filePath);
    wb.getWorksheet('게시글총수').getRow(2).getCell(8).value = 9;
    await wb.xlsx.writeFile(first.filePath);

    const second = await gaps.ensureGapsWorkbook(dir, dir, bands);
    assert.equal(second.created, false); // 이미 파일이 있었으므로 "새로 만들었다" 안내는 다시 뜨지 않는다
    const wb2 = await xlsx.readWorkbook(first.filePath);
    assert.equal(xlsx.readCell(wb2.getWorksheet('게시글총수').getRow(2).getCell(8)), 9);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureGapsWorkbook: 확인 엑셀이 이미 있어도 재수집으로 새로 드러난 결손은 새 행으로 추가된다(회귀 - 예전엔 무시되던 버그)', async () => {
  const dir = makeTmpDir();
  try {
    const bands = [{ bandId: '111', name: '1반' }];
    writeGapsFile(dir, '111', [{ type: 'total-post-count-mismatch', reasonTier: 2, expected: 10, captured: 8, missing: 2 }]);

    const first = await gaps.ensureGapsWorkbook(dir, dir, bands);
    const xlsx = require('../lib/xlsx');
    const wb1 = await xlsx.readWorkbook(first.filePath);
    wb1.getWorksheet('게시글총수').getRow(2).getCell(8).value = 9; // 게시글총수는 확인 완료
    await wb1.xlsx.writeFile(first.filePath);
    const midCheck = await gaps.readGapsResolution(first.filePath);
    assert.equal(midCheck.resolved, true); // 이 시점엔 모두 해결됨

    // acquire를 다시 돌려 새로운 결손(학생댓글)이 추가로 발견된 상황을 재현
    writeMemberCommentCounts(dir, '111', [{ memberName: '김철수', userNo: 1001, found: true, commentCount: 5 }]);
    writeNdjson(path.join(dir, '111', '2026-06-28', 'items.ndjson'), [
      { schemaType: 'comment', parentCommentId: null, data: { post_no: 1, comment_id: 'c1', author: { user_no: 1001, name: '김철수' }, created_at: 1, body: 'a' } },
    ]);

    const second = await gaps.ensureGapsWorkbook(dir, dir, bands);
    assert.equal(second.created, false); // 파일 자체는 이미 있었음(created 플래그는 "새 파일" 여부만 의미)
    const afterNewGap = await gaps.readGapsResolution(second.filePath);
    assert.equal(afterNewGap.resolved, false); // 새로 드러난 학생댓글 결손 때문에 다시 미해결이어야 한다
    assert.equal(afterNewGap.unresolvedCount, 1);

    // 기존에 확인해둔 게시글총수 manual_value=9는 재생성 후에도 그대로 남아있어야 한다
    const wb2 = await xlsx.readWorkbook(second.filePath);
    assert.equal(xlsx.readCell(wb2.getWorksheet('게시글총수').getRow(2).getCell(8)), 9);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureGapsWorkbook: 예전엔 결손이 있었지만 재수집으로 전부 해소되면 다음 실행에서 게이트가 stale 행으로 막지 않는다', async () => {
  const dir = makeTmpDir();
  try {
    const bands = [{ bandId: '111', name: '1반' }];
    writeGapsFile(dir, '111', [{ type: 'total-post-count-mismatch', reasonTier: 2, expected: 10, captured: 8, missing: 2 }]);

    const first = await gaps.ensureGapsWorkbook(dir, dir, bands);
    assert.equal(first.hasGaps, true);
    // manual_value를 채우지 않은 채로(미해결 상태로) 재수집이 그 결손을 실제로 해소했다고 가정
    fs.rmSync(path.join(dir, '111', 'incomplete_gaps.json'));

    const second = await gaps.ensureGapsWorkbook(dir, dir, bands);
    assert.equal(second.hasGaps, false);
    const afterResolved = await gaps.readGapsResolution(second.filePath);
    assert.equal(afterResolved.resolved, true); // stale 미해결 행이 남아 게이트를 막으면 안 된다
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readGapsResolution: 파일이 없으면 결손없음/게이트통과로 취급한다', async () => {
  const dir = makeTmpDir();
  try {
    const result = await gaps.readGapsResolution(path.join(dir, '없음.xlsx'));
    assert.equal(result.resolved, true);
    assert.equal(result.unresolvedCount, 0);
    assert.equal(result.corrections.bandPostCountOverrides.size, 0);
    assert.equal(result.corrections.memberCommentDeltas.size, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readGapsResolution: manual_value 미기입 항목이 있으면 resolved:false, 채우면 resolved:true + 보정치 계산', async () => {
  const dir = makeTmpDir();
  try {
    writeGapsFile(dir, '111', [{ type: 'total-post-count-mismatch', reasonTier: 2, expected: 10, captured: 8, missing: 2 }]);
    writeMemberCommentCounts(dir, '111', [{ memberName: 'A', userNo: 1, found: true, commentCount: 5 }]);
    writeNdjson(path.join(dir, '111', '2026-06-28', 'items.ndjson'), [
      { schemaType: 'comment', parentCommentId: null, data: { post_no: 1, comment_id: 'c1', author: { user_no: 1, name: 'A' }, created_at: 1, body: 'x' } },
    ]);
    const bands = [{ bandId: '111', name: '1반' }];
    const { filePath } = await gaps.ensureGapsWorkbook(dir, dir, bands);

    const beforeFill = await gaps.readGapsResolution(filePath);
    assert.equal(beforeFill.resolved, false);
    assert.equal(beforeFill.unresolvedCount, 2); // 게시글총수 1건 + 학생댓글 1건(캡처1 vs 표시5)

    const xlsx = require('../lib/xlsx');
    const wb = await xlsx.readWorkbook(filePath);
    wb.getWorksheet('게시글총수').getRow(2).getCell(8).value = 9; // manual_value
    wb.getWorksheet('학생댓글').getRow(2).getCell(8).value = 5; // manual_value = 화면표시값 그대로 확정
    await wb.xlsx.writeFile(filePath);

    const afterFill = await gaps.readGapsResolution(filePath);
    assert.equal(afterFill.resolved, true);
    assert.equal(afterFill.unresolvedCount, 0);
    assert.equal(afterFill.corrections.bandPostCountOverrides.get('111'), 9);
    assert.equal(afterFill.corrections.memberCommentDeltas.get(1), 4); // 5(manual) - 1(captured)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readGapsResolution: 시트 구성이 손상되면 GapsValidationError를 던진다', async () => {
  const dir = makeTmpDir();
  try {
    const ExcelJS = require('exceljs');
    const filePath = path.join(dir, '부적합_데이터_확인.xlsx');
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('엉뚱한시트');
    await wb.xlsx.writeFile(filePath);
    await assert.rejects(() => gaps.readGapsResolution(filePath), gaps.GapsValidationError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('applyMemberCommentCorrections: 기존 활동이 있는 유저는 commentCount/score를 보정한다', () => {
  const scores = new Map([[1, { userNo: 1, activeDays: 2, postCount: 1, commentCount: 1, score: 2, records: [] }]]);
  const result = gaps.applyMemberCommentCorrections(scores, new Map([[1, 3]]), { cap: 50 });
  const entry = result.get(1);
  assert.equal(entry.commentCount, 4);
  assert.equal(entry.activeDays, 2); // 이미 활동일수 > 0이면 건드리지 않는다
  assert.equal(entry.score, 2);
  assert.equal(entry.records.length, 1);
  assert.ok(entry.records[0].textPreview.includes('수동 보정'));
});

test('applyMemberCommentCorrections: 활동일수 0이던 유저가 확인된 활동이 있으면(delta>0) 활동일수를 1로 끌어올린다', () => {
  const scores = new Map([[1, { userNo: 1, activeDays: 0, postCount: 0, commentCount: 0, score: 0, records: [] }]]);
  const result = gaps.applyMemberCommentCorrections(scores, new Map([[1, 2]]), { cap: 50 });
  const entry = result.get(1);
  assert.equal(entry.commentCount, 2);
  assert.equal(entry.activeDays, 1);
  assert.equal(entry.score, 1);
});

test('applyMemberCommentCorrections: scores에 아예 없던 유저(무활동 후보)도 보정치로 새 항목이 생긴다', () => {
  const scores = new Map();
  const result = gaps.applyMemberCommentCorrections(scores, new Map([[7, 3]]), { cap: 50 });
  const entry = result.get(7);
  assert.ok(entry);
  assert.equal(entry.commentCount, 3);
  assert.equal(entry.activeDays, 1);
  assert.equal(entry.score, 1);
});

test('applyMemberCommentCorrections: delta<0(과대측정)은 활동일수를 깎지 않는다(보수적 선택)', () => {
  const scores = new Map([[1, { userNo: 1, activeDays: 3, postCount: 0, commentCount: 5, score: 3, records: [] }]]);
  const result = gaps.applyMemberCommentCorrections(scores, new Map([[1, -2]]), { cap: 50 });
  const entry = result.get(1);
  assert.equal(entry.commentCount, 3);
  assert.equal(entry.activeDays, 3);
  assert.equal(entry.score, 3);
});

// --- Phase 8: score_logic.xlsx의 dailyScoreCap/commentMultiplier와 일관되게 동작해야 함 ---

test('applyMemberCommentCorrections: dailyScoreCap/commentMultiplier를 커스텀하면 0→1 활동일수 보정치도 같은 공식으로 계산된다', () => {
  const scores = new Map([[1, { userNo: 1, activeDays: 0, postCount: 0, commentCount: 0, score: 0, records: [] }]]);
  // 댓글배수=3, 일일점수상한=2 -> 하루짜리 보정은 min(3,2)=2점이어야 한다(옛 기본값이면 무조건 1점)
  const result = gaps.applyMemberCommentCorrections(scores, new Map([[1, 1]]), { cap: 50, dailyScoreCap: 2, commentMultiplier: 3 });
  const entry = result.get(1);
  assert.equal(entry.activeDays, 1);
  assert.equal(entry.score, 2);
});

test('applyMemberCommentCorrections: 이미 활동일수>0인 유저는 score_logic 커스텀 여부와 무관하게 기존 score를 그대로 보존한다(재계산 안 함)', () => {
  // scorer.js가 배수 3짜리 하루로 계산해 score=6이 이미 들어있다고 가정 - activeDays(2)로부터
  // 다시 계산하면(Math.min(2,cap)) 틀린 값이 나오므로, 이 보정 함수는 activeDays를 안 건드리는
  // 경우 score도 절대 재계산하면 안 된다(Phase 8 이전엔 늘 score===activeDays였어서 안 드러났던
  // 버그 - 발견 즉시 수정).
  const scores = new Map([[1, { userNo: 1, activeDays: 2, postCount: 0, commentCount: 4, score: 6, records: [] }]]);
  const result = gaps.applyMemberCommentCorrections(scores, new Map([[1, 1]]), { cap: 50, dailyScoreCap: 3, commentMultiplier: 3 });
  const entry = result.get(1);
  assert.equal(entry.activeDays, 2); // 이미 활동 있음 - 안 건드림
  assert.equal(entry.score, 6); // Math.min(2,50)=2로 잘못 재계산되면 안 된다
});

test('applyMemberCommentCorrections: 파라미터를 생략하면(옵션 없음) 옛 기본값(1,1)으로 동작한다(회귀)', () => {
  const scores = new Map([[1, { userNo: 1, activeDays: 0, postCount: 0, commentCount: 0, score: 0, records: [] }]]);
  const result = gaps.applyMemberCommentCorrections(scores, new Map([[1, 1]]), { cap: 50 });
  assert.equal(result.get(1).score, 1);
});

test('applyMemberCommentCorrections: delta 0은 건드리지 않는다', () => {
  const scores = new Map([[1, { userNo: 1, activeDays: 1, postCount: 0, commentCount: 2, score: 1, records: [] }]]);
  const result = gaps.applyMemberCommentCorrections(scores, new Map([[1, 0]]), { cap: 50 });
  assert.deepEqual(result.get(1), scores.get(1));
});

test('엔드투엔드: 미해결 상태 → 채점 거부 → manual_value 채움 → 재실행 → 반영되어 채점 진행', async () => {
  const dir = makeTmpDir();
  try {
    const rawDir = dir;
    const inputDir = path.join(dir, 'input');
    const bandId = '111';
    const bands = [{ bandId, name: '1반' }];

    // 멤버 스냅샷: 활동있음학생(캡처 1건 확보), 무활동학생(캡처 0건 - 완전히 놓친 케이스)
    const membersDir = path.join(rawDir, bandId, '_members');
    fs.mkdirSync(membersDir, { recursive: true });
    fs.writeFileSync(
      path.join(membersDir, 'members_1700000000000.json'),
      JSON.stringify({
        members: [
          { user_no: 1, name: '활동있음학생', role: 'member' },
          { user_no: 2, name: '무활동학생', role: 'member' },
        ],
      })
    );
    writeNdjson(path.join(rawDir, bandId, '2026-06-28', 'items.ndjson'), [
      {
        schemaType: 'comment',
        parentCommentId: null,
        data: { post_no: 1, comment_id: 'c1', author: { user_no: 1, name: '활동있음학생' }, created_at: Date.UTC(2026, 5, 28, 3, 0, 0), body: '댓글' },
      },
    ]);

    // 결손: 게시글총수 불일치(밴드 단위) + 무활동학생의 댓글이 화면표시상 2건인데 캡처는 0건
    writeGapsFile(rawDir, bandId, [
      { type: 'total-post-count-mismatch', reason: 'feed-scroll-card-count-mismatch', reasonTier: 2, postNo: null, expected: 5, captured: 3, missing: 2 },
    ]);
    writeMemberCommentCounts(rawDir, bandId, [
      { memberName: '활동있음학생', userNo: 1, found: true, commentCount: 1 }, // 일치 - 확인 불필요
      { memberName: '무활동학생', userNo: 2, found: true, commentCount: 2 }, // 불일치 - 확인 필요
    ]);

    // 1단계: 채점 시작 전 게이트 확인 - 확인 엑셀이 없으므로 새로 만들고 거부되어야 한다
    const gapsCheck = await gaps.ensureGapsWorkbook(inputDir, rawDir, bands);
    assert.equal(gapsCheck.created, true);
    assert.equal(gapsCheck.hasGaps, true);

    const beforeFill = await gaps.readGapsResolution(gapsCheck.filePath);
    assert.equal(beforeFill.resolved, false); // 채점 거부되어야 하는 상태
    assert.equal(beforeFill.unresolvedCount, 2);

    // 2단계: 교수가 manual_value를 채운다(게시글총수: 실제로는 5건 맞음 확인 / 학생댓글: 화면표시 2건 확정)
    const xlsx = require('../lib/xlsx');
    const wb = await xlsx.readWorkbook(gapsCheck.filePath);
    wb.getWorksheet('게시글총수').getRow(2).getCell(8).value = 5;
    wb.getWorksheet('학생댓글').getRow(2).getCell(8).value = 2;
    await wb.xlsx.writeFile(gapsCheck.filePath);

    // 3단계: 재실행 시 게이트 확인 - 이제 통과해야 한다
    const afterFill = await gaps.readGapsResolution(gapsCheck.filePath);
    assert.equal(afterFill.resolved, true);

    // 4단계: 실제 채점 파이프라인(roster+parser+scorer+csv)에 보정치를 반영해 진행
    const { activities } = parser.parseBandRaw(rawDir, bandId);
    const scoresBeforeCorrection = scorer.scoreActivities(activities, { cap: 50 });
    assert.equal(scoresBeforeCorrection.has(2), false); // 보정 전에는 무활동학생이 아예 없다

    const scores = gaps.applyMemberCommentCorrections(scoresBeforeCorrection, afterFill.corrections.memberCommentDeltas, { cap: 50 });
    const bandPostCounts = gaps.applyBandPostCountOverrides(new Map([[bandId, 3]]), afterFill.corrections.bandPostCountOverrides);

    const { candidates } = roster.collectCandidateMembers(rawDir, bands, { taUserNos: [] });
    const mapping = roster.buildFinalMapping(candidates, new Map());
    const rows = csv.buildRows({ mapping, scores, cap: 50, bandCollectionComplete: new Map([[bandId, true]]), generatedAt: 'now' });
    const rowByName = Object.fromEntries(rows.map((r) => [r.실명, r]));

    // 반영 결과: 무활동학생은 더 이상 0점이 아니라 확인된 활동으로 1점을 받는다
    assert.equal(rowByName['무활동학생'].활동일수, 1);
    assert.equal(rowByName['무활동학생'].댓글수, 2);
    assert.equal(rowByName['무활동학생'].점수, 1);
    assert.ok(rowByName['무활동학생']._records[0].textPreview.includes('수동 보정'));
    // 활동있음학생은 원래 캡처값 그대로(보정 대상 아님)
    assert.equal(rowByName['활동있음학생'].활동일수, 1);
    assert.equal(rowByName['활동있음학생'].댓글수, 1);

    const bandSummaryRows = csv.buildBandSummaryRows(bands, bandPostCounts);
    assert.equal(bandSummaryRows[0].캡처된_게시글수, 5); // 게시글총수 보정 반영
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('applyBandPostCountOverrides: 지정된 밴드만 덮어쓰고 나머지는 그대로 둔다', () => {
  const bandPostCounts = new Map([
    ['111', 8],
    ['222', 5],
  ]);
  const result = gaps.applyBandPostCountOverrides(bandPostCounts, new Map([['111', 9]]));
  assert.equal(result.get('111'), 9);
  assert.equal(result.get('222'), 5);
});
