# dsh-dialogue-cleanup

Delete a DeepSeek Harness session from the **running** Web runtime — live store entry,
workspace records, and on-disk artifacts — from the session row's `...` menu.

This is a compliant re-implementation of the capability boundary of the npm package
`dsh-session-cleaner@1.0.2`, not a copy of its implementation. See
[README.zh.md](README.zh.md) for the Chinese version and the full rationale.

## Two entry points (both official slots; neither touches the DOM)

**A — the session row's `...` menu** (single delete)

`sidebar.workspaces.session.menu.item` at `order: 500` (after the shipped Archive at 400).
It opens a themed confirmation in `shell.overlay` that says the action cannot be undone.

**B — the bulk management panel** (inside Settings)

- Entry *and* panel: `settings.section` (`id: dialogue-cleanup`, `order: 25`, after the
  shipped `account(-10)/general(0)/models(10)/plugins(15)/agent-presets(20)`).
  One registration is one Settings page; its content renders in the panel's content column.
- Because of that it needs **no `layout` service** and does not compete for space in
  `main` or the sidebar — one fewer optional dependency and one fewer degradation branch.

Panel capabilities:

| Capability | Notes |
|---|---|
| List | `sessionQuery.listSessions()` for the **full logical corpus** (inactive/archived included), merged with `sessionController.list()` for `running`/`blank`/`updatedAt` |
| Titles | `sessionQuery.readTitleSnapshots(ids)` for the **current page only**, with caching and sharded concurrency (measured ~65 ms per title, see below) |
| Filters | free text (title/id/project path), project dropdown, state (all/deletable/running), **session-kind tri-state** (main / subagent / all; main only by default, matching the official sidebar), **archive tri-state** (hide archived / all conversations / archived only; **archived are shown by default** — unlike the official sidebar, since archiving is not deleting and archived sessions still occupy disk), sort, paging (max 200 per page) |
| Bulk delete | tick rows → **one request** `/delete { sessionIds }`; the Host reuses the same `deleteSession` per id |
| Safety | a running session is never selectable (the Host decides `deletable`; the UI does not guess); "select all" means every deletable row on the page |
| Feedback | aggregate result (ok/failed/degraded/directories removed) plus each failure reason; the list refreshes afterwards |
| Cost | the footer shows `tookMs` plus title cache hits/fetches, so a fast response is explainable |

## What it does

One irreversible operation, implemented **once** as a Host service
(`lib/service.js` → `deleteSession`) and reached through two thin adapters
(the HTTP contract and the slot UI), so the two paths cannot drift:

1. **Refuse a running session** — 409 `refused`.
2. **Detach the live store entry** — otherwise the deleted row stays visible as a ghost.
3. **Drop workspace records** — counting only workspaces that actually detached.
4. **Clear registry leftovers** — pin / archive records via the public idempotent API.
5. **Remove on-disk artifacts** — `<DSH_HOME>/sessions/<project>/<sessionId>`, plus the
   derived projection cache.
6. **Write an audit line** — `<DSH_HOME>/logs/dialogue-cleanup.jsonl`.

