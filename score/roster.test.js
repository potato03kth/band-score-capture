const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const roster = require('./roster');
const xlsx = require('../lib/xlsx');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bsc-test-'));
}

function writeMemberSnapshot(rawDir, bandId, members, ts = '1700000000000') {
  const dir = path.join(rawDir, String(bandId), '_members');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `members_${ts}.json`), JSON.stringify({ members }));
}

test('collectCandidateMembers: role이 member가 아닌 사람(리더/공동리더)은 후보에서 빠진다', () => {
  const dir = makeTmpDir();
  try {
    writeMemberSnapshot(dir, '111', [
      { user_no: 1, name: '교수', role: 'leader' },
      { user_no: 2, name: '조교', role: 'co-leader' },
      { user_no: 3, name: '학생A', role: 'member' },
      { user_no: 4, name: '학생B', role: 'member' },
    ]);
    const bands = [{ bandId: '111', name: '1반' }];
    const { candidates, leaderUserNos } = roster.collectCandidateMembers(dir, bands, { taUserNos: [] });
    assert.deepEqual(
      candidates.map((c) => c.userNo).sort(),
      [3, 4]
    );
    assert.equal(leaderUserNos.has(1), true);
    assert.equal(leaderUserNos.has(2), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('collectCandidateMembers: taUserNos로 지정한 user_no는 role이 member여도 제외된다', () => {
  const dir = makeTmpDir();
  try {
    writeMemberSnapshot(dir, '111', [
      { user_no: 5, name: '조교(역할 미설정)', role: 'member' },
      { user_no: 6, name: '학생', role: 'member' },
    ]);
    const bands = [{ bandId: '111', name: '1반' }];
    const { candidates } = roster.collectCandidateMembers(dir, bands, { taUserNos: [5] });
    assert.deepEqual(
      candidates.map((c) => c.userNo),
      [6]
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('collectCandidateMembers: 멤버 스냅샷이 없는 밴드는 건너뛴다', () => {
  const dir = makeTmpDir();
  try {
    const bands = [{ bandId: '999', name: '없는밴드' }];
    const { candidates } = roster.collectCandidateMembers(dir, bands, { taUserNos: [] });
    assert.deepEqual(candidates, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('collectCandidateMembers: 여러 밴드의 candidates를 밴드명과 함께 합산한다', () => {
  const dir = makeTmpDir();
  try {
    writeMemberSnapshot(dir, '111', [{ user_no: 1, name: '학생A', role: 'member' }]);
    writeMemberSnapshot(dir, '222', [{ user_no: 2, name: '학생B', role: 'member' }]);
    const bands = [
      { bandId: '111', name: '1반' },
      { bandId: '222', name: '2반' },
    ];
    const { candidates } = roster.collectCandidateMembers(dir, bands, { taUserNos: [] });
    assert.deepEqual(
      candidates.map((c) => ({ userNo: c.userNo, bandName: c.bandName })),
      [
        { userNo: 1, bandName: '1반' },
        { userNo: 2, bandName: '2반' },
      ]
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('assignSyntheticIds: user_no 오름차순으로 TEST0001부터 결정적으로 부여한다', () => {
  const map1 = roster.assignSyntheticIds([103, 101, 102]);
  assert.equal(map1.get(101), 'TEST0001');
  assert.equal(map1.get(102), 'TEST0002');
  assert.equal(map1.get(103), 'TEST0003');

  // 입력 순서가 달라도(집합이 같으면) 같은 결과가 나와야 한다(재현성)
  const map2 = roster.assignSyntheticIds([102, 103, 101]);
  assert.deepEqual([...map2.entries()], [...map1.entries()]);
});

test('assignSyntheticIds: 중복 user_no는 한 번만 취급된다', () => {
  const map = roster.assignSyntheticIds([5, 5, 3]);
  assert.equal(map.size, 2);
  assert.equal(map.get(3), 'TEST0001');
  assert.equal(map.get(5), 'TEST0002');
});

test('buildFinalMapping: 학번이 채워진 경우 matched, 안 채워진 경우 synthetic', () => {
  const candidates = [
    { userNo: 1, name: '홍길동', bandId: '111', bandName: '1반' },
    { userNo: 2, name: '김철수', bandId: '111', bandName: '1반' },
  ];
  const filledMap = new Map([[1, '20260001']]);
  const result = roster.buildFinalMapping(candidates, filledMap);
  assert.equal(result.get(1).mappingStatus, 'matched');
  assert.equal(result.get(1).studentId, '20260001');
  assert.equal(result.get(2).mappingStatus, 'synthetic');
  assert.equal(result.get(2).studentId, 'TEST0001');
});

test('buildFinalMapping: 동명이인은 학번 기입 여부와 무관하게 ambiguous 계열로 표시된다', () => {
  const candidates = [
    { userNo: 1, name: '홍길동', bandId: '111', bandName: '1반' },
    { userNo: 2, name: '홍길동', bandId: '222', bandName: '2반' },
  ];
  const filledMap = new Map([[1, '20260001']]); // 1만 학번 기입, 2는 미기입
  const result = roster.buildFinalMapping(candidates, filledMap);
  assert.equal(result.get(1).mappingStatus, 'ambiguous');
  assert.equal(result.get(1).studentId, '20260001');
  assert.equal(result.get(2).mappingStatus, 'ambiguous-synthetic');
  assert.equal(result.get(2).studentId, 'TEST0001');
});

test('loadRosterMapping: 파일이 없으면 템플릿을 만들고 created:true, filled는 빈 Map', async () => {
  const dir = makeTmpDir();
  try {
    const candidates = [{ bandName: '1반', bandId: '111', userNo: 1, name: '홍길동' }];
    const logs = [];
    const { filled, created } = await roster.loadRosterMapping(dir, candidates, { warn: (m) => logs.push(m) });
    assert.equal(created, true);
    assert.equal(filled.size, 0);
    assert.equal(fs.existsSync(path.join(dir, roster.ROSTER_FILENAME)), true);
    assert.equal(logs.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadRosterMapping: 학번이 채워진 기존 파일을 읽어 user_no → 학번 매핑을 만든다', async () => {
  const dir = makeTmpDir();
  try {
    const filePath = path.join(dir, roster.ROSTER_FILENAME);
    await xlsx.createRosterTemplate(filePath, [
      { bandName: '1반', bandId: '111', userNo: 1, name: '홍길동' },
      { bandName: '1반', bandId: '111', userNo: 2, name: '김철수' },
    ]);
    // 학번 칸(4번째 열)을 채운다
    const wb = await xlsx.readWorkbook(filePath);
    const sheet = wb.getWorksheet('로스터');
    sheet.getRow(2).getCell(4).value = '20260001';
    await wb.xlsx.writeFile(filePath);

    const { filled, created } = await roster.loadRosterMapping(dir, []);
    assert.equal(created, false);
    assert.equal(filled.get(1), '20260001');
    assert.equal(filled.has(2), false); // 비어있는 학번은 매핑에 포함 안 됨
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadRosterMapping: "로스터" 시트가 없으면 무시하고 빈 매핑으로 진행한다', async () => {
  const dir = makeTmpDir();
  try {
    const filePath = path.join(dir, roster.ROSTER_FILENAME);
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('다른시트');
    await wb.xlsx.writeFile(filePath);

    const logs = [];
    const { filled, created } = await roster.loadRosterMapping(dir, [], { warn: (m) => logs.push(m) });
    assert.equal(created, false);
    assert.equal(filled.size, 0);
    assert.equal(logs.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
