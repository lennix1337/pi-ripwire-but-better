# Native Pi integration audit

## Scope and acceptance

Test the installed local extension, not a proposed design: Pi loading, actual tool execution, OptChat projection, bounded context, failure/replay protection, source identity, and orchestration latency. No real model calls, grading, publication or application changes. A synthetic provider proves the tool protocol, not LLM reasoning quality. No claim of fastest-possible execution.

## Findings and changes

- Reproduced a source-fingerprint collision: untracked `a` containing `bc` and `ab` containing `c` previously hashed identically. Frame tracked components and untracked filename/content hashes independently. No receipt reuse introduced.
- Reproduced invalid UTF-8 pagination when offset points inside a multi-byte code point. Reject such offsets; emitted `nextOffset` remains safe. Added large-output reconstruction coverage.
- Four independent read-only Git subprocesses dominated fingerprint overhead. Run those queries concurrently; keep before/after fingerprints, bounded untracked reads, failure handling and uncertainty markers. This does not make fingerprinting an atomic repository snapshot; use an isolated snapshot for concurrent-edit-sensitive gates.
- One Windows fixture cleanup failed with EBUSY; fixture removal now uses bounded native filesystem retries (3 at 100 ms), not a test/check retry.

## Measurements

Windows Node 24.15.0. Disposable unborn Git repository with 20 untracked files; same Node/toolchain and smoke command. One warmup plus seven samples per version per order. Frozen original core/profiles retained outside Git. Run original→current, then current→original to check order sensitivity.

| Median | Original, forward / reverse | Current, forward / reverse | Reduction |
| --- | --- | --- | --- |
| Fingerprint | 126.86 / 118.76 ms | 49.51 / 46.71 ms | 61.0% / 60.7% |
| Full tiny check + receipt | 334.66 / 315.61 ms | 176.16 / 164.22 ms | 47.4% / 48.0% |
| Recipe listing | 29.66 / 27.30 ms | 28.80 / 27.89 ms | noise; no gain claimed |
| Evidence retrieval | 0.457 / 0.433 ms | 0.477 / 0.426 ms | noise; no gain claimed |

Tiny-check model result remained 1,090 JSON bytes; optimization does not inflate context. Evidence output pages remain capped at 6,000 UTF-8 bytes by default with lossless continuation; no speculative caching, prompt hooks, automatic checks, or additional dependencies were introduced.

Reproduce: `node test/benchmark-local.mjs [path-to-frozen-core.mjs]`. These numbers measure local orchestration on a fixture, not DentAI/GeneXus builds, real-model latency, token counts, or LLM accuracy.

## Follow-up: bounded filesystem concurrency

Metadata/content reads now run in batches of eight; sorted hashing, containment, the 64 MiB budget, and fresh before/after checks are preserved. No caching or dependencies added. Canonical multi-batch digest and oversized-input tests pass.

Same Windows/Node protocol, seven samples, forward/reverse version order:

| Fixture / median | Before forward/reverse | After forward/reverse | Reduction |
| --- | --- | --- | --- |
| 1,000 files: fingerprint | 383.12 / 357.65 ms | 131.98 / 121.53 ms | 65.6% / 66.0% |
| 1,000 files: tiny check + receipt | 847.74 / 791.48 ms | 352.89 / 335.84 ms | 58.4% / 57.6% |
| 20 files: fingerprint | 51.48 / 48.76 ms | 60.43 / 43.34 ms | mixed; no gain claimed |
| 20 files: tiny check + receipt | 184.32 / 168.22 ms | 168.73 / 157.68 ms | 8.5% / 6.3% |

Additional to earlier Git parallelization; percentages are not additive. Listing/retrieval remain noisy; context schema/limits unchanged. Reproduce with `PI_RIPWIRE_BENCH_FILES=1000 node test/benchmark-local.mjs [frozen-core]`. External evidence: `faster*.json`, `faster-baseline.mjs` in the evidence directory below.

Fresh typecheck, 20/20 tests including Pi/OptChat flow, and installed discovery passed. No fresh application checks or paid inference. Static limitations remain.

## Follow-up: bounded evidence reads

Evidence retrieval reads only the requested range plus one UTF-8 lookahead byte,
not the whole log. No caching or skipped source checks; file handles always close.
Unsafe integer offsets are rejected.

Paired Windows warm reads, 30 measured samples after five warmups, both orders:

- 4 MiB log, 6,000-byte page: 3.62–3.66 ms → 0.45–0.46 ms (**87.4–87.5% faster**).
- 6,000-byte log: 0.32–0.35 ms → 0.30–0.34 ms (small/noisy difference).
- At most 6,001 log bytes read per default page instead of 4,194,304 (>99.8% less).
- Responses match the baseline; model context size is unchanged.

Typecheck, **21 tests**, offline Pi/OptChat flow, and discovery passed.
Mixed 1/2/3/4-byte UTF-8 tested at every offset with limits 4–9; empty logs,
EOF/beyond-EOF and unsafe offsets covered. External evidence: `paging-benchmark.json`
and `paging-baseline.mjs`. Reproduce with `node test/benchmark-evidence.mjs <baseline>`.
This measures local retrieval, not whole-agent latency or reasoning quality.
Static check limitations below still apply.

## Validation and limits

TypeScript and offline Pi/OptChat integration pass; test totals are recorded in STATUS.md. Fresh local discovery finds exactly the three tools without inference. The existing narrow real-project checks previously passed; an attempted fresh smoke command during this audit returned an uncertain harness outcome and its redirected log was absent. No new project success is inferred from that attempt.

Ripwire edit checks report no incompatible callers but have no Git HEAD baseline. Quality-panel ranks no multi-family findings; several language/history families are unavailable. Quality-delta cannot run without baseline. Test-gate exits 4, with unknown runners for developer benchmark/smoke scripts and unresolved dynamic tool-handler coverage. These static limits are not hidden by the passing runtime tests.

Evidence: `C:/projetos/local-validation/performance/pi-ripwire/audit-{before,after}{,-reverse}.json`, `audit-tests.txt`, and `audit-baseline/`. Runtime logs and frozen baseline stay outside version control. Reload Pi to activate changed code; no commit or publishing.
