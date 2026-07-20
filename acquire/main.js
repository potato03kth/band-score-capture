const { app, BrowserWindow, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../lib/config');
const settingsLib = require('../lib/settings');
const { createWriter } = require('./writer');
const { createInterceptor } = require('./capture/interceptor');
const { attachCdpCapture } = require('./capture/cdp-capture');
const { createTracer } = require('./capture/tracer');
const collector = require('./collector');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config', 'config.jsonc');

function resolvePaths(config) {
  const p = config.paths || {};
  return {
    input: path.join(ROOT, p.input || 'input'),
    raw: path.join(ROOT, p.raw || 'data/raw'),
    out: path.join(ROOT, p.out || 'out'),
    logs: path.join(ROOT, p.logs || 'logs'),
  };
}

function createLogger(logFile) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const stream = fs.createWriteStream(logFile, { flags: 'a' });
  function write(level, args) {
    const line = `[${new Date().toISOString()}] [${level}] ${args
      .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ')}`;
    stream.write(line + '\n');
    if (level === 'ERROR') console.error(line);
    else if (level === 'WARN') console.warn(line);
    else console.log(line);
  }
  return {
    log: (...args) => write('INFO', args),
    warn: (...args) => write('WARN', args),
    error: (...args) => write('ERROR', args),
  };
}

async function run() {
  const config = loadConfig(CONFIG_PATH);
  const paths = resolvePaths(config);
  const logger = createLogger(path.join(paths.logs, 'audit', `run_${Date.now()}.log`));

  let settings;
  try {
    const mode = settingsLib.resolveMode();
    settings = await settingsLib.loadSettings({ inputDir: paths.input, mode });
  } catch (err) {
    if (err instanceof settingsLib.SettingsNotReadyError || err instanceof settingsLib.SettingsValidationError) {
      logger.error(err.message);
      dialog.showErrorBox('설정 확인 필요', err.message);
      app.quit();
      return;
    }
    throw err;
  }

  logger.log(
    `설정 로드 완료: 모드=${settings.mode}, 기간=${settings.startLabel || '(미지정)'}~${
      settings.endLabel || '(미지정)'
    }, cap=${settings.cap}, 대상 밴드 ${settings.bands.length}개`
  );

  const win = new BrowserWindow({
    width: 1200,
    height: 900,
    show: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      partition: (config.session && config.session.partition) || 'persist:band-capture',
    },
  });

  // CDP(webContents.debugger)로 캡처하므로 openDevTools()는 붙이지 않는다 — 둘은 같은
  // CDP 세션 슬롯을 다퉈 동시 사용이 불가하다(doc/m1-cdp-migration-plan.md §1).

  win.on('closed', () => {
    logger.warn('창이 사용자에 의해 닫혔습니다. 남은 밴드 수집이 중단됩니다.');
    app.quit();
  });

  if (process.env.BSC_TRACE !== '0') {
    logger.log('[main] 트레이스 활성화(기본값) — 요청 생명주기/댓글 total 변화/콘솔 에러를 logs/trace/에 기록합니다. 끄려면 BSC_TRACE=0.');
  }

  for (const band of settings.bands) {
    logger.log(`=== 밴드 시작: ${band.name} (${band.bandId}) ===`);
    const writer = createWriter({ rawDir: paths.raw, bandId: band.bandId });
    const tracer = createTracer({ logsDir: paths.logs, bandId: band.bandId });
    const interceptor = createInterceptor({ writer, bandId: band.bandId, logger, tracer });

    // AI가 화면을 직접 못 보는 세션(CLI 등)에서도 상황을 이해할 수 있도록, CDP가 attach되기
    // 전에도 collector.js가 안전하게 호출할 수 있는 no-op 스크린샷 함수를 먼저 걸어둔다 —
    // attach 완료 후 실제 함수로 교체된다(§ 아래 cdpPromise.then).
    interceptor.screenshot = async () => null;

    // 밴드마다 새로 attach/detach한다(옵션 A) — pending Map이 밴드 사이에서 꼬이지 않고
    // 에러 처리도 밴드 단위로 격리된다(doc/m1-cdp-migration-plan.md §3).
    // CDP attach 완료를 기다리지 않고 탐색을 바로 시작한다 — attach/Network.enable이 느리거나
    // 멈춰도(실기동 관측됨) 로그인 화면 로딩 자체는 막히면 안 되므로 병렬로 진행한다.
    const cdpPromise = attachCdpCapture(win, interceptor, { logger, tracer, logsDir: paths.logs, bandId: band.bandId })
      .then((cdp) => {
        interceptor.screenshot = cdp.screenshot;
        return cdp;
      })
      .catch((err) => {
        logger.error(`[main] CDP attach 실패: ${err.stack || err.message}`);
        return null;
      });
    try {
      await collector.runBandCollection({ win, interceptor, writer, band, settings, config, logger });
    } catch (err) {
      logger.error(`밴드 ${band.bandId} 수집 중 오류: ${err.stack || err.message}`);
      await interceptor.screenshot(`band-error-${band.bandId}`);
    } finally {
      const cdp = await cdpPromise;
      if (cdp) cdp.detach();
      tracer.close();
    }

    const delayMs = (config.pacing && config.pacing.delayBetweenBandsMs) || 5000;
    await collector.randomDelay({ minDelayMs: delayMs, maxDelayMs: delayMs });
  }

  logger.log('모든 밴드 수집 완료.');
}

app.whenReady().then(() => {
  run().catch((err) => {
    dialog.showErrorBox('실행 오류', err.stack || String(err));
    app.quit();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
