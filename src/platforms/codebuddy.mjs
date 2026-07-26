/**
 * CodeBuddy / WorkBuddy platform protocol (human attestation closed loop).
 *
 * CodeBuddy (desktop product WorkBuddy) ships a `codebuddy` CLI that is
 * structurally identical to claude-code, BUT its plugin install protocol cannot
 * pin a frozen ref: `plugin marketplace add <source>` and `plugin install
 * <plugin[@marketplace]>` have NO ref option, and the install tracks the
 * marketplace default branch / latest (verified against the real CLI and its
 * on-disk state model). An automated install checkpoint therefore cannot
 * guarantee the frozen artifact's identity, which this project's security model
 * requires. The install state DOES have a stable on-disk layout that serves as
 * verification evidence.
 *
 * So codebuddy-marketplace-install is modeled exactly like kimi's protocol
 * capability gap (a human attestation closed loop), with two differences driven
 * by the verified CodeBuddy state model:
 *
 *   - Install is from a unified marketplace (`artifact-skill-set`,
 *     https://github.com/ifoohoo/artifact-skill-set), NOT a release-tag URL.
 *   - Two install channels are accepted, both evidenced on disk:
 *       desktop: the WorkBuddy desktop app installs into
 *                `~/.workbuddy/plugins/marketplaces/<marketplace>/plugins/<plugin>/`
 *       cli:     the bundled `codebuddy` CLI, run with an isolated
 *                `HOME=<codebuddyHome>`, installs into
 *                `<codebuddyHome>/.codebuddy/plugins/marketplaces/<marketplace>/plugins/<plugin>/`
 *     The attestation names the channel (`installChannel`) and the marketplace;
 *     the install path is validated per channel and fails closed otherwise.
 *
 *   - execute NEVER execs the codebuddy CLI. It emits an actionable manual
 *     install requirement bound to the frozen plan digest + identity.
 *   - observe/verify consume a structured human attestation plus read-only
 *     verification of the installed copy. Missing/expired/mismatched/escaping
 *     proof fails closed, so a codebuddy unit can never reach VERIFIED without
 *     it — the same fail-closed severity as kimi ("post-publish verification
 *     cannot be waived").
 *
 * This module is the codebuddy half of the platform registry's strategy table
 * (registry.mjs references executeCodeBuddyManualRequirement /
 * readCodeBuddyManifest); the plugin-marketplace adapter consumes the
 * attestation path from here through a codebuddy-specific branch that mirrors
 * the kimi branch. The shared adapter primitives (safe-id pattern,
 * frozen-timeout validation, atomic evidence writes) live in
 * adapters/contract.mjs.
 *
 * NOTE on intentional duplication: the 64-hex digest pattern and the
 * lifecycle plan normalization below mirror kimi.mjs's pure helpers instead of
 * importing them. Importing from ./kimi.mjs would add a codebuddy -> kimi edge
 * that, combined with the kimi -> plan -> registry -> kimi cycle, deadlocks the
 * esbuild-generated module initializers in the self-contained bundle (the
 * `prepare` dynamic import never settles). Inlining these two tiny pure
 * functions keeps codebuddy's only cycle edge codebuddy -> plan -> registry
 * (the same shape kimi already ships with) and the bundle evaluating cleanly.
 *
 * @module platforms/codebuddy
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
import { canonicalJson } from '../core/digest.mjs';
// NOTE: computePlanDigest (../core/plan.mjs) is imported LAZILY inside
// resolveCodeBuddyBoundPlanDigest, NOT statically here. A static import would
// add a registry -> codebuddy -> plan -> registry cycle edge; combined with the
// existing kimi -> plan -> registry -> kimi cycle, that deadlocks esbuild's
// generated module initializers in the self-contained bundle (the `prepare`
// dynamic import never settles). kimi.mjs predates this constraint; codebuddy
// keeps the bundle graph acyclic by loading plan.mjs at call time (by then
// every module is initialized, so the lazy import resolves immediately).

/** 64-char lowercase hex plan/payload digest pattern (mirrors kimi.mjs). */
const HEX_DIGEST_RE = /^[a-f0-9]{64}$/;

