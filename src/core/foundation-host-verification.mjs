/**
 * Release-domain mapping for one frozen Cursor Skill. Foundation owns request
 * preparation, installation, process supervision and bound stream reads.
 */
import { basename, join, isAbsolute } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { prepareHostVerification, runHostVerification } from 'skill-family-engineering-kit';
import { canonicalJson } from 'skill-family-contracts';
import { createTemporaryWorkspace } from 'skill-family-harness-node';

import { verifyFrozenSnapshot } from '../snapshot/frozen.mjs';
import { canonicalPublicPath, publicPathCollisionKey } from '../snapshot/public-path.mjs';
import { CONSUMER_VERIFICATION_DEFERRED, POST_PUBLISH_VERIFY_FAILED, ReleaseError } from './errors.mjs';

function fail(message, details = {}) {
  return new ReleaseError(POST_PUBLISH_VERIFY_FAILED, message, details);
}

/** Release-owned scenario policy, shared by freezing and consuming the contract. */
export function assertCursorHostScenario(scenario) {
  const keys = ['workloadDocument', 'fixtureFiles', 'protectedWorkspaceFiles', 'platformManifest', 'effectivePrompt', 'expectedResult'];
  if (!scenario || typeof scenario !== 'object' || Array.isArray(scenario)
    || Object.keys(scenario).length !== keys.length || keys.some((key) => !Object.hasOwn(scenario, key))) {
    throw fail('Cursor host verification requires the complete frozen scenario');
  }
  for (const key of ['workloadDocument', 'effectivePrompt', 'expectedResult']) {
    if (typeof scenario[key] !== 'string' || !scenario[key].isWellFormed()
      || (key !== 'expectedResult' && scenario[key].length === 0)
      || (key === 'effectivePrompt' && scenario[key].includes('\0'))) {
      throw fail('Cursor scenario requires valid UTF-8 text', { field: key });
    }
  }
  if (!scenario.platformManifest || typeof scenario.platformManifest !== 'object' || Array.isArray(scenario.platformManifest)) {
    throw fail('Cursor scenario platformManifest must be a JSON object');
  }
  canonicalJson(scenario.platformManifest);
  for (const field of ['fixtureFiles', 'protectedWorkspaceFiles']) {
    const files = scenario[field];
    if (!Array.isArray(files) || files.length === 0) throw fail('Cursor scenario files must be non-empty', { field });
    const paths = [];
    for (const file of files) {
      if (!file || Object.keys(file).length !== 2 || typeof file.content !== 'string' || !file.content.isWellFormed()) {
        throw fail('Cursor scenario file requires path and UTF-8 content', { field });
      }
      let path;
      try { path = canonicalPublicPath(file.path).path; } catch { throw fail('Cursor scenario file path is unsafe', { field }); }
      const key = publicPathCollisionKey(path);
      if (path !== file.path || key.split('/').includes('.cursor')
        || paths.some((other) => other === key || other.startsWith(key + '/') || key.startsWith(other + '/'))) {
        throw fail('Cursor scenario files conflict or target a Cursor control path', { field });
      }
      paths.push(key);
    }
  }
}

