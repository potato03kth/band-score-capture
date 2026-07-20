# 다음 세션 시작 프롬프트

> 이 파일 내용을 다음 세션 시작 시 그대로 붙여넣어 쓴다. 배경/근거는 `doc/PLAN.md` §H에
> 전부 기록돼 있으니, 이 프롬프트는 "무엇을 할지"만 순서대로 정리한 것이다.

---

`band-score-capture` 프로젝트를 이어서 진행한다. 먼저 `CLAUDE.md` 전체와 `doc/PLAN.md` §H를
읽어라.

## 지금 상태 요약 — M1 acquire, M2 채점 1차 구현은 끝났다. 지금은 M2의 입출력 UX 재정비 단계다

M1(`acquire/`)은 실기동 검증까지 끝났고(`doc/m1-live-findings.md` §27-28), M2 채점 파이프라인
(`score/*.js`, `lib/xlsx.js`, `lib/settings.js`)도 1차로 동작하는 상태로 커밋됐다(`f537c58`).

2026-07-21에 이 M2 산출물의 입출력을 "코딩을 하나도 모르는 사용자가 문제없이 쓸 수 있는가"
기준으로 코드/문서 리뷰만으로 대조 점검했다(실기동 없음). 그 결과 여러 갭이 발견됐고, 8단계
구현 계획으로 정리해 `doc/PLAN.md` §H에 반영했다. **이번 세션은 그 Phase 0부터 순서대로
진행한다.** Phase를 건너뛰거나 순서를 바꾸지 마라 — 뒷 phase가 앞 phase의 산출물(특히 Phase
0의 테스트 인프라, Phase 3의 게시글수/댓글수 집계)에 의존한다.

## 이번 세션 할 일 — Phase 0: 테스트 인프라 구축

1. `package.json`에 `"test": "node --test score lib"` 스크립트를 추가한다. **새 devDependency는
   추가하지 않는다** — Node 18+(이미 `electron ^31`이 요구하는 버전대) 내장 `node:test` +
   `node:assert/strict`만 쓴다. Jest 등은 도입하지 않기로 확정됐다(이유는 §H-1 참고 — 이 프로젝트는
   `exceljs` 하나만 의존성으로 두는 최소주의 기조).
2. **범위는 `score/`와 `lib/`로만 한정한다.** `acquire/`는 실 Band 로그인·DOM 자동화가 필수라
   단위테스트로 흉내낼 수 없고, 목킹하면 오히려 실제 동작과 괴리된 가짜 안전감만 준다 —
   `CLAUDE.md`에 이미 확립된 실기동+트레이스로그+신뢰도tier 검증 방식을 그대로 유지하고,
   `acquire/`용 테스트는 만들지 마라.
3. 대상 모듈과 그 옆에 만들 테스트 파일(`*.test.js`, 모듈과 같은 디렉터리):
   - `lib/xlsx.js` → `lib/xlsx.test.js` — 템플릿 생성/읽기 round-trip, `readCell`의 Date/richText/일반
     문자열 처리
   - `lib/settings.js` → `lib/settings.test.js` — 정상 케이스, production 모드에서 날짜 미기입 거부,
     밴드 ID 정규화(URL/숫자 혼용), 밴드 중복 거부, 헤더 손상 거부
   - `score/parser.js` → `score/parser.test.js` — ndjson 파싱, post/comment 활동 레코드 변환
   - `score/rules.js` → `score/rules.test.js` — 측정기간 경계(KST 00:00/23:59), 과제글 판정
     (머리말+작성자 AND 조건)
   - `score/roster.js` → `score/roster.test.js` — 후보 수집(리더+조교 소거), 합성 학번 결정성,
     동명이인 매핑상태
   - `score/scorer.js` → `score/scorer.test.js` — 활동일수 집계, cap 적용
   - `score/csv.js` → `score/csv.test.js` — CSV/엑셀 출력 형식, unmatched 필터링
4. 합성 raw ndjson/엑셀 픽스처가 필요한 테스트는 `fs.mkdtempSync(path.join(os.tmpdir(), 'bsc-test-'))`로
   매 테스트마다 격리된 임시 디렉터리를 만들어 쓰고, 테스트 종료 후 정리한다(`fs.rmSync(..., {
   recursive: true })`). 실제 `data/raw/`나 `input/`(gitignored, 실 데이터 포함)은 절대 건드리지 마라.
5. 각 테스트는 **지금 이미 동작하는 M2 파이프라인의 실제 동작을 그대로 기록하는 회귀 테스트**로
   작성한다 — Phase 0에서는 동작을 바꾸지 않는다. 이후 Phase 1부터 동작을 바꿀 때, 이 베이스라인이
   깨지면 의도한 변경인지 실수인지 바로 구분할 수 있어야 한다.

## 검증

- `npm test`(= `node --test score lib`) 실행 시 위에서 작성한 테스트가 전부 통과해야 한다.
- Phase 0는 동작 변경이 없으므로, 기존에 수동으로 실행해 확인했던 것(`out/` 아래 M2 산출물이
  이번 세션 시작 시점과 같은 형태로 나오는지)과 결과가 같은지 한 번 더 확인한다.

## 완료 후

Phase 0가 끝나고 테스트가 전부 통과하면, 사용자에게 알리고 Phase 1(실행모드를 엑셀에서 CLI/env로
이전)로 넘어가도 될지 확인할 것. `doc/PLAN.md` §H-3에 Phase 1~8 전체 목록과 각 단계의 구현
범위·검증 방법이 정리돼 있다.