/**
 * Normalize a plan back to its frozen form for digest comparison (mirrors the
 * pure helper in kimi.mjs; inlined here to avoid a codebuddy -> kimi import
 * edge — see the module note). Only lifecycle status fields are reset: the
 * top-level `status` returns to "PREPARED" and every `externalActions[].status`
 * returns to "PENDING"; every other field is preserved verbatim.
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

/** Structured manual-install requirement written by codebuddy execute. */
export const CODEBUDDY_REQUIREMENT_FILE = 'release-skill-codebuddy-manual-install.json';
/** Structured human attestation consumed by codebuddy observe/verify. */
export const CODEBUDDY_ATTESTATION_FILE = 'release-skill-codebuddy-attestation.json';
/** Maximum attestation validity window (mirrors the 24h approval expiry). */
export const CODEBUDDY_MAX_ATTESTATION_VALIDITY_MS = 24 * 60 * 60 * 1000;

/**
 * Unified marketplace the WorkBuddy desktop app and the codebuddy CLI install
 * release-skill from (verified fact). The attestation `marketplace` field must
 * equal this value; the install path is validated against this marketplace
 * segment in both channels.
 */
export const CODEBUDDY_MARKETPLACE_NAME = 'artifact-skill-set';
/** Marketplace source URL used by the isolated-CLI install path. */
export const CODEBUDDY_MARKETPLACE_SOURCE = 'https://github.com/ifoohoo/artifact-skill-set';

/** Authoritative codebuddy plugin manifest (single candidate, no precedence). */
export const CODEBUDDY_PLUGIN_MANIFEST_RELATIVE = join('.codebuddy-plugin', 'plugin.json');

/** The only two install channels with verified on-disk evidence. */
const CODEBUDDY_INSTALL_CHANNELS = new Set(['desktop', 'cli']);

/** Well-known desktop install root (the WorkBuddy app's home dir name). */
const CODEBUDDY_DESKTOP_HOME_DIR = '.workbuddy';
/** CLI-side plugin state dir under the isolated HOME. */
const CODEBUDDY_CLI_STATE_DIR = '.codebuddy';

/**
 * Resolve and verify the genuine frozen plan digest from the adapter context,
 * for the codebuddy closed loop.
 *
 * Mirrors kimi's resolveBoundPlanDigest byte-for-byte in LOGIC (it reuses the
 * same pure `normalizePlanForDigest`), but speaks in codebuddy terms so the
 * codebuddy requirement/attestation error messages are codebuddy-worded. The
 * carried `context.plan.digest` is recomputed from the lifecycle-normalized
 * plan and must match exactly; any non-lifecycle tamper fails closed.
 *
 * @param {object} context - adapter context (must carry the frozen `plan`).
 * @returns {Promise<string>} the verified frozen plan digest.
 * @throws {Error} when the plan is absent or the digest does not match.
 */
export async function resolveCodeBuddyBoundPlanDigest(context) {
  const plan = context?.plan;
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new Error('context.plan is required to bind the codebuddy plan digest');
  }
  const carried = plan.digest;
  if (typeof carried !== 'string' || !HEX_DIGEST_RE.test(carried)) {
    throw new Error('context.plan.digest must be a 64-char lowercase hex frozen plan digest');
  }
  // Lazy import keeps the static bundle graph acyclic (see module note).
  const { computePlanDigest } = await import('../core/plan.mjs');
  const normalized = normalizePlanForDigest(plan);
  if (computePlanDigest(normalized) !== carried) {
    throw new Error('context.plan.digest does not match the normalized frozen plan (a non-lifecycle field was tampered)');
  }
  return carried;
}

