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
        studentId: xlsx.readCell(row.getCell(6)),
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

test('createRosterTemplate: 최초/최신활동이 있으면 "날짜 유형: 내용" 형식, 없으면 빈칸으로 기록된다', async () => {
  const dir = makeTmpDir();
  try {
    const filePath = path.join(dir, '2_로스터.xlsx');
    const members = [
      {
        bandName: '1반',
        bandId: '111',
        userNo: 1001,
        name: '다건유저',
        firstActivity: { dateStr: '2026-06-28', textPreview: '첫글', kind: 'post' },
        lastActivity: { dateStr: '2026-07-10', textPreview: '마지막댓글', kind: 'comment' },
      },
      { bandName: '1반', bandId: '111', userNo: 1002, name: '무활동유저', firstActivity: null, lastActivity: null },
    ];
    await xlsx.createRosterTemplate(filePath, members);

    const wb = await xlsx.readWorkbook(filePath);
    const sheet = wb.getWorksheet('로스터');
    assert.equal(xlsx.readCell(sheet.getRow(2).getCell(4)), '2026-06-28 게시글: 첫글');
    assert.equal(xlsx.readCell(sheet.getRow(2).getCell(5)), '2026-07-10 댓글: 마지막댓글');
    assert.equal(xlsx.readCell(sheet.getRow(3).getCell(4)), '');
    assert.equal(xlsx.readCell(sheet.getRow(3).getCell(5)), '');
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

test('createGapsTemplate: 3개 시트(게시글총수/게시글댓글/학생댓글)를 만들고 manual_value/note에 노란칸을 입힌다', async () => {
  const dir = makeTmpDir();
  try {
    const filePath = path.join(dir, '부적합_데이터_확인.xlsx');
    const sections = {
      totalPostCount: [{ bandName: '1반', bandId: '111', reasonTier: 2, reason: '스크롤 불일치', expected: 10, captured: 8, missing: 2 }],
      postComments: [
        {
          bandName: '1반',
          bandId: '111',
          reasonTier: 2,
          reason: '모달 표시 불일치',
          typeLabel: '모달표시댓글수',
          postNo: '5',
          postAuthor: '홍길동',
          postWebUrl: 'https://example.com/5',
          parentCommentId: '',
          parentAuthor: '',
          expected: 3,
          captured: 2,
          missing: 1,
        },
      ],
      memberComments: [
        { bandName: '1반', bandId: '111', memberName: '김철수', userNo: 1001, displayedCount: 5, capturedCount: 3, diff: 2 },
      ],
    };
    await xlsx.createGapsTemplate(filePath, sections);

    const wb = await xlsx.readWorkbook(filePath);
    const sheetNames = wb.worksheets.map((s) => s.name);
    assert.deepEqual(sheetNames, ['게시글총수', '게시글댓글', '학생댓글']);

    const totalSheet = wb.getWorksheet('게시글총수');
    assert.equal(xlsx.readCell(totalSheet.getRow(2).getCell(1)), '1반');
    assert.equal(xlsx.readCell(totalSheet.getRow(2).getCell(6)), 8);
    assert.equal(totalSheet.getRow(2).getCell(8).fill.fgColor.argb, 'FFFFFF00'); // manual_value
    assert.equal(totalSheet.getRow(2).getCell(9).fill.fgColor.argb, 'FFFFFF00'); // note

    const postSheet = wb.getWorksheet('게시글댓글');
    assert.equal(xlsx.readCell(postSheet.getRow(2).getCell(6)), '5');
    assert.equal(postSheet.getRow(2).getCell(14).fill.fgColor.argb, 'FFFFFF00'); // manual_value

    const memberSheet = wb.getWorksheet('학생댓글');
    assert.equal(xlsx.readCell(memberSheet.getRow(2).getCell(3)), '김철수');
    assert.equal(memberSheet.getRow(2).getCell(8).fill.fgColor.argb, 'FFFFFF00'); // manual_value
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createGapsTemplate: 학생댓글 시트의 반영값 컬럼은 manual_value 비었을 땐 캡처값, 채워지면 그 값을 쓰는 수식이고, 합계 행이 SUM으로 붙는다', async () => {
  const dir = makeTmpDir();
  try {
    const filePath = path.join(dir, '부적합_데이터_확인.xlsx');
    const sections = {
      totalPostCount: [],
      postComments: [],
      memberComments: [
        { bandName: '1반', bandId: '111', memberName: 'A', userNo: 1, displayedCount: 5, capturedCount: 3, diff: 2 },
        { bandName: '1반', bandId: '111', memberName: 'B', userNo: 2, displayedCount: 1, capturedCount: 0, diff: 1 },
      ],
    };
    await xlsx.createGapsTemplate(filePath, sections);

    const wb = await xlsx.readWorkbook(filePath);
    const sheet = wb.getWorksheet('학생댓글');
    assert.equal(sheet.getRow(2).getCell(10).value.formula, 'IF(H2="",F2,H2)');
    assert.equal(sheet.getRow(3).getCell(10).value.formula, 'IF(H3="",F3,H3)');

    // 합계 행(4행): 헤더1 + 데이터2 + 합계1
    assert.equal(xlsx.readCell(sheet.getRow(4).getCell(1)), '합계');
    assert.equal(sheet.getRow(4).getCell(6).value.formula, 'SUM(F2:F3)');
    assert.equal(sheet.getRow(4).getCell(10).value.formula, 'SUM(J2:J3)');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createGapsTemplate: 결손이 없는 섹션은 빈 시트(헤더만)로 남는다', async () => {
  const dir = makeTmpDir();
  try {
    const filePath = path.join(dir, '부적합_데이터_확인.xlsx');
    await xlsx.createGapsTemplate(filePath, { totalPostCount: [], postComments: [], memberComments: [] });
    const wb = await xlsx.readWorkbook(filePath);
    const memberSheet = wb.getWorksheet('학생댓글');
    let dataRowCount = 0;
    memberSheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      dataRowCount++;
    });
    assert.equal(dataRowCount, 0); // 합계 행도 안 붙는다(빈 시트에 의미 없음)
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
