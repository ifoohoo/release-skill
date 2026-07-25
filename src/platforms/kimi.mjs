/**
 * Kimi Code platform protocol (T2.2 step 2).
 *
 * Kimi Code protocol-gap modeling (BLOCKER-1 / MAJOR-1 / MAJOR-4 / MINOR-1).
 *
 * Kimi Code has NO scriptable plugin install/list CLI: plugin management is
 * interactive-only (`/plugins install <path-or-url>` in the TUI). There is no
 * `kimi plugins ...` subcommand and no `--json` output protocol. Therefore the
 * kimi-marketplace-install action is modeled as a protocol capability gap:
 *
 *   - execute NEVER execs a kimi CLI. It emits an actionable, version-pinned
 *     manual-install requirement bound to the frozen plan digest + identity.
 *   - observe consumes a structured human attestation (written after the
 *     operator runs the interactive install) plus read-only verification of
 *     the installed managed copy. Missing/expired/mismatched/escaping proof
 *     fails closed, so a kimi unit can never reach VERIFIED without it.
 *
 * This module is the kimi half of the platform registry's strategy table
 * (registry.mjs references these functions); the plugin-marketplace adapter
 * consumes the attestation path from here. The shared adapter primitives
 * (safe-id pattern, frozen-timeout validation, atomic evidence writes) live
 * in adapters/contract.mjs.
 *
 * T2.2 step 2 moved this closure verbatim out of plugin-marketplace.mjs:
 * every error message, field name, and file layout is byte-for-byte the
 * legacy behaviour (frozen by platform-golden.test.mjs and the BLOCKER-1
 * suite).
 *
 * @module platforms/kimi
 */

import { readFile, mkdir } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';

import {
  ActionType,
  ActionStatus,
  createResult,
  resolveTimeoutMs,
  SAFE_ID_RE,
  writeEvidenceAtomic,
} from '../adapters/contract.mjs';
import { computePlanDigest } from '../core/plan.mjs';
import { canonicalJson } from '../core/digest.mjs';

/** Structured manual-install requirement written by kimi execute. */
export const KIMI_REQUIREMENT_FILE = 'release-skill-kimi-manual-install.json';
/** Structured human attestation consumed by kimi observe. */
export const KIMI_ATTESTATION_FILE = 'release-skill-kimi-attestation.json';
/** Kimi Code managed install layout: $KIMI_CODE_HOME/plugins/managed/<id>/. */
export const KIMI_MANAGED_SUBPATH = join('plugins', 'managed');
/** Maximum attestation validity window (mirrors the 24h approval expiry). */
export const KIMI_MAX_ATTESTATION_VALIDITY_MS = 24 * 60 * 60 * 1000;

/** 64-char lowercase hex plan/payload digest pattern. */
export const HEX_DIGEST_RE = /^[a-f0-9]{64}$/;

/**
 * Ordered authoritative kimi plugin manifest candidates.
 * `kimi.plugin.json` at the plugin root takes priority over
 * `.kimi-plugin/plugin.json` (official precedence). Single source for both
 * the readManifest strategy and the registry's manifestPaths descriptor.
 */
export const KIMI_MANIFEST_CANDIDATES = Object.freeze([
  'kimi.plugin.json',
  join('.kimi-plugin', 'plugin.json'),
]);

/**
 * Normalize a plan back to its frozen form for digest comparison.
 *
 * Only lifecycle status fields are reset: the top-level `status` returns to
 * "PREPARED" and every `externalActions[].status` returns to "PENDING". Every
 * other field is preserved verbatim. publish/reconcile/verify mutate exactly
 * these status fields in memory as the saga progresses, so normalizing them
 * recovers the frozen digest while leaving all security-relevant fields
 * (baseline, units, action parameters/expected, production config, …) intact.
 *
 * @param {object} plan
 * @returns {object} the lifecycle-normalized plan
 */
function normalizePlanForDigest(plan) {
  const normalized = { ...plan, status: 'PREPARED' };
  if (Array.isArray(plan.externalActions)) {
    normalized.externalActions = plan.externalActions.map((action) => (
      action && typeof action === 'object' && !Array.isArray(action)
        ? { ...action, status: 'PENDING' }
        : action
    ));
  }
  return normalized;
}

