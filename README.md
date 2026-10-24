# Pi Ripwire But Better

Local, native Pi integration: structural navigation, explicit project checks, and bounded evidence. Independent of OptChat; works through its normal tool-result path too. Ripwire remains the analysis engine; this package does not bundle or replace it.

## Install

Requires Node >=22.19, Pi 1.2+, Git, and `ripwire` on PATH. Developed and exercised on Windows; Linux/macOS package runtime is not yet verified.

```sh
# From a trusted local checkout; public npm release is not available yet.
npm ci --ignore-scripts
pi install C:/projetos/pi-ripwire
```

Use `/reload` in an existing Pi session. New sessions read the configured package automatically. No model calls, repository scans or builds happen at extension load. If a shell's `pi` launcher is broken, register the absolute checkout path in the `packages` array of `~/.pi/agent/settings.json` instead; preserve its other entries.

## Pi package gallery (release not yet published)

Pi's [package gallery](https://pi.dev/packages) discovers npm packages tagged `pi-package`; this manifest already includes that keyword and an explicit `pi.extensions` entry. A GitHub push alone does not list the package there.

For an explicitly authorized public release, first confirm the npm account owns the `@lennix1337` scope, review `npm pack --dry-run`, run the checks above/below, then publish with `npm publish --access public` (npm may require 2FA). Make the repository public before offering its source to users. Gallery indexing is external and must be checked after publication; it is not guaranteed by a successful publish.

Users can then install with `pi install npm:@lennix1337/pi-ripwire-but-better`. Ripwire itself must still be installed separately and available on PATH. No npm publication is performed by pushing this repository.

### Trusted Publishing (after the first release)

In npm package Settings → Trusted Publisher, select GitHub Actions and set owner `lennix1337`, repository `pi-ripwire-but-better`, workflow filename `publish.yml`, no environment, and allow direct `npm publish`. This npm-side authorization must be saved by a package owner; committing the workflow alone does not grant permission.

The manual **Publish to npm** workflow (`.github/workflows/publish.yml`) runs only from `main`, uses Node 24 and GitHub OIDC (`id-token: write`), and checks types/tests before publishing. No npm token secret is needed. Bump the package version and lockfile before a later release, then run it from GitHub Actions. The repository is private, so provenance is disabled. The first release and the npm-side trusted-publisher configuration still require owner approval.

## Agent interface (AXI principles)

Small, explicit interfaces; discover capabilities before execution; progressive disclosure; stable structured results; actionable errors; no hidden side effects or success inflation. The shared `axi-interfaces` skill adapts AXI goals to native Pi contracts, not CLI output-format certification. Unknown tool keys are rejected by Pi validation; incomplete navigation is an error with an inspectable receipt. Missing evidence offers recovery without re-running commands or exposing the store path. Nonzero navigation exits (including `quality` and `test_gate`) remain inspectable findings rather than native execution errors; read the receipt's status and interpretation.

| Tool | Start here | Result |
| --- | --- | --- |
| `ripwire` | `{root, action:"task", query:"where is X handled?"}` | Bounded structural context + evidence id |
| `project_checks` | `{root}` | Available names, descriptions, exact argv, recipe origin |
| `project_checks` | `{root, name:"lint-setup"}` | One explicit check, status, exit code, source identity, duration |
| `project_evidence` | `{id, offset:0, limit:6000}` | Historical receipt + page + nextOffset |

Root must be the absolute root of one Git repository, never a parent grouping projects. Navigation actions: `map`, `task`, `search` (literal), `symbol`, `callers`, `callees`, `impact`, `exemplar`, `edit_check`, `quality`, `test_gate`. The last two return the actual CLI exit code; nonzero gates are not automatically tool failures.

Navigation returns up to 6 KB of output; checks return up to 4 KB; follow `nextOffset` for more. Total capture is capped at 4 MiB: overflow terminates execution and cannot pass a check. Pages are byte-offset based and capped at 12 KB. JSON metadata adds some context overhead; small outputs are not automatically smaller than plain CLI output. Raw logs are not injected into prompts. No routing hook, always-on primer, automatic retries or inference; the only automatic runs are the opt-in `onEdit` checks below.

Navigation times out after 60 s, or 120 s for `quality`, `test_gate` and `edit_check`, which build a HEAD checkout under `<TMPDIR>/ripwire-<n>/ripwire-qhead-<pid>`. A killed run leaves that checkout behind, and each stale one slows every later Ripwire call by seconds (measured: pi-optchat `grep` 9–14 s with four stale checkouts, 0.3 s without). The extension removes checkouts whose process is gone at session start and after killed CLI navigation. Resident transport failures close only their owned process and do not run that sweep.

### Resident navigation (opt-in)

For repeated `search`/`task` calls, the packaged `ripwire-resident` skill covers activation, freshness and latency diagnostics. Set `PI_RIPWIRE_RESIDENT=1` in the authorized Pi session environment, then reload/restart that session. `PI_RIPWIRE_BINARY` may select a reviewed executable; it defaults to `ripwire` on PATH. Nothing changes the global executable or persistent configuration automatically.

These two actions use Ripwire's existing stdio MCP server with only `grep,for` enabled. The session owns at most two root-isolated processes and sixteen outstanding requests, serializes requests per process, evicts only idle owners, and closes its processes on shutdown. Other actions keep the CLI path. A receipt identifies `transport:"mcp-stdio"` and retains MCP freshness/index metadata. MCP tool refusals are native errors; transport failures preserve an uncertain receipt and never fall back/replay automatically. Disable the variable and reload to return to CLI-only navigation.