/**
 * Authoritative, cross-run attestation directory for a codebuddy install.
 *
 * Lives at a stable root-fixed location keyed by the verified frozen plan
 * digest and plugin id:
 *   <root>/.release-skill/codebuddy-attestations/<planDigest>/<plugin>/
 *
 * This survives the publish -> manual install -> reconcile -> verify chain,
 * where each command otherwise uses a fresh runDir. Both the requirement and
 * the human attestation live here. Segments are pre-validated (planDigest is
 * 64-hex, plugin matches SAFE_ID_RE) and the resolved path is contained within
 * the authority base, so no path escape is possible. (Path-escape validation is
 * copied verbatim from kimiAuthorityDir, with codebuddy wording.)
 *
 * @param {object} context - adapter context (needs `root`).
 * @param {string} planDigest - verified frozen plan digest (64-hex).
 * @param {string} plugin - plugin id (SAFE_ID_RE).
 * @returns {string} absolute authority directory.
 */
export function codebuddyAuthorityDir(context, planDigest, plugin) {
  if (!context?.root) {
    throw new Error('context.root is required for the codebuddy attestation authority');
  }
  if (!HEX_DIGEST_RE.test(planDigest)) {
    throw new Error('codebuddy attestation authority requires a 64-hex plan digest');
  }
  if (!SAFE_ID_RE.test(plugin)) {
    throw new Error(`codebuddy attestation authority requires a safe plugin id: "${plugin}"`);
  }
  const base = resolve(context.root, '.release-skill', 'codebuddy-attestations');
  const dir = resolve(base, planDigest, plugin);
  const rel = relative(base, dir);
  const sep = process.platform === 'win32' ? '\\' : '/';
  if (
    rel === '' || rel === '..' || isAbsolute(rel) || rel.startsWith(`..${sep}`)
    || rel.split(sep).some((segment) => segment === '..' || segment === '')
  ) {
    throw new Error('codebuddy attestation authority path escapes its base');
  }
  return dir;
}

/**
 * The isolated CodeBuddy CLI HOME for the cli install channel. The operator
 * runs the bundled `codebuddy` CLI with `HOME=<codebuddyHome>` so the managed
 * marketplace clone lands inside the plan-digest-keyed authority rather than
 * the user's real `~/.codebuddy`. Identical across publish/reconcile/verify
 * run dirs because it derives from the authority dir.
 *
 * @param {string} attestationDir - plan-digest-keyed authority dir.
 * @returns {string}
 */
export function codebuddyCliHome(attestationDir) {
  return resolve(attestationDir, 'codebuddy-home');
}

/**
 * The expected CLI-channel install root for a plugin under an isolated home.
 * `<codebuddyHome>/.codebuddy/plugins/marketplaces/<marketplace>/plugins/<plugin>`
 *
 * @param {string} cliHome - isolated codebuddy HOME.
 * @param {string} marketplace - marketplace name.
 * @param {string} plugin - plugin id.
 * @returns {string}
 */
export function codebuddyCliInstallRoot(cliHome, marketplace, plugin) {
  return resolve(cliHome, CODEBUDDY_CLI_STATE_DIR, 'plugins', 'marketplaces', marketplace, 'plugins', plugin);
}

/**
 * Segment-level tail an attested desktop installPath must end with:
 * `/.workbuddy/plugins/marketplaces/<marketplace>/plugins/<plugin>`
 * (verified WorkBuddy desktop layout).
 *
 * @param {string} marketplace
 * @param {string} plugin
 * @returns {string[]}
 */
function codebuddyDesktopTailSegments(marketplace, plugin) {
  return [CODEBUDDY_DESKTOP_HOME_DIR, 'plugins', 'marketplaces', marketplace, 'plugins', plugin];
}

/**
 * Segment-level tail an attested cli installPath must end with:
 * `/.codebuddy/plugins/marketplaces/<marketplace>/plugins/<plugin>`
 * (verified CodeBuddy CLI layout).
 *
 * @param {string} marketplace
 * @param {string} plugin
 * @returns {string[]}
 */
function codebuddyCliTailSegments(marketplace, plugin) {
  return [CODEBUDDY_CLI_STATE_DIR, 'plugins', 'marketplaces', marketplace, 'plugins', plugin];
}