## HTTP contract

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api-ext/dialogue-cleanup/delete` | `{ "sessionId": "..." }` → delete |
| `POST`/`GET` | `/api-ext/dialogue-cleanup/list` | session rows with `deletable` / `blockedReason` |
| `GET` | `/api-ext/dialogue-cleanup/status` | capabilities, config, runtime paths |

Envelope: `{ ok: true, value }` / `{ ok: false, error: { code, message, hint? } }` — with
**semantically correct HTTP status codes** (400 / 403 / 404 / 405 / 409 / 429 / 500),
unlike the upstream package, which always answered `200`.

## Configuration

All tunables live in the plugin `Config` (see `lib/config.js`), so a user's patch layer
survives upgrades. Note that a matching override **replaces the whole `config`** — write
every field you care about.

| Key | Default | Meaning |
|---|---|---|
| `maxBodyBytes` | `65536` | request-body ceiling (upstream: 1 MiB) |
| `readTimeoutMs` | `10000` | body-read timeout (upstream: none) |
| `audit` / `auditPath` | `true` / `null` | audit log; `null` → `<DSH_HOME>/logs/...` |
| `rateLimitPerMinute` | `60` | per-minute delete **request** budget (a batch counts once); `0` disables |
| `requireIdleSession` | `true` | safety valve for the running-session refusal |
| `stopIdleAgent` | `false` | see the honest-degradation note below |
| `matchAlternateIdSpelling` | `true` | probe the other `session-` spelling, guarded |
| `removeProjectionCache` | `true` | also drop the derived projection cache |
| `clearRegistryRecords` | `true` | unpin / unarchive leftovers |
| `confirmInUi` | `true` | UI confirmation (the Host does not trust it) |
| `titleCacheTtlMs` | `300000` | title-fold cache TTL; `0` disables |
| `titleFetchConcurrency` | `8` | shard concurrency when folding titles (measured ~1.8x from 4 to 8) |
| `titleLimit` | `100` | max rows per page to fold titles for; `0` skips title reading entirely |
| `runningProbeTtlMs` | `1000` | how long a running-state snapshot is reused. Turns batch delete from O(N) full-corpus list calls into O(1); `0` re-probes every item (strictest) |

## Honest limitations

These are **measured** against the live runtime, and differ from what the upstream
package assumes. They are reported truthfully rather than papered over:

- **No public stop for an idle agent.** The public `Agent` type is
  `{ readonly id: SessionId }` — no `status`, no `ctx`. Upstream's
  `agent.status === "running"` and `agent.ctx.fiber._unload()` therefore cannot be
  relied on (`_unload` is a Cordis *private* method and is deliberately never called).
  "Is it running?" comes from the public `sessionController.list()` →
  `SessionSummary.running`. A session that still has an attached agent and cannot be
  stopped safely is **refused**, and the UI shows why.
- **Detaching the live entry is best-effort.** The public `sessions` service exposes
  create/prepare/enter/announce/flush/get/list/fork — **no** public `detach`. The plugin
  tries the public method first, then the internal `store` entry, and reports
  `detached: false` when neither is available instead of claiming success.
- **Two on-disk id spellings coexist.** Observed in one `<DSH_HOME>`:
  `...\<uuid>\session.v4.jsonl.zstd` and
  `...\session-<uuid>\session.v4.jsonl.zstd`. Upstream's exact-id join can never delete
  the prefixed half. This plugin probes the alternate spelling **only** when it can
  confirm the candidate is not a different live session; with no such evidence it
  deletes nothing rather than risk a neighbour.

## Verification status

Run `node --test "test/**/*.test.mjs"` — **147/147 passing**, covering path traversal,
`isInside` boundaries, symlink refusal, the guarded alternate-spelling rule, origin
framing, body limits and timeouts, status codes, idempotent single-flight, and the
`refused` path leaving disk untouched.

`node --check` passes on every JavaScript file.

**Visual verification was not performed** — this environment provides no browser
control. Per the official guidance, verification is limited to JavaScript syntax,
manifest validation, and the live Client slot; what the UI *looks like* is unverified.

See [VERIFICATION.md](VERIFICATION.md) for the full report, including the
back-filled A–I findings.

## Install

```powershell
dsh plugin add E:\Code\dsh-plugin-market\dsh-dialogue-cleanup
```

or via the Plugin Manager (`install_bundle` with this directory as the target).

## Layout

```text
dsh-dialogue-cleanup/
├── package.json          dsh.bundle.patch + dsh.client + meta/icon
├── cordis.patch.yml      inserts the row, inject: [webServer]
├── icon.svg
├── locale/{en,zh}.json   display metadata
├── client.js             slot registrations (menu row + confirm overlay)
├── lib/
│   ├── index.js          apply(ctx, config) — assembles and registers routes
│   ├── config.js         Config schema + defaults
│   ├── service.js        deleteSession — the single implementation
│   ├── artifacts.js      disk removal + path containment
│   ├── http.js           same-origin, body limits, status codes
│   └── audit.js          JSONL audit trail
├── scripts/
│   └── release.ps1       version bump + gate (+ CI pack/release)
├── .github/workflows/    pack-release.yml + publish-npm.yml
├── docs/RELEASING.md     versioning rules and the release pipeline
└── test/                 156 unit/contract/render/release tests
```

## Releasing

Tag-driven, fully automated in GitHub Actions — no local build artifacts, no gh/npm tokens
spent locally.

```powershell
pwsh -File scripts\release.ps1 -LocalOnly      # gate only (no version change, no publish)
pwsh -File scripts\release.ps1 -Bump auto      # gate → bump → commit → tag → push
```

Pushing a `v*` tag triggers **Pack and Release**: gate → `pnpm pack` → GitHub Release
(with tarball + `version.json` attachments) → npm via OIDC Trusted Publishing.

See [docs/RELEASING.md](docs/RELEASING.md) for the versioning rules, the
`dsh-plugin-market` → this repo adaptation points, and the two npm pitfalls
(`npm@latest` + node 22.14, and why the publish step must stay inside
`publish-npm.yml`).

## License

MIT
