# 다음 세션 시작 프롬프트

> 이 파일 내용을 다음 세션 시작 시 그대로 붙여넣어 쓴다. 배경/근거는 `doc/PLAN.md` §H에
> 전부 기록돼 있으니, 이 프롬프트는 "무엇을 할지"만 순서대로 정리한 것이다.

---

`band-score-capture` 프로젝트를 이어서 진행한다. 먼저 `CLAUDE.md` 전체와 `doc/PLAN.md` §H를
읽어라.

## 지금 상태 요약 — M2 입출력 UX 재정비 8단계 중 Phase 0~7 완료, 이번 세션은 사용자 결정 대기
## 항목 확인부터 시작하거나(아래), 여유되면 Phase 8로

M1(`acquire/`)은 실기동 검증까지 끝났다(`doc/m1-live-findings.md` §27-28 — 다시 손댈 때만
참고). M2 채점 파이프라인의 입출력 재정비 8단계 계획(`doc/PLAN.md` §H-3) 중 Phase 0(테스트
인프라)~Phase 7(파일명/폴더 정리)까지 구현·테스트·커밋 완료됐다. `npm test`(=
`node --test 'score/*.test.js' 'lib/*.test.js'`)는 119건 전부 통과 상태다.

**2026-07-21 같은 세션에서, Phase 0~6이 끝난 뒤 실기동 없이 합성 데이터로 M2 파이프라인
전체를 실제로 여러 번 실행해보는 사후 검증을 했다** — 단위테스트가 "재실행 간 상태 변화"
시나리오를 안 짜서 놓쳤던 버그 2건을 발견해 수정·회귀테스트·재검증까지 마쳤다. 상세 근거는
`doc/PLAN.md` §H-3 상단 "Phase 0~6 사후 검증" 항목 참고:
1. `score/roster.js` 임시 학번(TEST####) 재배정 버그 수정.
2. `score/gaps.js`/`lib/xlsx.js`/`score/index.js` — 확인 엑셀이 이미 있으면 재수집으로 새로
   드러난 결손이 게이트에 반영 안 되던 버그 수정(Phase 6의 핵심 목적과 직결되는 버그였음).

**Phase 6 핵심 산출물**(다음 phase 작업 전에 알아둘 것):
- `score/gaps.js` — incomplete_gaps.json(게시글총수/게시글댓글)과
  member_comment_counts_*.json(학생댓글) 로딩·변환·게이트 판정·보정 적용을 전부 담당.
  `ensureGapsWorkbook`은 이제 **매 실행마다 최신 섹션으로 재생성**하되(위 버그 수정 이후)
  기존에 채운 manual_value/note는 식별키(밴드/게시글/유저 기준)로 이어받는다.
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

**Phase 7 산출물**: `out/verify/*.csv`(개발자/조교용 진단 CSV) 3종에 `diag_` 접두어 적용
완료(`scripts/list_incomplete_gaps.js`→`diag_gap_checklist_<bandId>.csv`,
`scripts/verify_member_comment_counts.js`→`diag_member_comment_counts_<bandId>.csv`,
`scripts/verify_comment_counts.js`→`diag_captured_comment_counts_<bandId>.csv`).

## 사용자 결정 대기 — 이번 세션 먼저 확인할 것

Phase 7 리뷰 중 파일명 정리보다 큰 문제를 하나 발견해 **코드는 건드리지 않고 보고만** 해뒀다:

**`input/3_멤버리스트_<밴드>.xlsx`(교수가 밴드에서 내보내 투입하는 파일)와 이를 읽는
`lib/xlsx.js`의 `readMemberListExport`가 정의·단위테스트만 있고, 실제 채점 파이프라인
(`score/index.js`, `score/roster.js`) 어디에서도 호출되지 않는 죽은 코드다.** 리더/조교
판별은 이미 `get_members_of_band` API 응답의 `role` 필드로 처리되고 있다(M1 recon으로
확인·확정된 경로). PLAN.md D0 시절엔 이 엑셀이 "리더여부 식별 단서"로 필요하다고 봤지만,
recon에서 API가 role을 직접 준다는 게 확인된 뒤로 안 쓰이게 된 것으로 보인다(코드에 그 경위가
남아있진 않음 — 추정).

결정이 필요한 것: (a) `3_멤버리스트_<밴드>.xlsx`·`readMemberListExport`·관련 테스트를 죽은
코드로 판단해 삭제(교수가 더 이상 이 파일을 준비할 필요 없어짐 — 워크플로 단순화), 아니면
(b) PLAN.md NU10이 언급한 "역할 자동추론이 실패하는 케이스(활동 없는 리더)의 보완용 폴백"으로
실제 연결. 사용자에게 먼저 물어볼 것 — 코드 스캔만으로는 (a)/(b) 중 뭐가 맞는지 판단 불가.

## Phase 8 — `score_logic.xlsx` (여유가 되면, 최하위 우선순위)

`doc/PLAN.md` §H-3 Phase 8 참고. 신규 템플릿(일일활동상한·일일점수상한·댓글배수·게시글배수·
과제글포함여부, 기본값 전부 "변경불필요") + `score/rules.js`/`scorer.js` 파라미터화. 검증: 기본값일
때 Phase 0 베이스라인 테스트와 완전히 동일한 점수가 나오는지 회귀 확인, 값 변경 시 정확히
반영되는지.

## 완료 후

Phase 8이 끝나고(또는 위 사용자 결정 항목이 처리되고) 테스트가 전부 통과하면, 사용자에게
알릴 것. 8단계 전체(Phase 0~8)가 끝나면 M2 입출력 재정비 계획 자체가 완료되는 것이므로,
`doc/PLAN.md` §H를 "완료" 상태로 갱신하고 다음 마일스톤이 있는지 사용자에게 확인할 것. 매
phase 완료 시 `doc/PLAN.md` §H-3와 이 파일(`doc/next-session-prompt.md`)을 다음 phase
기준으로 갱신하고 커밋하는 습관을 유지해라(이번 세션 인계 방식 그대로).