/**
 * Segment-level check that a desktop installPath ends with the well-known
 * WorkBuddy marketplace layout. Pure string check (no filesystem): the path's
 * segments (split on `/` or `\`, dropping empty/`.` segments) must end with the
 * desktop tail. Fails closed otherwise.
 *
 * @param {string} installPath
 * @param {string} marketplace
 * @param {string} plugin
 * @returns {boolean}
 */
function matchesDesktopLayout(installPath, marketplace, plugin) {
  const segments = installPath.split(/[\\/]+/).filter((s) => s !== '' && s !== '.');
  const tail = codebuddyDesktopTailSegments(marketplace, plugin);
  if (segments.length < tail.length) return false;
  const offset = segments.length - tail.length;
  return tail.every((segment, index) => segments[offset + index] === segment);
}

/**
 * Segment-level check that a cli installPath ends with the well-known
 * CodeBuddy CLI marketplace layout. Pure string check (no filesystem): the
 * path's segments (split on `/` or `\`, dropping empty/`.` segments) must end
 * with the cli tail. Fails closed otherwise.
 *
 * @param {string} installPath
 * @param {string} marketplace
 * @param {string} plugin
 * @returns {boolean}
 */
function matchesCliLayout(installPath, marketplace, plugin) {
  const segments = installPath.split(/[\\/]+/).filter((s) => s !== '' && s !== '.');
  const tail = codebuddyCliTailSegments(marketplace, plugin);
  if (segments.length < tail.length) return false;
  const offset = segments.length - tail.length;
  return tail.every((segment, index) => segments[offset + index] === segment);
}

/**
 * Human-facing, actionable manual-install closed-loop instructions for
 * CodeBuddy / WorkBuddy.
 *
 * @param {{plugin:string, version:string, ref:string, cliHome:string, attestationDir:string}} p
 * @returns {string[]}
 */
function buildCodeBuddyManualInstructions({ plugin, version, ref, cliHome, attestationDir }) {
  const cliInstallRoot = codebuddyCliInstallRoot(cliHome, CODEBUDDY_MARKETPLACE_NAME, plugin);
  const desktopInstallRoot = `~/${CODEBUDDY_DESKTOP_HOME_DIR}/plugins/marketplaces/${CODEBUDDY_MARKETPLACE_NAME}/plugins/${plugin}`;
  return [
    `CodeBuddy/WorkBuddy plugin install cannot pin a frozen ref (the codebuddy CLI marketplace add/install have no ref option and track the default branch), so installation is a manual step proven by a human attestation.`,
    `1) publish fails closed at this codebuddy checkpoint and leaves the run PARTIAL (the automated Git branch/tag, npm, and GitHub Release writes still complete first).`,
    `2) PRIMARY PATH (WorkBuddy desktop): install release-skill from the unified marketplace "${CODEBUDDY_MARKETPLACE_NAME}" (${CODEBUDDY_MARKETPLACE_SOURCE}). Confirm "~/.workbuddy/settings.json" enabledPlugins contains "${plugin}@${CODEBUDDY_MARKETPLACE_NAME}": true. The plugin lands at "${desktopInstallRoot}/".`,
    `3) ALTERNATE PATH (bundled codebuddy CLI, isolatable): run the CLI with the ISOLATED home from this requirement so the clone lands inside it: HOME="${cliHome}" <codebuddy binary> plugin marketplace add ${CODEBUDDY_MARKETPLACE_SOURCE} ; then HOME="${cliHome}" <codebuddy binary> plugin install ${plugin}@${CODEBUDDY_MARKETPLACE_NAME}. The CLI ships with WorkBuddy.app (macOS known path /Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy). The plugin lands at "${cliInstallRoot}/".`,
    `4) REF LIMITATION WARNING: a codebuddy install tracks the marketplace default branch and CANNOT be pinned to frozen ref "${ref}". Before writing the attestation you MUST confirm the installed plugin manifest version equals the frozen version ${version}; otherwise do NOT issue an attestation.`,
    `5) Write the attestation JSON to: ${attestationDir}/${CODEBUDDY_ATTESTATION_FILE}. planDigest MUST be the frozen plan digest; payloadDigest MUST be the frozen snapshot payload digest; installChannel MUST be "desktop" or "cli"; marketplace MUST be "${CODEBUDDY_MARKETPLACE_NAME}"; installPath MUST be the actual installed plugin directory for the chosen channel. attestedAt must not be in the future and expiresAt must be within 24 hours of attestedAt.`,
    `   Required fields: consumer="codebuddy", plugin, version, entrySkill, repo, ref, marketplace, installChannel, installPath, planDigest, payloadDigest, attestedBy, attestedAt, expiresAt.`,
    `6) Re-run release-skill reconcile (promotes PARTIAL -> PUBLISHED) and then verify (-> VERIFIED). Both read the attestation from this same plan-digest-keyed authority directory, so a fresh run directory does not lose the proof.`,
  ];
}

