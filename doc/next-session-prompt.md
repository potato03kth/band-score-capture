# 다음 세션 시작 프롬프트

> 이 파일 내용을 다음 세션 시작 시 그대로 붙여넣어 쓴다. 배경/근거는 `doc/PLAN.md` §H에
> 전부 기록돼 있으니, 이 프롬프트는 "무엇을 할지"만 순서대로 정리한 것이다.

---

`band-score-capture` 프로젝트를 이어서 진행한다. 먼저 `CLAUDE.md` 전체와 `doc/PLAN.md` §H를
읽어라.

## 지금 상태 요약 — M2 입출력 UX 재정비 8단계 중 Phase 0~6 완료, 이번 세션은 Phase 7부터

M1(`acquire/`)은 실기동 검증까지 끝났다(`doc/m1-live-findings.md` §27-28 — 다시 손댈 때만
참고). M2 채점 파이프라인의 입출력 재정비 8단계 계획(`doc/PLAN.md` §H-3) 중 Phase 0(테스트
인프라)·Phase 1(실행모드 CLI/env 이전)·Phase 2(예상 게시글수 입력 + 밴드요약 시트)·Phase 3
(학생별 게시글수·댓글수 컬럼)·Phase 4(결과 시트 0값 하이라이트)·Phase 5(로스터 최초/최신활동
표시)·Phase 6(부적합 데이터 확인 엑셀 + 채점 게이트)까지 구현·테스트 완료됐고 전부 커밋됐다.
`npm test`(= `node --test 'score/*.test.js' 'lib/*.test.js'`)는 116건 전부 통과 상태다.

**Phase 6 핵심 산출물**(다음 phase 작업 전에 알아둘 것):
- `score/gaps.js`(신규) — incomplete_gaps.json(게시글총수/게시글댓글)과
  member_comment_counts_*.json(학생댓글) 로딩·변환·게이트 판정·보정 적용을 전부 담당.
  `ensureGapsWorkbook`(결손 있으면 `input/부적합_데이터_확인.xlsx` 생성, 없으면 미생성),
  `readGapsResolution`(파일 없으면 게이트 통과, 있으면 manual_value 미기입 여부로 판정 +
  보정치 계산), `applyMemberCommentCorrections`/`applyBandPostCountOverrides`(확정된 보정
  적용).
- `lib/xlsx.js`의 `createGapsTemplate` — 3시트(게시글총수/게시글댓글/학생댓글) 워크북 생성,
  "학생댓글" 시트에 실시간 반영값 IF수식 + 하단 SUM 합계행.
- `score/index.js` — 설정 로드 직후 게이트 연결(미해결 시 `process.exit(1)`), 채점 후 보정
  반영.
- **설계 결정(재확인 필요 시 `doc/PLAN.md` §H-3 Phase 6 항목 참고)**: 게시글총수/게시글댓글
  보정은 특정 학생에게 귀속 근거가 없어 점수에 반영 안 함(게시글총수만 밴드요약 시트 캡처된
  게시글수를 덮어씀). 학생댓글 보정만 유일하게 user_no가 있어 commentCount/activeDays에 직접
  반영됨.
- `scripts/list_incomplete_gaps.js`·`scripts/verify_member_comment_counts.js`는 이제
  `score/gaps.js`의 로더(`loadBandGaps`/`loadMemberCommentComparison`)를 재사용하는 얇은
  CLI 래퍼로 리팩터됨(개발자 진단용 콘솔+CSV 출력은 그대로 유지).

**이번 세션은 Phase 7(파일명/폴더 정리)부터 진행하고, 여유가 되면 Phase 8(`score_logic.xlsx`)
까지 진행한다.** Phase를 건너뛰지 마라.

## 이번 세션 할 일 — Phase 7: 파일명/폴더 정리

### 배경

`doc/PLAN.md` §H-2 표에 따르면 `out/verify/*`(개발자용 진단 CSV, `scripts/list_incomplete_gaps.js`·
`scripts/verify_member_comment_counts.js`가 생성)는 "파일명 명시화(개발자용 진단 CSV임을
이름에서 알 수 있게)"가 필요하다고 판단됐었다. **단, `부적합_데이터_확인.xlsx`는 Phase 6에서
이미 `input/`에 만들어지도록 구현 완료됐다** — H-2가 원래 요구했던 "왕복 입력물이므로
`input/`으로 위치 이전"은 이미 끝난 상태다. Phase 7에서 새로 할 일은 `out/verify/manual_followup_<bandId>.csv`,
`out/verify/member_comment_counts_<bandId>.csv` 같은 **개발자 전용 진단 산출물**의 이름이
"이게 뭔지" 파일명만으로 알 수 있는지 재검토하는 것이다(예: `_dev_diagnostic_` 접두어를 붙일지,
현재 이름으로 충분한지 등 — 강제하지 말고 실제로 헷갈리는지부터 판단할 것).

### 하위단계

- **7-1**: `out/verify/*.csv` 두 산출물의 파일명이 "개발자 진단용, 교수용 입력물 아님"이라는
  걸 이름만으로 알 수 있는지 검토. 필요하면 `scripts/list_incomplete_gaps.js`·
  `scripts/verify_member_comment_counts.js`의 outFile 이름을 바꾼다(예: 접두어 추가).
  바꾸지 않기로 결정해도 괜찮다 — 판단 근거를 커밋 메시지나 PLAN.md에 한 줄로 남길 것.
- **7-2**: `input/`·`out/` 디렉터리 전체를 훑어 이름만으로 용도가 불명확한 파일이 더 있는지
  확인(1_설정.xlsx, 2_로스터.xlsx, 부적합_데이터_확인.xlsx, scores_*.csv, 결과_및_감사_*.xlsx,
  unmatched_*.csv 등). 검증은 자동화 불필요 — 리뷰 결과를 정리해서 사용자에게 보고.

### 검증

- 코드 변경이 있다면(파일명 상수 변경 등) 관련 `node:test`가 있으면 갱신, `npm test` 전체
  통과 유지(116건 기준선에서 유지 또는 증가, 감소 금지).
- 파일명 검토 자체는 리뷰 결과 보고로 충분(자동 테스트 불필요, PLAN.md H-3에 이미 명시됨).

## Phase 8 — `score_logic.xlsx` (여유가 되면, 최하위 우선순위)

`doc/PLAN.md` §H-3 Phase 8 참고. 신규 템플릿(일일활동상한·일일점수상한·댓글배수·게시글배수·
과제글포함여부, 기본값 전부 "변경불필요") + `score/rules.js`/`scorer.js` 파라미터화. 검증: 기본값일
때 Phase 0 베이스라인 테스트와 완전히 동일한 점수가 나오는지 회귀 확인, 값 변경 시 정확히
반영되는지.

## 완료 후

Phase 7(+여유되면 8)이 끝나고 테스트가 전부 통과하면, 사용자에게 알릴 것. 8단계 전체
(Phase 0~8)가 끝나면 M2 입출력 재정비 계획 자체가 완료되는 것이므로, `doc/PLAN.md` §H를
"완료" 상태로 갱신하고 다음 마일스톤이 있는지 사용자에게 확인할 것. 매 phase 완료 시
`doc/PLAN.md` §H-3와 이 파일(`doc/next-session-prompt.md`)을 다음 phase 기준으로 갱신하고
커밋하는 습관을 유지해라(이번 세션 인계 방식 그대로).
