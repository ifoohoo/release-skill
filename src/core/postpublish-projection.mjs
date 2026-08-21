/**
 * Public payload managed projection (F-06 / T6).
 *
 * Release-domain orchestration ONLY. Full preflight, path containment,
 * lexical classification, transactional writes, rollback, and closure
 * digests all come from the exact Foundation version pinned by
 * `packages/release-skill/package.json` and `pnpm-lock.yaml`
 * `compileProjectionPlan()` / `runProjection()` by package import; strict
 * no-follow source reads come from `skill-family-harness-node`
 * `readFileStrict()`. This module never reimplements a containment check, a
 * preflight, a writer, or a rollback — it supplies exactly the release
 * semantics the Foundation mechanisms do not own:
 *
 * - WHAT is projected: the frozen plan's `postPublish.executionBundle.
 *   publicFiles` mapping (schema- and runtime-validated before the plan was
 *   frozen). Live project configuration is never read here or downstream —
 *   the frozen plan is the only authority, per the R1 timing contract.
 * - WHERE the bytes come from: the detached tag worktree at the frozen
 *   tagCommit (snapshot layout — public files live at their `to` paths),
 *   read strictly (no-follow, regular-file identity, digest receipt).
 * - WHERE the payload lands: a completely fresh `hub-payload` root inside
 *   the execution worktree. The payload root must not pre-exist; a planted
 *   symlink or stale directory at that path fails closed before any write.
 * - HOW authority is bound: the frozen mapping bytes ride the projection
 *   plan as a `caller-bytes` authority binding (FG-3) — the projection never
 *   reads authority from the target root and never forges target-local
 *   authority facts; the Kit re-verifies the digest-bound bytes before every
 *   mutation.
 *
 * Ordering guarantee: mapping shape checks, strict source staging, and the
 * pure compile step all happen BEFORE the payload root is created — lexical
 * escapes, duplicates, and collisions refuse with zero writes and leave no
 * partial `hub-payload` behind.
 *
 * @module core/postpublish-projection
 */

import { chmod, lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  buildProjectionClosure,
  compileProjectionPlan,
  runProjection,
} from 'skill-family-engineering-kit';
import { digestBytes, readFileStrict } from 'skill-family-harness-node';

import { ReleaseError, POST_PUBLISH_VERIFY_FAILED } from './errors.mjs';

/** Mechanism identity recorded in the materialize evidence. */
export const PROJECTION_MECHANISM = 'foundation.engineering-kit.projection';

/** The fresh payload root staged inside the execution worktree. */
export const PUBLIC_PAYLOAD_DIRNAME = 'hub-payload';

/** Authority identity of the frozen publicFiles mapping. */
const AUTHORITY_ID = 'frozen-public-files';
const AUTHORITY_PATH = 'postpublish-public-files.json';

/** Ownership identity recorded for every projected payload file. */
const OWNER_ID = 'release-skill-postpublish';

function fail(message, details = {}) {
  throw new ReleaseError(POST_PUBLISH_VERIFY_FAILED, `public payload projection: ${message}`, details);
}

/**
 * Stage the frozen public payload into a fresh `hub-payload` root inside the
 * execution worktree through the Foundation managed projection.
 *
 * @param {object} params
 * @param {string} params.executionWorktreeRoot - Detached tag worktree root
 *   (frozen tagCommit checkout; snapshot layout).
 * @param {string} params.candidateRoot - Disposable staging directory for the
 *   candidate closure (external to the payload root; caller owns cleanup).
 * @param {object[]} params.publicFiles - Frozen plan publicFiles mapping.
 * @returns {Promise<{payloadRoot: string, fileCount: number, mechanism: string}>}
 * @throws {ReleaseError} POST_PUBLISH_VERIFY_FAILED on any refusal — after
 *   Foundation preflight/rollback semantics, never with a partial payload.
 */