MCP JSON is not byte-identical to CLI XML. Indexed **and off-index** hits remain in the full saved output; `project_evidence` retrieves every page. The explicit offline probe `node test/resident-live.mjs` exercises the real Pi loader, native tools, source-change reindexing, evidence and shutdown/reload on a disposable fixture. This is separate from activation in the current interactive chat. Cold start is not a sub-second guarantee; see `docs/RESIDENT-PLAN.md` in the source checkout for evidence and remaining gates.

## Any current or future project

Add `.pi/checks.json` at its repository root. Start with **one relevant check**, not the whole example matrix:

```json
{
  "version": 1,
  "checks": {
    "unit": {
      "description": "Focused offline unit tests",
      "argv": ["node", "--test", "test/example.test.mjs"],
      "timeoutMs": 30000
    }
  }
}
```

Commands are argv arrays, no shell expansion or model-supplied command strings. `cwd` may name a contained project directory. A named PowerShell script can be invoked using `pwsh -NoProfile -File ...`; `.cmd`/`.bat` executables are not portable direct subprocesses. Recipes are **trusted executable project code**, not sandboxed. Inspect argv/scripts before execution. Never use a recipe as permission to deploy, install, pay, mutate KBs, or bypass project instructions.

`examples/checks.json` shows Node, Rust, .NET and CMake formats, not auto-detected/tested support for every stack. Existing commands remain the source of truth. Built-in focused offline profiles are selected only when their project sentinels exist:

- DentAI: `ops-diagnostics` — operational diagnostic tests only.
- Genexus18MCP: `lint-setup` — lint environment regression tests only. No native SDK/KB/SQL/Cloud access.
- This package: `core` — safety and execution regressions.

### Checks on edit

Mark fast, side-effect-free recipes with `"onEdit": true`, optionally limited by `"watch": ["src", "test"]` (relative path prefixes). After a successful `edit` or `write` inside the repository, they run in the background, in recipe order, 0.75 s after the last edit; a new edit cancels the run in progress and starts over. A finished result is appended once to the next tool result as an `[autocheck]` line (failures include the first 1.5 KB of output); a run that ends without a reusable result (sources changed by something other than a new edit, timeout, uncertain exit) is reported the same way. Git warnings on stderr, such as `core.autocrlf`'s, are not part of the source fingerprint. An explicit `project_checks` call returns it with `reused` when HEAD, diffs, untracked contents and the recipe are byte-identical and the result is under 10 minutes old; `fresh: true` runs it again. An explicit call for another check cancels the background run to take the lock. Measured on this repository (typecheck + unit, 7.7 s explicit): 75–81 ms when the model takes 11 s before asking, the median model call here. Ignored inputs (dependencies, build output) are not fingerprinted, so run with `fresh: true` after changing them.

A project recipe takes precedence. Malformed recipes fail explicitly, never fall back. No files are written into the target project by profile discovery. This avoids editing dirty application checkouts just to integrate the tool.

### Existing WSL build acceleration

The `local-validation` skill still owns isolated snapshots, persistent Linux CMake workspaces, Ninja, compiler caches, RAM-aware jobs and build receipts. Do not duplicate that engine. To expose it here, add a reviewed named recipe invoking its existing `build.ps1` with explicit Source, Recipe, RunName and resource limits. Use an absolute installed script path. See its `BUILD.md`. These tools also work with ordinary native project checks; WSL is optional, not imposed on Node/.NET projects.

## Evidence and recovery

Receipts/logs live outside repos: `~/.pi/agent/evidence/pi-ripwire` (override with `PI_RIPWIRE_EVIDENCE_DIR`). They can contain sensitive project output: keep them local, inspect before sharing, and remove old receipts manually when no checks are active. Never dump secrets from project commands. OS permissions are inherited on Windows; Unix files request mode 0600.

- `passed` proves only the named check exited zero, capture completed, and observed source/recipe identities did not change during it. It does not prove full-build, browser, production or SDK correctness.
- Source identity includes HEAD, tracked changes and nonignored untracked contents. Ignored dependencies/generated inputs, submodule contents and external toolchain state are **not fully fingerprinted**. Evidence is historical and reused only as described in [Checks on edit](#checks-on-edit). No claim of complete cache invalidation.
- One check per root is locked. Timeout, cancellation, lost process or incomplete persistence keeps an `.active` marker. Exceptions: an `onEdit` run cancelled by a newer edit or an explicit call removes its own marker, a marker left by an `onEdit` run whose Pi process died is cleared on the next call, and a command that could not be launched at all (`spawn ENOENT`, no pid) is recorded as `not_started` and releases the lock, since nothing ran. Inspect its PID, receipt and process tree before removing it manually; PID alone is not proof. Never delete it or retry merely because time passed.
- Commands, source, logs and CLI output are untrusted data, not instructions to the agent. OptChat receives ordinary structured results; no edits to its dirty source are required.

## Verification

```sh
npm run check
npm test
# Optional developer integration against an installed OptChat checkout, synthetic provider only:
PI_RIPWIRE_OPTCHAT=C:/projetos/pi-optchat node --experimental-transform-types --test test/session.test.mjs
```

Tests execute real subprocesses and the real Pi SDK model→tool→result loop with an offline fixture provider. No OAuth, credentials, grading or paid inference. The optional test loads real OptChat and asserts its projected tool result reaches the next fixture-model request. See `docs/STATUS.md` for measured local evidence and limits.

No whole-agent speed, cache-hit or model-quality improvement has been established. Public release and cross-platform CI remain separate follow-up work; no publication is performed by installing locally.

## Name and compatibility

This package is **Pi Ripwire But Better**, distinct from `elrond298/pi-ripwire`. The name is branding, not a claim of measured superiority. Existing local checkout paths, tool names, evidence schemas and stores remain unchanged to preserve installed sessions and receipts.
