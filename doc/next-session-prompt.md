# 다음 세션 시작 프롬프트

> 이 파일 내용을 다음 세션 시작 시 그대로 붙여넣어 쓴다. 배경은 `doc/m1-live-findings.md` §22에
> 전부 기록돼 있으니, 이 프롬프트는 "무엇을 할지"만 순서대로 정리한 것이다.

---

`D:\programing\git\source\band-score-capture` 프로젝트를 이어서 진행한다. 먼저
`doc/m1-live-findings.md` §22를 읽어라 — 지난 세션 막판에 발견한 미해결 버그다.

**요약**: 지난 세션에 버그 A(이벤트 버스 레이스)와 버그 B(댓글 페이지네이션 트리거)를 전부
해결·검증했고(`postsCommentsComplete: 52/52`, 트레이스 로그도 실제 데이터를 정상적으로
캡처했다고 보여줌), 그런데 검증 스크립트를 준비하다가 **`data/raw/103239777/`의 raw 파일들이
그 세션 동안 실제로는 전혀 갱신되지 않았다**는 걸 발견했다(마지막 파일 수정 시각이 그 세션의
첫 재기동보다도 이르다 — 5시간 이상 차이). 즉 트레이스가 보여준 "성공"이 디스크에 반영됐다는
보장이 없다. **이걸 풀기 전엔 M1이 끝났다고 볼 수 없다.**

## 이미 배제된 것 (다시 확인할 필요 없음)

- `writer.writeComment()` 자체는 정상 작동(직접 단위 테스트로 확인 — §22-2 참고).
- 최상위 댓글 `comment_id`가 글마다 겹쳐서 dedup 충돌로 유실되는 것도 아님(실측으로 전역
  유일함을 확인, 충돌 0건).

## 할 일 (순서대로, 재기동 최소화 원칙 지킬 것)

1. **재기동 없이 먼저**: `logs/audit/`의 최근 로그 파일들에서 `"[cdp] getResponseBody 실패"`가
   댓글 API(`get_comments`) URL과 함께 등장하는지 grep으로 확인. (이게 있으면
   `interceptor.handleCapture`가 예외를 던지고 있다는 뜻 — `cdp-capture.js`의 try/catch가
   삼키고 있을 가능성.)
2. **계측 추가**: `acquire/capture/interceptor.js`의 `handleCommentList` 루프 안,
   `writer.writeComment(...)` 호출 직후에 다음을 트레이스로 남긴다:
   ```js
   const { isNew } = writer.writeComment(c, { contentType, parentCommentId, postNo, sourceUrl: url });
   trace.record({
     phase: 'writeComment',
     postNo,
     commentId: c.comment_id,
     isNew,
     createdAtType: typeof c.created_at,
     createdAt: c.created_at,
   });
   ```
   `comment.created_at`이 숫자(epoch ms)가 아니라 문자열이면, `writer.js`의
   `kstDateStr(ms)`가 `new Date(ms + 9*3600*1000)`에서 `+`가 문자열 접합으로 동작해(피연산자
   중 하나라도 문자열이면 JS의 `+`는 숫자 덧셈이 아니라 문자열 이어붙이기) `Invalid Date`가
   될 수 있다는 게 가장 유력한 가설이다 — 이 계측으로 바로 확인된다.
3. `node --check`로 문법 확인 후, `BSC_TRACE=1 BSC_DEBUG_UNCLASSIFIED=1 npx electron .`로
   **딱 1회** 실기동한다. 로그인 세션이 유지된다고 가정하지 말 것(지난 세션에 이 가정이 매번
   틀렸다 — 로그인 화면이 뜨면 사람이 직접 로그인해야 한다).
4. 트레이스에서 `phase:'writeComment'` 항목들을 확인해 원인을 확정한다:
   - `isNew`가 계속 `false`라면 → dedup이 뭔가를 이미 알고 있다고 착각하는 것(원인 재조사 필요).
   - `createdAtType`이 `"string"`이거나 `createdAt`이 비정상적인 값이면 → 가설 2가 맞다,
     `writer.js`의 `kstDateStr`/`appendLine`에서 타입을 명시적으로 `Number(...)` 변환하도록
     고친다.
   - `isNew:true`인데도 파일에 안 남으면 → `appendLine`/`fs.appendFileSync` 자체를 더 깊이
     파야 한다(예외를 던지는지, 경로가 이상한지).
5. 원인을 고친 뒤 `node scripts/verify_comment_counts.js`를 다시 돌려
   `out/verify/captured_comment_counts_103239777.csv`의 `captured_top_level`/`captured_replies`
   값이 이번엔 실제로 채워지는지 확인한다.
6. **그 다음에야 사용자가 원래 요청한 검증으로 넘어간다**: 사용자가 미리 확인해둔 1번~48번
   게시글의 댓글 개수를, CSV의 `manual_count` 칸에 채워 넣게 하고(사용자가 직접 채우거나
   불러주면 내가 채운다), `diff = manual_count - captured_total`을 계산해 어긋나는 글이
   있는지 확인한다. 어긋나는 글이 있으면 그 글의 raw 데이터를 다시 열어 원인을 진단한다.

## 원칙

- 재기동은 위 3번에서 딱 1회만 계획한다 — 여러 가설(writeComment 호출 여부·isNew·created_at
  타입)을 한 번의 트레이스로 동시에 확인할 수 있게 계측을 미리 다 넣고 나서 실행할 것.
- 오늘 세션에서 이미 19회 재기동 + 크래시 1회 + 로그인 차단 1회를 겪었다 — 재기동
  최소화(`doc/m1-live-findings.md` §4/§8-2)를 반드시 지킬 것.
- 클릭/스크롤 트리거(버그 B) 관련 코드는 이미 잘 작동하는 것으로 검증됐으니 건드리지 말 것 —
  이번 문제는 순수하게 "쓰기(write)" 경로의 문제다.
