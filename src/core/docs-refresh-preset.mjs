/**
 * docs-refresh preset: refresh one or more independent docs repositories
 * (v0.6.3 R4, design §2.5).
 *
 * GitHub-Pages-style docs sites live in their own repositories. One
 * declaration refreshes ALL of them (config.repositories array) from the
 * frozen release payload:
 *
 * - config.mappings copies payload files into the docs repository
 *   (from = payload-relative source, to = repository-relative destination);
 *   an optional per-mapping versionMarker placeholder is replaced with the
 *   frozen release version while writing (version-marker replacement);
 * - config.gates (argument arrays, R1 hook runner) run inside each docs
 *   repository AFTER the write and BEFORE any commit/push — the docs build
 *   gate; a failing gate leaves zero remote side effects;
 * - every repository is committed with the frozen bot identity and pushed
 *   (never --force); byte-identical content -> NO_CHANGE (idempotent).
 *
 * Payload requirement: mappings read the materialized payload, which only
 * exists in the distribute phase (§2.3 contexts carry payloadDir there); a
 * postVerify-phase declaration fails closed with a clear message.
 *
 * @module core/docs-refresh-preset
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { ReleaseError, GATE_FAILED } from './errors.mjs';
import { applyDownstreamGitChange } from './preset-gitwrite.mjs';

/**
 * Assert `from` stays inside the materialized payload directory (declaration
 * validation guarantees a safe relative shape; this is the execution-time
 * re-check).
 */
function resolvePayloadSource(payloadDir, from) {
  const sourcePath = resolve(payloadDir, from);
  const rel = relative(payloadDir, sourcePath);
  if (rel === '' || isAbsolute(rel) || rel === '..'
    || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new ReleaseError(
      GATE_FAILED,
      `docs-refresh mapping source "${from}" escapes the payload directory`,
      { from },
    );
  }
  return sourcePath;
}

/**
 * Execute one docs-refresh preset hook end-to-end: for every declared docs
 * repository, copy the mapped payload files (version-marker replacement),
 * run the docs build gates, and push. Shared by distribute and postVerify
 * (payload requirement effectively binds it to the distribute phase).
 *
 * @param {object} params
 * @param {object} params.hook - Declared hook entry (config bound).
 * @param {object} params.contextProjection - The §2.3 context projection.
 * @param {object} params.commitIdentity - Frozen commitIdentity.
 * @param {string} params.payloadDir - Materialized payload directory
 *   (distribute phase; postVerify contexts never carry it).
 * @param {string} params.root - Release workspace root.
 * @param {Function} [params.exec] - Injectable git exec (tests).
 * @param {Function} [params.hookRunner] - Injectable gate runner (tests).
 * @returns {Promise<{ status: string, observation: object,
 *   observations: object[], mode: string }>}
 */
export async function executeDocsRefreshHook(params) {
  const { hook, contextProjection, commitIdentity, payloadDir, root, exec, hookRunner } = params ?? {};
  const config = hook?.config;
  const repositories = config?.repositories;
  if (!Array.isArray(repositories) || repositories.length === 0) {
    throw new ReleaseError(GATE_FAILED, 'docs-refresh requires a non-empty config.repositories array');
  }
  const mappings = config?.mappings;
  if (!Array.isArray(mappings) || mappings.length === 0) {
    throw new ReleaseError(GATE_FAILED, 'docs-refresh requires a non-empty config.mappings array');
  }
  if (typeof payloadDir !== 'string' || payloadDir.length === 0) {
    throw new ReleaseError(
      GATE_FAILED,
      'docs-refresh copies files from the materialized payload, which only exists in the distribute phase; declare phase: distribute (the default) instead of postVerify',
      {},
    );
  }

  const unitId = contextProjection?.unitId ?? 'unknown';
  const version = contextProjection?.version ?? 'unknown';
  const gates = config?.gates ?? [];

  // Deterministic per-mapping write. Binary-safe copy; the version-marker
  // replacement (when declared) treats the file as UTF-8 text.
  const mutate = async (worktree) => {
    for (const mapping of mappings) {
      const sourcePath = resolvePayloadSource(payloadDir, mapping.from);
      let content = await readFile(sourcePath).catch(() => null);
      if (content === null) {
        throw new ReleaseError(
          GATE_FAILED,
          `docs-refresh mapping source "${mapping.from}" is missing from the materialized payload`,
          { from: mapping.from },
        );
      }
      if (typeof mapping.versionMarker === 'string' && mapping.versionMarker.length > 0) {
        const text = content.toString('utf8');
        content = Buffer.from(text.split(mapping.versionMarker).join(version), 'utf8');
      }
      const destination = join(worktree, mapping.to);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, content);
    }
  };

  const observations = [];
  let anyChange = false;
  for (const [index, target] of repositories.entries()) {
    let result;
    try {
      result = await applyDownstreamGitChange({
        target,
        commitIdentity,
        commitSubject: `release-skill docs-refresh ${unitId} ${version}`,
        mutate,
        gates,
        contextProjection,
        root,
        ...(exec !== undefined ? { exec } : {}),
        ...(hookRunner !== undefined ? { hookRunner } : {}),
      });
    } catch (err) {
      throw new ReleaseError(
        err?.code ?? GATE_FAILED,
        `docs-refresh repository ${index + 1} of ${repositories.length} failed: ${err?.message ?? err}`,
        { repositoryIndex: index, ...(err?.details ?? {}) },
      );
    }
    observations.push({
      repositoryIndex: index,
      ...(typeof target.remoteUrl === 'string' ? { remoteUrl: target.remoteUrl } : {}),
      ...(typeof target.workspace === 'string' ? { workspace: target.workspace } : {}),
      branch: target.branch,
      ...(result.observation ?? {}),
    });
    if (result.status === 'EXECUTED') anyChange = true;
  }

  if (!anyChange) {
    return {
      status: 'NO_CHANGE',
      mode: 'no-change',
      observation: { mode: 'no-change' },
      observations,
    };
  }
  const firstPushed = observations.find((entry) => entry.mode === 'pushed');
  return {
    status: 'EXECUTED',
    mode: 'pushed',
    observation: {
      mode: 'pushed',
      ...(firstPushed?.pushedCommit ? { pushedCommit: firstPushed.pushedCommit } : {}),
      repositoryCount: repositories.length,
    },
    observations,
  };
}
