const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ExcelJS = require('exceljs');

const csv = require('./csv');
const scorer = require('./scorer');

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

test('buildRows: 활동 기록이 없는 사용자는 활동일수/점수/게시글수/댓글수 0, "활동 없음"으로 표시된다', () => {
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
  assert.equal(rows[0].게시글수, 0);
  assert.equal(rows[0].댓글수, 0);
  assert.equal(rows[0].점수, 0);
  assert.equal(rows[0].감사근거, '활동 없음');
});

test('buildRows: 게시글수/댓글수는 scores의 postCount/commentCount를 그대로 옮긴다', () => {
  const mapping = new Map([
    [1, { userNo: 1, name: 'A', bandId: '111', bandName: '1반', studentId: 's1', mappingStatus: 'matched' }],
  ]);
  const scores = new Map([[1, { activeDays: 2, postCount: 3, commentCount: 5, score: 2, records: [] }]]);
  const rows = csv.buildRows({ mapping, scores, cap: 50, bandCollectionComplete: new Map([['111', true]]), generatedAt: 'now' });
  assert.equal(rows[0].게시글수, 3);
  assert.equal(rows[0].댓글수, 5);
});

test('buildRows: 게시글수+댓글수는 scorer.scoreActivities가 만든 감사 원장(records)의 실제 종류별 건수와 일치한다', () => {
  const activities = [
    { userNo: 1, createdAtMs: Date.UTC(2026, 5, 28, 3, 0, 0), kind: 'post', postNo: '1', textPreview: '글1' },
    { userNo: 1, createdAtMs: Date.UTC(2026, 5, 28, 3, 1, 0), kind: 'post', postNo: '2', textPreview: '글2' },
    { userNo: 1, createdAtMs: Date.UTC(2026, 5, 29, 3, 0, 0), kind: 'comment', postNo: '1', textPreview: '댓글1' },
  ];
  const scores = scorer.scoreActivities(activities, { cap: 50 });
  const mapping = new Map([
    [1, { userNo: 1, name: 'A', bandId: '111', bandName: '1반', studentId: 's1', mappingStatus: 'matched' }],
  ]);
  const rows = csv.buildRows({ mapping, scores, cap: 50, bandCollectionComplete: new Map([['111', true]]), generatedAt: 'now' });

  const records = rows[0]._records;
  const postRecordCount = records.filter((r) => r.kind === 'post').length;
  const commentRecordCount = records.filter((r) => r.kind === 'comment').length;
  assert.equal(rows[0].게시글수, postRecordCount);
  assert.equal(rows[0].댓글수, commentRecordCount);
  assert.equal(rows[0].게시글수, 2);
  assert.equal(rows[0].댓글수, 1);
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

test('writeAuditWorkbook: 밴드요약/결과/컬럼 설명/감사 4개 시트를 만들고 감사 시트에 활동 기록을 나열한다', async () => {
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
    const bandSummaryRows = csv.buildBandSummaryRows(
      [{ name: '1반', bandId: '111', expectedPostCount: 10 }],
      new Map([['111', 10]])
    );
    await csv.writeAuditWorkbook(filePath, rows, bandSummaryRows);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(filePath);
    const sheetNames = wb.worksheets.map((s) => s.name);
    assert.deepEqual(sheetNames, ['밴드요약', '결과', '컬럼 설명', '감사']);

    const summarySheet = wb.getWorksheet('밴드요약');
    assert.equal(summarySheet.getRow(2).getCell(1).value, '1반');
    assert.equal(summarySheet.getRow(2).getCell(3).value, 10);
    assert.equal(summarySheet.getRow(2).getCell(4).value, 10);
    assert.equal(summarySheet.getRow(2).getCell(5).value, '일치');

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

test('writeAuditWorkbook: 결과 시트에서 활동일수/게시글수/댓글수/점수가 0인 셀만 배경(fill)이 설정된다', async () => {
  const dir = makeTmpDir();
  try {
    const filePath = path.join(dir, 'audit.xlsx');
    const rows = [
      {
        학번: 's1',
        실명: '활동학생',
        user_no: 1,
        band_id: '111',
        band_name: '1반',
        활동일수: 2,
        게시글수: 1,
        댓글수: 1,
        점수: 2,
        매핑상태: 'matched',
        수집완료여부: '완료',
        감사근거: '2건 활동',
        산출시각: 'now',
        _records: [],
      },
      {
        학번: 's2',
        실명: '무활동학생',
        user_no: 2,
        band_id: '111',
        band_name: '1반',
        활동일수: 0,
        게시글수: 0,
        댓글수: 0,
        점수: 0,
        매핑상태: 'matched',
        수집완료여부: '완료',
        감사근거: '활동 없음',
        산출시각: 'now',
        _records: [],
      },
    ];
    await csv.writeAuditWorkbook(filePath, rows, []);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(filePath);
    const resultSheet = wb.getWorksheet('결과');

    const header = resultSheet.getRow(1).values;
    const colIndex = (name) => header.indexOf(name);
    const zeroCols = ['활동일수', '게시글수', '댓글수', '점수'].map(colIndex);

    // row 2 = 활동학생 (0값 없음) → 강조 컬럼 전부 fill 없음
    for (const idx of zeroCols) {
      const cell = resultSheet.getRow(2).getCell(idx);
      assert.equal(cell.fill, undefined, `활동학생의 ${cell.col ?? idx}열은 fill이 없어야 함`);
    }
    // 학번 컬럼(0이 될 수 없는 문자열 컬럼)은 강조 대상 아님
    assert.equal(resultSheet.getRow(3).getCell(colIndex('학번')).fill, undefined);

    // row 3 = 무활동학생 (전부 0) → 강조 컬럼 전부 fill 설정됨
    for (const idx of zeroCols) {
      const cell = resultSheet.getRow(3).getCell(idx);
      assert.equal(cell.fill.type, 'pattern');
      assert.equal(cell.fill.fgColor.argb, 'FFFFFF00');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildBandSummaryRows: 예상치 없음/일치/불일치 3가지 상태를 계산한다', () => {
  const bands = [
    { name: '1반', bandId: '111', expectedPostCount: null },
    { name: '2반', bandId: '222', expectedPostCount: 5 },
    { name: '3반', bandId: '333', expectedPostCount: 5 },
  ];
  const bandPostCounts = new Map([
    ['111', 3],
    ['222', 5],
    ['333', 4],
  ]);
  const rows = csv.buildBandSummaryRows(bands, bandPostCounts);
  assert.equal(rows[0].상태, '(예상치 미입력)');
  assert.equal(rows[1].상태, '일치');
  assert.equal(rows[2].상태, '불일치(확인 필요)');
});

test('buildBandSummaryRows: 캡처 데이터가 없는 밴드는 캡처된 게시글수 0으로 처리한다', () => {
  const bands = [{ name: '1반', bandId: '999', expectedPostCount: 3 }];
  const rows = csv.buildBandSummaryRows(bands, new Map());
  assert.equal(rows[0].캡처된_게시글수, 0);
  assert.equal(rows[0].상태, '불일치(확인 필요)');
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
