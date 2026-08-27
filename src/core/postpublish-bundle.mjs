/**
 * Post-publish private execution bundle (F-01 / T1).
 *
 * Release-domain orchestration ONLY. Path classification, containment,
 * digesting, strict reads, exclusive publication, and temporary workspaces
 * all come from `skill-family-harness-node` (0.6.0) by package import; this
 * module never reimplements a hash, a containment check, an atomic writer,
 * or a temporary-workspace algorithm. It supplies exactly the release
 * semantics the Foundation mechanisms do not own:
 *
 * - WHERE the frozen bytes live: digest-addressed under the SAME
 *   `.release-skill` that owns the plan authority — mechanically derived,
 *   never a caller-supplied arbitrary root:
 *
 *       <plan authority .release-skill>/postpublish-bundles/<closure.digest>/<resource.path>
 *
 * - WHAT gets frozen: the closed-world `postPublish.executionFiles` manifest
 *   (parent-workspace files that post-publish commands need but the frozen
 *   tag tree does not contain; helpers must be declared explicitly). The
 *   closure is the verbatim return of `computeResourceClosure()` — sorted,
 *   deduplicated, containment-read, digested by Foundation. The frozen plan
 *   (`postPublish.executionBundle`) is the ONLY source of truth for the
 *   bundle; there is no parallel manifest and no second bundle digest —
 *   `publicFiles` ride the plan digest with everything else.
 *
 * - HOW the bytes return at execution time: distribute/postVerify strictly
 *   re-read every bundle file (frozen sha256 content guard + publication
 *   mode guard), recompute the closure through Foundation in a disposable
 *   workspace, compare it with the plan's frozen closure, and only then
 *   install the verified bytes into the detached tag worktree — exclusively,
 *   so a bundle entry can never shadow a frozen tag file. Any mismatch
 *   fails closed BEFORE any hook or external write.
 *
 * Private files execute through the tag's interpreter and never depend on
 * live executable modes; the bundle publishes and re-verifies one fixed
 * regular-file mode.
 *
 * @module core/postpublish-bundle
 */

import { mkdir } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';

import {
  HARNESS_ERROR_KINDS,
  classifyPathInput,
  computeResourceClosure,
  publishFileExclusive,
  readFileStrict,
  withTemporaryWorkspace,
} from 'skill-family-harness-node';

import { ReleaseError, GATE_FAILED } from './errors.mjs';

/** Foundation mechanism identity frozen into every executionBundle. */
export const EXECUTION_BUNDLE_MECHANISM = 'foundation.harness.resource-closure';

/** Bundle store directory name under the plan authority `.release-skill`. */
export const POSTPUBLISH_BUNDLES_DIRNAME = 'postpublish-bundles';

/** Authority directory that owns plans, approvals, runs — and bundles. */
export const RELEASE_SKILL_DIRNAME = '.release-skill';

/**
 * The single regular-file mode every bundle byte is published with and must
 * still carry at execution time. A mode deviation is tamper evidence: the
 * frozen closure binds content, and publication mode is this fixed policy
 * constant — no per-file mode manifest exists.
 */
export const EXECUTION_BUNDLE_FILE_MODE = 0o644;

function fail(message, details = {}) {
  throw new ReleaseError(GATE_FAILED, `execution bundle: ${message}`, details);
}

/**
 * Mechanically derive the bundle store root from the `.release-skill`
 * authority directory that owns the plan. The caller never supplies an
 * arbitrary root: the store is a fixed child of the plan's own authority
 * directory.
 *
 * @param {string} releaseSkillDir - Absolute path of a `.release-skill` dir.
 * @returns {string} Absolute bundle store root (may not exist yet).
 */
export function bundleRootForAuthorityDir(releaseSkillDir) {
  const absolute = resolve(releaseSkillDir);
  if (basename(absolute) !== RELEASE_SKILL_DIRNAME) {
    fail('bundle root must be derived from a .release-skill authority directory', { releaseSkillDir: absolute });
  }
  return join(absolute, POSTPUBLISH_BUNDLES_DIRNAME);
}

/**
 * Mechanically derive the bundle store root from a plan authority path:
 * anchor on the nearest `.release-skill` ancestor of the plan file.
 *
 * @param {string} planPath - Absolute path of the frozen plan.
 * @returns {string} Absolute bundle store root.
 */
