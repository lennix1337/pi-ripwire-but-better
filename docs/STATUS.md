# Local implementation status

## Implemented

Native Pi extension in `C:/projetos/pi-ripwire` with three tools: fixed-verb Ripwire navigation, explicit named project checks, and paged evidence. No prompt hook, background indexing, model routing, inference, auto-install, auto-build, auto-retry, or automatic evidence reuse. Version 1 `.pi/checks.json` works independently of stack; focused built-in DentAI/Genexus18MCP profiles do not modify those repositories. Existing WSL build acceleration stays in the local-validation skill, callable through an explicit recipe.

## Verified

- TypeScript check passed.
- 16/16 regressions passed, including real subprocesses, root confinement, source-change detection, newborn repositories, output caps, timeouts/replay blocking, persistence, and recipe validation.
- Real Pi SDK loader and model → check tool → subprocess → receipt → next model request passed using an entirely synthetic provider.
- Real dirty OptChat checkout loaded in a disposable profile; projection preserved tool output for the next fixture request. No changes to its source, credentials, active profiles or real provider calls. Its fixture compactor is treated separately from main model turns.
- Fresh Pi resource loader discovered exactly one configured local package with all three tools and no diagnostics.
- Dotfiles mirror loaded successfully without node_modules. Windows installer syntax and isolated seed/preserve-existing fixture passed; no full host installer execution.
- npm package dry-run contains only eight intended source/documentation/example files; no evidence, auth files or dependency tree. Nothing published.
- Actual DentAI focused operational-diagnostics check: 10/10 tests, ~5.45 s including orchestration/fingerprinting. The tests include a deliberate ~5 s loopback timeout: not an orchestration bottleneck.
- Actual Genexus18MCP focused lint-setup check: 3/3 tests, ~0.39 s including orchestration/fingerprinting. No SDK/KB/SQL/Cloud operations.
- Real Ripwire task lens completed in ~1.18 s on this new extension: 5,078 output bytes, all returned because below the 6 KB cap. No token saving is claimed for this small result.
- Ripwire `projectChecks` edit-check passed; absolute quality-panel completed with no ranked multi-family findings.

Evidence outside Git: `C:/projetos/local-validation/performance/pi-ripwire/` (`tests-final.txt`, `session.txt`, `real-project-checks.json`, `navigation.json`, `real-smoke.txt`, static reports). Project check receipts also live in the default local evidence store. They are historical observations, not permission to reuse them for changed inputs.

## Follow-up audit

See `PERFORMANCE-AUDIT.md` for the reproduced fingerprint/UTF-8 defects, fixes, frozen-baseline measurements, and static-check limits. Latest follow-up validation: 21/21 tests including real offline Pi and OptChat flow, typecheck and discovery. Bounded evidence reads reduced 4 MiB log pagination from 3.62–3.66 ms to 0.45–0.46 ms (87.4–87.5%) in both benchmark orders, with identical returned content and at most 6,001 log bytes read per default page. Bounded eight-file I/O batches reduced fingerprinting 65.6–66.0% and tiny-check orchestration 57.6–58.4% on the 1,000-file fixture, relative to the already Git-parallel baseline; small-fixture fingerprint results were mixed. See the audit for both run orders. Synthetic check orchestration fell from 315–335 ms to 164–176 ms across both run orders; this is not a whole-agent speed claim. Existing project tests above are historical; a new smoke attempt lacked observable execution output and is not counted as a fresh pass.

## Windows check-launch recovery (2026-10-26)

- Reproduced a synchronous `.cmd` launch rejection (`EINVAL`) being recorded as `outcome_uncertain`, which stranded the repository lock despite no child starting. Asynchronous missing-executable errors were already classified `not_started`.
- Synchronous spawn rejection now carries the same no-start evidence. Failed launches keep their error flag/receipt, release only the no-start lock, and explain the explicit-shell/Pi-PATH boundary. No retry or shell fallback is added; real timeouts still retain the uncertainty fence.
- Windows suite: 53 passed, one optional OptChat integration skipped; includes real `.cmd` rejection, explicit `cmd.exe` recovery, no execution before recovery, and fresh Pi native-tool/evidence read-back. Removing the no-start classification caused the two new synchronous-launch regressions to fail; it was restored and the suite passed.
- Ripwire contracts unchanged and quality gate passed (two informational churn findings). Static test-gate still has unresolved call-graph coverage; passing tests do not prove every statically impacted path.
- Existing sessions require `/reload` to load the fix. No reload, production action, account/PATH change or package release is performed by this work. Fresh Linux/macOS execution remains unverified.

## Limits / pending

- Quality-delta cannot compare this new, uncommitted repository: no HEAD or pinned prior baseline. Explicit test-gate exited 4: four recommended files, zero untested symbols; developer smoke has `run_unknown=1`. All four recommended test/smoke files were actually executed.
- This verifies narrow project checks, not either application's full matrix, browser, deployed behavior or SDK parity.
- Ignored dependencies/generated inputs, external toolchain state and submodule contents are not fully fingerprinted. No automatic result reuse, so no stale-success shortcut is enabled.
- Linux/macOS runtime, public npm/GitHub publication and clean public-install CI not yet verified. Package source is original; no source from the existing Pi integrations was copied.
- No whole-agent speed, cache-hit or LLM accuracy gain has been measured. The benefit established here is a working native bounded interface, not faster underlying analysis/builds.
- Configured locally; existing sessions require `/reload`. No commit, push, merge, release or deployment in this task. The package is mirrored in dotfiles for the Windows installer, preserving existing checkout work.
