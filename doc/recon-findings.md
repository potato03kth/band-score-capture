# recon-findings.md — 밴드 내부 API 정찰 기록 (M0 완료)

> M0 정찰에서 **실제 조교 계정 · 실제 대상 밴드**로 관측한 사실만 적는다.
> 추측/희망은 적지 않는다. 이 파일이 채워져야 M1(취득) 착수 가능.
>
> **상태: 정찰 성공 판정 4개 항목 모두 통과 ✅ → preload 인터셉트 경로 성립 → M1 착수 가능.**

- 정찰 수행자: 조교 세션(수동 로그인) + Claude Code 관측
- 정찰 일시(KST): 2026-07-16
- 대상 밴드: **36.5도의물리학[3분반]**, `band_no=103239777`, 멤버 57
- 조교 계정(로그인 본인): **김태훈**, `user_no=84880771` (role=coleader, `me:true`로 확인)
- 관측 도구: [x] Electron/Chromium 인앱 브라우저  ·  fetch/XHR 몽키패치 인터셉트  ·  Performance Resource Timing

> ⚠️ **관측 방식 주의**: 인앱 브라우저는 페이지 스크립트가 이미 로드된 **뒤**에 몽키패치를 걸어서,
> 앱이 먼저 잡아둔 fetch/XHR 참조를 일부 우회한다. 그럼에도 **앱의 실제 XHR 요청 응답을 캡처하는 데 성공**했다
> (게시글 상세·댓글·피드 페이지네이션 모두). Electron **preload는 페이지 스크립트보다 먼저** 실행되므로
> 인터셉트가 더 확실히 성립한다.

---

## 🔑 최상위 결론 (M1 설계에 바로 반영할 것)

1. **API 도메인은 별도다.** 문서(HTML)는 `www.band.us`, **데이터(JSON)는 `api-kr.band.us`**, 배치는 `bapi-kr.band.us`, 인증은 `auth.band.us`.
   → 인터셉트 대상 URL 매칭은 `api-kr.band.us` / `bapi-kr.band.us` 기준.
2. **인증은 요청별 서명(sjcl)이다.** `window.bauth`가 Stanford Crypto Library(sjcl)를 사용하고, 자격은 `bandWebAuthInfo`(문자열)에 있다.
   쿠키(`band_session`)만으로 직접 재요청하면 **`"권한이 없습니다"`(result_data.message)** 로 거부된다.
   → **replay(요청 재구성) 불가. 앱이 실제 보내는 요청의 응답을 가로채는 intercept가 유일한 경로.**(PLAN의 preload 몽키패치 전략과 일치)
3. **식별자 필드 정정 (중요):** 브리프/PLAN이 가정한 `user_key` / `post_key` / `comment_key`는 실제로 존재하지 않는다. 실제 필드는:
   - 사용자: **`user_no`**(전역 숫자 ID) + `member_key`·`profile_key`(밴드 범위 문자열)
   - 게시글: **`post_no`**(정수)
   - 댓글: **`comment_id`** + `post_comment_id`
   → `config`·`roster.js`·dedup 키 네이밍을 `user_no`/`post_no`/`comment_id`로 정정.
4. **역할이 응답에 실린다.** `author.role ∈ {member, leader, coleader}`. 멤버 목록은 `get_members_of_band`로 통째 확보(이름·user_no·role·가입일).
5. **역할 확정 + 조교 소거는 단순화(교수가 직접 제외):**
   - **교수 = 황인각, `user_no=15222358` (role=leader)** — `[과제n]` 게시글 작성자(화면 확인: `[과제2]`·`[과제3]`). **3분반·4분반 모두 leader**로 일관.
   - **조교(로그인 본인) = 김태훈, `user_no=84880771`** — 3분반 `coleader`, 4분반 `member`. **조교 role은 밴드마다 다름**(→ `role!=member`만으론 조교를 못 거름).
   - **결정(사용자)**: 조교는 **1명뿐이고 교수가 조교 user_no를 직접 지정해 제외**한다. 따라서 소거는 `taUserNos`(교수 제공, 전역 1개) 명시 제외로 충분 — role 가변 문제는 이 방식으로 해소됨. 자동 role 추론에 의존하지 않는다.
   - `professorUserNos=[15222358]`(role=leader로 자동식별 보조 가능), `taUserNos=[84880771]`(명시 제외).
