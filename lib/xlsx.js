const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');

// 매 호출마다 새 객체를 만든다. ExcelJS는 cell.style 컨테이너를 셀 간에 내부적으로 공유할 수 있어서,
// 하나의 스타일 객체 리터럴을 여러 셀에 재사용하면 한 셀에 Date 값을 넣을 때 매겨지는 numFmt가
// 같은 스타일을 참조하는 다른 셀(예: 숫자 "총점 상한")까지 날짜로 오염시키는 것을 실측했다(NU7 실증).
function applyYellow(cell) {
  cell.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFFFFF00' },
  };
}

async function fileExists(filePath) {
  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(dirPath) {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

async function createSettingsTemplate(filePath) {
  await ensureDir(path.dirname(filePath));
  const wb = new ExcelJS.Workbook();

  const settingSheet = wb.addWorksheet('설정');
  settingSheet.columns = [
    { header: '항목', key: 'item', width: 16 },
    { header: '값', key: 'value', width: 24 },
    { header: '설명', key: 'desc', width: 64 },
  ];
  settingSheet.getRow(1).font = { bold: true };

  const rows = [
    ['측정 시작일', '', '계측을 시작할 날짜. YYYY-MM-DD (KST 00:00부터). 예: 2026-06-28'],
    ['측정 종료일', '', '계측을 끝낼 날짜. YYYY-MM-DD (KST 23:59까지). 예: 2026-07-16'],
    ['총점 상한', 50, '한 학생이 받을 수 있는 최대 점수. 기간과 무관하게 교수가 정함'],
  ];
  for (const [item, value, desc] of rows) {
    const row = settingSheet.addRow({ item, value, desc });
    applyYellow(row.getCell('value'));
  }

  const bandSheet = wb.addWorksheet('대상밴드');
  bandSheet.columns = [
    { header: '밴드 이름', key: 'name', width: 20 },
    { header: '밴드 URL 또는 ID', key: 'bandRef', width: 56 },
  ];
  bandSheet.getRow(1).font = { bold: true };
  const exampleRow = bandSheet.addRow({
    name: '(예시, 지우고 실제 값 입력)',
    bandRef: 'https://www.band.us/band/103239777/post 또는 103239777',
  });
  exampleRow.font = { italic: true, color: { argb: 'FF888888' } };
  const bandRowCount = 7;
  for (let i = 0; i < bandRowCount; i++) {
    const row = bandSheet.addRow({ name: '', bandRef: '' });
    applyYellow(row.getCell('name'));
    applyYellow(row.getCell('bandRef'));
  }

  await wb.xlsx.writeFile(filePath);
}

async function readWorkbook(filePath) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  return wb;
}

function readCell(cell) {
  if (cell == null) return '';
  const v = cell.value;
  if (v == null) return '';
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if (typeof v.text === 'string') return v.text.trim();
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('').trim();
    if (v.result != null) return v.result;
  }
  return typeof v === 'string' ? v.trim() : v;
}

// input/2_로스터.xlsx — 학번 입력용. 교수가 프로그램을 안 켜본 상태에서도 "이 사람이 누구인지"
// 알아볼 수 있도록 밴드 이름·user_no·실명을 미리 채워두고, 학번 칸만 노랗게 비워 채우게 한다.
// 교수·조교(리더 소거집합)는 채점 대상이 아니므로 애초에 이 목록에서 뺀다(불필요한 입력 방지).
// members: [{ bandName, bandId, userNo, name }, ...] (제외 대상 이미 필터링된 상태로 전달)
async function createRosterTemplate(filePath, members) {
  await ensureDir(path.dirname(filePath));
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('로스터');
  sheet.columns = [
    { header: '밴드', key: 'bandName', width: 14 },
    { header: 'user_no(참고용, 수정 금지)', key: 'userNo', width: 22 },
    { header: '실명', key: 'name', width: 14 },
    { header: '학번', key: 'studentId', width: 16 },
  ];
  sheet.getRow(1).font = { bold: true };
  for (const m of members) {
    const row = sheet.addRow({ bandName: m.bandName, userNo: m.userNo, name: m.name, studentId: '' });
    row.getCell('userNo').font = { color: { argb: 'FF888888' } };
    applyYellow(row.getCell('studentId'));
  }
  await wb.xlsx.writeFile(filePath);
}

// 밴드에서 "학생 내보내기"로 받은 멤버리스트 엑셀(3_멤버리스트_<밴드>.xlsx)을 읽는다.
// 실측 확인된 실제 포맷(2026-07-20, 사용자 제공 원본 파일): 헤더가
// [빈칸, 이름, 소개, 리더 여부, 휴대폰 번호, 이메일, 가입일]이고, 리더 여부 칸의 값은
// "리더"(교수)/"공동리더"(조교)/공란(일반 멤버)이다. 1번 열("멤버" 섹션 표시)은 장식용이라
// 무시한다. user_no는 이 파일에 없다(API get_members_of_band에서만 얻을 수 있음 - PLAN.md
// D0-R R-4) - 이름으로만 대조 가능하다.
async function readMemberListExport(filePath) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const sheet = wb.worksheets[0];
  const rows = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return; // 헤더
    const name = readCell(row.getCell(2));
    if (!name) return;
    const leaderRaw = readCell(row.getCell(4));
    rows.push({
      name: String(name).trim(),
      leaderStatus: leaderRaw ? String(leaderRaw).trim() : null, // "리더" | "공동리더" | null
      joinedAtRaw: readCell(row.getCell(7)),
    });
  });
  return rows;
}

module.exports = {
  applyYellow,
  fileExists,
  ensureDir,
  createSettingsTemplate,
  createRosterTemplate,
  readMemberListExport,
  readWorkbook,
  readCell,
};
