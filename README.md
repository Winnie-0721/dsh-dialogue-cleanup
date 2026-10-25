<h1 align="center">dsh-dialogue-cleanup</h1>

<p align="center"><strong>English</strong> · <a href="./README.zh.md">简体中文</a></p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-dialogue-cleanup"><img alt="npm version" src="https://img.shields.io/npm/v/dsh-dialogue-cleanup?label=npm" /></a>
  <a href="https://www.npmjs.com/package/dsh-dialogue-cleanup"><img alt="npm downloads" src="https://img.shields.io/npm/dt/dsh-dialogue-cleanup?label=downloads%20total" /></a>
  <a href="https://github.com/Winnie-0721/dsh-dialogue-cleanup/releases/latest"><img alt="GitHub release" src="https://img.shields.io/github/v/release/Winnie-0721/dsh-dialogue-cleanup" /></a>
  <a href="https://github.com/Winnie-0721/dsh-dialogue-cleanup/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/Winnie-0721/dsh-dialogue-cleanup" /></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-yellow.svg" /></a>
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img alt="DeepSeek Harness 0.2.0-rc.2" src="https://img.shields.io/badge/DeepSeek%20Harness-0.2.0--rc.2-blue" /></a>
</p>

<p align="center"><strong>Delete DeepSeek Harness sessions from the running Web GUI — without restarting, without leaving the window.</strong></p>
<p align="center">One row in the session <code>...</code> menu for a single delete, plus a bulk management page inside Settings.</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/Winnie-0721/dsh-dialogue-cleanup/main/docs/assets/panel.png" alt="Bulk management panel in Settings: search, filters, per-row status badges and 16 session rows" width="760" />
</p>

<p align="center">
  <a href="#quick-start"><strong>Install</strong></a> ·
  <a href="#ui-at-a-glance">Gallery</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="docs/RELEASING.md">Releasing</a> ·
  <a href="https://github.com/Winnie-0721/dsh-dialogue-cleanup/releases/latest">Releases</a>
</p>

## Why it exists

**One-line positioning: deleting a session should actually delete it.** DeepSeek Harness keeps a session
in four places at once — the live store, the workspace records, the registry leftovers
(pin / archive), and the files on disk. Removing one of them leaves a ghost row, a stale
workspace, or a directory that silently keeps occupying disk. Everything below is that
positioning made concrete:

- **One irreversible operation, implemented once.** `deleteSession` lives in the Host
  (`lib/service.js`) and is reached through two thin adapters — the HTTP contract and the slot UI —
  so the single-delete path and the bulk path **cannot drift apart**.
- **A running session is refused, not guessed at.** The Host decides `deletable` and the UI simply
  does not offer what the Host would reject. The panel never decides by itself whether something is
  safe to delete.
- **Archived sessions are still shown by default.** Archiving is *not* deleting: an archived session
  still occupies disk, so hiding it by default would hide exactly the files you came to clean up.
  (The official sidebar hides them; here it is a tri-state filter — `hide archived` / `all` /
  `archived only` — and **archived are shown by default**.)
- **Blank sessions are hidden by default** (matching the official sidebar). A blank session never
  received a message: its log holds only five initialization events (~588 bytes) with no
  `user/message` and no `session/title`, so it never had a title to show. They usually far outnumber
  real sessions (199 of 254 on one host), and listing them one-per-row is what used to fill the
  panel with `(no title)`. The official sidebar's `sessionVisible()` does
  `if (session.blank && session.id !== current) return false;`. Here it is a tri-state filter —
  `hide blank` / `all` / `blank only` — **default `hide`**; the two explicit settings exist because
  cleaning disk is this plugin's job, so blank sessions stay reachable for bulk deletion. The list
  reports `blank: { filter, total }` and the panel shows "N blank sessions hidden" with a one-click
  switch, so nothing ever looks silently lost.
- **Subagent rows are labelled.** The official sidebar hides `origin: 'subagent'` rows entirely, so
  whenever those rows do appear (kind = subagent / all) each one is explicitly badged — a subagent
  session must never look like an ordinary conversation.
