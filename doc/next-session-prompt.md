# 다음 세션 시작 프롬프트

> 이 파일 내용을 다음 세션 시작 시 그대로 붙여넣어 쓴다. 배경/근거는 `doc/PLAN.md` §H에
> 전부 기록돼 있으니, 이 프롬프트는 "무엇을 할지"만 순서대로 정리한 것이다.

---

`band-score-capture` 프로젝트를 이어서 진행한다. 먼저 `CLAUDE.md` 전체와 `doc/PLAN.md` §H를
읽어라.

## 지금 상태 요약 — M2 입출력 UX 재정비 8단계 중 Phase 0~5 완료, 이번 세션은 Phase 6부터

M1(`acquire/`)은 실기동 검증까지 끝났다(`doc/m1-live-findings.md` §27-28). M2 채점 파이프라인의
입출력 재정비 8단계 계획(`doc/PLAN.md` §H-3) 중 Phase 0(테스트 인프라)·Phase 1(실행모드
CLI/env 이전)·Phase 2(예상 게시글수 입력 + 밴드요약 시트)·Phase 3(학생별 게시글수·댓글수 컬럼)·
Phase 4(결과 시트 0값 하이라이트)·Phase 5(로스터 최초/최신활동 표시)까지 구현·테스트 완료됐고
전부 커밋됐다(`1a09479`, `578858d`, `45319dc`, `eadd3ef`, `4070393`, `5d2aea0`). `npm test`
(= `node --test score lib`)는 95건 전부 통과 상태다.

**이번 세션은 Phase 6(부적합 데이터 확인 엑셀 + 채점 게이트, 5개 하위단계)부터 순서대로
진행한다.** Phase를 건너뛰거나 순서를 바꾸지 마라 — 뒷 phase가 앞 phase의 산출물에 의존한다.

## 이번 세션 할 일 — Phase 6: 부적합 데이터 확인 엑셀 + 채점 게이트

### 배경 (반드시 먼저 이해할 것)

지금 "부적합 데이터"(자동 수집이 확신 못 하고 사람 확인이 필요하다고 표시한 것)는 3개의
독립된 축으로 이미 흩어져 존재한다. Phase 6은 이 세 축을 **엑셀 하나**로 합쳐 왕복 입력물로
만들고, 미해결 항목이 남아있으면 채점을 거부하는 게이트를 만드는 작업이다.

1. **게시글 총수 자체 불일치** — `data/raw/<bandId>/incomplete_gaps.json`의
   `type: 'total-post-count-mismatch'` 항목(`acquire/collector.js:1370` 부근에서 씀,
   `reasonTier: 2`). "이 글 자체를 놓쳤는지" 확인하는 것으로, 아래 2번과는 채워야 할 값의
   성격이 다르다(개별 게시글 댓글수 보충이 아니라 게시글 존재 여부 확인) — 엑셀 안에서
   **별도 하위 섹션**으로 구분해야 한다(H-1 확정 사항).
2. **게시글별 댓글수 불일치** — 같은 `incomplete_gaps.json`의 나머지 타입들:
   `type: 'displayed-count-mismatch'`(`reasonTier: 2`, 모달 표시 댓글수와 불일치),
   `type: 'reply'`(`reasonTier: 3`, 대댓글 추정), 타입 없는 기본 케이스(post-level 최상위
   댓글수 불일치, `reasonTier: 3`). 지금 이 파일은 `scripts/list_incomplete_gaps.js`가 읽어서
   콘솔 체크리스트 + `out/verify/manual_followup_<bandId>.csv`(빈 `manual_value`/`note` 칸)로
   변환한다 — **이 스크립트의 CSV 생성 로직을 엑셀 워크북 생성으로 그대로 이전**하는 게
   6-1의 핵심.
3. **학생별 댓글수 불일치** — `data/raw/<bandId>/_members/member_comment_counts_*.json`
   (최신 파일, `acquire/writer.js:168` `writeMemberCommentCounts`가 씀 — `BSC_VERIFY_MEMBERS=1`일
   때만 채워짐)와 raw ndjson에서 직접 집계한 캡처값을 대조한다. 지금
   `scripts/verify_member_comment_counts.js`가 이 대조를 해서
   `out/verify/member_comment_counts_<bandId>.csv`(member_name, user_no, displayed_count,
   captured_count, diff)를 낸다 — 이 로직도 이전 대상.

"화면 표시 댓글수"라는 용어를 쓸 것(H-1 확정 — "예측 댓글수"라는 표현은 CLAUDE.md 신뢰도
tier상 오해 소지가 있어 폐기됨. 이 값은 tier 2, band.us UI가 사람에게 보여주는 값이지 시스템
추정치가 아니다).

### 하위단계 (순서대로, 각자 별도 커밋 권장)