/**
 * Read the authoritative CodeBuddy plugin manifest from a verified plugin root.
 *
 * Single candidate `.codebuddy-plugin/plugin.json` (no precedence chain, unlike
 * kimi). Returns the parsed manifest and the root-relative manifest path.
 * Throws when the manifest is absent, not valid JSON, or not an object.
 *
 * @param {string} pluginRootReal - realpath of the verified plugin root.
 * @returns {Promise<{manifest:object, manifestRelative:string}>}
 */
export async function readCodeBuddyManifest(pluginRootReal) {
  const manifestRelative = CODEBUDDY_PLUGIN_MANIFEST_RELATIVE;
  const manifestPath = resolve(pluginRootReal, manifestRelative);
  let content;
  try {
    content = await readFile(manifestPath, 'utf8');
  } catch {
    throw new Error(`no codebuddy plugin manifest found (expected ${manifestRelative})`);
  }
  let manifest;
  try {
    manifest = JSON.parse(content);
  } catch {
    throw new Error(`codebuddy plugin manifest ${manifestRelative} is not valid JSON`);
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`codebuddy plugin manifest ${manifestRelative} is not an object`);
  }
  return { manifest, manifestRelative };
}

/**
 * Validate a structured codebuddy manual-install attestation against the frozen
 * action and the verified frozen plan digest.
 *
 * Bindings (fail closed on any mismatch):
 * - `consumer` must be "codebuddy".
 * - `installChannel` must be "desktop" or "cli".
 * - `marketplace` must equal the requirement-declared unified marketplace
 *   (`artifact-skill-set`).
 * - `planDigest` binds to the REAL frozen plan digest (`boundPlanDigest`, from
 *   `context.plan.digest`) — NOT to `action.manifestDigest`.
 * - `payloadDigest` binds separately to `action.manifestDigest`.
 * - plugin identity, version, entry skill, repo, and frozen ref must match.
 * - Time bounds: `attestedAt` not in the future, window (`expiresAt -
 *   attestedAt`) <= 24h, and not expired relative to `isoNow`.
 * - installPath per channel (lexical): desktop must end with the well-known
 *   `/.workbuddy/plugins/marketplaces/<marketplace>/plugins/<plugin>` segment
 *   tail. The cli channel's containment within the isolated home is enforced in
 *   the adapter observe branch (it needs the context-derived isolated home and
 *   realpath resolution, mirroring kimi's observe-side managed-root check).
 *
 * @param {object} attestation - parsed attestation JSON.
 * @param {object} action - the expanded codebuddy action (top-level fields).
 * @param {string} isoNow - current ISO timestamp.
 * @param {string} boundPlanDigest - verified frozen plan digest.
 * @returns {{valid:boolean, error:string|null}}
 */