- **It says what it actually did.** The result line reports ok / failed / degraded / directories
  removed, and each failure keeps its own reason verbatim. When the live store entry cannot be
  detached, the plugin reports `detached: false` rather than claiming success.
- **Errors are semantically truthful.** Unlike the upstream package (which always answered `200`),
  this one uses real status codes: 400 / 403 / 404 / 405 / 409 / 429 / 500.

## UI at a glance

**The confirmation overlay: irreversible, and it says so.** Two closing paths only — an explicit
Cancel button, or `Esc`. Clicking the scrim deliberately does **not** dismiss it, because a
mis-click on an irreversible delete should not cost you your chance to confirm:

<p align="center">
  <img src="https://raw.githubusercontent.com/Winnie-0721/dsh-dialogue-cleanup/main/docs/assets/confirm.png" alt="Delete confirmation: permanent deletion warning, session id, and Cancel / 永久删除 buttons" width="440" />
</p>

The overlay is a **native `<dialog>` driven by `showModal()`**, so it enters the browser's *top
layer* and therefore stacks above the Settings panel it was opened from (a plain positioned element
could not). That also brings a real focus trap and correct `Esc` semantics for free — and it needs no
portal outside the component tree.

**The bulk panel (inside Settings)** — search, project / state / session-kind / archive filters,
sort, paging, and per-row status badges. The badges in the screenshot above come from real render
output: `空闲` (idle) / `运行中` (running, not selectable) / `子代理` (subagent) / `已归档` (archived).

