/**
 * marketplace-registry-entry preset: direct-edit downstream registry entry
 * update (v0.6.3 R4, design §2.5).
 *
 * For downstream marketplaces WITHOUT their own governance/render pipeline:
 * locate the registry entry by config.entryKey inside config.registryPath,
 * update the declared fieldsFromPlan from the FROZEN plan values (§2.3
 * context projection), run the declared downstream gates (argument arrays via
 * the R1 hook runner), then push. Hubs with their own governance use
 * proposal-inbox instead.
 *
 * Registry document shape (canonical, validated fail-closed):
 * { "entries": [ { "key": "<entryKey>", ...fields } ] }
 * - a missing registry file, a missing/malformed `entries` array, or a
 *   missing entry key is REMOTE_CONFLICT: the downstream state disagrees
 *   with the declaration and a human decides (nothing is ever invented);
 * - the updated document is serialized deterministically (2-space indent +
 *   trailing newline): byte-identical output -> NO_CHANGE (idempotent);
 * - every other entry and field is preserved untouched.
 *
 * fieldsFromPlan maps entry field -> §2.3 context field; only frozen plan
 * values are ever written (version/tag/commit/tree/manifestDigest/planDigest/
 * publishedAt/unitId). A source value absent from the frozen plan fails
 * closed before any write.
 *
 * @module core/marketplace-registry-entry
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ReleaseError, GATE_FAILED, REMOTE_CONFLICT } from './errors.mjs';
import { FIELDS_FROM_PLAN_SOURCES } from './presets.mjs';
import { applyDownstreamGitChange } from './preset-gitwrite.mjs';

export { FIELDS_FROM_PLAN_SOURCES };

/**
 * Apply the frozen-plan field update to one registry document. Pure and
 * deterministic: returns the updated document, or throws when the document
 * shape or the entry disagrees with the declaration.
 *
 * @param {object} registry - Parsed registry document.
 * @param {object} params - { entryKey, fieldsFromPlan, contextProjection }.
 * @returns {object} The updated registry document (new object).
 * @throws {ReleaseError} REMOTE_CONFLICT when the entry cannot be located;
 *   GATE_FAILED when a frozen source value is missing.
 */
export function updateRegistryEntry(registry, params) {
  const { entryKey, fieldsFromPlan, contextProjection } = params ?? {};
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) {
    throw new ReleaseError(REMOTE_CONFLICT, 'marketplace registry file is not a JSON object; human decision required', {});
  }
  if (!Array.isArray(registry.entries)) {
    throw new ReleaseError(
      REMOTE_CONFLICT,
      'marketplace registry file carries no "entries" array; the marketplace-registry-entry preset expects { "entries": [ { "key": ... } ] }',
      {},
    );
  }
  const entryIndex = registry.entries.findIndex(
    (entry) => entry && typeof entry === 'object' && !Array.isArray(entry) && entry.key === entryKey,
  );
  if (entryIndex < 0) {
    throw new ReleaseError(
      REMOTE_CONFLICT,
      `marketplace registry entry "${entryKey}" not found; registering a new entry requires a human decision`,
      { entryKey },
    );
  }

  const updated = JSON.parse(JSON.stringify(registry)); // deep, order-stable copy
  const entry = updated.entries[entryIndex];
  for (const [entryField, sourceField] of Object.entries(fieldsFromPlan)) {
    const value = contextProjection?.[sourceField];
    if (typeof value !== 'string' || value.length === 0) {
      throw new ReleaseError(
        GATE_FAILED,
        `fieldsFromPlan."${entryField}" maps to context field "${sourceField}" which the frozen plan does not provide`,
        { entryField, sourceField },
      );
    }
    entry[entryField] = value;
  }
  return updated;
}

/** Deterministic registry serialization (byte-stable NO_CHANGE detection). */
export function serializeRegistry(registry) {
  return `${JSON.stringify(registry, null, 2)}\n`;
}

/**
 * Execute one marketplace-registry-entry preset hook end-to-end: read the
 * downstream registry, apply the frozen-plan update, run the downstream
 * gates, and push (never --force). Shared by distribute and postVerify.
 *
 * @param {object} params
 * @param {object} params.hook - Declared hook entry (config bound).
 * @param {object} params.contextProjection - The §2.3 context projection.
 * @param {object} params.commitIdentity - Frozen commitIdentity.
 * @param {string} params.root - Release workspace root.
 * @param {Function} [params.exec] - Injectable git exec (tests).
 * @param {Function} [params.hookRunner] - Injectable gate runner (tests).
 * @returns {Promise<{ status: string, observation: object, registryPath: string }>}
 */
export async function executeMarketplaceRegistryEntryHook(params) {
  const { hook, contextProjection, commitIdentity, root, exec, hookRunner } = params ?? {};
  const config = hook?.config;
  const target = config?.target;
  if (!target || typeof target.branch !== 'string') {
    throw new ReleaseError(GATE_FAILED, 'marketplace-registry-entry requires config.target with a branch');
  }
  const registryPath = config?.registryPath ?? 'registry.json';
  const entryKey = config?.entryKey;
  const fieldsFromPlan = config?.fieldsFromPlan;
  if (typeof entryKey !== 'string' || entryKey.length === 0) {
    throw new ReleaseError(GATE_FAILED, 'marketplace-registry-entry requires config.entryKey');
  }
  if (!fieldsFromPlan || typeof fieldsFromPlan !== 'object' || Object.keys(fieldsFromPlan).length === 0) {
    throw new ReleaseError(GATE_FAILED, 'marketplace-registry-entry requires a non-empty config.fieldsFromPlan');
  }

  const unitId = contextProjection?.unitId ?? 'unknown';
  const version = contextProjection?.version ?? 'unknown';

  let currentText = null;
  const mutate = async (worktree) => {
    const absoluteRegistry = join(worktree, registryPath);
    let raw;
    try {
      raw = await readFile(absoluteRegistry, 'utf8');
    } catch {
      throw new ReleaseError(
        REMOTE_CONFLICT,
        `marketplace registry file "${registryPath}" is missing in the downstream repository; creating it requires a human decision`,
        { registryPath },
      );
    }
    currentText = raw;
    let registry;
    try {
      registry = JSON.parse(raw);
    } catch {
      throw new ReleaseError(
        REMOTE_CONFLICT,
        `marketplace registry file "${registryPath}" is not valid JSON; human decision required`,
        { registryPath },
      );
    }
    const updated = updateRegistryEntry(registry, { entryKey, fieldsFromPlan, contextProjection });
    const serialized = serializeRegistry(updated);
    if (serialized === currentText) {
      // Leave the file untouched: the staged tree stays equal to the tip and
      // the shared lifecycle reports NO_CHANGE.
      return;
    }
    const { writeFile } = await import('node:fs/promises');
    await writeFile(absoluteRegistry, serialized);
  };

  const result = await applyDownstreamGitChange({
    target,
    commitIdentity,
    commitSubject: `release-skill marketplace-registry-entry ${unitId} ${version} (${entryKey})`,
    mutate,
    gates: config?.gates ?? [],
    contextProjection,
    root,
    ...(exec !== undefined ? { exec } : {}),
    ...(hookRunner !== undefined ? { hookRunner } : {}),
  });
  return { ...result, registryPath };
}