export function validateCodeBuddyAttestation(attestation, action, isoNow, boundPlanDigest) {
  if (!attestation || typeof attestation !== 'object' || Array.isArray(attestation)) {
    return { valid: false, error: 'codebuddy attestation is not an object' };
  }
  const requiredStrings = ['plugin', 'version', 'entrySkill', 'repo', 'ref', 'installPath', 'payloadDigest', 'planDigest', 'attestedBy', 'attestedAt', 'expiresAt', 'marketplace', 'installChannel'];
  for (const field of requiredStrings) {
    if (typeof attestation[field] !== 'string' || attestation[field].length === 0) {
      return { valid: false, error: `codebuddy attestation missing required field "${field}"` };
    }
  }
  if (attestation.consumer !== 'codebuddy') {
    return { valid: false, error: `codebuddy attestation consumer "${attestation.consumer}" must be "codebuddy"` };
  }
  if (!CODEBUDDY_INSTALL_CHANNELS.has(attestation.installChannel)) {
    return { valid: false, error: `codebuddy attestation installChannel "${attestation.installChannel}" must be "desktop" or "cli"` };
  }
  if (attestation.marketplace !== CODEBUDDY_MARKETPLACE_NAME) {
    return { valid: false, error: `codebuddy attestation marketplace "${attestation.marketplace}" must be "${CODEBUDDY_MARKETPLACE_NAME}"` };
  }
  if (!HEX_DIGEST_RE.test(attestation.planDigest)) {
    return { valid: false, error: 'codebuddy attestation planDigest must be a 64-char lowercase hex digest' };
  }
  if (attestation.planDigest !== boundPlanDigest) {
    return { valid: false, error: 'codebuddy attestation planDigest does not match the frozen plan digest' };
  }
  if (attestation.plugin !== action.plugin) {
    return { valid: false, error: `codebuddy attestation plugin "${attestation.plugin}" does not match action plugin "${action.plugin}"` };
  }
  if (attestation.version !== action.version) {
    return { valid: false, error: `codebuddy attestation version "${attestation.version}" does not match action version "${action.version}"` };
  }
  if (attestation.entrySkill !== action.entrySkill) {
    return { valid: false, error: `codebuddy attestation entrySkill "${attestation.entrySkill}" does not match action entrySkill "${action.entrySkill}"` };
  }
  if (attestation.repo !== action.repo) {
    return { valid: false, error: `codebuddy attestation repo "${attestation.repo}" does not match action repo "${action.repo}"` };
  }
  const expectedRef = action.ref ?? `v${action.version}`;
  if (attestation.ref !== expectedRef) {
    return { valid: false, error: `codebuddy attestation ref "${attestation.ref}" does not match frozen ref "${expectedRef}"` };
  }
  if (attestation.payloadDigest !== action.manifestDigest) {
    return { valid: false, error: 'codebuddy attestation payloadDigest does not match the frozen payload digest' };
  }
  const attestedMs = Date.parse(attestation.attestedAt);
  const expiresMs = Date.parse(attestation.expiresAt);
  const nowMs = Date.parse(isoNow);
  if (!Number.isFinite(attestedMs) || !Number.isFinite(expiresMs) || !Number.isFinite(nowMs)) {
    return { valid: false, error: 'codebuddy attestation attestedAt/expiresAt must be valid ISO timestamps' };
  }
  if (attestedMs > nowMs) {
    return { valid: false, error: 'codebuddy attestation attestedAt is in the future' };
  }
  if (expiresMs <= attestedMs) {
    return { valid: false, error: 'codebuddy attestation expiresAt must be after attestedAt' };
  }
  if (expiresMs - attestedMs > CODEBUDDY_MAX_ATTESTATION_VALIDITY_MS) {
    return { valid: false, error: 'codebuddy attestation validity must not exceed 24 hours' };
  }
  if (nowMs > expiresMs) {
    return { valid: false, error: 'codebuddy attestation has expired' };
  }
  // Desktop installPath must end with the well-known WorkBuddy marketplace
  // layout (segment-level). The cli channel's isolated-home containment is
  // enforced in the adapter observe branch (needs the context-derived isolated
  // home + realpath), mirroring kimi's observe-side managed-root check.
  if (attestation.installChannel === 'desktop'
      && !matchesDesktopLayout(attestation.installPath, attestation.marketplace, attestation.plugin)) {
    return { valid: false, error: `codebuddy attestation installPath does not match the WorkBuddy desktop marketplace layout (.workbuddy/plugins/marketplaces/${attestation.marketplace}/plugins/${attestation.plugin})` };
  }
  // CLI installPath must end with the well-known CodeBuddy CLI marketplace
  // layout (segment-level). This is a lexical check; the full realpath
  // containment within the isolated home is enforced in the adapter observe
  // branch (needs the context-derived isolated home + realpath resolution).
  if (attestation.installChannel === 'cli'
      && !matchesCliLayout(attestation.installPath, attestation.marketplace, attestation.plugin)) {
    return { valid: false, error: `codebuddy attestation installPath does not match the CodeBuddy CLI marketplace layout (.codebuddy/plugins/marketplaces/${attestation.marketplace}/plugins/${attestation.plugin})` };
  }
  return { valid: true, error: null };
}

