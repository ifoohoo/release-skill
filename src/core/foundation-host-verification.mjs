/**
 * Release-domain mapping for frozen single-skill host verification (`cursor-plugin`,
 * `antigravity-plugin`). Foundation owns request preparation, installation,
 * process supervision and bound stream reads.
 */
// @decision D-RS-005
// @feature REL002
// @scenario S-003

import { basename, join, isAbsolute } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { prepareHostVerification, runHostVerification } from 'skill-family-engineering-kit';
import { canonicalJson } from 'skill-family-contracts';
import { createTemporaryWorkspace } from 'skill-family-harness-node';

import { verifyFrozenSnapshot } from '../snapshot/frozen.mjs';
import { canonicalPublicPath, publicPathCollisionKey } from '../snapshot/public-path.mjs';
import { CONSUMER_VERIFICATION_DEFERRED, POST_PUBLISH_VERIFY_FAILED, ReleaseError } from './errors.mjs';

export const HOST_VERIFICATION_PROFILES = Object.freeze({
  'cursor-plugin': Object.freeze({
    hostId: 'cursor',
    displayName: 'Cursor',
    distributionType: 'cursor-plugin',
    executableRelPath: 'cursor-agent',
    controlDirs: Object.freeze(['.cursor']),
    workspacePrefix: 'release-skill-cursor-',
    retainAction: 'inspect-retained-cursor-scene',
  }),
  'antigravity-plugin': Object.freeze({
    hostId: 'antigravity',
    displayName: 'Antigravity',
    distributionType: 'antigravity-plugin',
    executableRelPath: 'agy',
    controlDirs: Object.freeze(['.gemini', '.antigravity']),
    workspacePrefix: 'release-skill-antigravity-',
    retainAction: 'inspect-retained-antigravity-scene',
  }),
});

const PROFILE_BY_HOST_ID = Object.freeze(
  Object.fromEntries(Object.values(HOST_VERIFICATION_PROFILES).map((profile) => [profile.hostId, profile])),
);

function fail(message, details = {}) {
  return new ReleaseError(POST_PUBLISH_VERIFY_FAILED, message, details);
}

/** Release-owned scenario policy, shared by freezing and consuming the contract. */
export function assertHostVerificationScenario(scenario, { hostId = 'cursor' } = {}) {
  const profile = PROFILE_BY_HOST_ID[hostId];
  if (!profile) {
    throw fail(`Unsupported host verification profile: ${hostId}`, { hostId });
  }
  const label = profile.displayName;
  const controlDirSet = new Set(profile.controlDirs);
  const keys = ['workloadDocument', 'fixtureFiles', 'protectedWorkspaceFiles', 'platformManifest', 'effectivePrompt', 'expectedResult'];
  if (!scenario || typeof scenario !== 'object' || Array.isArray(scenario)
    || Object.keys(scenario).length !== keys.length || keys.some((key) => !Object.hasOwn(scenario, key))) {
    throw fail(`${label} host verification requires the complete frozen scenario`);
  }
  for (const key of ['workloadDocument', 'effectivePrompt', 'expectedResult']) {
    if (typeof scenario[key] !== 'string' || !scenario[key].isWellFormed()
      || (key !== 'expectedResult' && scenario[key].length === 0)
      || (key === 'effectivePrompt' && scenario[key].includes('\0'))) {
      throw fail(`${label} scenario requires valid UTF-8 text`, { field: key });
    }
  }
  if (!scenario.platformManifest || typeof scenario.platformManifest !== 'object' || Array.isArray(scenario.platformManifest)) {
    throw fail(`${label} scenario platformManifest must be a JSON object`);
  }
  canonicalJson(scenario.platformManifest);
  for (const field of ['fixtureFiles', 'protectedWorkspaceFiles']) {
    const files = scenario[field];
    if (!Array.isArray(files) || files.length === 0) throw fail(`${label} scenario files must be non-empty`, { field });
    const paths = [];
    for (const file of files) {
      if (!file || Object.keys(file).length !== 2 || typeof file.content !== 'string' || !file.content.isWellFormed()) {
        throw fail(`${label} scenario file requires path and UTF-8 content`, { field });
      }
      let path;
      try { path = canonicalPublicPath(file.path).path; } catch { throw fail(`${label} scenario file path is unsafe`, { field }); }
      const key = publicPathCollisionKey(path);
      if (path !== file.path || key.split('/').some((seg) => controlDirSet.has(seg))
        || paths.some((other) => other === key || other.startsWith(key + '/') || key.startsWith(other + '/'))) {
        throw fail(`${label} scenario files conflict or target a ${label} control path`, { field });
      }
      paths.push(key);
    }
  }
}

export function assertCursorHostScenario(scenario) {
  return assertHostVerificationScenario(scenario, { hostId: 'cursor' });
}