/** Consume only frozen domain facts and this invocation's explicit private roots. */
export async function verifyFrozenCursorSkillWithFoundation({
  plan, unitId, root, cursorHostRuntime,
  runHostVerificationFn = runHostVerification,
  clock = () => new Date().toISOString(),
} = {}) {
  const unit = (plan?.units ?? []).find((candidate) => candidate.id === unitId);
  const distribution = unit?.distributions?.find((candidate) => candidate.type === 'cursor-plugin');
  const contract = distribution?.hostVerificationContract;
  if (!unit?.frozenSnapshot?.path || !unit.frozenSnapshot.commit || !unit.frozenSnapshot.manifestDigest) {
    throw fail('Cursor host verification requires a frozen unit snapshot', { unitId });
  }
  if (contract?.contractVersion !== 1 || contract.hostId !== 'cursor'
    || contract.entrySkill !== distribution.entrySkill
    || contract.payloadDigest !== unit.frozenSnapshot.manifestDigest
    || contract.manifestRelativePath !== 'skills/' + contract.entrySkill + '/SKILL.md') {
    throw fail('Cursor host verification contract does not bind the frozen payload and entry Skill', { unitId });
  }
  assertCursorHostScenario(contract.scenario);
  if (!cursorHostRuntime || Object.keys(cursorHostRuntime).length !== 2
    || !['executableRoot', 'existingUserStateRoot'].every((key) =>
      typeof cursorHostRuntime[key] === 'string' && isAbsolute(cursorHostRuntime[key]))) {
    throw fail('Cursor host verification requires explicit absolute executableRoot and existingUserStateRoot', { unitId });
  }
  const frozen = await verifyFrozenSnapshot({ root, snapshotPath: unit.frozenSnapshot.path, expectedDigest: contract.payloadDigest });
  const prefix = 'skills/' + contract.entrySkill + '/';
  const members = frozen.entries.filter((entry) => entry.type === 'file' && entry.path.startsWith(prefix))
    .map((entry) => entry.path.slice(prefix.length));
  if (!members.includes('SKILL.md')) throw fail('Cursor frozen entry Skill is missing SKILL.md', { unitId });
  const scenario = contract.scenario;
  const owned = await createTemporaryWorkspace({ prefix: 'release-skill-cursor-' });
  let retain = false;
  let prepared;
  let result;
  try {
    const repositoryRoot = await owned.resolve('repository');
    const workspaceRoot = join(repositoryRoot, 'workspace');
    const sessionRoot = await owned.resolve('session');
    await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
    await mkdir(sessionRoot, { mode: 0o700 });
    for (const file of scenario.protectedWorkspaceFiles) {
      await owned.writeFile('repository/workspace/' + file.path, file.content, { mode: 0o600 });
    }
    prepared = await prepareHostVerification({
      hostId: 'cursor',
      verificationSetId: plan.digest + ':' + unitId + ':cursor',
      candidate: {
        ref: unit.frozenSnapshot.commit,
        manifest: canonicalJson({
          contractVersion: contract.contractVersion, unitId, candidateRef: unit.frozenSnapshot.commit,
          payloadDigest: contract.payloadDigest, entrySkill: contract.entrySkill,
          manifestRelativePath: contract.manifestRelativePath,
        }),
      },
      skill: { root: join(frozen.snapshotDir, 'skills', contract.entrySkill), entrySkill: contract.entrySkill, members },
      workloadDocument: scenario.workloadDocument,
      fixtureFiles: scenario.fixtureFiles,
      workspace: { repositoryRoot, root: workspaceRoot, protectedMembers: scenario.protectedWorkspaceFiles.map((file) => file.path) },
      platformManifest: canonicalJson(scenario.platformManifest),
      effectivePrompt: scenario.effectivePrompt,
      executable: { root: cursorHostRuntime.executableRoot, relPath: 'cursor-agent' },
      existingUserStateRoot: cursorHostRuntime.existingUserStateRoot,
      sessionRoot,
      timeoutPolicy: {
        schemaVersion: 1, kind: 'skill-family.timeout-policy',
        maxSeconds: (distribution.timeoutMs ?? 300000) / 1000, killGraceSeconds: 1,
      },
    });
    // An unexpected exception after dispatch cannot establish process termination.
    retain = true;
    result = await runHostVerificationFn(prepared);
    retain = !['observed', 'failed', 'rejected'].includes(result?.status);
    if (retain) {
      throw new ReleaseError(CONSUMER_VERIFICATION_DEFERRED,
        'Cursor invocation is indeterminate; inspect the retained private scene before retrying with fresh runtime inputs', {
          unitId,
          requirements: [{ unitId, hostId: 'cursor', action: 'inspect-retained-cursor-scene', sceneId: basename(owned.root) }],
        });
    }
    const stdout = result.streams ? await prepared.readInvocationStream(result, 'stdout') : null;
    if (result.status !== 'observed') {
      throw fail('Foundation Cursor invocation did not reach an observed result', { unitId, status: result.status, reason: result.reason });
    }
    if (!stdout) throw fail('Cursor invocation has no bound stdout evidence', { unitId });
    let answer;
    try { answer = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(stdout)); } catch {
      throw fail('Cursor invocation did not return valid UTF-8 success JSON', { unitId });
    }
    if (answer?.type !== 'result' || answer.subtype !== 'success' || answer.is_error !== false
      || typeof answer.result !== 'string' || answer.result !== scenario.expectedResult) {
      throw fail('Cursor result does not match the frozen expected result', { unitId });
    }
    return {
      planDigest: plan.digest, unitId, distributionType: 'cursor-plugin',
      candidateRef: unit.frozenSnapshot.commit, payloadDigest: contract.payloadDigest,
      manifestRelativePath: contract.manifestRelativePath, entrySkill: contract.entrySkill,
      hostId: result.host.hostId, driverId: result.host.driverId, foundationStatus: result.status,
      requestDigest: result.requestDigest, runtimeIdentities: result.runtimeIdentities,
      execution: result.execution, snapshots: result.snapshots, streams: result.streams, observedAt: clock(),
    };
  } catch (error) {
    if (error instanceof ReleaseError) throw error;
    if (retain) {
      throw new ReleaseError(CONSUMER_VERIFICATION_DEFERRED, 'Cursor invocation outcome is unknown; inspect the retained private scene', {
        unitId, requirements: [{ unitId, hostId: 'cursor', action: 'inspect-retained-cursor-scene', sceneId: basename(owned.root) }],
      });
    }
    throw fail('Foundation Cursor host verification failed closed', { unitId, foundationCode: error?.code ?? null });
  } finally {
    if (!retain) await owned.dispose();
  }
}
