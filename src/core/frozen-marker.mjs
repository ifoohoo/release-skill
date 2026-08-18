/**
 * FROZEN marker maintenance (2026-08-18 release-cycle investigation §4.5,
 * review §3.3 option 1).
 *
 * prepare writes `.release-skill/FROZEN` after a plan is frozen; verify
 * clears it when the release reaches VERIFIED. The marker is a read-only
 * governance signal — a gentlemen's-agreement flag that cross-repo writers
 * (e.g. skill-family治理 tasks) may consult to avoid writing into a repo
 * mid-release. This repo only maintains it mechanically; it does not and
 * cannot enforce the convention on other writers.
 *
 * Marker content (JSON):
 *   { planDigest, targetVersions: { unitId: version }, createdAt, runId }
 *
 * Semantics:
 * - A successful prepare overwrites any previous marker.
 * - A failed prepare never writes (prepare only calls this after plan write).
 * - verify clears it ONLY on VERIFIED; failed/PARTIAL verify runs keep it.
 *
 * @module core/frozen-marker
 */

import { readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

/** Marker file name inside the `.release-skill` release directory. */
export const FROZEN_MARKER_FILENAME = 'FROZEN';

/**
 * Absolute marker path for a release directory.
 *
 * @param {string} releaseDir - Absolute `.release-skill` directory.
 * @returns {string}
 */
export function frozenMarkerPath(releaseDir) {
  return join(releaseDir, FROZEN_MARKER_FILENAME);
}

/**
 * Write (or overwrite) the FROZEN marker.
 *
 * @param {string} releaseDir - Absolute `.release-skill` directory.
 * @param {object} marker
 * @param {string} marker.planDigest - Digest of the frozen plan.
 * @param {Record<string, string>} marker.targetVersions - unitId -> version.
 * @param {string} marker.createdAt - ISO-8601 timestamp (plan createdAt).
 * @param {string} marker.runId - The prepare run id that froze the plan.
 * @returns {Promise<string>} The marker path written.
 */
export async function writeFrozenMarker(releaseDir, marker) {
  const payload = {
    planDigest: marker.planDigest,
    targetVersions: marker.targetVersions,
    createdAt: marker.createdAt,
    runId: marker.runId,
  };
  const markerPath = frozenMarkerPath(releaseDir);
  await writeFile(markerPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return markerPath;
}

/**
 * Read the FROZEN marker without throwing.
 *
 * @param {string} releaseDir - Absolute `.release-skill` directory.
 * @returns {Promise<object | null>} The marker payload, or null when absent
 *   or unparseable (a corrupt marker is treated as absent).
 */
export async function readFrozenMarker(releaseDir) {
  let raw;
  try {
    raw = await readFile(frozenMarkerPath(releaseDir), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Clear the FROZEN marker.
 *
 * @param {string} releaseDir - Absolute `.release-skill` directory.
 * @returns {Promise<boolean>} true when a marker existed and was removed.
 */
export async function clearFrozenMarker(releaseDir) {
  try {
    await unlink(frozenMarkerPath(releaseDir));
    return true;
  } catch {
    return false;
  }
}
