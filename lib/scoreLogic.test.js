const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scoreLogic = require('./scoreLogic');
const xlsx = require('./xlsx');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bsc-test-'));
}

test('loadScoreLogic: 파일이 없으면 템플릿을 만들고 기본값(옛 하드코딩 규칙과 동일)을 그대로 반환한다(막지 않음)', async () => {
  const dir = makeTmpDir();
  try {
    const result = await scoreLogic.loadScoreLogic(dir);
    assert.equal(result.created, true);
    assert.equal(fs.existsSync(result.filePath), true);
    assert.equal(result.dailyActivityCap, Infinity);
    assert.equal(result.dailyScoreCap, 1);
    assert.equal(result.postMultiplier, 1);
    assert.equal(result.commentMultiplier, 1);
    assert.equal(result.includeAssignmentPosts, false);
    assert.equal(result.assignmentPostScore, 5);
    assert.equal(result.assignmentScoreCap, 20);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadScoreLogic: 전부 "변경불필요"인 파일도 기본값과 동일하게 해석된다', async () => {
  const dir = makeTmpDir();
  try {
    const filePath = path.join(dir, scoreLogic.SCORE_LOGIC_FILENAME);
    await xlsx.createScoreLogicTemplate(filePath);
    const result = await scoreLogic.loadScoreLogic(dir);
    assert.equal(result.created, false);
    assert.equal(result.dailyActivityCap, Infinity);
    assert.equal(result.dailyScoreCap, 1);
    assert.equal(result.postMultiplier, 1);
    assert.equal(result.commentMultiplier, 1);
    assert.equal(result.includeAssignmentPosts, false);
    assert.equal(result.assignmentPostScore, 5);
    assert.equal(result.assignmentScoreCap, 20);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function writeValues(dir, overrides) {
  const filePath = path.join(dir, scoreLogic.SCORE_LOGIC_FILENAME);
  await xlsx.createScoreLogicTemplate(filePath);
  const wb = await xlsx.readWorkbook(filePath);
  const sheet = wb.getWorksheet('설정');
  sheet.eachRow((row, rn) => {
    if (rn === 1) return;
    const item = row.getCell(1).value;
    if (item in overrides) row.getCell(2).value = overrides[item];
  });
  await wb.xlsx.writeFile(filePath);
  return filePath;
}

test('loadScoreLogic: 값을 바꾸면 정확히 반영된다', async () => {
  const dir = makeTmpDir();
  try {
    await writeValues(dir, {
      일일활동상한: 3,
      일일점수상한: 2,
      댓글배수: 0.5,
      게시글배수: 2,
      과제글포함여부: '포함',
      과제글당점수: 10,
      과제점수상한: 30,
    });
    const result = await scoreLogic.loadScoreLogic(dir);
    assert.equal(result.dailyActivityCap, 3);
    assert.equal(result.dailyScoreCap, 2);
    assert.equal(result.commentMultiplier, 0.5);
    assert.equal(result.postMultiplier, 2);
    assert.equal(result.includeAssignmentPosts, true);
    assert.equal(result.assignmentPostScore, 10);
    assert.equal(result.assignmentScoreCap, 30);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadScoreLogic: 일일활동상한에 "무제한"을 넣으면 Infinity로 해석된다', async () => {
  const dir = makeTmpDir();
  try {
    await writeValues(dir, { 일일활동상한: '무제한' });
    const result = await scoreLogic.loadScoreLogic(dir);
    assert.equal(result.dailyActivityCap, Infinity);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadScoreLogic: 과제글포함여부에 "제외"를 넣으면 false(기존과 동일)로 해석된다', async () => {
  const dir = makeTmpDir();
  try {
    await writeValues(dir, { 과제글포함여부: '제외' });
    const result = await scoreLogic.loadScoreLogic(dir);
    assert.equal(result.includeAssignmentPosts, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadScoreLogic: 배수/상한에 0 이하 숫자를 넣으면 ScoreLogicValidationError', async () => {
  const dir = makeTmpDir();
  try {
    await writeValues(dir, { 댓글배수: 0 });
    await assert.rejects(() => scoreLogic.loadScoreLogic(dir), scoreLogic.ScoreLogicValidationError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadScoreLogic: 과제글당점수/과제점수상한에 0 이하 숫자를 넣으면 ScoreLogicValidationError', async () => {
  const dir = makeTmpDir();
  try {
    await writeValues(dir, { 과제점수상한: -1 });
    await assert.rejects(() => scoreLogic.loadScoreLogic(dir), scoreLogic.ScoreLogicValidationError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadScoreLogic: 배수/상한에 숫자도 "변경불필요"도 아닌 문자열을 넣으면 ScoreLogicValidationError', async () => {
  const dir = makeTmpDir();
  try {
    await writeValues(dir, { 일일점수상한: '많이' });
    await assert.rejects(() => scoreLogic.loadScoreLogic(dir), scoreLogic.ScoreLogicValidationError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadScoreLogic: 과제글포함여부에 "포함"/"제외"/"변경불필요" 외 값을 넣으면 ScoreLogicValidationError', async () => {
  const dir = makeTmpDir();
  try {
    await writeValues(dir, { 과제글포함여부: '몰라요' });
    await assert.rejects(() => scoreLogic.loadScoreLogic(dir), scoreLogic.ScoreLogicValidationError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadScoreLogic: 시트 구성이 손상되면 ScoreLogicValidationError', async () => {
  const dir = makeTmpDir();
  try {
    const ExcelJS = require('exceljs');
    const filePath = path.join(dir, scoreLogic.SCORE_LOGIC_FILENAME);
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('엉뚱한시트');
    await wb.xlsx.writeFile(filePath);
    await assert.rejects(() => scoreLogic.loadScoreLogic(dir), scoreLogic.ScoreLogicValidationError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
