const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ExcelJS = require('exceljs');

const csv = require('./csv');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bsc-test-'));
}

test('buildRows: 매핑 순서와 무관하게 밴드명 오름차순, 밴드 내 점수 내림차순으로 정렬된다', () => {
  const mapping = new Map([
    [1, { userNo: 1, name: '홍길동', bandId: '222', bandName: '2반', studentId: 's1', mappingStatus: 'matched' }],
    [2, { userNo: 2, name: '김철수', bandId: '111', bandName: '1반', studentId: 's2', mappingStatus: 'matched' }],
    [3, { userNo: 3, name: '이영희', bandId: '111', bandName: '1반', studentId: 's3', mappingStatus: 'matched' }],
  ]);
  const scores = new Map([
    [2, { activeDays: 1, score: 1, records: [] }],
    [3, { activeDays: 5, score: 5, records: [] }],
  ]);
  const bandCollectionComplete = new Map([
    ['111', true],
    ['222', false],
  ]);
  const rows = csv.buildRows({ mapping, scores, cap: 50, bandCollectionComplete, generatedAt: 'now' });

  assert.deepEqual(
    rows.map((r) => r.실명),
    ['이영희', '김철수', '홍길동']
  );
  assert.equal(rows[0].band_name, '1반');
  assert.equal(rows[0].점수, 5);
  assert.equal(rows[1].점수, 1);
  assert.equal(rows[2].band_name, '2반');
});

test('buildRows: 활동 기록이 없는 사용자는 활동일수/점수 0, "활동 없음"으로 표시된다', () => {
  const mapping = new Map([
    [1, { userNo: 1, name: '무활동학생', bandId: '111', bandName: '1반', studentId: 's1', mappingStatus: 'matched' }],
  ]);
  const rows = csv.buildRows({
    mapping,
    scores: new Map(),
    cap: 50,
    bandCollectionComplete: new Map([['111', true]]),
    generatedAt: 'now',
  });
  assert.equal(rows[0].활동일수, 0);
  assert.equal(rows[0].점수, 0);
  assert.equal(rows[0].감사근거, '활동 없음');
});

test('buildRows: 수집완료여부는 bandCollectionComplete를 그대로 반영한다', () => {
  const mapping = new Map([
    [1, { userNo: 1, name: 'A', bandId: '111', bandName: '1반', studentId: 's1', mappingStatus: 'matched' }],
    [2, { userNo: 2, name: 'B', bandId: '222', bandName: '2반', studentId: 's2', mappingStatus: 'matched' }],
  ]);
  const bandCollectionComplete = new Map([
    ['111', true],
    ['222', false],
  ]);
  const rows = csv.buildRows({ mapping, scores: new Map(), cap: 50, bandCollectionComplete, generatedAt: 'now' });
  const byBand = Object.fromEntries(rows.map((r) => [r.band_name, r.수집완료여부]));
  assert.equal(byBand['1반'], '완료');
  assert.equal(byBand['2반'], '미완료(확인 필요)');
});