/**
 * Resolve and verify the genuine frozen plan digest from the adapter context.
 *
 * The kimi manual-install requirement and attestation bind to the REAL frozen
 * plan digest (`context.plan.digest`) — never to `action.manifestDigest`, which
 * is only the snapshot payload digest.
 *
 * Integrity model: the carried `context.plan.digest` is recomputed from the
 * lifecycle-normalized plan and must match EXACTLY. Status transitions
 * (top-level status, per-action checkpoint status) are normalized away, but any
 * other field tamper changes the recomputed digest and fails closed. This
 * proves the attestation is bound to the genuine frozen plan, not to a spoofed
 * or mutated stand-in.
 *
 * @param {object} context - adapter context (must carry the frozen `plan`).
 * @returns {string} the verified frozen plan digest.
 * @throws {Error} when the plan is absent or the digest does not match.
 */
export function resolveBoundPlanDigest(context) {
  const plan = context?.plan;
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new Error('context.plan is required to bind the kimi plan digest');
  }
  const carried = plan.digest;
  if (typeof carried !== 'string' || !HEX_DIGEST_RE.test(carried)) {
    throw new Error('context.plan.digest must be a 64-char lowercase hex frozen plan digest');
  }
  const normalized = normalizePlanForDigest(plan);
  if (computePlanDigest(normalized) !== carried) {
    throw new Error('context.plan.digest does not match the normalized frozen plan (a non-lifecycle field was tampered)');
  }
  return carried;
}

/**
 * Authoritative, cross-run attestation directory for a kimi install.
 *
 * Lives at a stable root-fixed location keyed by the verified frozen plan
 * digest and plugin id:
 *   <root>/.release-skill/kimi-attestations/<planDigest>/<plugin>/
 *
 * This survives the publish -> manual install -> reconcile -> verify chain,
 * where each command otherwise uses a fresh runDir (an attestation written to a
 * publish runDir would be invisible to reconcile/verify). Both the requirement
 * and the human attestation live here. The segments are pre-validated (planDigest
 * is 64-hex, plugin matches SAFE_ID_RE) and the resolved path is contained
 * within the authority base, so no path escape is possible.
 *
 * @param {object} context - adapter context (needs `root`).
 * @param {string} planDigest - verified frozen plan digest (64-hex).
 * @param {string} plugin - plugin id (SAFE_ID_RE).
 * @returns {string} absolute authority directory.
 */
export function kimiAuthorityDir(context, planDigest, plugin) {
  if (!context?.root) {
    throw new Error('context.root is required for the kimi attestation authority');
  }
  if (!HEX_DIGEST_RE.test(planDigest)) {
    throw new Error('kimi attestation authority requires a 64-hex plan digest');
  }
  if (!SAFE_ID_RE.test(plugin)) {
    throw new Error(`kimi attestation authority requires a safe plugin id: "${plugin}"`);
  }
  const base = resolve(context.root, '.release-skill', 'kimi-attestations');
  const dir = resolve(base, planDigest, plugin);
  const rel = relative(base, dir);
  const sep = process.platform === 'win32' ? '\\' : '/';
  if (
    rel === '' || rel === '..' || isAbsolute(rel) || rel.startsWith(`..${sep}`)
    || rel.split(sep).some((segment) => segment === '..' || segment === '')
  ) {
    throw new Error('kimi attestation authority path escapes its base');
  }
  return dir;
}

/**
 * Build the official, version-pinned install URL for a frozen Git ref.
 *
 * Prefers the GitHub release-tag URL (`/releases/tag/<ref>`), which pins the
 * exact published ref; `/tree/<ref>` is the documented equivalent. A bare
 * repository URL is NOT acceptable because it installs the latest release (or
 * default branch), which need not equal the frozen version.
 *
 * @param {string} repo - owner/repo
 * @param {string} ref - frozen Git ref (tag)
 * @returns {string}
 */
function buildKimiInstallUrl(repo, ref) {
  return `https://github.com/${repo}/releases/tag/${ref}`;
}

/**
 * Human-facing, actionable manual-install closed-loop instructions for Kimi Code.
 *
 * @param {{installUrl:string, plugin:string, version:string, ref:string, isolatedHome:string, attestationDir:string}} p
 * @returns {string[]}
 */
