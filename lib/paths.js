const path = require('path');

// 패키징된 exe는 __dirname이 asar 내부(쓰기 불가)를 가리키므로, 사용자 데이터(input/data/out/logs)는
// exe 위치와 무관한 고정 폴더에 둔다. 처음엔 "내 문서"(app.getPath('documents'))를 썼으나,
// 2026-07-22 실기동에서 "내 문서"가 OneDrive 동기화 폴더로 리디렉션된 PC(대학 관리 계정 등)에서
// data/raw/의 잦은 append 쓰기마다 OneDrive가 파일을 잠그고 동기화를 시도해 수집 속도가 심각하게
// 느려지고(스크롤 렉·타임아웃) 심지어 멤버 목록 캡처가 15초 타임아웃(acquire/collector.js)을
// 넘겨 실패하는 원인이 됨을 실측 확인 — app.getPath('appData')(%APPDATA%)는 OneDrive의 "알려진
// 폴더 이동(KFM)" 대상이 절대 아니라서(Desktop/Documents/Pictures만 해당) 이 문제에서 자유롭다.
// 발견/접근성은 완료 대화상자에 결과 파일 경로를 그대로 보여주는 것으로 대체한다.
function resolveDataRoot() {
  const isElectronRuntime = !!process.versions.electron;
  if (isElectronRuntime) {
    const { app } = require('electron');
    if (app.isPackaged) {
      return path.join(app.getPath('appData'), '밴드 성적 자동 채점기');
    }
  }
  return path.join(__dirname, '..');
}

module.exports = { resolveDataRoot };