/**
 * CodeBuddy protocol capability gap: the codebuddy CLI cannot pin a frozen ref,
 * so there is NO trustworthy automated install checkpoint. execute NEVER execs a
 * codebuddy command. Instead it emits an actionable manual-install requirement
 * bound to the real frozen plan digest + identity (naming both install channels
 * and the unified marketplace), and leaves success to observe/verify, which
 * consume only a trusted human attestation plus read-only verification. Without
 * that proof the checkpoint fails closed and can never reach VERIFIED.
 *
 * Isolation model: the cli channel's isolated home is a STABLE, plan-digest-keyed
 * directory under the attestation authority (`<authorityDir>/codebuddy-home`).
 * execute creates the isolated home (so the operator's CLI has a HOME to write
 * into) but never the marketplace install subdir (the operator's CLI install
 * creates that). The desktop channel uses the user's real `~/.workbuddy` and
 * needs no isolated home. The requirement write is idempotent: an identical
 * existing requirement is left untouched, a divergent one fails closed.
 *
 * Referenced from the registry as the codebuddy strategy.buildManualRequirement
 * — the automatable=false manual-requirement path.
 *
 * @param {object} action - expanded codebuddy action (validated params already).
 * @param {object} context - adapter context (root, runDir, plan).
 * @returns {Promise<import('../adapters/contract.mjs').AdapterResult>}
 */