function buildKimiManualInstructions({ installUrl, plugin, version, ref, isolatedHome, attestationDir }) {
  return [
    `Kimi Code has no scriptable plugin-install CLI; installation is a manual, interactive step.`,
    `1) publish fails closed at this kimi checkpoint and leaves the run PARTIAL (the automated Git branch/tag, npm, and GitHub Release writes still complete first).`,
    `2) Launch Kimi Code with the ISOLATED home from this requirement so the managed copy lands inside it: set HOME="${isolatedHome}" and KIMI_CODE_HOME="${isolatedHome}". The plugin installs to "${isolatedHome}/plugins/managed/${plugin}/".`,
    `3) In that isolated Kimi Code session run: /plugins install ${installUrl}  (pinned to frozen ref "${ref}", version ${version}; never install the bare repository URL). Confirm the trust prompt for plugin "${plugin}", then run /plugins reload (or /new).`,
    `4) Write the attestation JSON to: ${attestationDir}/${KIMI_ATTESTATION_FILE}. planDigest MUST be the frozen plan digest; payloadDigest MUST be the frozen snapshot payload digest; installPath MUST be the isolated managed directory above. attestedAt must not be in the future and expiresAt must be within 24 hours of attestedAt.`,
    `   Required fields: consumer="kimi", plugin, version, entrySkill, repo, ref, installPath, planDigest, payloadDigest, attestedBy, attestedAt, expiresAt.`,
    `5) Re-run release-skill reconcile (promotes PARTIAL -> PUBLISHED) and then verify (-> VERIFIED). Both read the attestation from this same plan-digest-keyed authority directory, so a fresh run directory does not lose the proof.`,
    `An install into the ordinary ~/.kimi-code is NOT acceptable proof: the attested installPath must resolve inside this requirement's isolated KIMI_CODE_HOME managed root, otherwise verification fails closed.`,
  ];
}

/**
 * Read the authoritative Kimi plugin manifest from a verified plugin root.
 *
 * `kimi.plugin.json` at the root takes priority over `.kimi-plugin/plugin.json`
 * when both exist (official precedence). Returns the parsed manifest and the
 * root-relative manifest path. Throws when no valid manifest is present.
 *
 * @param {string} pluginRootReal - realpath of the verified plugin root.
 * @returns {Promise<{manifest:object, manifestRelative:string}>}
 */
export async function readKimiManifest(pluginRootReal) {
  for (const manifestRelative of KIMI_MANIFEST_CANDIDATES) {
    const manifestPath = resolve(pluginRootReal, manifestRelative);
    let content;
    try {
      content = await readFile(manifestPath, 'utf8');
    } catch {
      continue;
    }
    let manifest;
    try {
      manifest = JSON.parse(content);
    } catch {
      throw new Error(`kimi plugin manifest ${manifestRelative} is not valid JSON`);
    }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      throw new Error(`kimi plugin manifest ${manifestRelative} is not an object`);
    }
    return { manifest, manifestRelative };
  }
  throw new Error('no kimi plugin manifest found (expected kimi.plugin.json or .kimi-plugin/plugin.json)');
}

/**
 * Validate a structured kimi manual-install attestation against the frozen
 * action and the verified frozen plan digest.
 *
 * Bindings (fail closed on any mismatch):
 * - `planDigest` binds to the REAL frozen plan digest (`boundPlanDigest`, from
 *   `context.plan.digest`) — NOT to `action.manifestDigest`.
 * - `payloadDigest` binds separately to `action.manifestDigest` (the sealed
 *   snapshot payload digest).
 * - plugin identity, version, entry skill, repo, and frozen ref must match.
 * - Time bounds: `attestedAt` must not be in the future, the validity window
 *   (`expiresAt - attestedAt`) must not exceed 24h, and the attestation must
 *   not be expired relative to `isoNow`.
 *
 * @param {object} attestation - parsed attestation JSON.
 * @param {object} action - the expanded kimi action (top-level fields).
 * @param {string} isoNow - current ISO timestamp.
 * @param {string} boundPlanDigest - verified frozen plan digest.
 * @returns {{valid:boolean, error:string|null}}
 */