6. **user_no는 전역(크로스밴드 동일) — 확정.** 황인각(15222358)·김태훈(84880771) 모두 3분반·4분반에서 동일 → 규칙10 크로스밴드 dedup·소거 성립.
7. **🚨 "댓글 N" 총계 = 최상위 댓글 + 대댓글. 대댓글은 별도 nested 조회 필수(완전성 급소).**
   실측(post/47): UI "댓글 40" = **최상위 댓글 28 + 대댓글 12** (`total:40`, 체크섬 일치).
   post-level `get_comments`는 **최상위 댓글 28개만** 반환(20/page, `before` 커서로 2페이지 후 `previous_params:null` 종료). 대댓글 12개는 각 부모 댓글의 `comment_count`로만 표시되고 **응답 본문에 내용·작성자 없음**.
   → 대댓글을 계측하려면 **`comment_count>0`인 부모 댓글마다 nested `get_comments`(content_type:"comment")를 추가 호출**해야 한다. 안 하면 **그날 대댓글만 단 학생이 통째로 누락(억울한 0점)**. 수집 호출 수·시간이 크게 증가(U7 심화).

---

## 0. 로그인 (U8)

| 항목 | 관측 |
|------|------|
| 로그인 방식 | **밴드 자체계정(이메일/휴대폰)** + 소셜(네이버/페이스북) 선택지. 조교 계정 로그인 성공 |
| captcha 발생 여부 | [x] 없음 |
| 2단계 인증(2FA) 여부 | [x] 있음 → **밴드앱 푸시 또는 SMS** |
| Chromium(인앱 브라우저)에서 통과되는가 | [x] 예 (Electron도 동일 Chromium 계열 → 통과 기대) |
| 세션 persist 재사용 시 재로그인 주기 | 쿠키 `band_session` + 서명자격(`bandWebAuthInfo`). Electron `persist:` 파티션으로 재사용. **주기 미측정**(장시간 관측 필요 → M1에서 기록) |

> 로그인은 사람이 창에서 1회 수동 수행. 자동 로그인 미구현(절대제약 준수).

---

## 1. 관측된 내부 엔드포인트 (URL 패턴)

베이스: `https://api-kr.band.us` (배치는 `https://bapi-kr.band.us`). 모든 호출에 `?ts=<epoch ms>` 캐시버스터가 붙는다.

| 행동 | 메서드 | URL 패턴 | 핵심 파라미터 | 응답 요약 |
|------|--------|----------|---------------|-----------|
| **피드 목록 로드** | GET(XHR) | `/v2.0.0/get_posts_and_announcements` | `band_no`, `resolution_type=4`, `order_by=created_at_desc`, `limit`(기본 20) | `result_data.{items[], paging}`. `items[i] = {post, type}` |
| **피드 다음 페이지(과거)** | GET(XHR) | `/v2.0.0/get_posts_and_announcements` | `after_post_no`, `after_announcement_created_at`, `band_no`, `limit=20`, `order_by=created_at_desc` | `paging.next_params`에 커서. **종료 = `next_params: null`** |
| **게시글 상세 열기** | GET(XHR) | `/v2.0.0/get_post` | `band_no`, `post_no`, `resolution_type=4` | `result_data.post` (댓글 배열 없음, `comment_count`만) |
| **댓글 목록 로드** | GET(XHR) | `/v2.3.0/get_comments` | `band_no`, `content_key={"content_type":"post","post_no":N}`(URL 인코딩), `resolution_type=4`, `limit`(기본 20) | `result_data.{items[], paging, total}` |
| **댓글 "이전(더 오래된)" 페이지** | GET(XHR) | `/v2.3.0/get_comments` | `before=<cursor>`, `content_key`, `band_no`, `limit=20` | `paging.previous_params`에 `before` 커서. **종료 = `previous_params: null`** |
| 배치 호출 | (XHR) | `bapi-kr.band.us/v2.0.0/batch` | 여러 API 묶음 | 초기 로드시 사용 |
| (참고) 공지 | GET | `/v2.0.0/get_band_notices` | `band_no`, `limit=3` | 상단 공지 |
| **멤버 목록** | GET(XHR) | `/v2.0.0/get_members_of_band` | `band_no` | `result_data.{members[], member_count, has_more_member}`. `members[i]={name, user_no, role, member_type, created_at(가입일 epoch ms)}`. **로스터·리더집합·가입일 확보처.** `has_more_member`=true면 페이지네이션 |
| (참고) 밴드정보 | GET | `/v2.2.0/get_band_information` | `band_no` | 밴드 메타 |
| (참고) 내 프로필 | GET | `/v2.1.0/get_profile` | — | 로그인 본인 |
| (노이즈) 뉴스카운트 폴링 | GET | `/v1.2.0/get_news_count` | — | ~60초 주기 폴링. **인터셉트 대상 아님(제외 필터)** |

