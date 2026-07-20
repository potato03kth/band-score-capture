# 다음 세션 시작 프롬프트

> 이 파일 내용을 다음 세션 시작 시 그대로 붙여넣어 쓴다. 배경은 `doc/m1-live-findings.md`
> §27~28에 전부 기록돼 있으니, 이 프롬프트는 "무엇을 할지"만 순서대로 정리한 것이다.

---

`band-score-capture` 프로젝트를 이어서 진행한다. 먼저 `CLAUDE.md` 전체와
`doc/m1-live-findings.md` §27~28을 읽어라.

## 지금 상태 요약 — M1 acquire 핵심 검증은 끝났다

이번 세션에서 발견·수정한 버그들:
1. §27-4: 멤버 목록 지연 로딩 스크롤, 탭 전환 로딩 대기, 이벤트버스(postDetail) 중복소비.
2. §28-9: `.btnNextPost`가 공지사항으로 넘어가면 순회 전체가 조기 중단되던 버그(4분반에서
   51/98건까지만 수집되던 원인) - `announcementDetail` 이벤트를 새로 emit해서 감지·스킵.
3. §28-10: `commentPage` 이벤트도 postDetail과 같은 클래스의 이중 emit 버그가 있어
   `incomplete_gaps.json`에 가짜 결손이 다수 보고되고 있었다(실제 raw 데이터는 처음부터
   완전했음 - `writer.writeComment`가 collector의 소비 로직과 무관하게 무조건 기록하기
   때문). `drainCommentPages`로 수정.

**3분반(103239777) + 4분반(103240315) 2개 밴드, 총 3회 반복 실기동으로 전부 검증 완료**
(§28-9~28-11):
- 이벤트버스 중복소비 0건(3회 전부)
- `feedExhausted:true`, 게시글 수가 피드 스크롤 카운트와 거의 정확히 일치(3분반 61건 = §1
  수동 확인 정답과 정확히 일치)
- 멤버별 댓글 수 교차검증: 3분반 57/57, 4분반 56/56
- `incomplete_gaps.json`: 3분반 3건, 4분반 1건으로, 전부 이미 알려진 사소한 항목뿐
- 멤버별 대조의 남은 불일치는 검증 단계 동안의 실시간 댓글 활동으로 설명됨(버그 아님, 3회
  재현으로 확인)

`acquire/collector.js`/`acquire/capture/{interceptor,endpoints}.js`는 이 상태로 커밋됐다.
`input/1_설정.xlsx`(gitignored)에 3분반+4분반이 둘 다 등록돼 있다.

## 할 일

1. M1 acquire를 완료 선언하고 scoring(M2) 설계로 넘어갈 수 있다. `doc/PLAN.md`/
   `doc/project_brief.md` 참고.
2. 시작 전에 `git log --oneline -5`로 이번 세션 커밋이 실제로 반영됐는지 확인하고, 사용자에게
   M2로 넘어가도 될지 확인할 것.

## 원칙 (이번 세션에서 확인된 것)

- CDP 원격 디버깅이나 `node_modules/.bin/electron <스크립트>` 같은 가벼운 타겟 테스트 스크립트로
  먼저 가설을 검증하고, 확신이 서면 전체 사이클을 최소 횟수로 도는 방식이 효과적이었다.
- `win.loadURL()`을 직접 쓰지 말고 항상 `safeLoadURL`류 래퍼(`ERR_ABORTED` 또는 `(-3)` 코드
  둘 다 무시)를 쓸 것 - 이 환경에서 에러 메시지에 "ERR_ABORTED" 텍스트가 없는 경우가 실측
  확인됐다.
- 밴드 UI 언어(한국어/영어)는 세션마다 바뀔 수 있다 - **텍스트 매칭에 의존하지 말 것**.
  위치/순서/class 기반으로 selector를 짤 것.
- **로그에 찍히는 "표시값 vs 캡처값 불일치" 경고를 곧바로 "데이터 유실"로 해석하지 말 것.**
  §28-10에서 확인했듯 raw ndjson은 `writer.writeComment` 등이 인터셉터 단에서 무조건 기록하므로
  collector.js의 in-memory 진단 카운터 버그와 실제 데이터 유실은 별개일 수 있다 - raw 파일을
  직접 까서 확인하는 게 가장 확실하다.
- 이벤트버스(interceptor emit)가 클릭 1번에 이벤트를 두 번 쏘는 경우가 여러 종류의 이벤트에서
  반복 발견됐다(postDetail §27-1, commentPage §28-10) - 비슷한 단일-consume 패턴이 남아있는
  곳이 또 있는지 의심해볼 가치가 있다(예: memberPage, feedPage).
- 서버 응답이 `status:200`인데 `bodyLen:0`이고 비정상적으로 느린 패턴이나 `ERR_NAME_NOT_RESOLVED`
  같은 네트워크 에러를 한두 번 관측했지만 재시도하면 재현 안 됨 - 재현성 없는 1회성 신호는
  과도하게 확대 해석하지 말 것.