export function deriveBundleRoot(planPath) {
  const absolute = resolve(planPath);
  const segments = absolute.split(sep).filter(Boolean);
  const anchorIndex = segments.lastIndexOf(RELEASE_SKILL_DIRNAME);
  if (anchorIndex < 0) {
    fail('plan path has no .release-skill ancestor; cannot derive the bundle store root', { planPath: absolute });
  }
  const prefix = absolute.startsWith(sep) ? sep : '';
  const releaseSkillDir = prefix + join(...segments.slice(0, anchorIndex + 1));
  return bundleRootForAuthorityDir(releaseSkillDir);
}

/**
 * Freeze the private execution bundle for one postPublish declaration.
 *
 * Order of operations (all before the plan is written):
 * 1. Foundation path classification for every declared entry (no parallel
 *    path regex; ambiguous inputs never reach the filesystem);
 * 2. `computeResourceClosure()` — Foundation sorts, deduplicates,
 *    containment-reads (every root-escape class rejected, root-internal
 *    ancestor aliases are path aliases, not escapes), and digests; the
 *    return value is frozen VERBATIM;
 * 3. strict re-read of every entry bound to its frozen sha256 (any
 *    concurrent drift fails closed; a symbolic-link entry is never readable
 *    — Foundation no-follow), then exclusive publication of the exact bytes
 *    under `<bundleRoot>/<closure.digest>/<resource.path>`. Re-preparing
 *    identical bytes is idempotent; divergent bytes on an occupied
 *    digest-addressed slot fail closed.
 *
 * Symbolic-link policy is fully delegated to Foundation (2026-08-21 handoff
 * ruling C): anything escaping the workspace root is rejected by closure
 * containment, a leaf symbolic link is rejected by `readFileStrict`
 * (no-follow), and ordinary-file identity and digests stay bound.
 *
 * @param {object} params
 * @param {string} params.workspaceRoot - Release workspace root.
 * @param {string} params.releaseSkillDir - `.release-skill` authority dir
 *   that will own the frozen plan (mechanical bundle-root anchor).
 * @param {string[]} [params.executionFiles] - Closed-world manifest.
 * @param {object[]} [params.publicFiles] - Release-unit public projection
 *   frozen into the plan alongside the closure.
 * @returns {Promise<{foundationMechanism: string, closure: object, publicFiles: object[]}>}
 */
