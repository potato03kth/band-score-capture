// 규칙11: CSV 출력 + 교수용 감사 엑셀(U10·P4).
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

const COLUMN_DESCRIPTIONS = [
  ['학번', '로스터의 학번. 동명이인은 매핑 확정 후 채워짐. 아직 미기입이면 임시 학번(TEST####)'],
  ['실명', '밴드 닉네임(=실명)'],
  ['user_no', '밴드 내부 사용자 고유 ID(전역 숫자, 동명이인 구분용)'],
  ['band_id', '소속 밴드 ID'],
  ['band_name', '소속 밴드 이름'],
  ['활동일수', '측정기간 중 게시글/댓글/대댓글을 1개 이상 작성한 날의 수(하루 최대 1)'],
  ['점수', 'min(활동일수, 총점상한)'],
  ['매핑상태', 'matched(정상) / synthetic(임시 학번, 로스터 미기입) / ambiguous(동명이인, 확인 필요) / ambiguous-synthetic(동명이인+임시학번)'],
  ['수집완료여부', '해당 밴드 취득이 측정기간 전체를 빠짐없이 커버했는지(feedExhausted 기준)'],
  ['감사근거', '이 점수의 근거가 되는 활동 건수(감사 시트의 상세 근거로 이어짐)'],
  ['산출시각', '이 결과를 뽑은 시각'],
];

// 교수가 "대상밴드" 시트에 채운 예상 게시글수(선택)와 실제 캡처된 게시글수를 대조한다.
// bandPostCounts: Map<bandId(string), capturedPostCount>. 예상치는 선택 입력이라 없으면
// 대조하지 않고 "(예상치 미입력)"으로만 표시한다 — 불일치 게이트(Phase 6)와 달리 채점을
// 막지 않는 참고용 요약이다.
function buildBandSummaryRows(bands, bandPostCounts) {
  return bands.map((b) => {
    const captured = bandPostCounts.get(String(b.bandId)) ?? 0;
    const expected = b.expectedPostCount ?? null;
    let status;
    if (expected == null) status = '(예상치 미입력)';
    else if (expected === captured) status = '일치';
    else status = '불일치(확인 필요)';
    return {
      band_name: b.name,
      band_id: b.bandId,
      예상_게시글수: expected == null ? '' : expected,
      캡처된_게시글수: captured,
      상태: status,
    };
  });
}

function buildRows({ mapping, scores, cap, bandCollectionComplete, generatedAt }) {
  const rows = [];
  for (const [userNo, m] of mapping) {
    const s = scores.get(userNo);
    const activeDays = s ? s.activeDays : 0;
    const score = s ? s.score : 0;
    rows.push({
      학번: m.studentId,
      실명: m.name,
      user_no: m.userNo,
      band_id: m.bandId,
      band_name: m.bandName,
      활동일수: activeDays,
      점수: score,
      매핑상태: m.mappingStatus,
      수집완료여부: bandCollectionComplete.get(m.bandId) ? '완료' : '미완료(확인 필요)',
      감사근거: s ? `${s.records.length}건 활동` : '활동 없음',
      산출시각: generatedAt,
      _records: s ? s.records : [],
    });
  }
  rows.sort((a, b) => (a.band_name === b.band_name ? b.점수 - a.점수 : a.band_name.localeCompare(b.band_name)));
  return rows;
}

function writeCsv(filePath, rows) {
  const header = COLUMN_DESCRIPTIONS.map(([col]) => col);
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push(header.map((col) => csvEscape(r[col])).join(','));
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
}

async function writeAuditWorkbook(filePath, rows, bandSummaryRows = []) {
  const wb = new ExcelJS.Workbook();

  const summarySheet = wb.addWorksheet('밴드요약');
  summarySheet.columns = [
    { header: '밴드 이름', key: 'band_name', width: 20 },
    { header: 'band_id', key: 'band_id', width: 16 },
    { header: '예상 게시글수', key: '예상_게시글수', width: 16 },
    { header: '캡처된 게시글수', key: '캡처된_게시글수', width: 16 },
    { header: '상태', key: '상태', width: 20 },
  ];
  summarySheet.getRow(1).font = { bold: true };
  for (const r of bandSummaryRows) summarySheet.addRow(r);

  const resultSheet = wb.addWorksheet('결과');
  resultSheet.columns = COLUMN_DESCRIPTIONS.map(([col]) => ({ header: col, key: col, width: col === '실명' ? 12 : 16 }));
  resultSheet.getRow(1).font = { bold: true };
  for (const r of rows) {
    const row = {};
    for (const [col] of COLUMN_DESCRIPTIONS) row[col] = r[col];
    resultSheet.addRow(row);
  }

  const descSheet = wb.addWorksheet('컬럼 설명');
  descSheet.columns = [
    { header: '컬럼', key: 'col', width: 14 },
    { header: '설명', key: 'desc', width: 70 },
  ];
  descSheet.getRow(1).font = { bold: true };
  for (const [col, desc] of COLUMN_DESCRIPTIONS) descSheet.addRow({ col, desc });

  const auditSheet = wb.addWorksheet('감사');
  auditSheet.columns = [
    { header: '학번', key: 'studentId', width: 14 },
    { header: '실명', key: 'name', width: 12 },
    { header: '밴드', key: 'bandName', width: 12 },
    { header: '날짜(KST)', key: 'dateStr', width: 12 },
    { header: '유형', key: 'kind', width: 10 },
    { header: '게시글 번호', key: 'postNo', width: 12 },
    { header: '내용 요약', key: 'textPreview', width: 60 },
  ];
  auditSheet.getRow(1).font = { bold: true };
  for (const r of rows) {
    for (const rec of r._records) {
      auditSheet.addRow({
        studentId: r.학번,
        name: r.실명,
        bandName: r.band_name,
        dateStr: rec.dateStr,
        kind: rec.kind === 'post' ? '게시글' : '댓글',
        postNo: rec.postNo,
        textPreview: rec.textPreview,
      });
    }
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  await wb.xlsx.writeFile(filePath);
}

function writeUnmatchedCsv(filePath, rows) {
  const unmatched = rows.filter((r) => r.매핑상태.includes('synthetic') || r.매핑상태.includes('ambiguous'));
  const header = ['학번(임시)', '실명', 'user_no', 'band_name', '매핑상태'];
  const lines = [header.join(',')];
  for (const r of unmatched) {
    lines.push([r.학번, r.실명, r.user_no, r.band_name, r.매핑상태].map(csvEscape).join(','));
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
  return unmatched.length;
}

module.exports = {
  buildRows,
  buildBandSummaryRows,
  writeCsv,
  writeAuditWorkbook,
  writeUnmatchedCsv,
  COLUMN_DESCRIPTIONS,
};