> `content_key`는 JSON 문자열을 통째로 URL 인코딩한 것: `{"content_type":"post","post_no":43}`.
> 대댓글 조회는 `content_type:"comment"`로 추정(M1에서 확인) — 다만 채점상 대댓글도 작성자 `user_no`로 활동 인정되므로 우선순위 낮음.

---

## 2. 응답 필드 존재 확인 (핵심)

### 2-1. 게시글 응답 (`get_post` / 피드 `items[].post`)

| 필드 | 존재? | 실제 키 이름 | 비고 |
|------|-------|--------------|------|
| 작성자 식별자 | [x] | **`author.user_no`**(숫자) | + `author.member_key`·`author.profile_key`(밴드범위 문자열). `user_key`란 이름은 **없음** |
| 작성자 닉네임(실명) | [x] | `author.name` | 예: "박재완", "전석훈" |
| 작성자 역할 | [x] | `author.role` | `member` / `leader` / `coleader` |
| created_at(최초 작성) | [x] | `created_at` | **epoch 밀리초(number)**. 예 `1783940183000` |
| content(본문) | [x] | `content` | 접두 `[과제n]` 확인 가능(교수 글에서 육안 확인) |
| 댓글이 목록에 함께 오나 | [~] | `latest_comment`, `featured_comment` | **최신 1~2건만**. 전체는 아님 → `get_comments` 별도(U7) |
| 게시글 고유 식별 | [x] | **`post_no`**(정수) | dedup 키. 예 27, 42, 43. `post_key`란 이름은 **없음** |
| 댓글 수 | [x] | `comment_count` | 계측 완전성 대조에 사용 |
| 부가 | [x] | `emotion_count`, `read_count`, `member_read_count`, `is_major_notice`, `web_url`, `band` | 공감/조회는 계측 제외(R2) |

> 피드 `items[]`는 `{post, type}` 래퍼다. `type`이 일반 게시글/공지(announcement)를 구분 → 파서에서 `it.post` 언랩 필요. 공지도 게시글로 계측 대상(단, 작성자·머리말 규칙 적용).

### 2-2. 댓글 응답 (`get_comments` `items[]`)

| 필드 | 존재? | 실제 키 이름 | 비고 |
|------|-------|--------------|------|
| 작성자 식별자 | [x] | `author.user_no` | 게시글과 동일 author 스키마 |
| created_at | [x] | `created_at` | **epoch 밀리초(number)** |
| content | [x] | **`body`** | ⚠️ 게시글은 `content`, 댓글은 `body` |
| 부모 게시글 식별 | [x] | `post_no` | + `content_type:"comment"` |
| 대댓글(nested) 구조 | [x] | `comment_count`(대댓글 수) | 부모 댓글 아래 인라인 표시(모달 확인). 별도 조회로 소진 필요 |
| 댓글 고유 식별 | [x] | **`comment_id`** + `post_comment_id` | dedup 키. `comment_key`란 이름은 **없음** |
| 부가 | [x] | `is_secret`, `is_restricted`, `emotion_count`, `is_ai_generated` | 비밀/제한 댓글 여부 |

---

## 3. created_at 시간 의미 (E-계열)

| 항목 | 관측 |
|------|------|
| 포맷 | **epoch 밀리초(number)** (초/ISO 아님) |
| 타임존 | **UTC epoch** → 표시 KST = **+9h** |
| 경계 샘플 | `post_no=43` `created_at=1783940183000` → UI 표시 "2026-07-13 오후 7:56(KST)" 와 일치 → epoch ms(UTC)→KST 변환 확정 |
| 수정된 글이 created_at 유지? | 미확인(수정 이력 관측 못함). R5는 first-seen wins로 방어하므로 영향 제한적 |

