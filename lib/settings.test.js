const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ExcelJS = require('exceljs');

const settingsLib = require('./settings');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bsc-test-'));
}

// settingsRows: [[item, value], ...] 순서/항목 자유 지정(헤더 손상 테스트용으로 시트 자체도 커스텀 가능)
async function writeSettingsWorkbook(filePath, {
  settingHeaders = ['항목', '값', '설명'],
  settingRows = [
    ['측정 시작일', ''],
    ['측정 종료일', ''],
    ['총점 상한', 50],
    ['실행 모드', 'test'],
  ],
  bandHeaders = ['밴드 이름', '밴드 URL 또는 ID'],
  bandRows = [['1반', 'https://www.band.us/band/103239777/post']],
  includeBandSheet = true,
} = {}) {
  const wb = new ExcelJS.Workbook();
  const settingSheet = wb.addWorksheet('설정');
  settingSheet.addRow(settingHeaders);
  for (const [item, value] of settingRows) settingSheet.addRow([item, value, '']);

  if (includeBandSheet) {
    const bandSheet = wb.addWorksheet('대상밴드');
    bandSheet.addRow(bandHeaders);
    for (const row of bandRows) bandSheet.addRow(row);
  }

  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await wb.xlsx.writeFile(filePath);
}

test('loadSettings: 파일이 없으면 템플릿을 만들고 SettingsNotReadyError를 던진다', async () => {
  const dir = makeTmpDir();
  try {
    await assert.rejects(
      () => settingsLib.loadSettings({ inputDir: dir }),
      settingsLib.SettingsNotReadyError
    );
    assert.equal(fs.existsSync(path.join(dir, settingsLib.SETTINGS_FILENAME)), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadSettings: 정상 케이스(test 모드, 밴드 1개)는 문제없이 로드된다', async () => {
  const dir = makeTmpDir();
  try {
    const filePath = path.join(dir, settingsLib.SETTINGS_FILENAME);
    await writeSettingsWorkbook(filePath);
    const settings = await settingsLib.loadSettings({ inputDir: dir });
    assert.equal(settings.mode, 'test');
    assert.equal(settings.cap, 50);
    assert.equal(settings.measureStartMs, null);
    assert.equal(settings.measureEndMs, null);
    assert.deepEqual(settings.bands, [{ name: '1반', bandId: '103239777' }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadSettings: production 모드에서 측정 시작/종료일이 비어있으면 거부한다', async () => {
  const dir = makeTmpDir();
  try {
    const filePath = path.join(dir, settingsLib.SETTINGS_FILENAME);
    await writeSettingsWorkbook(filePath, {
      settingRows: [
        ['측정 시작일', ''],
        ['측정 종료일', ''],
        ['총점 상한', 50],
        ['실행 모드', 'production'],
      ],
    });
    await assert.rejects(
      () => settingsLib.loadSettings({ inputDir: dir }),
      settingsLib.SettingsValidationError
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadSettings: production 모드 + 날짜 기입은 통과하고 KST 경계로 변환된다', async () => {
  const dir = makeTmpDir();
  try {
    const filePath = path.join(dir, settingsLib.SETTINGS_FILENAME);
    await writeSettingsWorkbook(filePath, {
      settingRows: [
        ['측정 시작일', '2026-06-28'],
        ['측정 종료일', '2026-07-16'],
        ['총점 상한', 50],
        ['실행 모드', 'production'],
      ],
    });
    const settings = await settingsLib.loadSettings({ inputDir: dir });
    assert.equal(settings.startLabel, '2026-06-28');
    assert.equal(settings.endLabel, '2026-07-16');
    assert.equal(settings.measureStartMs, settingsLib.kstMidnightUtcMs(2026, 6, 28));
    assert.equal(settings.measureEndMs, settingsLib.kstEndOfDayUtcMs(2026, 7, 16));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadSettings: 밴드 ID는 URL이든 순수 숫자든 동일하게 정규화된다', async () => {
  const dir = makeTmpDir();
  try {
    const filePath = path.join(dir, settingsLib.SETTINGS_FILENAME);
    await writeSettingsWorkbook(filePath, {
      bandRows: [
        ['1반', 'https://www.band.us/band/103239777/post'],
        ['2반', '203239778'],
      ],
    });
    const settings = await settingsLib.loadSettings({ inputDir: dir });
    assert.deepEqual(settings.bands, [
      { name: '1반', bandId: '103239777' },
      { name: '2반', bandId: '203239778' },
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadSettings: 밴드 ID 중복이면 거부한다', async () => {
  const dir = makeTmpDir();
  try {
    const filePath = path.join(dir, settingsLib.SETTINGS_FILENAME);
    await writeSettingsWorkbook(filePath, {
      bandRows: [
        ['1반', '103239777'],
        ['1반 복사본', '103239777'],
      ],
    });
    await assert.rejects(
      () => settingsLib.loadSettings({ inputDir: dir }),
      settingsLib.SettingsValidationError
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadSettings: "대상밴드" 시트 헤더가 손상되면 거부한다', async () => {
  const dir = makeTmpDir();
  try {
    const filePath = path.join(dir, settingsLib.SETTINGS_FILENAME);
    await writeSettingsWorkbook(filePath, {
      bandHeaders: ['밴드명 오타', '밴드 URL 또는 ID'],
    });
    await assert.rejects(
      () => settingsLib.loadSettings({ inputDir: dir }),
      settingsLib.SettingsValidationError
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadSettings: "설정" 시트 헤더가 손상되면 거부한다', async () => {
  const dir = makeTmpDir();
  try {
    const filePath = path.join(dir, settingsLib.SETTINGS_FILENAME);
    await writeSettingsWorkbook(filePath, {
      settingHeaders: ['항목', '내용', '설명'],
    });
    await assert.rejects(
      () => settingsLib.loadSettings({ inputDir: dir }),
      settingsLib.SettingsValidationError
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadSettings: "대상밴드" 시트가 통째로 없으면 거부한다', async () => {
  const dir = makeTmpDir();
  try {
    const filePath = path.join(dir, settingsLib.SETTINGS_FILENAME);
    await writeSettingsWorkbook(filePath, { includeBandSheet: false });
    await assert.rejects(
      () => settingsLib.loadSettings({ inputDir: dir }),
      settingsLib.SettingsValidationError
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadSettings: 밴드가 하나도 없으면 거부한다', async () => {
  const dir = makeTmpDir();
  try {
    const filePath = path.join(dir, settingsLib.SETTINGS_FILENAME);
    await writeSettingsWorkbook(filePath, { bandRows: [] });
    await assert.rejects(
      () => settingsLib.loadSettings({ inputDir: dir }),
      settingsLib.SettingsValidationError
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadSettings: "실행 모드" 값이 test/production이 아니면 거부한다', async () => {
  const dir = makeTmpDir();
  try {
    const filePath = path.join(dir, settingsLib.SETTINGS_FILENAME);
    await writeSettingsWorkbook(filePath, {
      settingRows: [
        ['측정 시작일', ''],
        ['측정 종료일', ''],
        ['총점 상한', 50],
        ['실행 모드', 'staging'],
      ],
    });
    await assert.rejects(
      () => settingsLib.loadSettings({ inputDir: dir }),
      settingsLib.SettingsValidationError
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadSettings: 측정 시작일이 종료일보다 늦으면 거부한다', async () => {
  const dir = makeTmpDir();
  try {
    const filePath = path.join(dir, settingsLib.SETTINGS_FILENAME);
    await writeSettingsWorkbook(filePath, {
      settingRows: [
        ['측정 시작일', '2026-07-16'],
        ['측정 종료일', '2026-06-28'],
        ['총점 상한', 50],
        ['실행 모드', 'production'],
      ],
    });
    await assert.rejects(
      () => settingsLib.loadSettings({ inputDir: dir }),
      settingsLib.SettingsValidationError
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('kstMidnightUtcMs / kstEndOfDayUtcMs: KST 00:00과 23:59:59.999를 UTC ms로 변환한다', () => {
  const start = settingsLib.kstMidnightUtcMs(2026, 6, 28);
  const end = settingsLib.kstEndOfDayUtcMs(2026, 6, 28);
  assert.equal(new Date(start).toISOString(), '2026-06-27T15:00:00.000Z');
  assert.equal(new Date(end).toISOString(), '2026-06-28T14:59:59.999Z');
});
