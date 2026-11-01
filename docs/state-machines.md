# Implicit state machines in pi-ripwire

Catalog made on `origin/main` (328570c). Line references are by function name.

Severity: P1 wrong behaviour with real impact, P2 wrong behaviour in a reachable situation, P3 latent or cosmetic.

Index freshness is owned by Ripwire itself (the MCP result's `_fresh:*` metadata, e.g. `_fresh:reindexed`, is stored in the receipt as `protocol`); this package does not keep an index state of its own. The only freshness machines here are the source digests of machine 4.

## 1. Resident MCP server (`src/resident.ts`, `createServer`)

- **States:** `starting` (child spawned, `initialized = false`) -> `ready` (`initialized`) -> `serving` (one `active` request) -> back to `ready`; any state -> `failed` (`failure` set, child killed, SIGKILL after 1 s) which is terminal. `closed` is a getter over `failure`.
- **Events:** JSON-RPC response (routed by `responseRouter` to the single `active` request), framing/size/envelope errors, deadline, abort signal, child `error`/`exit`, stdin error, `close()`.
- **Transitions:** every failure goes through the one `fail(error)` function, which is idempotent (`if (failure) return`), rejects the active request, destroys stdin and kills the child. A JSON-RPC `error` response rejects only that request (the server stays `ready`). A request is "dispatched" once written; it is never replayed.
- **Lives in:** closure variables of `createServer`; `chain` (promise tail) serializes requests; `queued` counts admitted requests; `idleTimer` (set by `release` when the last request leaves) and `killTimer`.
- **Invariants:** one in-flight request per server; a mismatched response id poisons the server; nothing is retried or routed to the CLI after a dispatched failure.
- **Findings**
  - RES-1 (P3, catalogued). A JSON-RPC error answer to `initialize` rejects the request but leaves `initialized = false` and the server alive: the next request sends `initialize` again to a process the server may already consider initialized. Ripwire's reply to a repeated initialize is not specified here; not observed.
  - RES-2 (P3, catalogued). `release` re-arms `idleTimer` on a server that `dispose`/`close` already failed; the (unref'd) timer fires, finds the server no longer in `servers` and returns. Harmless.
  - Explicit enough and covered by `test/resident.test.mjs` (reuse, idle exit, timeout, corruption, cancellation, bursts, shutdown). Left as is.

## 2. Resident pool admission (`createResidentPool`)

- **State:** `servers` (root -> server, at most `maxServers`), `pending` (at most `maxPending`), `closed`, `admission` (promise chain that serializes admission only).
- **Transitions:** `navigate` validates, counts `pending`, appends to `admission`, then `acquire`: reuse, or replace a `closed` server, or evict one idle server (`queued === 0`), or refuse when full; `queued++` happens in the same turn as the map lookup so the idle timer cannot race it. `dispose`: `closed = true`, wait for admission, close all.
- **Findings:** none. `cancellable` rejects the caller early while the queued job still releases its slot when it ends, so `pending` reflects real work.

## 3. Idle expiry (`release`)

Last request out arms a 5-minute timer; admission clears it; the timer re-checks `queued` and map identity before closing. Explicit and tested (`an idle server exits after idleMs`, `the idle timer never interrupts a dispatched or queued request`). No findings.

## 4. Autocheck per repository (`src/autocheck.ts`)

- **State per root (`state(root)`):** `timer` (debounce), `controller` (cancels the current sweep), `running` + `runningName` (the speculative run in flight), `halt`, `results` (name -> finished result with its digest); plus module-level `notes` and `unconfigured`. Together they encode: `idle` / `debouncing` / `sweeping` (waiting for an old run, running recipe k) / `halted by an explicit claim`.
- **Events and transitions:** `edited(file)` clears `results` and the root's notes, aborts the controller, restarts the debounce; `timer` fires `sweep`; `runOne` records a note and a reusable result for `passed`/`failed`, a note for anything else not caused by an abort; `claim(root, name)` (called before an explicit `project_checks`) returns a reusable result for the identical digest or stops the sweep and waits for the lock holder; `drainNotes` words each note as "current sources" only if the digest still matches (the fix of #3); `dispose`.
- **Invariants:** at most one speculative run per root; an explicit check that `claim` returned `null` for must find the lock free of speculative runs; results are reused only for the identical source and recipe digest within `maxAgeMs`.
- **Findings**
  - **AC-1 (P2, fixed).** `sweep` waited for the cancelled run of the previous edit *before* creating its own controller and resetting `halt`. Both happened after the wait, so anything that arrived during it was lost: an explicit `claim` (which sets `halt` and aborts `s.controller`, still the old, already aborted one) could not stop that sweep, the sweep resumed with `halt = false` and started a speculative run, and the explicit `projectChecks` that followed `claim`'s `null` raced it for the lock and could be refused with "An automatic onEdit check is running for this repository; call again when it ends" (`CHECK_ACTIVE`). A further edit in that window hit the same gap and let two sweeps overlap. Reachable whenever an edit lands while a long onEdit run (typecheck) is in flight and an explicit check is requested within the cancelled run's exit time. Fix: the sweep takes the controller and clears `halt` first, aborting the previous sweep's controller, and only then waits. Test: `a sweep waiting for a cancelled run does not start once an explicit check has claimed the repository`.
  - AC-2 (P3, catalogued). `dispose()` aborts and clears timers but sets no disposed flag; an `edited` call after `session_shutdown` would re-arm a timer. No caller does that today.
  - AC-3 (P3, catalogued). `dirs` caches `rootOf(dir)` for the session, including `null` for a directory that was not a repository when first seen; a later `git init` there is not noticed until reload.
  - AC-4 (P3, catalogued). `runOne` reports `CHECK_ACTIVE` silently (an explicit or foreign check owns the repository). That is intended, and the explicit run produces its own evidence.

## 5. Check lock marker (`src/core.ts`, `acquireLock`, `projectChecks` `finally`)

- **States (file `<sha256(root)>.active` in the evidence store):** absent -> held (`{id, pid, root, name, started, speculative}`) -> absent when the run completed or never started; kept ("uncertain") when execution started but did not complete (timeout, cancellation, signal, fingerprint failure, save failure) for an explicit run.
- **Rules:** `wx` create; on `EEXIST`, a marker with `speculative: true` whose pid is dead is cleared and retaken, anything else (explicit run, unreadable marker, live pid) raises `CHECK_ACTIVE`. A cancelled speculative run clears its own marker (`completed` is true for `speculative && reason === 'cancelled'`).
- **Findings**
  - AC-5 (P3, catalogued). Clearing a stale speculative marker is not atomic: two Pi processes that read the same dead-pid marker both `unlink` and then `wx`; the second `unlink` can delete the first's fresh marker and both runs proceed. Needs two sessions on one repository reaping at the same instant.
  - AC-6 (P3, catalogued, design decision). An explicit run's marker survives a timeout, cancellation or output-limit stop (`result.reason` set) and blocks every later check on that repository until someone deletes it by hand. This is deliberate ("never blindly replay"); the process tree was killed before `execute` resolved, so an automatic expiry keyed on a dead pid would be a policy change, not a bug fix.
  - AC-7 (P3, catalogued). `projectChecks` writes the receipt as `status: 'running'` first and rewrites it at the end; a crashed Pi leaves a `running` receipt on disk forever. `evidence()` returns it as is.

## 6. Check run phases (`projectChecks` locals `receipt`, `executionStarted`, `completed`, `output`)

Phases: lock held -> receipt written (`running`) -> execution started -> finished and saved. Three locals decide the final receipt status and whether the marker is removed: `status` becomes `not_started` (execution never started), `outcome_uncertain` (started, then an error), or one of `passed`/`failed`/`source_changed`/`outcome_uncertain`/timeout/cancelled/output_limit. The assignments are in two places (success path and `catch`) and agree. Left as is; covered by the existing check tests.

## 7. Navigation receipts (`navigate`, `navigateResident`)

One shot, no persistent machine; the receipt is saved after the call. Status vocabulary: `completed`, `nonzero_exit`, execution reason (`timeout`, `cancelled`, `output_limit`), and `transport_error` for a resident failure. No findings.

## 8. Stale HEAD checkouts (`reapStaleHeadTrees`)

Stateless sweep keyed on pid liveness (`process.kill(pid, 0)`); a reused pid keeps its tree (P3, harmless).

## Summary

| machine | states | explicitness before | after | findings |
| --- | --- | --- | --- | --- |
| Resident MCP server | starting / ready / serving / failed | closure vars, one idempotent `fail` | unchanged | RES-1 P3, RES-2 P3 |
| Resident pool admission | admitting / full / closed | counters + promise chain | unchanged | none |
| Idle expiry | armed / cleared / fired | timer + `queued` guard | unchanged | none |
| Autocheck per repository | idle / debouncing / sweeping / halted | 5 per-root fields | controller owned from sweep start | AC-1 P2 fixed, AC-2 P3, AC-3 P3, AC-4 P3 |
| Check lock marker | absent / held / uncertain / stale | file protocol | unchanged | AC-5 P3, AC-6 P3, AC-7 P3 |
| Check run phases | locked / started / saved | 3 locals | unchanged | none |
| Navigation receipts | one shot | n/a | n/a | none |
| Stale HEAD checkouts | stateless | n/a | n/a | none |
