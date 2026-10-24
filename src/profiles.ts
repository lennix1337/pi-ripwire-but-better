// Small, explicit, offline checks. These do not stand for project-wide validation.
export const profiles = [
  {
    name: 'dentai', sentinels: ['pnpm-workspace.yaml', 'apps/api/scripts/operational-diagnostics.node-test.mjs'],
    checks: {
      'ops-diagnostics': { description: 'Focused API operational-diagnostics tests; no production or paid provider calls', argv: ['node', '--test', 'apps/api/scripts/operational-diagnostics.node-test.mjs'], timeoutMs: 30000 },
    },
  },
  {
    name: 'genexus18mcp', sentinels: ['Genexus18MCP.sln', 'scripts/lint.test.js'],
    checks: {
      'lint-setup': { description: 'Offline lint setup regressions; no SDK, KB, SQL or Cloud calls', argv: ['node', '--test', 'scripts/lint.test.js'], timeoutMs: 30000 },
    },
  },
  {
    name: 'pi-ripwire', sentinels: ['src/core.ts', 'test/core.test.mjs'],
    checks: {
      'core': { description: 'Offline integration and safety regressions', argv: ['node', '--test', 'test/core.test.mjs'], timeoutMs: 30000 },
    },
  },
];
