---
name: ripwire-resident
description: "Use when enabling or diagnosing Pi's resident Ripwire MCP searches, checking hot-index freshness, or measuring navigation latency."
---

# Resident navigation

1. Confirm one repository root and inspect `README.md` in this package, section **Resident navigation (opt-in)**. Record the executable and baseline timings before activation.
2. Enable only through the authorized session environment: `PI_RIPWIRE_RESIDENT=1`; optionally set `PI_RIPWIRE_BINARY` to a reviewed executable. Reload or restart the owning Pi session. Environment setup is not performed by this skill.
3. Call native `ripwire` with `search` or `task`. Confirm `transport:"mcp-stdio"`, the protocol freshness metadata, and the saved receipt through `project_evidence`. Other actions remain CLI-backed.
4. For a local implementation check, inspect and run `node test/resident-live.mjs` from the package checkout. It uses a disposable Git fixture, real MCP and Pi loader, refreshes changed source and exercises shutdown/reload without model requests. This does not prove the current interactive profile reloaded.
5. Report cold and warm latency separately. MCP JSON and CLI XML differ; compare served indexed **and off-index** hit identities/totals rather than asserting byte-equivalence. A timeout/cancellation/protocol failure has a receipt and no automatic replay; inspect it before another request.

The pool retains at most two repository processes and admits at most sixteen outstanding requests. Session shutdown closes owned processes. Disabling the variable and reloading restores the default CLI path. An error or timing result never grants permission for a retry, executable replacement or broader repository access.