> 채점 KST 경계(00:00/23:59)는 `new Date(ms)` → KST(+9) 변환 후 날짜 절단. 단위테스트 고정 필요.

---

## 4. user_no 안정성 (U2)

| 항목 | 관측 |
|------|------|
| 같은 사람이 여러 글/댓글에서 동일 `user_no`인가 | [x] 예 (author.user_no 일관) |
| 같은 사람이 **다른 밴드**에서도 동일 `user_no`인가 | [x] **예 — 확정.** 황인각=15222358, 김태훈=84880771 모두 3분반(103239777)·4분반(103240315)에서 동일 |
| `user_no` 형식 | 숫자(예: 15222358, 84880771, 85151914, 90330483, 93306017) |
| 밴드범위 식별자 | `member_key`·`profile_key`(문자열) — 밴드마다 다를 수 있음. 전역 dedup은 **`user_no` 사용** |

---

## 5. 역할 식별 — 교수/조교 구분 (U3 / R3)

`author.role` 필드가 응답에 직접 실리므로 리더집합을 자동 도출한다.

| 역할 | 이름 | user_no | 판별 근거 |
|------|------|---------|-----------|
| **교수** | 황인각 | **15222358** | `role=leader` + `[과제n]` 게시글 작성자(화면 `[과제2]`,`[과제3]` 확인) |
| 조교(로그인 본인) | 김태훈 | **84880771** | `role=coleader` + 응답의 `me:true` |
| (기타 리더) | — | — | 3분반에서는 위 2명 외 리더 미관측 |

- [x] `professorUserNos`(교수) 확정 = `[15222358]` — 과제글 판정용
- [x] `taUserNos`(조교, 로그인 본인) 확정 = `[84880771]` — 소거용
- [x] `leaderUserNos` = `role != "member"`(해당 밴드) **∪ `taUserNos`(전역)** — 조교가 member인 밴드 대비 필수(4분반 사례).
- 참고: 조교(coleader)가 `[과제n]`을 써도 작성자≠교수(leader 황인각)라 과제글로 오분류 안 됨(R3 부작용 해소 확인).

> ⚠️ M1 초기 검증 권장: 실제 `[과제n]` 게시글 1건을 `get_post`로 열어 `author.user_no == 15222358` 최종 대조.

### 5-1. 멤버리스트 이름 ↔ API 닉네임 일치 (NU2)
| 항목 | 관측 |
|------|------|
| 멤버리스트 "이름" ↔ 게시글/댓글 표시 `author.name` 동일 문자열인가 | 부분확인: `get_members_of_band`의 `members[].name`과 게시글/댓글 `author.name`은 **같은 소스**(실명형: 황서현·양지민·박재완·강민지…). 교수 제공 멤버리스트 엑셀과의 대조는 M1(trim/공백 정규화 후 비교) |
| 매핑 조인 전략 | **`get_members_of_band`(밴드 내 name↔user_no) → 로스터 엑셀(name↔학번)** 을 name으로 조인. 동명이인은 user_no로 분리 후 `4_동명이인_매핑.xlsx`. 가입일(`created_at`)은 동명이인 보조식별(NU4)에 사용 |

---

## 6. 페이지네이션 방식 (U6)

| 대상 | 방식 | 파라미터명 | 페이지 크기 | 종료 판정법 |
|------|------|------------|-------------|-------------|
| 피드(과거로) | 커서 | `after_post_no` + `after_announcement_created_at` (`paging.next_params`) | 20 | `next_params == null` |
| 최상위 댓글(과거로) | 커서 | `before` (`paging.previous_params`), `limit=20` | 20 | `previous_params == null` |
| 대댓글(nested) | (부모별 조회) | `content_key content_type:"comment"` + 부모 comment_id (M1 확정) | — | — |