export async function freezeExecutionBundle({ workspaceRoot, releaseSkillDir, executionFiles = [], publicFiles = [] } = {}) {
  if (!workspaceRoot || typeof workspaceRoot !== 'string') {
    throw new TypeError('freezeExecutionBundle: workspaceRoot must be a directory path string');
  }
  if (!Array.isArray(executionFiles)) {
    throw new TypeError('freezeExecutionBundle: executionFiles must be an array');
  }
  for (const relPath of executionFiles) {
    const classification = classifyPathInput(relPath);
    if (!classification.ok) {
      fail(`executionFiles entry is not a safe workspace-relative path (kind: ${classification.kind})`, {
        path: typeof relPath === 'string' ? relPath : typeof relPath,
        kind: classification.kind,
      });
    }
  }

  // Foundation closure: sort, dedupe, containment reads, sha256 — verbatim.
  // Thin adapter mapping only: Foundation mechanism errors (lexical
  // traversal, symlink/realpath escapes, missing inputs) surface as
  // release-domain GATE_FAILED without reimplementing any mechanism.
  let closure;
  try {
    closure = await computeResourceClosure({
      root: workspaceRoot,
      resources: executionFiles.map((path) => ({ path, role: 'input' })),
    });
  } catch (cause) {
    if (cause instanceof ReleaseError) throw cause;
    fail(`cannot compute the executionFiles closure: ${cause?.message ?? cause}`, {
      kind: cause?.details?.kind,
    });
  }

  const bundleRoot = bundleRootForAuthorityDir(releaseSkillDir);
  await mkdir(bundleRoot, { recursive: true });

  for (const resource of closure.resources) {
    // Strict re-read bound to the frozen digest: any byte drift between the
    // closure computation and the publication fails closed.
    let receipt;
    try {
      receipt = await readFileStrict(workspaceRoot, resource.path, { expectedSha256: resource.sha256 });
    } catch (cause) {
      fail(`cannot strictly read executionFiles entry for publication: ${cause?.message ?? cause}`, {
        path: resource.path,
        kind: cause?.details?.kind,
      });
    }
    const relTarget = join(closure.digest, resource.path);
    try {
      await publishFileExclusive(bundleRoot, relTarget, receipt.content, {
        mode: EXECUTION_BUNDLE_FILE_MODE,
        createParents: true,
      });
    } catch (cause) {
      if (cause?.details?.kind === HARNESS_ERROR_KINDS.EXCLUSIVE_PUBLISH_CONFLICT) {
        // Idempotent same-bytes re-prepare: the existing slot must carry the
        // exact frozen bytes at the publication mode, verified strictly.
        try {
          const existing = await readFileStrict(bundleRoot, relTarget, { expectedSha256: resource.sha256 });
          if (existing.mode !== EXECUTION_BUNDLE_FILE_MODE) {
            fail('existing bundle file carries an unexpected mode', { path: resource.path, mode: existing.mode });
          }
          continue;
        } catch (verifyCause) {
          fail(`bundle slot already exists with divergent bytes: ${verifyCause?.message ?? verifyCause}`, {
            path: resource.path,
            kind: verifyCause?.details?.kind,
          });
        }
      }
      fail(`cannot publish bundle bytes: ${cause?.message ?? cause}`, {
        path: resource.path,
        kind: cause?.details?.kind,
      });
    }
  }

  return {
    foundationMechanism: EXECUTION_BUNDLE_MECHANISM,
    closure,
    publicFiles: structuredClone(publicFiles),
  };
}

/**
 * Field-by-field closure comparison (the recomputed Foundation closure must
 * equal the frozen plan closure; the digest alone is compared first).
 */
function sameClosureResources(actual, expected) {
  if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length !== expected.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    const left = actual[index] ?? {};
    const right = expected[index] ?? {};
    if (left.path !== right.path || left.role !== right.role
      || left.exists !== right.exists || left.sha256 !== right.sha256) {
      return false;
    }
  }
  return true;
}

/**
 * Verify the frozen execution bundle closure WITHOUT installing anything
 * (rework R-01: the full-declaration preflight reuses this exact
 * implementation before the first external write — a later declaration's
 * missing/drifted bundle must fail the whole saga with zero writes).
 *
 * Steps (the first half of verifyAndInstallExecutionBundle, shared verbatim):
 * 1. Strictly read every frozen resource from the digest-addressed store
 *    (`readFileStrict` with the frozen sha256 content guard); the file mode
 *    must still equal the publication mode — any deviation is tamper;
 * 2. recompute the closure through Foundation in a disposable workspace and
 *    compare it (digest + resources) with the plan's frozen closure.
 *
 * @param {object} params
 * @param {object} params.postPublish - The CURRENT declaration being
 *   verified (REQUIRED, rework R-06: the v1/v2 normalized single item or the
 *   v3 loop item; an array fails closed).
 * @param {string} params.planPath - Absolute plan authority path (mechanical
 *   bundle-root anchor).
 * @returns {Promise<{verified: boolean, bytesByPath: Map<string, Buffer>}>}
 *   `verified: false` with an empty map when the declaration carries no
 *   executionBundle (a legal no-bundle declaration).
 */
