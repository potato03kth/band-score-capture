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

**`doc/next-session-prompt.md` is the literal next prompt to paste in** — it
lays out, in order, the one unresolved bug blocking M1: raw ndjson files
under `data/raw/103239777/` were not being updated during a session that the
in-memory trace log showed as fully successful (`postsCommentsComplete:
52/52`). Root cause was not yet confirmed as of 2026-07-17 end of session.
Leading hypothesis: `comment.created_at` may not always be a numeric epoch
ms at runtime, which would corrupt `writer.js`'s `kstDateStr()` via JS's
string-concatenation `+` behavior. **Do not treat M1 as done until this is
resolved and verified**, regardless of what any trace log or restart
appears to show.

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

## How to run

`npx electron .` (or `npm start`). Add `BSC_TRACE=1` for full
request-lifecycle + comment-pagination-total + console-error tracing into
`logs/trace/*.ndjson`. See `doc/project_brief.md` and `doc/PLAN.md` for the
overall milestone plan, and `doc/recon-findings.md` for the M0 API recon
this project is built on.
