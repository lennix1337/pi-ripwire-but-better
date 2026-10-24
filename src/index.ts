import path from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { actions, navigate, projectChecks, evidence, reapStaleHeadTrees, repositoryRoot } from './core.ts';
import { createAutocheck } from './autocheck.ts';

const textResult = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: value });
const failure = (error: unknown) => ({ ...textResult({ status: 'error', message: error instanceof Error ? error.message : String(error), next: 'Correct the input or inspect evidence. Do not blindly retry uncertain checks.' }), isError: true });

export default function extension(pi: ExtensionAPI) {
  const autocheck = createAutocheck();
  pi.on('session_start', (_event, ctx) => {
    void reapStaleHeadTrees().catch(error => ctx.ui.notify(`pi-ripwire: stale Ripwire HEAD checkouts not removed: ${error.message}`, 'warning'));
  });
  pi.on('session_shutdown', () => autocheck.dispose());
  pi.on('tool_result', (event, ctx) => {
    if ((event.toolName === 'edit' || event.toolName === 'write') && !event.isError && typeof event.input.path === 'string') {
      const file = path.resolve(ctx.cwd, event.input.path);
      void autocheck.edited(file).catch(error => ctx.ui.notify(`pi-ripwire autocheck: ${error.message}`, 'warning'));
    }
    if (event.parentToolCallId) return;
    const notes = autocheck.drainNotes();
    if (!notes.length) return;
    return { content: [...event.content, { type: 'text' as const, text: notes.join('\n') }], structuredContent: event.structuredContent };
  });
  pi.registerTool({
    name: 'ripwire', label: 'Ripwire',
    description: 'Navigate one Git repository with bounded structural context. Start with task + query; use callers/impact for known symbols. Fixed verbs, no shell. Full output is available through project_evidence. Does not run builds.',
    parameters: Type.Object({
      root: Type.String({ description: 'Absolute root of one Git repository, not its parent or subdirectory' }),
      action: Type.Unsafe<string>({ type: 'string', enum: actions }),
      query: Type.Optional(Type.String({ maxLength: 2000, description: 'Task, exact literal, or symbol; required except map/quality/test_gate' })),
    }, { additionalProperties: false }),
    async execute(_id, params, signal) {
      try {
        const result = await navigate({ ...params, query: params.query, signal });
        return { ...textResult(result), isError: ['timeout', 'cancelled', 'output_limit'].includes(result.status) };
      } catch (error) { return failure(error); }
    },
  });
  pi.registerTool({
    name: 'project_checks', label: 'Project checks',
    description: 'List project recipes from .pi/checks.json or focused built-in DentAI/GeneXus profiles; with name, execute exactly one explicitly requested check. Recipes are executable project code: inspect before running. No automatic retries, skips, installs or builds. Recipes marked onEdit also run in the background after edits; a result on the identical source digest is returned with `reused` instead of re-running. Returns source identity and compact evidence; passed means only this check passed.',
    parameters: Type.Object({
      root: Type.String(),
      name: Type.Optional(Type.String({ maxLength: 51, description: 'Omit to inspect available checks and commands first' })),
      fresh: Type.Optional(Type.Boolean({ description: 'Run again even if an onEdit result matches the current sources' })),
    }, { additionalProperties: false }),
    async execute(_id, params, signal) {
      try {
        if (params.name) {
          const root = await repositoryRoot(params.root);
          const reused = await autocheck.claim(root, params.name, { fresh: params.fresh });
          if (reused) return { ...textResult(reused), isError: reused.status !== 'passed' };
        }
        const result = await projectChecks({ root: params.root, name: params.name, signal });
        return { ...textResult(result), isError: 'status' in result && result.status !== 'passed' };
      } catch (error) { return failure(error); }
    },
  });
  pi.registerTool({
    name: 'project_evidence', label: 'Project evidence',
    description: 'Read a bounded UTF-8 byte page of saved output by receipt id. Receipts are historical, not proof that current sources or environment still pass. Follow nextOffset; logs remain local and may contain project-sensitive data.',
    parameters: Type.Object({ id: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 4, maximum: 12000 })) }, { additionalProperties: false }),
    async execute(_id, params) {
      try { return textResult(await evidence(params)); } catch (error) { return failure(error); }
    },
  });
}