test('writeCsv: 헤더가 COLUMN_DESCRIPTIONS 순서와 일치하고, 콤마/줄바꿈/따옴표가 이스케이프된다', () => {
  const dir = makeTmpDir();
  try {
    const filePath = path.join(dir, 'scores.csv');
    const rows = [
      {
        학번: 's1',
        실명: '홍길동, 반장',
        user_no: 1,
        band_id: '111',
        band_name: '1반',
        활동일수: 3,
        점수: 3,
        매핑상태: 'matched',
        수집완료여부: '완료',
        감사근거: '3건 활동',
        산출시각: '2026-07-21T00:00:00.000Z',
      },
    ];
    csv.writeCsv(filePath, rows);
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.trim().split('\n');
    assert.equal(lines[0], csv.COLUMN_DESCRIPTIONS.map(([col]) => col).join(','));
    assert.ok(lines[1].includes('"홍길동, 반장"'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeCsv: 값에 큰따옴표가 있으면 두 배로 이스케이프된다', () => {
  const dir = makeTmpDir();
  try {
    const filePath = path.join(dir, 'scores.csv');
    const rows = [{ 학번: 's1', 실명: '별명 "홍"길동', user_no: 1, band_id: '111', band_name: '1반' }];
    csv.writeCsv(filePath, rows);
    const content = fs.readFileSync(filePath, 'utf8');
    assert.ok(content.includes('"별명 ""홍""길동"'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeAuditWorkbook: 결과/컬럼 설명/감사 3개 시트를 만들고 감사 시트에 활동 기록을 나열한다', async () => {
  const dir = makeTmpDir();
  try {
    const filePath = path.join(dir, 'audit.xlsx');
    const rows = [
      {
        학번: 's1',
        실명: '홍길동',
        user_no: 1,
        band_id: '111',
        band_name: '1반',
        활동일수: 1,
        점수: 1,
        매핑상태: 'matched',
        수집완료여부: '완료',
        감사근거: '2건 활동',
        산출시각: 'now',
        _records: [
          { dateStr: '2026-06-28', kind: 'post', postNo: '1', textPreview: '글1' },
          { dateStr: '2026-06-28', kind: 'comment', postNo: '1', textPreview: '댓글1' },
        ],
      },
    ];
    await csv.writeAuditWorkbook(filePath, rows);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(filePath);
    const sheetNames = wb.worksheets.map((s) => s.name);
    assert.deepEqual(sheetNames, ['결과', '컬럼 설명', '감사']);

    const resultSheet = wb.getWorksheet('결과');
    assert.equal(resultSheet.getRow(1).getCell(1).value, '학번');
    assert.equal(resultSheet.getRow(2).getCell(2).value, '홍길동');

    const auditSheet = wb.getWorksheet('감사');
    assert.equal(auditSheet.rowCount, 3); // 헤더 1 + 활동 2건
    assert.equal(auditSheet.getRow(2).getCell(5).value, '게시글');
    assert.equal(auditSheet.getRow(3).getCell(5).value, '댓글');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeUnmatchedCsv: synthetic/ambiguous 매핑상태만 걸러서 쓰고 개수를 반환한다', () => {
  const dir = makeTmpDir();
  try {
    const filePath = path.join(dir, 'unmatched.csv');
    const rows = [
      { 학번: 's1', 실명: 'A', user_no: 1, band_name: '1반', 매핑상태: 'matched' },
      { 학번: 'TEST0001', 실명: 'B', user_no: 2, band_name: '1반', 매핑상태: 'synthetic' },
      { 학번: 's3', 실명: 'C', user_no: 3, band_name: '1반', 매핑상태: 'ambiguous' },
      { 학번: 'TEST0002', 실명: 'D', user_no: 4, band_name: '1반', 매핑상태: 'ambiguous-synthetic' },
    ];
    const count = csv.writeUnmatchedCsv(filePath, rows);
    assert.equal(count, 3);
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.trim().split('\n');
    assert.equal(lines.length, 4); // 헤더 + 3건
    assert.equal(lines[0], '학번(임시),실명,user_no,band_name,매핑상태');
    assert.ok(!content.includes(',A,1,1반,matched'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeUnmatchedCsv: 전부 matched면 개수 0, 헤더만 있는 파일을 쓴다', () => {
  const dir = makeTmpDir();
  try {
    const filePath = path.join(dir, 'unmatched.csv');
    const rows = [{ 학번: 's1', 실명: 'A', user_no: 1, band_name: '1반', 매핑상태: 'matched' }];
    const count = csv.writeUnmatchedCsv(filePath, rows);
    assert.equal(count, 0);
    const content = fs.readFileSync(filePath, 'utf8');
    assert.equal(content.trim(), '학번(임시),실명,user_no,band_name,매핑상태');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
