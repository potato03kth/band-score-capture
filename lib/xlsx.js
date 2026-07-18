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
    ['실행 모드', 'test', 'test 또는 production. production이면 시작/종료일이 비어있으면 실행을 거부합니다'],
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

module.exports = {
  applyYellow,
  fileExists,
  ensureDir,
  createSettingsTemplate,
  readWorkbook,
  readCell,
};
