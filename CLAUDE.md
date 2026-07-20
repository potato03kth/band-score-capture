# band-score-capture — working notes for Claude Code

Read this file first. It carries context that previously only lived in one
assistant's local memory on the original dev machine — it will not exist for
a fresh session unless it's written down here.

## What this project is

Electron app that auto-grades Naver Band class participation for a TA
(김태훈). It logs into Band with a real, manually-authenticated Electron
session (no automated login — 2FA/anti-abuse risk), then intercepts the
band.us internal JSON APIs via CDP (`webContents.debugger`) to capture
posts/comments/replies/members into `data/raw/` as ndjson. A separate
offline "scoring" step (not built yet, M2) will read that raw data and
produce a CSV.

Full history, ruled-out failure modes, and exact selectors/quirks confirmed
by hand are in `doc/m1-live-findings.md` — read it (esp. §1-22) before
touching `acquire/collector.js` or `acquire/capture/*` again. Many "obvious"
fixes there were already tried and reverted.

## Start here for the next work session

**`doc/next-session-prompt.md` is the literal next prompt to paste in.** As of
2026-07-20 end of session, §27's blockers are fixed, plus two more bugs found
via a combined 2-band (3분반+4분반) live test: `.btnNextPost` walking into an
announcement instead of the next post (silently truncated the walk), and a
`commentPage` double-emit bug (same class as §27-1's `postDetail` one) that
was causing false-positive gap reports in `incomplete_gaps.json` — the raw
ndjson itself was actually complete all along, since `writer.writeComment`
persists unconditionally in the interceptor regardless of collector.js's
consumption bookkeeping. See `doc/m1-live-findings.md` §28 for the full
story (§28-9 announcement fix, §28-10 the double-emit/false-positive-gap
finding). All fixes verified across 3 repeated live runs on both bands:
0 duplicate event processing, `feedExhausted:true`, gap counts down to 3
and 1 (from 12 and 4), member verification 57/57 and 56/56. M1 acquire's
core data-accuracy verification is done. Changes are **committed**
(commit `1041e82` plus the announcement/drain fixes) — verify with
`git log` at session start.

## Working style — lessons paid for with real restarts, don't relearn them

- **Minimize Electron restarts.** Each live run against the real Band
  account costs minutes (login + full traversal) and carries real
  anti-abuse risk on Naver's side. Before proposing another `npx electron .`
  / `npm start` live run, check whether current instrumentation
  (`acquire/capture/tracer.js`, `BSC_TRACE=1`) can already distinguish the
  open hypotheses. If not, add logging for *all* open questions first, then
  run once and analyze the resulting trace offline. One session hit 20+
  restarts by going "one hypothesis → restart → check → next hypothesis" —
  don't repeat that.
- **Never assume the persisted session skips login.** The `persist:
  band-capture` partition does not reliably mean login is skipped on a
  given run — across many restarts it was wrong every time. Always tell the
  user manual login (with 2FA) is likely required and to watch for the
  login window, rather than assuring them it'll be automatic.
- **When a UI-automation trigger (click/scroll) is flaky and traces alone
  don't explain why, don't keep iterating speculative code changes.** After
  ~2-3 failed automated attempts, ask the user to inspect the live DOM in
  DevTools and report the actual selector/behavior. This resolved a
  comment-pagination bug (`.moreComment` selector, real
  `sendInputEvent`-based clicks instead of synthetic `.click()`) after ~15
  restarts of pure guessing failed.
- Process note (Windows): stopping the shell that launched `npx electron .`
  does **not** kill the Electron process tree — child processes survive.
  Use `Get-Process electron | Stop-Process -Force` before relaunching.

## Data handling — why data/, input/, out/, logs/ are gitignored

`data/raw/` contains real captured Band content: student names, `user_no`,
`member_key`, and actual comment text. `input/` holds the professor's real
run settings (`1_설정.xlsx`). `out/` and `logs/` are derived
artifacts/audit logs from real runs. These are intentionally excluded from
git (see `.gitignore`) even though this repo is currently **public** —
don't add or suggest removing that exclusion. If you need sample data to
test against, ask the user rather than committing real captures.

## Trust tiers for judging data completeness (user-defined, 2026-07-20)

No signal in this pipeline is an independent, external ground truth — everything ultimately comes
from band.us itself. When deciding whether captured data is complete, always reason in these
tiers (highest to lowest trust), and always consider all of them together, not just one:

1. **Human verification** — a person actually reading the page and counting. This is the only
   real ground truth this project has ever had (see the 61/63-post manual count exercise in
   `doc/m1-live-findings.md`).
2. **"Right before human verification" tier** — three specific UI-rendered signals the user has
   identified as trustworthy proxies for what a human would see:
   - Post modal's own displayed comment count (`.postCount > .postCountLeft > .faceComment >
     .comment` chain, the number band.us itself renders for "댓글 N개" including replies) —
     trustworthy because it's literally what a human reads on screen, unlike the API's
     `comment_count` field.
   - Total post count via `div.postWrap.viewTypeListWrap` → count of
     `div.cCard.gContentCardShadow.-brunchOfPostType` children (excluding
     `data-viewname="DAnnouncementItemView"` items and `display:none` elements), after scrolling
     the feed all the way to the bottom.
   - Per-member total comment count via 멤버 → member icon → 작성글 보기 → 댓글 tab → scroll to
     bottom. Note: this is captured by *our own code* too, so it's a cross-check between two
     paths through the same automation, not a fully independent source — still useful for
     catching internal inconsistencies.
3. **Band's own bare numeric fields** (`comment_count` on posts/comments, `total` in paginated
   responses) — already established as unreliable (`doc/m1-live-findings.md` §12-2, §20-1).
   Useful only as a last-resort hint, never as the sole basis for declaring success or failure.
4. **Our own loop-termination signals** (`.moreComment`/`.moreReply` button absence,
   `previousParams === null`) — these decide when collection *stops*, but "band's UI has nothing
   more to show" is not the same claim as "we have the true complete data."

When adding or reviewing any completeness check, cite which tier it's based on, and prefer
disagreements to be resolved in favor of the higher tier. `data/raw/<bandId>/incomplete_gaps.json`
records tier-3-vs-captured mismatches and tier-2-vs-captured mismatches with a `reason` field
distinguishing them — read that field before deciding how seriously to treat an entry.

## How to run

`npx electron .` (or `npm start`). Add `BSC_TRACE=1` for full
request-lifecycle + comment-pagination-total + console-error tracing into
`logs/trace/*.ndjson`. See `doc/project_brief.md` and `doc/PLAN.md` for the
overall milestone plan, and `doc/recon-findings.md` for the M0 API recon
this project is built on.
