const fs = require('fs');
const path = require('path');

// BSC_TRACE=1로 켜면 모든 data-host 요청의 생명주기(요청 발생/응답 도착/실패), 댓글
// 페이지네이션 중 total 값 변화, 밴드 페이지 콘솔 에러를 logs/trace/에 ndjson으로 통째로
// 남긴다. m1-live-findings.md §8-2 참고 — "재기동 한 번 = 가설 하나 검증"의 비용을 줄이려고
// 실기동 전에 미리 깔아두는 상시 계측이다. 기본은 꺼져 있다(끄면 record()는 아무 것도 안 함).
function createTracer({ logsDir, bandId, enabled = process.env.BSC_TRACE === '1' } = {}) {
  if (!enabled) {
    return { enabled: false, file: null, record: () => {}, close: () => {} };
  }
  const dir = path.join(logsDir, 'trace');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `trace_${bandId}_${Date.now()}.ndjson`);
  const stream = fs.createWriteStream(file, { flags: 'a' });
  // close()는 main.js가 밴드 처리를 끝내며 부르지만, CDP의 Debugger.onMessage 핸들러는
  // async라 그 시점에 아직 처리 중인 메시지가 남아있을 수 있다 — close() 이후에도 record()가
  // 불려서 stream.write()가 ERR_STREAM_WRITE_AFTER_END로 앱 전체를 죽이는 크래시를 실기동으로
  // 확인함(2026-07-17). close 이후의 record()는 조용히 버린다.
  let closed = false;

  function record(event) {
    if (closed) return;
    stream.write(JSON.stringify({ tsMs: Date.now(), bandId, ...event }) + '\n');
  }

  return {
    enabled: true,
    file,
    record,
    close: () => {
      closed = true;
      stream.end();
    },
  };
}

module.exports = { createTracer };
