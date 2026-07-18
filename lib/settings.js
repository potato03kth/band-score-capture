const path = require('path');
const xlsx = require('./xlsx');

class SettingsNotReadyError extends Error {}
class SettingsValidationError extends Error {}

const SETTINGS_FILENAME = '1_설정.xlsx';
const SETTING_SHEET_HEADERS = ['항목', '값', '설명'];
const BAND_SHEET_HEADERS = ['밴드 이름', '밴드 URL 또는 ID'];

function kstMidnightUtcMs(y, m, d) {
  return Date.UTC(y, m - 1, d, 0, 0, 0) - 9 * 3600 * 1000;
}
function kstEndOfDayUtcMs(y, m, d) {
  return Date.UTC(y, m - 1, d, 23, 59, 59, 999) - 9 * 3600 * 1000;
}

function parseKstDateCell(value, label) {
  if (value instanceof Date) {
    return { y: value.getUTCFullYear(), m: value.getUTCMonth() + 1, d: value.getUTCDate() };
  }
  if (typeof value === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    if (m) return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  }
  throw new SettingsValidationError(
    `${label} 형식이 올바르지 않습니다. "설정" 시트에 YYYY-MM-DD 형식으로 입력하세요 (예: 2026-06-28). 현재 값: ${JSON.stringify(
      value
    )}`
  );
}

function normalizeBandId(raw, rowNumber) {
  const str = String(raw ?? '').trim();
  if (!str) return null;
  const m = /(\d{5,})/.exec(str);
  if (!m) {
    throw new SettingsValidationError(
      `"대상밴드" 시트 ${rowNumber}행의 값에서 밴드 번호(숫자)를 찾을 수 없습니다: ${JSON.stringify(raw)}`
    );
  }
  return m[1];
}

function assertHeaders(sheet, expectedHeaders, sheetLabel, filePath) {
  const row1 = sheet.getRow(1);
  for (let i = 0; i < expectedHeaders.length; i++) {
    const val = xlsx.readCell(row1.getCell(i + 1));
    if (val !== expectedHeaders[i]) {
      throw new SettingsValidationError(
        `${filePath}의 "${sheetLabel}" 시트 헤더가 손상되었습니다 (${i + 1}번째 열 기대값 "${
          expectedHeaders[i]
        }", 실제 "${val}"). 파일을 삭제한 뒤 다시 실행해 템플릿을 재생성하세요.`
      );
    }
  }
}

function findSettingValue(sheet, itemLabel) {
  let found;
  let foundRow = false;
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const item = xlsx.readCell(row.getCell(1));
    if (item === itemLabel) {
      found = xlsx.readCell(row.getCell(2));
      foundRow = true;
    }
  });
  if (!foundRow) {
    throw new SettingsValidationError(
      `"설정" 시트에서 "${itemLabel}" 항목을 찾을 수 없습니다. 파일을 삭제한 뒤 다시 실행해 템플릿을 재생성하세요.`
    );
  }
  return found;
}

