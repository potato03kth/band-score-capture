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
    { header: '예상 게시글수(선택)', key: 'expectedPostCount', width: 20 },
  ];
  bandSheet.getRow(1).font = { bold: true };
  const exampleRow = bandSheet.addRow({
    name: '(예시, 지우고 실제 값 입력)',
    bandRef: 'https://www.band.us/band/103239777/post 또는 103239777',
    expectedPostCount: '',
  });
  exampleRow.font = { italic: true, color: { argb: 'FF888888' } };
  const bandRowCount = 7;
  for (let i = 0; i < bandRowCount; i++) {
    const row = bandSheet.addRow({ name: '', bandRef: '', expectedPostCount: '' });
    applyYellow(row.getCell('name'));
    applyYellow(row.getCell('bandRef'));
    applyYellow(row.getCell('expectedPostCount'));
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

// 최초/최신활동 힌트(roster.computeActivityHints의 결과 한 건)를 사람이 읽을 문구로 만든다.
// 활동이 없으면(hint == null) 빈 문자열 — "다건/0건 유저" 중 0건 케이스.
function formatActivityHint(hint) {
  if (!hint) return '';
  const kindLabel = hint.kind === 'post' ? '게시글' : '댓글';
  return `${hint.dateStr} ${kindLabel}: ${hint.textPreview}`;
}

// input/2_로스터.xlsx — 학번 입력용. 교수가 프로그램을 안 켜본 상태에서도 "이 사람이 누구인지"
// 알아볼 수 있도록 밴드 이름·user_no·실명·최초/최신활동을 미리 채워두고, 학번 칸만 노랗게
// 비워 채우게 한다. 최초/최신활동은 동명이인 등 식별이 애매할 때의 보조 근거일 뿐 채점에는
// 쓰이지 않는다(참고용). 교수·조교(리더 소거집합)는 채점 대상이 아니므로 애초에 이 목록에서
// 뺀다(불필요한 입력 방지).
// members: [{ bandName, bandId, userNo, name, firstActivity, lastActivity }, ...]
// (제외 대상 이미 필터링된 상태로 전달. firstActivity/lastActivity는 roster.computeActivityHints
// 결과의 { dateStr, textPreview, kind } 또는 활동 없으면 null)
async function createRosterTemplate(filePath, members) {
  await ensureDir(path.dirname(filePath));
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('로스터');
  sheet.columns = [
    { header: '밴드', key: 'bandName', width: 14 },
    { header: 'user_no(참고용, 수정 금지)', key: 'userNo', width: 22 },
    { header: '실명', key: 'name', width: 14 },
    { header: '최초활동(참고용)', key: 'firstActivity', width: 40 },
    { header: '최신활동(참고용)', key: 'lastActivity', width: 40 },
    { header: '학번', key: 'studentId', width: 16 },
  ];
  sheet.getRow(1).font = { bold: true };
  for (const m of members) {
    const row = sheet.addRow({
      bandName: m.bandName,
      userNo: m.userNo,
      name: m.name,
      firstActivity: formatActivityHint(m.firstActivity),
      lastActivity: formatActivityHint(m.lastActivity),
      studentId: '',
    });
    row.getCell('userNo').font = { color: { argb: 'FF888888' } };
    applyYellow(row.getCell('studentId'));
  }
  await wb.xlsx.writeFile(filePath);
}

// 1-based 열 번호 -> 엑셀 열 문자(A, B, ..., Z, AA, ...). 26개 넘는 시트가 없어 단순 구현으로 충분.
function colLetter(n) {
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// input/부적합_데이터_확인.xlsx — Phase 6 채점 게이트의 왕복 입력물. 3개 독립 섹션(시트)로
// 구성된다: "게시글총수"(밴드 단위, 특정 학생에 귀속 불가 — 참고+게이트용), "게시글댓글"
// (게시글 단위, 마찬가지로 특정 학생에 귀속 불가), "학생댓글"(user_no 단위 — 유일하게 채점
// 보정(commentCount/activeDays)에 직접 반영됨. score/gaps.js의 applyMemberCommentCorrections
// 참고). 귀속 불가 이유: incomplete_gaps.json의 게시글/댓글 결손 항목에는 "글쓴이"만 있고
// 실제 빠진 댓글을 누가 썼는지는 알 수 없다(post-modal-displayed-count-mismatch 등) — 잘못된
// 귀속으로 없는 점수를 만들어주는 것보다, 사람 확인(게이트)만 요구하고 점수는 건드리지 않는
// 쪽이 안전하다.
async function createGapsTemplate(filePath, sections) {
  await ensureDir(path.dirname(filePath));
  const wb = new ExcelJS.Workbook();

  const totalPostSheet = wb.addWorksheet('게시글총수');
  totalPostSheet.columns = [
    { header: '밴드', key: 'bandName', width: 14 },
    { header: 'band_id', key: 'bandId', width: 14 },
    { header: '신뢰도tier', key: 'reasonTier', width: 10 },
    { header: '사유', key: 'reason', width: 30 },
    { header: '화면 스크롤 확인 게시글수', key: 'expected', width: 20 },
    { header: '순회 수집 게시글수', key: 'captured', width: 18 },
    { header: '차이(부족)', key: 'missing', width: 12 },
    { header: 'manual_value(사람이 확인한 실제 게시글 총수)', key: 'manualValue', width: 36 },
    { header: 'note', key: 'note', width: 30 },
  ];
  totalPostSheet.getRow(1).font = { bold: true };
  for (const r of sections.totalPostCount) {
    const row = totalPostSheet.addRow({ ...r, manualValue: r.manualValue ?? '', note: r.note ?? '' });
    applyYellow(row.getCell('manualValue'));
    applyYellow(row.getCell('note'));
  }

  const postCommentSheet = wb.addWorksheet('게시글댓글');
  postCommentSheet.columns = [
    { header: '밴드', key: 'bandName', width: 14 },
    { header: 'band_id', key: 'bandId', width: 14 },
    { header: '신뢰도tier', key: 'reasonTier', width: 10 },
    { header: '사유', key: 'reason', width: 30 },
    { header: '유형', key: 'typeLabel', width: 12 },
    { header: '게시글 번호', key: 'postNo', width: 12 },
    { header: '작성자', key: 'postAuthor', width: 12 },
    { header: '게시글 URL', key: 'postWebUrl', width: 40 },
    { header: '부모댓글ID', key: 'parentCommentId', width: 16 },
    { header: '부모댓글 작성자', key: 'parentAuthor', width: 14 },
    { header: '화면표시/집계 댓글수', key: 'expected', width: 18 },
    { header: '캡처된 댓글수', key: 'captured', width: 14 },
    { header: '차이(부족)', key: 'missing', width: 12 },
    { header: 'manual_value(사람이 확인한 실제 댓글수)', key: 'manualValue', width: 36 },
    { header: 'note', key: 'note', width: 30 },
  ];
  postCommentSheet.getRow(1).font = { bold: true };
  for (const r of sections.postComments) {
    const row = postCommentSheet.addRow({ ...r, manualValue: r.manualValue ?? '', note: r.note ?? '' });
    applyYellow(row.getCell('manualValue'));
    applyYellow(row.getCell('note'));
  }

  const memberSheet = wb.addWorksheet('학생댓글');
  const memberColumns = [
    { header: '밴드', key: 'bandName', width: 14 },
    { header: 'band_id', key: 'bandId', width: 14 },
    { header: '이름', key: 'memberName', width: 12 },
    { header: 'user_no', key: 'userNo', width: 14 },
    { header: '화면표시 댓글수', key: 'displayedCount', width: 14 },
    { header: '캡처된 댓글수', key: 'capturedCount', width: 14 },
    { header: '차이', key: 'diff', width: 10 },
    { header: 'manual_value(사람이 확인한 실제 댓글수)', key: 'manualValue', width: 36 },
    { header: 'note', key: 'note', width: 30 },
    { header: '반영값(참고용, 수식)', key: 'resolved', width: 16 },
  ];
  memberSheet.columns = memberColumns;
  memberSheet.getRow(1).font = { bold: true };

  const capturedColLetter = colLetter(memberColumns.findIndex((c) => c.key === 'capturedCount') + 1);
  const manualValueColLetter = colLetter(memberColumns.findIndex((c) => c.key === 'manualValue') + 1);
  const resolvedColLetter = colLetter(memberColumns.findIndex((c) => c.key === 'resolved') + 1);

  let excelRowNumber = 1; // 헤더가 1행
  for (const r of sections.memberComments) {
    excelRowNumber++;
    const row = memberSheet.addRow({ ...r, manualValue: r.manualValue ?? '', note: r.note ?? '' });
    applyYellow(row.getCell('manualValue'));
    applyYellow(row.getCell('note'));
    // manual_value가 비어있으면 캡처값을 그대로, 채워지면 그 값을 즉시 화면에 반영(재실행 없이
    // 교수가 입력하는 즉시 확인 가능하도록 - H-3 6-2).
    row.getCell('resolved').value = {
      formula: `IF(${manualValueColLetter}${excelRowNumber}="",${capturedColLetter}${excelRowNumber},${manualValueColLetter}${excelRowNumber})`,
    };
  }
  if (sections.memberComments.length > 0) {
    const firstDataRow = 2;
    const lastDataRow = excelRowNumber;
    const totalRow = memberSheet.addRow({ bandName: '합계' });
    totalRow.font = { bold: true };
    totalRow.getCell('capturedCount').value = {
      formula: `SUM(${capturedColLetter}${firstDataRow}:${capturedColLetter}${lastDataRow})`,
    };
    totalRow.getCell('resolved').value = {
      formula: `SUM(${resolvedColLetter}${firstDataRow}:${resolvedColLetter}${lastDataRow})`,
    };
  }

  await wb.xlsx.writeFile(filePath);
}

module.exports = {
  applyYellow,
  fileExists,
  ensureDir,
  createSettingsTemplate,
  createRosterTemplate,
  createGapsTemplate,
  readWorkbook,
  readCell,
};
