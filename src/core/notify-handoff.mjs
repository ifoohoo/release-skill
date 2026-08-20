/**
 * notify-handoff preset: the zero-write floor (v0.6.3 R4, design §2.5).
 *
 * Every downstream scenario degrades to at least this behavior: NO writes of
 * any kind — the §2.3 frozen context is rendered into a DETERMINISTIC
 * downstream sync checklist (version/tag/sha/tree/evidence path/suggested
 * actions), which the command layer writes into the run evidence and echoes.
 * Zero configuration, usable by any project, requiresApproval defaults false.
 *
 * The renderer is pure: identical inputs produce byte-identical checklists
 * (snapshot-locked by test/postpublish-notify-handoff.test.mjs). payloadDir
 * and any other local-only artifact never enter the checklist.
 *
 * @module core/notify-handoff
 */

/** Context fields rendered into the checklist, in deterministic order. */
const CHECKLIST_FACT_FIELDS = ['unitId', 'version', 'tag', 'commit', 'tree', 'manifestDigest', 'planDigest', 'runId', 'publishedAt'];

/**
 * Render the deterministic downstream sync checklist for the notify-handoff
 * preset. Pure function — no I/O, no writes.
 *
 * @param {object} contextProjection - The §2.3 context projection.
 * @param {object} [options]
 * @param {string} [options.evidencePath] - This run's evidence path (rendered
 *   as the `evidence:` line when provided).
 * @returns {string[]} Checklist lines (deterministic order and wording).
 */
export function renderNotifyHandoffChecklist(contextProjection, options = {}) {
  const context = contextProjection ?? {};
  const lines = [
    'notify-handoff downstream sync checklist (zero-write floor; no automated write was performed)',
  ];
  for (const field of CHECKLIST_FACT_FIELDS) {
    const value = context[field];
    if (typeof value === 'string' && value.length > 0) {
      lines.push(`- ${field}: ${value}`);
    }
  }
  const verifyEvidence = context.verifyEvidence;
  if (verifyEvidence && typeof verifyEvidence === 'object') {
    lines.push(`- verifyEvidence: runId=${verifyEvidence.runId ?? ''} status=${verifyEvidence.status ?? ''} finishedAt=${verifyEvidence.finishedAt ?? ''}`);
  }
  if (typeof options.evidencePath === 'string' && options.evidencePath.length > 0) {
    lines.push(`- evidence: ${options.evidencePath}`);
  }
  lines.push('suggested actions:');
  lines.push('- manually sync the frozen release facts above into every downstream consumer (marketplace entries, docs sites, hub registries)');
  lines.push('- downstream updates require human action or the downstream governance workflow; this hook wrote nothing');
  return lines;
}

/**
 * Execute one notify-handoff preset hook: render the checklist. The command
 * layer evidences/echoes it; this module performs zero writes.
 *
 * @param {object} params
 * @param {object} params.contextProjection - The §2.3 context projection.
 * @param {string} [params.evidencePath] - This run's evidence path.
 * @returns {Promise<{ status: 'EXECUTED', mode: 'notify-handoff',
 *   checklist: string[], manualSyncPrompt: string, observation: object }>}
 */
export async function executeNotifyHandoffHook(params) {
  const { contextProjection, evidencePath } = params ?? {};
  const checklist = renderNotifyHandoffChecklist(contextProjection, {
    ...(evidencePath !== undefined ? { evidencePath } : {}),
  });
  return {
    status: 'EXECUTED',
    mode: 'notify-handoff',
    checklist,
    manualSyncPrompt: checklist.join('\n'),
    observation: { mode: 'notify-handoff' },
  };
}