> The two screenshots are generated from the **actual component tree and the actual CSS** by
> `scripts/render-shot.mjs` (the same React stand-in the render tests use), rasterised with headless
> Edge. They are not hand-drawn mockups; they are also not a photograph of a live GUI — see
> [Honest limitations](#honest-limitations).

## Quick Start

```sh
dsh plugin --profile web add dsh-dialogue-cleanup
```

1. **Single delete** — hover a session row in the sidebar, open the `...` menu and pick
   **Delete session** (registered at `order: 500`, right after the shipped Archive entry at 400).
   A themed confirmation appears; confirming removes the live entry, the workspace records, the
   registry leftovers and the on-disk artifacts.
2. **Bulk delete** — open **Settings → Dialogue Cleanup**. Tick rows (or *Select all deletable*),
   then delete them in one request.
3. Host-side changes need a **restart** of the DSH process; client-side changes do not (see the table
   in [docs/RELEASING.md](docs/RELEASING.md)).

> Compatible with DSH **0.2.0-rc.2**. The npm package and the GitHub Release are published together;
> versioning rules and the release chain live in [docs/RELEASING.md](docs/RELEASING.md).

## How it works

One npm package carries both halves, installed into the host per the official plugin spec:

- **Host half (repo process)** — `lib/index.js` is a Cordis function plugin exporting only
  `name` / `inject` / `apply`. It registers a single `ctx.webServer` prefix route and keeps the
  entire deletion implementation in `lib/service.js`. Filesystem removal and path containment live in
  `lib/artifacts.js`; the audit trail in `lib/audit.js`.
- **Client half (browser)** — `client.js`, a single-file bundle registered through
  `window.__ModuleLoader__.load({ id, factory })`, with **zero dependencies beyond `require("react")`**.
- **Both entry points are official slots; neither touches the DOM:**
  - `sidebar.workspaces.session.menu.item` at `order: 500` → the single-delete row.
  - `settings.section` (`id: dialogue-cleanup`, `order: 25`, after the shipped
    `account(-10) / general(0) / models(10) / plugins(15) / agent-presets(20)`) → entry **and** panel.
    One registration is one Settings page, whose content renders in the panel's content column.
- **Because the panel lives in Settings it needs no `layout` service** and does not compete for space
  in `main` or the sidebar — one fewer optional dependency and one fewer degradation branch.
- **The stylesheet travels with the component.** The menu item renders its own `<style>` beside
  itself (finding H1 of the project's own audit: the row was rendering unstyled because the
  stylesheet was only injected on the settings path).

### The deletion sequence

1. **Refuse a running session** — 409 `refused`.
2. **Detach the live store entry** — otherwise the deleted row survives as a ghost.
3. **Drop workspace records** — counting only workspaces that actually detached.
4. **Clear registry leftovers** — pin / archive records, via the public idempotent API.
5. **Remove on-disk artifacts** — `<DSH_HOME>/sessions/<project>/<sessionId>`, plus the derived
   projection cache.
6. **Write an audit line** — `<DSH_HOME>/logs/dialogue-cleanup.jsonl`.

## HTTP contract

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api-ext/dialogue-cleanup/delete` | `{ "sessionId": "..." }` → delete one; `{ "sessionIds": [...] }` → delete many (the Host runs the same `deleteSession` per id and returns a per-id result) |
| `POST`/`GET` | `/api-ext/dialogue-cleanup/list` | session rows with `deletable` / `blockedReason` / `classification` / `titleState` |
| `GET` | `/api-ext/dialogue-cleanup/status` | capabilities, config, runtime paths |

Envelope: `{ ok: true, value }` / `{ ok: false, error: { code, message, hint? } }`.

Each `/list` row carries `titleState`, which distinguishes the four reasons `title` can be
empty. Collapsing them into one "untitled" label is what made a whole screen look broken:

| `titleState` | Meaning | Retry helps? |
|---|---|---|
| `ready` | the title is present | — |
| `blank` | `blank: true` — the session never received a user message (init events only) | no, it should never have had one |
| `empty` | the session has content, but the host answered that there is genuinely no title (e.g. a subagent session that only ran `turn/start` → `turn/end`) | no |
| `unread` | the session has content, but the title was not read this time (outside `titleLimit`, or the read failed) | yes |

`empty` is backed by a `titleConfirmed` set that only accepts ids the host **answered for**
successfully, so a budget miss or a failed batch can never masquerade as "there is no title".
The client renders three distinct placeholders from this, and prints the session id for both
`empty` and `unread` rows (both are real sessions, and deletion is irreversible) while staying
silent for `blank` rows (199 of 254 on a measured profile — a wall of UUIDs would bury the real ones).

## Configuration

All tunables live in the plugin `Config` (`lib/config.js`), so a user's patch layer survives
upgrades. A matching override **replaces the whole `config`** — write every field you care about.

| Key | Default | Meaning |
|---|---|---|
| `maxBodyBytes` | `65536` | request-body ceiling (upstream: 1 MiB) |
| `readTimeoutMs` | `10000` | body-read timeout (upstream: none) |
| `audit` / `auditPath` | `true` / `null` | audit log; `null` → `<DSH_HOME>/logs/...` |
| `auditMaxBytes` | `4194304` | audit rotation threshold (4 MiB); `0` disables rotation |
| `auditRotateKeep` | `3` | rotated files kept (excluding the current one) |
| `rateLimitPerMinute` | `60` | per-minute delete **request** budget (a batch counts once); `0` disables |
| `requireIdleSession` | `true` | safety valve for the running-session refusal |
| `stopIdleAgent` | `false` | see the honest-degradation note below |
| `matchAlternateIdSpelling` | `true` | probe the other `session-` spelling, guarded |
| `removeProjectionCache` | `true` | also drop the derived projection cache |
| `clearRegistryRecords` | `true` | unpin / unarchive leftovers |
| `confirmInUi` | `true` | UI confirmation (the Host does not trust it) |
| `announceRemoval` | `true` | emit `session.removed` after deletion so other views drop the row |
| `titleCacheTtlMs` | `300000` | title-fold cache TTL; `0` disables |
| `titleFetchConcurrency` | `8` | shard concurrency when folding titles |
| `titleLimit` | `100` | max rows per page to fold titles for; `0` skips title reading |
| `titleSearchLimit` | `40` | separate title budget for keyword search (independent of `titleLimit`); rows beyond it are reported in `titles.truncated` |
| `runningProbeTtlMs` | `1000` | how long a running-state snapshot is reused. Turns batch delete from O(N) full-corpus list calls into O(1); `0` re-probes every item |

## Honest limitations

These are **measured** against the live runtime and differ from what the upstream package assumes.
They are reported truthfully rather than papered over:

- **No public stop for an idle agent.** The public `Agent` type is
  `{ readonly id: SessionId }` — no `status`, no `ctx`. Upstream's `agent.status === "running"` and
  `agent.ctx.fiber._unload()` therefore cannot be relied on (`_unload` is a Cordis *private* method
  and is deliberately never called). "Is it running?" comes from the public
  `sessionController.list()` → `SessionSummary.running`. A session that still has an attached agent
  and cannot be stopped safely is **refused**, and the UI shows why.
- **Detaching the live entry is best-effort.** The public `sessions` service exposes
  create/prepare/enter/announce/flush/get/list/fork — **no** public `detach`. The plugin tries the
  public method first, then the internal `store` entry, and reports `detached: false` when neither is
  available instead of claiming success.
- **Two on-disk id spellings coexist.** Observed in one `<DSH_HOME>`:
  `...\<uuid>\session.v4.jsonl.zstd` and `...\session-<uuid>\session.v4.jsonl.zstd`. An exact-id join
  can never delete the prefixed half. This plugin probes the alternate spelling **only** when it can
  confirm the candidate is not a different live session; with no such evidence it deletes nothing
  rather than risk a neighbour.
- **The screenshots are real render output, not a live-GUI photograph.** They come from the actual
  component tree + actual CSS, rasterised headless; the theme tokens are pinned to a light theme and
  the row data is a demo fixture. What the panel looks like inside a running GUI with the real theme
  has not been captured here.

## Development and acceptance

```sh
# Full gate: node --check + migration/contract/render/release regression suites
node scripts/run-tests.mjs

# Release gate only (no version change, no packing, no publishing)
pwsh -File scripts/release.ps1 -LocalOnly

# Regenerate the two documentation screenshots from the real component tree
node scripts/render-shot.mjs
```

> Do not use `node --test "test/**/*.test.mjs"`: **glob expansion needs Node 22+**, while
> `engines.node` declares `>=20`. On Node 20 that command fails outright with
> `Could not find '.../test/**/*.test.mjs'`. `scripts/run-tests.mjs` enumerates
> `test/*.test.mjs` itself and hands the list to `node --test`, so all three Node versions
> and both platforms behave identically (covered by CI).

The suites are currently **300 tests across 18 files** (3 of them are platform-specific, so
each platform actually runs 297):

| Suite | Covers |
|---|---|
| `contract.test.mjs` | the host ↔ client contract and slot declarations (largest suite) |
| `service.test.mjs` | `deleteSession` end-to-end behaviour and refusals |
| `fault-injection.test.mjs` | **per-step fault injection**: disk / memory / workspace / audit / announce each failing must not be reported as complete success; includes the §4.1 pre-delete re-check race, §4.2 observable identity-query failure, §4.3 observable link skipping, the alternate-spelling red line, and junction escape (static + race) |
| `isolated-integration.test.mjs` | **destructive integration in isolation**: full side-effect cleanup, running sessions untouched, a real child process SIGKILLed mid-run then re-run, batch partial success then retry |
| `batch-semantics.test.mjs` | batch semantics: de-duplication, distinguishable `deleted`/`noop`/`refused`/`blocked`, exact `retry` list, `allComplete` |
| `audit.test.mjs` | audit log: field minimisation, truncation, rotation (without truncating the log being written), concurrency, unwritable/out-of-root paths, disabled, config bounds |
| `perf-regression.test.mjs` | query-performance semantic guards: cold vs warm results identical field by field, no duplicate title reads within one request, N concurrent requests read once, failures recoverable, metrics never leak titles or `cwd` |
| `client.test.mjs` | registration surface, ids, no-cross-package requires |
| `render.test.mjs` | components **actually rendered** through a React stand-in; the four `titleState` placeholders must be pairwise distinguishable, `empty` must not reuse `unread`'s wording, and every defaulted filter value (`archived` / `kind` / `blank`) must actually reach the request URL — a dropdown that only changes local state looks perfectly fine and filters nothing |
| `artifacts.test.mjs` | path containment, symlink refusal, alternate-spelling guards, `isRealPathInside` positive and negative |
| `session-id.test.mjs` | id validation (no separators or dots) |
| `eol.test.mjs` | line endings, and that every tracked file is git-declared `eol=lf` |
| `release-workflow.test.mjs` | the OIDC publishing structure (**reverse assertion**: `pack-release.yml` must not contain its own publish steps) |
| `ps-script.test.mjs` | PowerShell 5.1 BOM / encoding pitfalls |
| `project-identity.test.mjs` | a row's project identity is **one field**: display, filtering and the dropdown are all derived from it (cwd when present, else the workspace path); case/separator variants collapse into one option |
| `transaction-boundary.test.mjs` | delete × concurrency boundaries: a title read in flight, a batch with one refused and one malformed id, audit in flight / failing, and the three projection-cache states (normal / symlink fail-closed / root path anomaly) |
| `title-async-prototype.test.mjs` | **a prototype, not a production path**: the reference merge state machine from `docs/TITLE-ASYNC-DESIGN.md`, checked against a gate-controlled fake host (first paint unblocked, no stuck `pending`, late token rejected, deleted row not resurrected, `empty` ≠ `unreadable`) |
| `classification.test.mjs` | session **classification** is three-state: a row seen only in the summary path must come back as `unknown`, never as `main`; evidence only accumulates (a missing field is not a counter-proof); plus a handler-level case pinning `GET /list?kind=unknown` through the HTTP whitelist |

Two of these exist because the corresponding bug actually shipped and was caught afterwards:

- **`eol.test.mjs`** — the first release produced *different bytes* from CI (`pnpm pack`) and from
  local (`npm pack`): `icon.svg` and `LICENSE` were CRLF in CI, because `.gitattributes` declared
  only `* text=auto` and the GitHub Windows runner defaults to `core.autocrlf=true`. The first
  version of this test **missed it** (it scanned a hardcoded extension list, so `*.svg` and the
  extension-less `LICENSE` were invisible); it now sweeps every **git-tracked** file and reads the
  **effective** attribute via `git check-attr`. Fixing it also caught `.gitignore`.
- **`release-workflow.test.mjs`** — the OIDC trust is bound to a **workflow filename**, and writing
  the publish steps a second time is exactly the bug that broke that other repository's releases
  twice. See [docs/RELEASING.md](docs/RELEASING.md).

## Repository layout

| Path | Contents |
|---|---|
| `lib/index.js` | `apply(ctx, config)` — assembles and registers the host routes |
| `lib/service.js` | `deleteSession` — the single deletion implementation |
| `lib/artifacts.js` | disk removal + path containment |
| `lib/http.js` | same-origin checks, body limits, status codes |
| `lib/config.js` | `Config` schema + defaults |
| `lib/audit.js` | JSONL audit trail |
| `client.js` | the web client half: slot registrations (menu row + confirm overlay + settings section) |
| `cordis.patch.yml` | inserts the host half, `inject: [webServer]` |
| `.github/workflows/` | `pack-release.yml` (tag → gate → pack → GitHub Release) and `publish-npm.yml` (**the only** npm-publish implementation, triggered by the same tag push in parallel — never invoked via `workflow_call`) |
| `docs/RELEASING.md` | version rules and the release chain |
| `scripts/release.ps1` | version bump + gate (+ CI pack/release) |
| `scripts/render-shot.mjs` | regenerates the documentation screenshots |
| `test/` | the 300-test regression suite |

## License

MIT