export function validateKimiAttestation(attestation, action, isoNow, boundPlanDigest) {
  if (!attestation || typeof attestation !== 'object' || Array.isArray(attestation)) {
    return { valid: false, error: 'kimi attestation is not an object' };
  }
  const requiredStrings = ['plugin', 'version', 'entrySkill', 'repo', 'ref', 'installPath', 'payloadDigest', 'planDigest', 'attestedBy', 'attestedAt', 'expiresAt'];
  for (const field of requiredStrings) {
    if (typeof attestation[field] !== 'string' || attestation[field].length === 0) {
      return { valid: false, error: `kimi attestation missing required field "${field}"` };
    }
  }
  if (attestation.consumer !== 'kimi') {
    return { valid: false, error: `kimi attestation consumer "${attestation.consumer}" must be "kimi"` };
  }
  if (!HEX_DIGEST_RE.test(attestation.planDigest)) {
    return { valid: false, error: 'kimi attestation planDigest must be a 64-char lowercase hex digest' };
  }
  if (attestation.planDigest !== boundPlanDigest) {
    return { valid: false, error: 'kimi attestation planDigest does not match the frozen plan digest' };
  }
  if (attestation.plugin !== action.plugin) {
    return { valid: false, error: `kimi attestation plugin "${attestation.plugin}" does not match action plugin "${action.plugin}"` };
  }
  if (attestation.version !== action.version) {
    return { valid: false, error: `kimi attestation version "${attestation.version}" does not match action version "${action.version}"` };
  }
  if (attestation.entrySkill !== action.entrySkill) {
    return { valid: false, error: `kimi attestation entrySkill "${attestation.entrySkill}" does not match action entrySkill "${action.entrySkill}"` };
  }
  if (attestation.repo !== action.repo) {
    return { valid: false, error: `kimi attestation repo "${attestation.repo}" does not match action repo "${action.repo}"` };
  }
  const expectedRef = action.ref ?? `v${action.version}`;
  if (attestation.ref !== expectedRef) {
    return { valid: false, error: `kimi attestation ref "${attestation.ref}" does not match frozen ref "${expectedRef}"` };
  }
  if (attestation.payloadDigest !== action.manifestDigest) {
    return { valid: false, error: 'kimi attestation payloadDigest does not match the frozen payload digest' };
  }
  const attestedMs = Date.parse(attestation.attestedAt);
  const expiresMs = Date.parse(attestation.expiresAt);
  const nowMs = Date.parse(isoNow);
  if (!Number.isFinite(attestedMs) || !Number.isFinite(expiresMs) || !Number.isFinite(nowMs)) {
    return { valid: false, error: 'kimi attestation attestedAt/expiresAt must be valid ISO timestamps' };
  }
  if (attestedMs > nowMs) {
    return { valid: false, error: 'kimi attestation attestedAt is in the future' };
  }
  if (expiresMs <= attestedMs) {
    return { valid: false, error: 'kimi attestation expiresAt must be after attestedAt' };
  }
  if (expiresMs - attestedMs > KIMI_MAX_ATTESTATION_VALIDITY_MS) {
    return { valid: false, error: 'kimi attestation validity must not exceed 24 hours' };
  }
  if (nowMs > expiresMs) {
    return { valid: false, error: 'kimi attestation has expired' };
  }
  return { valid: true, error: null };
}

/**
 * Kimi Code protocol capability gap (BLOCKER-1): there is NO scriptable
 * `kimi plugins install/list` CLI and no `--json` protocol. execute NEVER execs
 * a kimi command. Instead it emits an actionable, version-pinned manual-install
 * requirement bound to the real frozen plan digest + identity, and leaves
 * success to observe, which consumes only a trusted human attestation plus
 * read-only verification. Without that proof the checkpoint fails closed and can
 * never reach VERIFIED.
 *
 * Isolation model (B/C): the kimi home is a STABLE, plan-digest-keyed directory
 * under the attestation authority (`<authorityDir>/kimi-home`), not the per-run
 * runDir consumer dir. The operator launches Kimi Code with that KIMI_CODE_HOME
 * so the managed copy lands at `<kimiHome>/plugins/managed/<plugin>/`, a
 * location that is identical across publish/reconcile/verify run dirs. execute
 * creates ONLY the managed parent (`plugins/managed`), never `managed/<plugin>`
 * (the operator's interactive install creates that). The requirement write is
 * idempotent: an identical existing requirement is left untouched, a divergent
 * one fails closed.
 *
 * Referenced from the registry as the kimi strategy.buildManualRequirement —
 * the automatable=false manual-requirement path.
 *
 * @param {object} action - expanded kimi action (validated params already).
 * @param {object} context - adapter context (root, runDir, plan).
 * @returns {Promise<import('../adapters/contract.mjs').AdapterResult>}
 */