- **6-1**: `scripts/list_incomplete_gaps.js`(게시글 총수 + 게시글별 댓글수, 위 1·2번)와
  `scripts/verify_member_comment_counts.js`(학생별 댓글수, 위 3번)의 데이터 로딩/변환 로직을
  새 모듈(예: `score/gaps.js`, 또는 `lib/xlsx.js`에 통합 — 판단해서 정하되 `score/`+`lib/`
  기존 계층 분리 원칙 유지)로 옮겨, `input/부적합_데이터_확인.xlsx`를 만드는 함수를 짠다.
  워크북 안에 3개 섹션(시트로 분리하는 편이 자연스러움: "게시글총수", "게시글댓글",
  "학생댓글") + 각 행에 `manual_value` 노란칸(`lib/xlsx.js`의 `applyYellow` 재사용).
- **6-2**: "학생댓글" 시트에 SUMIF류 수식으로 "manual_value 반영 시 실시간 합산" 계산기
  컬럼을 추가한다(교수가 값을 채우는 즉시 화면에서 합계가 바뀌어 보이게 — ExcelJS로 수식
  문자열을 `cell.value = { formula: '...' }` 형태로 넣으면 됨).
- **6-3**: 되읽기 함수를 `score/gaps.js`(신규)에 작성 — 워크북을 읽어 각 섹션의
  `manual_value`가 전부 채워졌는지 판단하는 함수(예: `checkGapsResolved(filePath)` →
  `{ resolved: boolean, unresolvedCount, bySection }`). 파일이 아예 없는 경우(=수집 단계에서
  결손이 하나도 없었던 경우)는 "게이트 통과"로 취급해야 한다 — 결손 없음과 결손 미해결을
  혼동하지 말 것.
- **6-4**: `score/index.js`에 게이트 연결 — 채점 시작 전에 `score/gaps.js`로 확인해서
  미해결이면 명확한 안내 메시지와 함께 `process.exit(1)`(기존 `settingsLib` 검증 실패 패턴과
  동일하게). 해결된 상태면 `manual_value`를 활동 레코드에 반영한 뒤 정상 진행(반영 방법은
  섹션별로 다름 — 게시글 총수/게시글 댓글은 원래 게시글·댓글 카운트에 보정치를 더하는 방식,
  학생별 댓글수는 해당 user_no의 commentCount/activeDays에 직접 반영하는 방식이 될 것 —
  설계 시 `score/scorer.js`의 `scoreActivities` 출력 구조(`activeDays`, `postCount`,
  `commentCount`, `records`)와 어떻게 합성할지 먼저 결정하고 시작할 것. `records`에 근거
  없는 보정 값을 넣게 되면 감사 시트(`score/csv.js`의 `auditSheet`)의 "내용 요약"이 빈
  껍데기가 되므로, 최소한 "수동 보정(사유: ...)" 같은 placeholder 텍스트를 넣어 감사근거를
  잃지 않게 할 것).
- **6-5**: 엔드투엔드 검증 — 합성 데이터로 "미해결 상태 → 채점 거부 → manual_value 채움 →
  재실행 → 반영되어 채점 진행"까지 전체 시나리오를 `node:test`로 작성.

### 주의사항

- **`taUserNos` 소거는 이 작업과 무관.** H-1에서 이미 "교수용 입력에 제외 대상을 별도로
  노출할 필요 없음, 조교가 섞이면 교수가 직접 무시하면 됨"으로 확정됐다 — 부적합 데이터
  확인 엑셀에 조교 소거 UI를 추가하지 말 것.
- Phase 2에서 만든 "밴드요약" 시트(예상 게시글수 vs 캡처된 게시글수)와 이번 Phase 6의
  "게시글총수" 섹션은 **다른 것**이다 — 밴드요약은 참고용 요약이고(채점을 막지 않음),
  Phase 6은 결손이 확인되지 않으면 채점 자체를 막는 게이트다. 혼동하지 말 것
  (`doc/PLAN.md` §H-3 Phase 0 설명에 이미 이 경고가 있다).
- 신뢰도 tier 판단(`CLAUDE.md` "Trust tiers" 절)을 엑셀 안 문구·정렬 순서에 반영할 것 —
  `reasonTier`가 낮을수록(신뢰도 높을수록) 먼저 보이게(`scripts/list_incomplete_gaps.js`가
  이미 이렇게 정렬하고 있으니 그 순서를 유지).

## 검증

- 각 하위단계마다 `node:test`로 회귀 테스트 추가, `npm test` 전체 통과 유지(현재 95건
  기준선에서 늘어나야 함, 줄어들면 안 됨).
- 6-5의 엔드투엔드 시나리오 테스트가 이번 Phase의 최종 검증 기준.

## 완료 후

Phase 6이 끝나고 테스트가 전부 통과하면, 사용자에게 알리고 Phase 7(파일명/폴더 정리)로
넘어가도 될지 확인할 것. `doc/PLAN.md` §H-3에 Phase 7~8 전체 목록과 각 단계의 구현 범위·검증
방법이 정리돼 있다. 매 phase 완료 시 `doc/PLAN.md` §H-3와 이 파일(`doc/next-session-prompt.md`)을
다음 phase 기준으로 갱신하고 커밋하는 습관을 유지해라(이번 세션 인계 방식 그대로).