async function loadSettings({ inputDir }) {
  const filePath = path.join(inputDir, SETTINGS_FILENAME);

  if (!(await xlsx.fileExists(filePath))) {
    await xlsx.createSettingsTemplate(filePath);
    throw new SettingsNotReadyError(
      `설정 파일이 없어 새로 만들었습니다: ${filePath}\n노란 칸을 채우고 저장한 뒤 프로그램을 다시 실행하세요.`
    );
  }

  const wb = await xlsx.readWorkbook(filePath);
  const settingSheet = wb.getWorksheet('설정');
  const bandSheet = wb.getWorksheet('대상밴드');
  if (!settingSheet || !bandSheet) {
    throw new SettingsValidationError(
      `${filePath} 파일의 시트 구성이 손상되었습니다. "설정"·"대상밴드" 시트가 모두 있어야 합니다. 파일을 삭제하고 다시 실행해 템플릿을 재생성하세요.`
    );
  }
  assertHeaders(settingSheet, SETTING_SHEET_HEADERS, '설정', filePath);
  assertHeaders(bandSheet, BAND_SHEET_HEADERS, '대상밴드', filePath);

  const modeRaw = findSettingValue(settingSheet, '실행 모드');
  const mode = typeof modeRaw === 'string' ? modeRaw.trim().toLowerCase() : '';
  if (mode !== 'test' && mode !== 'production') {
    throw new SettingsValidationError(
      `"실행 모드" 값이 올바르지 않습니다. test 또는 production만 허용됩니다. 현재 값: ${JSON.stringify(modeRaw)}`
    );
  }

  const capRaw = findSettingValue(settingSheet, '총점 상한');
  const cap = Number(capRaw);
  if (!Number.isFinite(cap) || cap <= 0) {
    throw new SettingsValidationError(
      `"총점 상한" 값이 올바르지 않습니다. 1 이상의 숫자를 입력하세요. 현재 값: ${JSON.stringify(capRaw)}`
    );
  }

  const startRaw = findSettingValue(settingSheet, '측정 시작일');
  const endRaw = findSettingValue(settingSheet, '측정 종료일');
  const startEmpty = startRaw === '' || startRaw == null;
  const endEmpty = endRaw === '' || endRaw == null;

  if (mode === 'production' && (startEmpty || endEmpty)) {
    throw new SettingsValidationError(
      `실행 모드가 production인데 측정 시작일/종료일이 비어 있습니다. 정식 채점은 매 실행 시 기간을 직접 입력해야 합니다 (스테일 설정으로 실행하는 것을 막기 위함).`
    );
  }

  let measureStartMs = null;
  let measureEndMs = null;
  let startLabel = null;
  let endLabel = null;

  if (!startEmpty) {
    const s = parseKstDateCell(startRaw, '측정 시작일');
    measureStartMs = kstMidnightUtcMs(s.y, s.m, s.d);
    startLabel = `${s.y}-${String(s.m).padStart(2, '0')}-${String(s.d).padStart(2, '0')}`;
  }
  if (!endEmpty) {
    const e = parseKstDateCell(endRaw, '측정 종료일');
    measureEndMs = kstEndOfDayUtcMs(e.y, e.m, e.d);
    endLabel = `${e.y}-${String(e.m).padStart(2, '0')}-${String(e.d).padStart(2, '0')}`;
  }
  if (measureStartMs != null && measureEndMs != null && measureStartMs > measureEndMs) {
    throw new SettingsValidationError(`측정 시작일(${startLabel})이 측정 종료일(${endLabel})보다 늦습니다.`);
  }

  const bands = [];
  bandSheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const name = xlsx.readCell(row.getCell(1));
    const bandRef = xlsx.readCell(row.getCell(2));
    if (!name && !bandRef) return;
    if (typeof name === 'string' && name.startsWith('(예시')) return;
    if (!name || !bandRef) {
      throw new SettingsValidationError(
        `"대상밴드" 시트 ${rowNumber}행의 이름·URL/ID 중 하나가 비어 있습니다. 둘 다 채우거나 행을 비워두세요.`
      );
    }
    const bandId = normalizeBandId(bandRef, rowNumber);
    bands.push({ name: String(name).trim(), bandId });
  });

  if (bands.length === 0) {
    throw new SettingsValidationError(`"대상밴드" 시트에 입력된 밴드가 없습니다. 최소 1개 이상 입력하세요.`);
  }

  const seen = new Map();
  for (const b of bands) {
    if (seen.has(b.bandId)) {
      throw new SettingsValidationError(
        `"대상밴드" 시트에 밴드 ID ${b.bandId}가 중복 입력되었습니다 (${seen.get(b.bandId)} / ${b.name}).`
      );
    }
    seen.set(b.bandId, b.name);
  }

  return {
    filePath,
    mode,
    cap,
    measureStartMs,
    measureEndMs,
    startLabel,
    endLabel,
    bands,
  };
}

module.exports = {
  SETTINGS_FILENAME,
  SettingsNotReadyError,
  SettingsValidationError,
  loadSettings,
  kstMidnightUtcMs,
  kstEndOfDayUtcMs,
};