export async function verifyExecutionBundle({ planPath, postPublish } = {}) {
  const declaration = postPublish;
  if (!declaration || typeof declaration !== 'object') {
    fail('verifyExecutionBundle requires the current postPublish declaration; pass the normalized single item or the v3 loop item explicitly');
  }
  if (Array.isArray(declaration)) {
    fail('verifyExecutionBundle requires the current postPublish declaration, never the declaration array');
  }
  const bundle = declaration.executionBundle;
  if (!bundle) return { verified: false, bytesByPath: new Map() };
  const closure = bundle.closure;
  if (!closure || !Array.isArray(closure.resources) || typeof closure.digest !== 'string') {
    fail('plan carries a malformed executionBundle closure');
  }

  const bundleRoot = deriveBundleRoot(planPath);
  const bytesByPath = new Map();
  for (const resource of closure.resources) {
    if (!resource || resource.role !== 'input' || resource.exists !== true || typeof resource.sha256 !== 'string') {
      fail('executionBundle closure resources must be existing input resources with frozen digests', {
        path: resource?.path,
      });
    }
    let receipt;
    try {
      receipt = await readFileStrict(bundleRoot, join(closure.digest, resource.path), {
        expectedSha256: resource.sha256,
      });
    } catch (cause) {
      fail(`bundle resource is missing or drifted from the frozen closure: ${cause?.message ?? cause}`, {
        path: resource.path,
        kind: cause?.details?.kind,
      });
    }
    if (receipt.mode !== EXECUTION_BUNDLE_FILE_MODE) {
      fail(`bundle resource mode was tampered (expected ${EXECUTION_BUNDLE_FILE_MODE.toString(8)}, got ${receipt.mode.toString(8)})`, {
        path: resource.path,
      });
    }
    bytesByPath.set(resource.path, receipt.content);
  }

  // Foundation recomputation in a disposable workspace: any inconsistency
  // fails before a hook or an external write.
  try {
    await withTemporaryWorkspace(async (workspace) => {
      for (const resource of closure.resources) {
        await workspace.writeFile(resource.path, bytesByPath.get(resource.path));
      }
      const recomputed = await computeResourceClosure({
        root: workspace.root,
        resources: closure.resources.map((resource) => ({ path: resource.path, role: resource.role })),
      });
      if (recomputed.digest !== closure.digest || !sameClosureResources(recomputed.resources, closure.resources)) {
        fail('recomputed bundle closure differs from the frozen plan closure');
      }
    }, { prefix: 'rs-execution-bundle-verify-' });
  } catch (cause) {
    if (cause instanceof ReleaseError) throw cause;
    fail(`bundle closure recomputation failed: ${cause?.message ?? cause}`, { kind: cause?.details?.kind });
  }

  return { verified: true, bytesByPath };
}

/**
 * Re-verify the frozen execution bundle (the SAME closure verification the
 * full-declaration preflight runs) and install ONLY the verified bytes into
 * the detached tag worktree. Runs BEFORE any hook or external write.
 *
 * Install step: exclusively publish the verified bytes into the worktree —
 * an occupied target means the bundle would shadow a frozen tag file and
 * fails closed.
 *
 * @param {object} params
 * @param {object} params.postPublish - The CURRENT declaration being
 *   executed (v3 multi-unit contract §4.3). REQUIRED (rework R-06): callers
 *   must pass the declaration explicitly — v1/v2 callers pass the single item
 *   obtained from normalizePostPublishView(), v3 callers pass their loop
 *   item. Omitting it fails closed; an array never matches (fail-closed).
 * @param {string} params.planPath - Absolute plan authority path (mechanical
 *   bundle-root anchor).
 * @param {string} params.worktreePath - Detached tag worktree root.
 * @returns {Promise<{installed: string[]}>} Installed relative paths.
 */
export async function verifyAndInstallExecutionBundle({ planPath, worktreePath, postPublish } = {}) {
  const { bytesByPath } = await verifyExecutionBundle({ planPath, postPublish });
  const declaration = postPublish;
  const closure = declaration?.executionBundle?.closure;

  // Install verified bytes into the tag worktree — exclusively: the bundle
  // must never overwrite (shadow) a file that already belongs to the tag.
  const installed = [];
  for (const resource of closure?.resources ?? []) {
    try {
      await publishFileExclusive(worktreePath, resource.path, bytesByPath.get(resource.path), {
        mode: EXECUTION_BUNDLE_FILE_MODE,
        createParents: true,
      });
    } catch (cause) {
      if (cause?.details?.kind === HARNESS_ERROR_KINDS.EXCLUSIVE_PUBLISH_CONFLICT) {
        fail(`execution bundle would overwrite a frozen tag file: ${resource.path}`, { path: resource.path });
      }
      fail(`cannot install bundle bytes into the tag worktree: ${cause?.message ?? cause}`, {
        path: resource.path,
        kind: cause?.details?.kind,
      });
    }
    installed.push(resource.path);
  }
  return { installed };
}