/** Consume only frozen domain facts and this invocation's explicit private roots. */
export async function verifyFrozenHostSkillWithFoundation({
  plan, unitId, root,
  distributionType = 'cursor-plugin',
  hostRuntime,
  cursorHostRuntime,
  prepareHostVerificationFn = prepareHostVerification,
  runHostVerificationFn = runHostVerification,
  clock = () => new Date().toISOString(),
} = {}) {
  const profile = HOST_VERIFICATION_PROFILES[distributionType];
  if (!profile) {
    throw fail(`Unsupported host verification distribution "${distributionType}"`, { unitId, distributionType });
  }
  const label = profile.displayName;
  const runtime = hostRuntime ?? (profile.hostId === 'cursor' ? cursorHostRuntime : undefined);
  const unit = (plan?.units ?? []).find((candidate) => candidate.id === unitId);
  const distribution = unit?.distributions?.find((candidate) => candidate.type === profile.distributionType);
  const contract = distribution?.hostVerificationContract;
  if (!unit?.frozenSnapshot?.path || !unit.frozenSnapshot.commit || !unit.frozenSnapshot.manifestDigest) {
    throw fail(`${label} host verification requires a frozen unit snapshot`, { unitId, hostId: profile.hostId });
  }
  if (contract?.contractVersion !== 1 || contract.hostId !== profile.hostId
    || contract.entrySkill !== distribution.entrySkill
    || contract.payloadDigest !== unit.frozenSnapshot.manifestDigest
    || contract.manifestRelativePath !== 'skills/' + contract.entrySkill + '/SKILL.md') {
    throw fail(`${label} host verification contract does not bind the frozen payload and entry Skill`, { unitId, hostId: profile.hostId });
  }
  assertHostVerificationScenario(contract.scenario, { hostId: profile.hostId });
  if (!runtime || Object.keys(runtime).length !== 2
    || !['executableRoot', 'existingUserStateRoot'].every((key) =>
      typeof runtime[key] === 'string' && isAbsolute(runtime[key]))) {
    throw fail(`${label} host verification requires explicit absolute executableRoot and existingUserStateRoot`, { unitId, hostId: profile.hostId });
  }
  const frozen = await verifyFrozenSnapshot({ root, snapshotPath: unit.frozenSnapshot.path, expectedDigest: contract.payloadDigest });
  const prefix = 'skills/' + contract.entrySkill + '/';
  const members = frozen.entries.filter((entry) => entry.type === 'file' && entry.path.startsWith(prefix))
    .map((entry) => entry.path.slice(prefix.length));
  if (!members.includes('SKILL.md')) throw fail(`${label} frozen entry Skill is missing SKILL.md`, { unitId, hostId: profile.hostId });
  const scenario = contract.scenario;
  const owned = await createTemporaryWorkspace({ prefix: profile.workspacePrefix });
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
    prepared = await prepareHostVerificationFn({
      hostId: profile.hostId,
      verificationSetId: plan.digest + ':' + unitId + ':' + profile.hostId,
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
      executable: { root: runtime.executableRoot, relPath: profile.executableRelPath },
      existingUserStateRoot: runtime.existingUserStateRoot,
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
        `${label} invocation is indeterminate; inspect the retained private scene before retrying with fresh runtime inputs`, {
          unitId,
          requirements: [{ unitId, hostId: profile.hostId, action: profile.retainAction, sceneId: basename(owned.root) }],
        });
    }
    const stdout = result.streams ? await prepared.readInvocationStream(result, 'stdout') : null;
    if (result.status !== 'observed') {
      throw fail(`Foundation ${label} invocation did not reach an observed result`, { unitId, hostId: profile.hostId, status: result.status, reason: result.reason });
    }
    if (!stdout) throw fail(`${label} invocation has no bound stdout evidence`, { unitId, hostId: profile.hostId });
    let answer;
    try { answer = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(stdout)); } catch {
      throw fail(`${label} invocation did not return valid UTF-8 success JSON`, { unitId, hostId: profile.hostId });
    }
    if (answer?.type !== 'result' || answer.subtype !== 'success' || answer.is_error !== false
      || typeof answer.result !== 'string' || answer.result !== scenario.expectedResult) {
      throw fail(`${label} result does not match the frozen expected result`, { unitId, hostId: profile.hostId });
    }
    return {
      planDigest: plan.digest, unitId, distributionType: profile.distributionType,
      candidateRef: unit.frozenSnapshot.commit, payloadDigest: contract.payloadDigest,
      manifestRelativePath: contract.manifestRelativePath, entrySkill: contract.entrySkill,
      hostId: result.host.hostId, driverId: result.host.driverId, foundationStatus: result.status,
      requestDigest: result.requestDigest, runtimeIdentities: result.runtimeIdentities,
      execution: result.execution, snapshots: result.snapshots, streams: result.streams, observedAt: clock(),
    };
  } catch (error) {
    if (error instanceof ReleaseError) throw error;
    if (retain) {
      throw new ReleaseError(CONSUMER_VERIFICATION_DEFERRED, `${label} invocation outcome is unknown; inspect the retained private scene`, {
        unitId, requirements: [{ unitId, hostId: profile.hostId, action: profile.retainAction, sceneId: basename(owned.root) }],
      });
    }
    if (profile.hostId !== 'cursor' && /preparation supports only cursor/iu.test(error?.message ?? '')) {
      throw fail(
        `${label} 宿主自动核验尚未获得当前 Foundation 驱动支持，已校验冻结契约与快照并阻断放行（禁止静默跳过）`,
        { unitId, hostId: profile.hostId, distributionType: profile.distributionType, contractValidated: true, foundationCode: error?.code ?? null },
      );
    }
    throw fail(`Foundation ${label} host verification failed closed`, { unitId, hostId: profile.hostId, foundationCode: error?.code ?? null });
  } finally {
    if (!retain) await owned.dispose();
  }
}

export async function verifyFrozenCursorSkillWithFoundation(options = {}) {
  return verifyFrozenHostSkillWithFoundation({ ...options, distributionType: 'cursor-plugin' });
}
