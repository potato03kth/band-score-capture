const path = require('path');

// 패키징된 exe는 __dirname이 asar 내부(쓰기 불가)를 가리키므로, 사용자 데이터는 exe 위치와
// 무관한 고정 폴더에 둔다. 2026-07-22 실기동에서 전부 "내 문서"(app.getPath('documents'))에
// 두면, "내 문서"가 OneDrive 동기화 폴더로 리디렉션된 PC(대학 관리 계정 등)에서 data/raw/의
// 잦은 append 쓰기마다 OneDrive가 파일을 잠그고 동기화를 시도해 수집 속도가 심각하게
// 느려지고(스크롤 렉·타임아웃) 심지어 멤버 목록 캡처가 15초 타임아웃(acquire/collector.js)을
// 넘겨 실패하는 원인이 됨을 확인. 반면 사용자는 무료(웹) Excel만 쓸 수 있어 input/out의
// xlsx 파일은 OneDrive에 있어야 열고 편집할 수 있다는 반대 제약도 있음 — 그래서 폴더를
// 쓰기 패턴에 따라 분리한다:
//   - input/out: 사람이 직접 열어보고 편집/열람하는 파일(설정 엑셀, 최종 결과) → "내 문서"
//     (OneDrive 동기화 대상이어도 문제없음 — 수집 중 반복 append가 아니라 가끔 한 번씩 쓰기)
//   - data/raw, logs: 수집 중 계속 append되는 고빈도 쓰기 파일 → OneDrive KFM 대상이 절대
//     아닌 app.getPath('appData')(%APPDATA%)로 격리해 동기화 잠금 경합을 피한다.
function resolveRoots() {
  const isElectronRuntime = !!process.versions.electron;
  if (isElectronRuntime) {
    const { app } = require('electron');
    if (app.isPackaged) {
      const folderName = '밴드 성적 자동 채점기';
      return {
        documentsRoot: path.join(app.getPath('documents'), folderName),
        appDataRoot: path.join(app.getPath('appData'), folderName),
      };
    }
  }
  const devRoot = path.join(__dirname, '..');
  return { documentsRoot: devRoot, appDataRoot: devRoot };
}

module.exports = { resolveRoots };