export async function executeCodeBuddyManualRequirement(action, context) {
  const actionType = ActionType.CODEBUDDY_MARKETPLACE_INSTALL;

  // (A) Bind to the REAL frozen plan digest via strict normalized recompute.
  let planDigest;
  try {
    planDigest = await resolveCodeBuddyBoundPlanDigest(context);
  } catch (planErr) {
    return createResult({
      actionType,
      status: ActionStatus.EXECUTE_FAILED,
      error: `cannot bind codebuddy requirement to the frozen plan: ${planErr.message}`,
    });
  }

  // Validate the frozen timeout. CodeBuddy execs no CLI, but the frozen-timeout
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

  // (B) Stable, plan-digest-keyed authority dir, shared across
  // publish/reconcile/verify run dirs.
  let attestationDir;
  try {
    attestationDir = codebuddyAuthorityDir(context, planDigest, action.plugin);
  } catch (dirErr) {
    return createResult({
      actionType,
      status: ActionStatus.EXECUTE_FAILED,
      error: dirErr.message,
    });
  }
  const cliHome = codebuddyCliHome(attestationDir);
  const cliInstallRoot = codebuddyCliInstallRoot(cliHome, CODEBUDDY_MARKETPLACE_NAME, action.plugin);
  const desktopInstallRoot = `~/${CODEBUDDY_DESKTOP_HOME_DIR}/plugins/marketplaces/${CODEBUDDY_MARKETPLACE_NAME}/plugins/${action.plugin}`;

  const instructions = buildCodeBuddyManualInstructions({
    plugin: action.plugin,
    version: action.version,
    ref,
    cliHome,
    attestationDir,
  });

  const requirement = {
    kind: 'codebuddy-manual-install-requirement',
    consumer: 'codebuddy',
    plugin: action.plugin,
    version: action.version,
    entrySkill: action.entrySkill,
    repo: action.repo,
    ref,
    marketplace: CODEBUDDY_MARKETPLACE_NAME,
    marketplaceSource: CODEBUDDY_MARKETPLACE_SOURCE,
    installChannels: ['desktop', 'cli'],
    // (A) planDigest binds to the real frozen plan digest;
    // expectedPayloadDigest binds separately to the snapshot payload digest.
    planDigest,
    expectedPayloadDigest: action.manifestDigest,
    isolatedHome: cliHome,
    codebuddyHome: cliHome,
    cliInstallRoot,
    desktopInstallRoot,
    attestationDir,
    attestationFile: CODEBUDDY_ATTESTATION_FILE,
    attestationTemplate: {
      consumer: 'codebuddy',
      plugin: action.plugin,
      version: action.version,
      entrySkill: action.entrySkill,
      repo: action.repo,
      ref,
      marketplace: CODEBUDDY_MARKETPLACE_NAME,
      installChannel: '<"desktop" or "cli">',
      installPath: '<actual installed plugin directory for the chosen channel>',
      planDigest,
      payloadDigest: action.manifestDigest,
      attestedBy: '<person responsible for the manual install>',
      attestedAt: '<ISO 8601 now; must not be in the future>',
      expiresAt: '<ISO 8601; within 24h of attestedAt>',
    },
    instructions,
  };

  // Create ONLY the isolated cli home (which transitively creates the authority
  // dir); never pre-create the marketplace install subdir — the operator's CLI
  // install (cli channel) or the WorkBuddy desktop app (desktop channel) owns
  // the actual install directory.
  try {
    await mkdir(cliHome, { recursive: true, mode: 0o700 });
  } catch (mkdirErr) {
    return createResult({
      actionType,
      status: ActionStatus.EXECUTE_FAILED,
      error: `cannot create codebuddy isolated home directory: ${mkdirErr.message}`,
    });
  }

  // Idempotent requirement write: an identical existing requirement is left
  // untouched; a divergent existing requirement fails closed (never silently
  // overwritten). `createdAt` is volatile and excluded from the comparison.
  const requirementPath = resolve(attestationDir, CODEBUDDY_REQUIREMENT_FILE);
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
        error: `existing codebuddy manual-install requirement is invalid JSON; refusing to overwrite: ${parseErr.message}`,
      });
    }
  } catch (readErr) {
    if (readErr?.code === 'ENOENT') {
      requirementMissing = true;
    } else {
      return createResult({
        actionType,
        status: ActionStatus.EXECUTE_FAILED,
        error: `existing codebuddy manual-install requirement cannot be read; refusing to overwrite: ${readErr.message}`,
      });
    }
  }
  if (!requirementMissing) {
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      return createResult({
        actionType,
        status: ActionStatus.EXECUTE_FAILED,
        error: 'existing codebuddy manual-install requirement is not an object; refusing to overwrite',
      });
    }
    const { createdAt: _existingCreatedAt, ...existingBody } = existing;
    if (canonicalJson(existingBody) !== canonicalJson(requirement)) {
      return createResult({
        actionType,
        status: ActionStatus.EXECUTE_FAILED,
        error: 'existing codebuddy manual-install requirement conflicts with the current frozen action; refusing to overwrite',
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
      consumer: 'codebuddy',
      plugin: action.plugin,
      version: action.version,
      entrySkill: action.entrySkill,
      repo: action.repo,
      ref,
      marketplace: CODEBUDDY_MARKETPLACE_NAME,
      installChannels: ['desktop', 'cli'],
      planDigest,
      attestationDir,
      codebuddyHome: cliHome,
      cliInstallRoot,
      desktopInstallRoot,
      instructions,
    },
  });
}
