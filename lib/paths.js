const path = require('path');

// 패키징된 exe는 __dirname이 asar 내부(쓰기 불가)를 가리키므로, 사용자 데이터(input/data/out/logs)는
// "내 문서\밴드 성적 자동 채점기\"로 고정한다 — 교수님이 탐색기에서 쉽게 찾을 수 있고 exe 위치에
// 영향받지 않는다. 개발 모드(npm start, node score/index.js)는 기존처럼 리포 루트를 그대로 쓴다.
function resolveDataRoot() {
  const isElectronRuntime = !!process.versions.electron;
  if (isElectronRuntime) {
    const { app } = require('electron');
    if (app.isPackaged) {
      return path.join(app.getPath('documents'), '밴드 성적 자동 채점기');
    }
  }
  return path.join(__dirname, '..');
}

module.exports = { resolveDataRoot };