- **댓글 페이지네이션 실측(post/47, 총 40)**: page1 = 20 최상위, page2 = 8 최상위(`before=9`) → 합 **28 최상위**, 이후 `previous_params:null`로 종료. 나머지 12 = 대댓글(별도). → `total`(=40)은 대댓글 포함 총계이므로 **`total`을 완료판정 기준으로 쓰면 안 됨**(최상위 수집 완료 + 대댓글 별도 수집으로 판정).
- 피드 API 페이지 크기: `limit=20`(관측). *사용자 육안 관측 게시글 ~25개/페이지는 UI 배칭 — 채점 완전성엔 무영향(커서로 끝까지 소진).*
- 취득 완전성(U6): ①피드를 `next_params`가 null이거나 **가장 오래된 글 created_at < 측정시작일**까지 소진, ②각 글의 최상위 댓글을 `previous_params:null`까지 소진, ③**`comment_count>0`인 각 댓글의 대댓글을 nested로 소진** → 밴드별 `collection_complete` 기록.
- 무한스크롤 트리거: window 스크롤로 발화(인앱 브라우저에서 `scrollTo(0, scrollHeight)` 반복으로 다음 페이지 확인). Electron collector도 동일하게 스크롤 오케스트레이션. 댓글은 "이전 댓글" 버튼/스크롤로 `before` 페이지 반복.

---

## 7. 정찰 성공 판정 (PLAN.md C의 게이트)

- [x] 2-1/2-2에 `user_no`·`created_at`·`content`/`body`·`post_no`/`comment_id`가 **모두 존재**
- [x] 댓글 페이지네이션 종료 판정 가능 (`previous_params == null`)
- [x] created_at 포맷·타임존 확정 (epoch ms UTC → KST +9)
- [x] 로그인이 Chromium(Electron 계열)에서 통과 (2FA 앱/SMS, captcha 없음)

→ **4개 모두 충족 → preload 인터셉트 경로 성립 → M1 착수 가능.** ✅

---

## 8. 기타 관측 / 특이사항

- **전송 방식**: 앱은 데이터 요청에 **XMLHttpRequest(XHR)** 사용(일부 fetch/batch 혼재). preload에서 XHR·fetch 양쪽 몽키패치 권장.
- **인증 서명(sjcl)**: `window.bauth.sjcl` 존재. Authorization은 요청별 계산/서명값으로 추정 → **정적 토큰 재사용/replay 불가**. 쿠키만으로 재요청 시 `"권한이 없습니다"`. 인터셉트만이 안전.
- **도메인 분리**: 관측/인터셉트는 `api-kr.band.us`·`bapi-kr.band.us` 대상. `www.band.us`는 SPA 문서 셸.
- **인앱 브라우저 캡처 한계**: 네트워크 패널이 XHR 본문을 못 잡는 경우가 있어 **Performance Resource Timing + fetch/XHR 몽키패치**로 관측했다. Electron에서는 preload 선점으로 해소.
- **대댓글(nested reply) 모델 — 실측 확정**: post/47에서 UI "댓글 40" = 최상위 28 + 대댓글 12(체크섬 일치). post-level `get_comments`(content_type:"post")는 **최상위 댓글만** 반환하고, 대댓글은 각 부모의 `comment_count`로만 노출 — 이 뷰에선 `latest_comment`가 비어(`{}`) 대댓글 내용·작성자가 응답에 **아예 없음**. → **`comment_count>0`인 모든 부모 댓글에 대해 nested `get_comments`(content_type:"comment") 별도 호출 필요**(정확한 파라미터 형태는 M1 실캡처로 확정). 상세뷰는 로드시 이 nested 호출을 자동 수행해 인라인 렌더함.
- **대상 밴드(관측 확인)**: 3분반 `band_no=103239777`, 4분반 `band_no=103240315` (같은 과목·같은 교수/조교). 실사용 2~7개 가변은 `1_설정.xlsx`.
- **미확정(M1로 이월)**:
  - 세션 재로그인 주기(2FA 재요청 빈도) 실측 — 장시간 관측 필요, 이번 세션에서 측정 불가
  - 대댓글 nested 조회 정확한 파라미터(`content_type:"comment"` + 부모 comment_id) 실캡처
  - 수정된 글의 created_at 유지 여부
  - `get_members_of_band` 대량 멤버시 `has_more_member` 페이지네이션 커서(57명은 1페이지)
  - 교수 제공 멤버리스트 엑셀 ↔ `author.name`/`members[].name` 최종 대조(NU2)
