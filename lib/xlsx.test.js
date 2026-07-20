const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ExcelJS = require('exceljs');

const xlsx = require('./xlsx');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bsc-test-'));
}

test('readCell: null/빈 셀 → 빈 문자열', () => {
  assert.equal(xlsx.readCell(null), '');
  assert.equal(xlsx.readCell(undefined), '');
  assert.equal(xlsx.readCell({ value: null }), '');
  assert.equal(xlsx.readCell({ value: undefined }), '');
});

test('readCell: 문자열은 trim된다', () => {
  assert.equal(xlsx.readCell({ value: '  hello  ' }), 'hello');
});

test('readCell: Date는 그대로 반환된다', () => {
  const d = new Date('2026-06-28T00:00:00.000Z');
  const result = xlsx.readCell({ value: d });
  assert.equal(result, d);
});

test('readCell: richText 객체는 조각을 이어붙여 trim한다', () => {
  const v = { richText: [{ text: ' foo' }, { text: 'bar ' }] };
  assert.equal(xlsx.readCell({ value: v }), 'foobar');
});

test('readCell: hyperlink 등 {text} 객체는 text를 trim해서 반환한다', () => {
  const v = { text: '  103239777  ', hyperlink: 'https://example.com' };
  assert.equal(xlsx.readCell({ value: v }), '103239777');
});

test('readCell: 수식 셀({result})은 result 값을 반환한다', () => {
  const v = { formula: 'SUM(A1:A2)', result: 42 };
  assert.equal(xlsx.readCell({ value: v }), 42);
});

test('readCell: 숫자는 그대로 반환된다(trim 안 함)', () => {
  assert.equal(xlsx.readCell({ value: 5 }), 5);
});

test('createSettingsTemplate → readWorkbook: 시트/헤더/행이 round-trip된다', async () => {
  const dir = makeTmpDir();
  try {
    const filePath = path.join(dir, '1_설정.xlsx');
    await xlsx.createSettingsTemplate(filePath);
    assert.equal(await xlsx.fileExists(filePath), true);

    const wb = await xlsx.readWorkbook(filePath);
    const settingSheet = wb.getWorksheet('설정');
    const bandSheet = wb.getWorksheet('대상밴드');
    assert.ok(settingSheet, '설정 시트가 있어야 한다');
    assert.ok(bandSheet, '대상밴드 시트가 있어야 한다');

    assert.equal(xlsx.readCell(settingSheet.getRow(1).getCell(1)), '항목');
    assert.equal(xlsx.readCell(settingSheet.getRow(1).getCell(2)), '값');
    assert.equal(xlsx.readCell(settingSheet.getRow(1).getCell(3)), '설명');

    const items = [];
    settingSheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      items.push(xlsx.readCell(row.getCell(1)));
    });
    // 실행 모드는 엑셀이 아닌 CLI/env(--mode, BSC_MODE)로 옮겨졌다(Phase 1) — 이 시트엔 없다.
    assert.deepEqual(items, ['측정 시작일', '측정 종료일', '총점 상한']);

    let capRow;
    settingSheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      const item = xlsx.readCell(row.getCell(1));
      if (item === '총점 상한') capRow = row;
    });
    assert.equal(xlsx.readCell(capRow.getCell(2)), 50);

    assert.equal(xlsx.readCell(bandSheet.getRow(1).getCell(1)), '밴드 이름');
    assert.equal(xlsx.readCell(bandSheet.getRow(1).getCell(2)), '밴드 URL 또는 ID');

    let dataRowCount = 0;
    bandSheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      dataRowCount++;
    });
    // 예시 1행 + 빈 입력행 7행
    assert.equal(dataRowCount, 8);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createSettingsTemplate: 이미 존재하는 디렉터리 없이도 생성한다(ensureDir)', async () => {
  const dir = makeTmpDir();
  try {
    const filePath = path.join(dir, 'nested', 'deeper', '1_설정.xlsx');
    await xlsx.createSettingsTemplate(filePath);
    assert.equal(fs.existsSync(filePath), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createRosterTemplate → readWorkbook: 멤버 목록이 그대로 기록되고 학번 칸은 비어있다', async () => {
  const dir = makeTmpDir();
  try {
    const filePath = path.join(dir, '2_로스터.xlsx');
    const members = [
      { bandName: '1반', bandId: '111', userNo: 1001, name: '홍길동' },
      { bandName: '1반', bandId: '111', userNo: 1002, name: '김철수' },
    ];
    await xlsx.createRosterTemplate(filePath, members);

    const wb = await xlsx.readWorkbook(filePath);
    const sheet = wb.getWorksheet('로스터');
    assert.ok(sheet);

    const rows = [];
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      rows.push({
        bandName: xlsx.readCell(row.getCell(1)),
        userNo: xlsx.readCell(row.getCell(2)),
        name: xlsx.readCell(row.getCell(3)),
        studentId: xlsx.readCell(row.getCell(4)),
      });
    });
    assert.deepEqual(rows, [
      { bandName: '1반', userNo: 1001, name: '홍길동', studentId: '' },
      { bandName: '1반', userNo: 1002, name: '김철수', studentId: '' },
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readMemberListExport: 실제 내보내기 포맷(빈칸/이름/소개/리더여부/전화/이메일/가입일)을 파싱한다', async () => {
  const dir = makeTmpDir();
  try {
    const filePath = path.join(dir, '3_멤버리스트_1반.xlsx');
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('멤버');
    sheet.addRow(['멤버', '이름', '소개', '리더 여부', '휴대폰 번호', '이메일', '가입일']);
    sheet.addRow(['', '김태훈', '', '리더', '010-0000-0000', 'a@example.com', '2026-01-01']);
    sheet.addRow(['', '조교1', '', '공동리더', '010-1111-1111', 'b@example.com', '2026-01-02']);
    sheet.addRow(['', '홍길동', '', '', '010-2222-2222', 'c@example.com', '2026-01-03']);
    sheet.addRow(['', '', '', '', '', '', '']); // 이름 없는 빈 행은 무시돼야 한다
    await wb.xlsx.writeFile(filePath);

    const rows = await xlsx.readMemberListExport(filePath);
    assert.deepEqual(rows, [
      { name: '김태훈', leaderStatus: '리더', joinedAtRaw: '2026-01-01' },
      { name: '조교1', leaderStatus: '공동리더', joinedAtRaw: '2026-01-02' },
      { name: '홍길동', leaderStatus: null, joinedAtRaw: '2026-01-03' },
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fileExists: 없는 파일은 false, 만든 파일은 true', async () => {
  const dir = makeTmpDir();
  try {
    const filePath = path.join(dir, 'nope.xlsx');
    assert.equal(await xlsx.fileExists(filePath), false);
    await xlsx.createSettingsTemplate(filePath);
    assert.equal(await xlsx.fileExists(filePath), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