export async function projectPublicPayload({ executionWorktreeRoot, candidateRoot, publicFiles } = {}) {
  if (!executionWorktreeRoot || typeof executionWorktreeRoot !== 'string') {
    throw new TypeError('projectPublicPayload: executionWorktreeRoot must be a directory path string');
  }
  if (!candidateRoot || typeof candidateRoot !== 'string') {
    throw new TypeError('projectPublicPayload: candidateRoot must be a directory path string');
  }

  // --- Domain mapping shape (schema-validated upstream; re-checked fail-
  // closed). Lexical path rejection belongs to Foundation classification. ---
  if (!Array.isArray(publicFiles) || publicFiles.length === 0) {
    fail('the frozen plan carries no publicFiles mapping; the payload cannot be staged');
  }
  for (const [index, entry] of publicFiles.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || typeof entry.from !== 'string' || entry.from.length === 0
      || typeof entry.to !== 'string' || entry.to.length === 0
      || entry.mode !== 'preserve') {
      fail(`frozen publicFiles entry ${index} is not a valid preserve-mode mapping`, { index });
    }
  }

  const worktreeReal = await realpath(executionWorktreeRoot).catch(() => null);
  if (!worktreeReal) {
    fail('the execution worktree does not resolve to an existing directory', { executionWorktreeRoot });
  }

  // --- Payload target preflight: the root must not pre-exist. The tag
  // worktree is disposable and freshly created; a planted symlink or stale
  // directory at the payload path fails closed BEFORE any write. ---
  const payloadPath = join(worktreeReal, PUBLIC_PAYLOAD_DIRNAME);
  const preExisting = await lstat(payloadPath).catch(() => null);
  if (preExisting) {
    fail(`the payload root already exists in the tag worktree (${preExisting.isSymbolicLink() ? 'symbolic link' : 'pre-existing entry'})`, {
      path: PUBLIC_PAYLOAD_DIRNAME,
    });
  }

  // --- Candidate staging: strict no-follow reads of every frozen `to` source
  // from the frozen worktree (never the live workspace). A symlinked source
  // is refused here — the escape target is never opened. ---
  const stagedResources = [];
  for (const entry of publicFiles) {
    let receipt;
    try {
      receipt = await readFileStrict(executionWorktreeRoot, entry.to);
    } catch (cause) {
      fail(`cannot strictly read the frozen public file "${entry.to}" from the tag worktree: ${cause?.message ?? cause}`, {
        path: entry.to,
        kind: cause?.details?.kind,
      });
    }
    const stagePath = join(candidateRoot, entry.to);
    await mkdir(dirname(stagePath), { recursive: true });
    await writeFile(stagePath, receipt.content);
    await chmod(stagePath, receipt.mode);
    stagedResources.push({ path: entry.to, sha256: receipt.sha256, mode: receipt.mode });
  }

  // --- Authority binding: the frozen mapping bytes ride the plan as a
  // caller-bytes binding — no authority filesystem access, nothing forged
  // into the target root. ---
  const authorityBytes = Buffer.from(JSON.stringify(publicFiles), 'utf8');

  // --- Pure compile: containment, duplicates, portable collisions, closure
  // digests — every refusal happens before the payload root exists. ---
  let prepared;
  try {
    prepared = compileProjectionPlan({
      rootBinding: payloadPath,
      authoritySources: [{
        id: AUTHORITY_ID,
        path: AUTHORITY_PATH,
        type: 'file',
        sha256: digestBytes(authorityBytes),
        mode: 0o644,
      }],
      ownership: publicFiles.map((entry) => ({
        path: entry.to,
        authoritySource: AUTHORITY_ID,
        owner: { kind: 'managed', id: OWNER_ID },
        expect: { state: 'absent' },
      })),
      handwrittenPolicy: { authoritySource: AUTHORITY_ID, patterns: [] },
      previousOwnedClosure: buildProjectionClosure([]),
      externalCandidateClosure: buildProjectionClosure(stagedResources),
      authorityBinding: {
        kind: 'caller-bytes',
        bytes: { [AUTHORITY_ID]: authorityBytes.toString('base64') },
        freshRoot: true,
      },
    });
  } catch (cause) {
    fail(`the frozen publicFiles mapping cannot be compiled into a projection plan: ${cause?.message ?? cause}`, {
      kind: cause?.details?.kind,
    });
  }

  // --- Create the payload root and re-verify its identity (TOCTOU guard:
  // the realpath must equal the compiled rootBinding). ---
  try {
    await mkdir(payloadPath);
  } catch (cause) {
    fail(`cannot create the fresh payload root: ${cause?.message ?? cause}`, { path: PUBLIC_PAYLOAD_DIRNAME });
  }
  const payloadReal = await realpath(payloadPath).catch(() => null);
  if (!payloadReal || payloadReal !== payloadPath) {
    fail('the payload root identity changed during creation (symbolic-link ancestor refused)', {
      path: PUBLIC_PAYLOAD_DIRNAME,
    });
  }

  // --- Foundation managed projection: complete preflight already passed;
  // runProjection re-verifies candidate, authority, and target expectations
  // before every mutation and restores the complete closure on failure. ---
  try {
    await runProjection({
      root: payloadPath,
      manifest: prepared.manifest,
      candidateRoot,
      preparedProjection: prepared,
    });
  } catch (cause) {
    fail(`projection execution refused: ${cause?.message ?? cause}`, {
      kind: cause?.details?.kind,
    });
  }

  return { payloadRoot: payloadReal, fileCount: publicFiles.length, mechanism: PROJECTION_MECHANISM };
}