export async function executeKimiManualRequirement(action, context) {
  const actionType = ActionType.KIMI_MARKETPLACE_INSTALL;

  // (A) Bind to the REAL frozen plan digest via strict normalized recompute.
  let planDigest;
  try {
    planDigest = resolveBoundPlanDigest(context);
  } catch (planErr) {
    return createResult({
      actionType,
      status: ActionStatus.EXECUTE_FAILED,
      error: `cannot bind kimi requirement to the frozen plan: ${planErr.message}`,
    });
  }

  // Validate the frozen timeout. Kimi execs no CLI, but the frozen-timeout
  // fail-closed invariant still holds for every marketplace action.
  try {
    resolveTimeoutMs(action);
  } catch (timeoutErr) {
    return createResult({
      actionType,
      status: ActionStatus.EXECUTE_FAILED,
      error: timeoutErr.message,
    });
  }

  const ref = action.ref ?? `v${action.version}`;
  const installUrl = buildKimiInstallUrl(action.repo, ref);

  // (B) Stable, plan-digest-keyed authority dir — the ONLY kimi home, shared
  // across publish/reconcile/verify run dirs.
  let attestationDir;
  try {
    attestationDir = kimiAuthorityDir(context, planDigest, action.plugin);
  } catch (dirErr) {
    return createResult({
      actionType,
      status: ActionStatus.EXECUTE_FAILED,
      error: dirErr.message,
    });
  }
  const kimiHome = resolve(attestationDir, 'kimi-home');
  const managedParent = resolve(kimiHome, KIMI_MANAGED_SUBPATH); // plugins/managed
  // plugins/managed/<plugin> — created by the operator's interactive install.
  const managedInstallRoot = resolve(managedParent, action.plugin);

  const instructions = buildKimiManualInstructions({
    installUrl,
    plugin: action.plugin,
    version: action.version,
    ref,
    isolatedHome: kimiHome,
    attestationDir,
  });

  const requirement = {
    kind: 'kimi-manual-install-requirement',
    consumer: 'kimi',
    plugin: action.plugin,
    version: action.version,
    entrySkill: action.entrySkill,
    repo: action.repo,
    ref,
    installUrl,
    // (A) planDigest binds to the real frozen plan digest;
    // expectedPayloadDigest binds separately to the snapshot payload digest.
    planDigest,
    expectedPayloadDigest: action.manifestDigest,
    isolatedHome: kimiHome,
    kimiCodeHome: kimiHome,
    managedInstallRoot,
    attestationDir,
    attestationFile: KIMI_ATTESTATION_FILE,
    attestationTemplate: {
      consumer: 'kimi',
      plugin: action.plugin,
      version: action.version,
      entrySkill: action.entrySkill,
      repo: action.repo,
      ref,
      installPath: managedInstallRoot,
      planDigest,
      payloadDigest: action.manifestDigest,
      attestedBy: '<person responsible for the manual install>',
      attestedAt: '<ISO 8601 now; must not be in the future>',
      expiresAt: '<ISO 8601; within 24h of attestedAt>',
    },
    instructions,
  };

  // Create ONLY the managed parent (plugins/managed); never pre-create
  // managed/<plugin> — the operator's interactive install creates that.
  try {
    await mkdir(managedParent, { recursive: true, mode: 0o700 });
  } catch (mkdirErr) {
    return createResult({
      actionType,
      status: ActionStatus.EXECUTE_FAILED,
      error: `cannot create kimi managed parent directory: ${mkdirErr.message}`,
    });
  }

  // Idempotent requirement write: an identical existing requirement is left
  // untouched; a divergent existing requirement fails closed (never silently
  // overwritten). `createdAt` is volatile and excluded from the comparison.
  const requirementPath = resolve(attestationDir, KIMI_REQUIREMENT_FILE);
  let existing = null;
  let requirementMissing = false;
  try {
    const existingRaw = await readFile(requirementPath, 'utf8');
    try {
      existing = JSON.parse(existingRaw);
    } catch (parseErr) {
      return createResult({
        actionType,
        status: ActionStatus.EXECUTE_FAILED,
        error: `existing kimi manual-install requirement is invalid JSON; refusing to overwrite: ${parseErr.message}`,
      });
    }
  } catch (readErr) {
    if (readErr?.code === 'ENOENT') {
      requirementMissing = true;
    } else {
      return createResult({
        actionType,
        status: ActionStatus.EXECUTE_FAILED,
        error: `existing kimi manual-install requirement cannot be read; refusing to overwrite: ${readErr.message}`,
      });
    }
  }
  if (!requirementMissing) {
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      return createResult({
        actionType,
        status: ActionStatus.EXECUTE_FAILED,
        error: 'existing kimi manual-install requirement is not an object; refusing to overwrite',
      });
    }
    const { createdAt: _existingCreatedAt, ...existingBody } = existing;
    if (canonicalJson(existingBody) !== canonicalJson(requirement)) {
      return createResult({
        actionType,
        status: ActionStatus.EXECUTE_FAILED,
        error: 'existing kimi manual-install requirement conflicts with the current frozen action; refusing to overwrite',
      });
    }
  } else {
    await writeEvidenceAtomic(requirementPath, { ...requirement, createdAt: new Date().toISOString() });
  }

  return createResult({
    actionType,
    status: ActionStatus.EXECUTED,
    observation: {
      installed: false,
      manualInstallRequired: true,
      consumer: 'kimi',
      plugin: action.plugin,
      version: action.version,
      entrySkill: action.entrySkill,
      repo: action.repo,
      ref,
      installUrl,
      planDigest,
      attestationDir,
      kimiCodeHome: kimiHome,
      managedInstallRoot,
      instructions,
    },
  });
}
