/**
 * Pure proposal-document projection shared by runtime transports and frozen
 * postVerify execution hooks. Keep this module free of package dependencies
 * so a detached public-tag worktree can load it without node_modules.
 *
 * @module core/proposal-document
 */

import { ReleaseError, GATE_FAILED } from './errors.mjs';

/** Proposal document identity. */
export const PROPOSAL_SCHEMA_VERSION = 1;
export const PROPOSAL_KIND = 'release-skill/update-proposal';

/** Proposal file location inside the downstream repository. */
export function proposalFileName(unitId, version) {
  if (typeof unitId !== 'string' || unitId.length === 0
    || typeof version !== 'string' || version.length === 0) {
    throw new ReleaseError(GATE_FAILED, 'proposal file name requires unitId and version', { unitId, version });
  }
  return `incoming/${unitId}-${version}.json`;
}

/**
 * Build the deterministic downstream proposal from a post-publish context.
 * Local materialization paths are intentionally excluded.
 */
export function buildProposalDocument(context) {
  const required = ['unitId', 'version', 'tag', 'commit', 'planDigest', 'runId'];
  for (const field of required) {
    if (typeof context?.[field] !== 'string' || context[field].length === 0) {
      throw new ReleaseError(GATE_FAILED, `proposal document requires context field "${field}"`, { field });
    }
  }
  const { unitId, version, tag, commit, tree, manifestDigest, planDigest, runId, publishedAt, verifyEvidence } = context;
  return {
    schemaVersion: PROPOSAL_SCHEMA_VERSION,
    kind: PROPOSAL_KIND,
    unitId,
    version,
    tag,
    sha: commit,
    commit,
    ...(typeof tree === 'string' && tree.length > 0 ? { tree } : {}),
    ...(typeof manifestDigest === 'string' && manifestDigest.length > 0 ? { manifestDigest } : {}),
    planDigest,
    runId,
    ...(publishedAt !== undefined ? { publishedAt } : {}),
    ...(verifyEvidence !== undefined ? { verifyEvidence } : {}),
    changeSummary: `release ${unitId} ${version} (tag ${tag}, commit ${commit})`,
  };
}
