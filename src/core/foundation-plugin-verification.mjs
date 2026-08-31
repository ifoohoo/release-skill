/**
 * Release-domain thin adapter for Foundation 0.15 complete-plugin observation.
 *
 * The frozen snapshot remains the only payload authority. This module derives
 * transient Foundation inputs from that tree, calls the released Kit API, and
 * returns only the fields needed to bind the mechanism observation to a
 * release action. It does not prove a marketplace install or host invocation.
 *
 * @module core/foundation-plugin-verification
 */

import { join } from 'node:path';

import { digestDocument } from 'skill-family-contracts';
import {
  bundledHostProfilesRoot,
  describeHost,
  runPluginVerification,
} from 'skill-family-engineering-kit';
import {
  createFilesystemRootBinding,
  digestBytes,
  observeFilesystemTree,
  readFileBound,
} from 'skill-family-harness-node';

import { getPlatform, normalizeHostId } from '../platforms/registry.mjs';
import { verifyFrozenSnapshot } from '../snapshot/frozen.mjs';
import { ReleaseError, POST_PUBLISH_VERIFY_FAILED } from './errors.mjs';

// Foundation's public plugin-verification request freezes the built-in driver
// contract at 1.0.0. The real API integration test intentionally exercises
// this value so an upstream contract change fails closed during adoption.
const FOUNDATION_PLUGIN_DRIVER_VERSION = '1.0.0';
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

function isSafeRelativePath(value) {
  return typeof value === 'string'
    && value.length > 0
    && !value.startsWith('/')
    && !value.includes('\\')
    && !value.includes(':')
    && !value.includes('\0')
    && value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..');
}

function decodeCanonicalBase64(value) {
  if (typeof value !== 'string' || !BASE64_PATTERN.test(value)) return null;
  const decoded = Buffer.from(value, 'base64');
  return decoded.toString('base64') === value ? decoded : null;
}

function hasExactKeys(value, keys) {
  return Object.keys(value).sort().join(',') === keys.join(',');
}

function compareUnicodeCodePoints(left, right) {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0));
  const rightPoints = Array.from(right, (character) => character.codePointAt(0));
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index] - rightPoints[index];
  }
  return leftPoints.length - rightPoints.length;
}

function installCommandExited(result) {
  const commands = result?.facts?.install?.commands;
  if (!Array.isArray(commands)) return false;
  return commands.every((command) => {
    const execution = command?.execution;
    return execution?.exitStatus === 0 && execution.processStatus === 'exited';
  });
}

function assertStableInstallTreeState(state) {
  if (state === undefined) return;
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw fail('Foundation install tree state is invalid');
  }
  if (
    state.commandExited === false
    || state.isolated === false
    || state.stable === false
    || state.namespaceWriterActive === true
  ) {
    throw fail('Foundation install tree is not a stable isolated post-command tree', {
      commandExited: state.commandExited ?? null,
      isolated: state.isolated ?? null,
      stable: state.stable ?? null,
      namespaceWriterActive: state.namespaceWriterActive ?? null,
    });
  }
}

function compareRecordedInstallTree(observation, expectedMembers) {
  if (
    !observation
    || typeof observation !== 'object'
    || observation.schemaVersion !== 1
    || observation.kind !== 'skill-family.filesystem-tree-observation'
    || !/^[0-9a-f]{64}$/u.test(observation.membersDigest ?? '')
    || !Array.isArray(observation.members)
  ) {
    throw fail('Foundation install tree observation has an invalid shape');
  }
  if (digestDocument(observation.members) !== observation.membersDigest) {
    throw fail('Foundation install tree observation digest does not match its members');
  }
  const actual = new Map();
  const foldedPaths = new Set();
  let previousPath = null;
  for (const member of observation.members) {
    const foldedPath = member?.path?.toLowerCase();
    if (
      !member
      || !isSafeRelativePath(member.path)
      || !['directory', 'file', 'symlink'].includes(member.type)
      || actual.has(member.path)
      || foldedPaths.has(foldedPath)
      || previousPath !== null && compareUnicodeCodePoints(previousPath, member.path) >= 0
    ) {
      throw fail('Foundation install tree observation contains duplicate or invalid paths');
    }
    actual.set(member.path, member);
    foldedPaths.add(foldedPath);
    const requiredKeys = member.type === 'directory'
      ? ['path', 'statMode', 'type']
      : member.type === 'file'
        ? ['bytes', 'contentBase64', 'path', 'sha256', 'statMode', 'type']
        : ['bytes', 'path', 'statMode', 'targetBase64', 'type'];
    if (!hasExactKeys(member, requiredKeys)) {
      throw fail('Foundation install tree member has unknown or missing fields', { path: member.path });
    }
    previousPath = member.path;
    if (
      typeof member.statMode !== 'number'
      || !Number.isInteger(member.statMode)
      || member.statMode < 0
      || member.statMode > 0xffff
    ) {
      throw fail('Foundation install tree member mode is invalid', { path: member.path });
    }
    if (member.type === 'file') {
      const content = decodeCanonicalBase64(member.contentBase64);
      if (
        !content
        || typeof member.sha256 !== 'string'
        || !SHA256_PATTERN.test(member.sha256)
        || !Number.isSafeInteger(member.bytes)
        || member.bytes < 0
        || member.bytes !== content.length
        || member.sha256 !== digestBytes(content)
      ) {
        throw fail('Foundation install tree file record is invalid', { path: member.path });
      }
    }
    if (member.type === 'symlink') {
      const target = decodeCanonicalBase64(member.targetBase64);
      if (
        !target
        || target.length === 0
        || !Number.isSafeInteger(member.bytes)
        || member.bytes < 1
        || member.bytes !== target.length
      ) {
        throw fail('Foundation install tree link record is invalid', { path: member.path });
      }
    }
  }
  const expected = new Map(expectedMembers.map((member) => [member.path, member]));
  for (const [path, expectedMember] of expected) {
    const member = actual.get(path);
    if (!member || member.type === 'symlink' || member.type !== expectedMember.type) {
      throw fail('declared install tree member is missing or unsafe', { path });
    }
    if (member.type === 'file' && (
      member.sha256 !== expectedMember.sha256
      || member.bytes !== expectedMember.bytes
      || ((member.statMode & 0o111) !== 0) !== expectedMember.executable
    )) {
      throw fail('declared install tree member drifted from the frozen payload', { path });
    }
  }
  const extras = [...actual.values()].filter((member) => !expected.has(member.path));
  const extraInstalledPaths = extras
    .map((member) => member.path)
    .sort(compareUnicodeCodePoints);
  const extraInstalledLinks = extras
    .filter((member) => member.type === 'symlink')
    .map((member) => {
      // Keep the target bytes supplied by Foundation. No path resolution or
      // target read occurs here, so an added link can never be followed.
      return {
        path: member.path,
        targetBase64: member.targetBase64,
        bytes: member.bytes,
        statMode: member.statMode,
      };
    })
    .sort((left, right) => compareUnicodeCodePoints(left.path, right.path));
  return { extraInstalledPaths, extraInstalledLinks };
}

function fail(message, details = {}) {
  return new ReleaseError(POST_PUBLISH_VERIFY_FAILED, message, details);
}

function projectSourceMembers(entries) {
  const directories = new Set();
  for (const entry of entries) {
    const parts = entry.path.split('/');
    for (let count = 1; count < parts.length; count += 1) {
      directories.add(parts.slice(0, count).join('/'));
    }
  }
  return [
    ...[...directories].map((path) => ({ path, type: 'directory' })),
    ...entries.map((entry) => ({
      path: entry.path,
      type: 'file',
      sha256: entry.contentDigest,
      bytes: entry.size,
      executable: (entry.mode & 0o111) !== 0,
    })),
  ].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

/**
 * Return whether one human-consumer action has the complete frozen identity
 * required by Foundation's local-staged plugin verification.
 *
 * This predicate is deliberately plan-derived. It does not persist a second
 * action list, and the verifier repeats the same checks before every call.
 */
export function isFoundationPluginVerificationEligible({ action, units = [] } = {}) {
  const platformId = action?.parameters?.consumer;
  const expectedType = platformId === 'kimi'
    ? 'kimi-marketplace-install'
    : platformId === 'codebuddy'
      ? 'codebuddy-marketplace-install'
      : null;
  if (!expectedType || action?.type !== expectedType) return false;

  const unit = units.find((candidate) => candidate.id === action.unitId);
  const snapshot = unit?.frozenSnapshot;
  const sourceDescriptor = action.parameters?.sourceDescriptor;
  if (
    !snapshot?.path
    || !snapshot.commit
    || !snapshot.manifestDigest
    || sourceDescriptor?.form !== 'bundled-family'
    || sourceDescriptor.pluginSubpath !== '.'
    || sourceDescriptor.commit !== snapshot.commit
    || sourceDescriptor.payloadDigest !== snapshot.manifestDigest
    || action.parameters?.sourceCommit !== snapshot.commit
    || action.parameters?.snapshotPath !== snapshot.path
    || action.parameters?.manifestDigest !== snapshot.manifestDigest
  ) return false;

  const platform = getPlatform(platformId);
  return (unit.distributions ?? []).some((distribution) => (
    distribution.type === platform.distributionType
    && typeof distribution.installationContract?.manifestRelativePath === 'string'
    && distribution.installationContract.manifestRelativePath.length > 0
  ));
}

function assertResultMatchesRequest(result, request) {
  if (
    result?.status !== 'observed'
    || result.requestDigest !== digestDocument(request)
    || result.goal !== request.goal
    || digestDocument(result.source) !== digestDocument(request.source)
    || digestDocument(result.host) !== digestDocument(request.host)
    || result.facts?.install?.payloadMatches !== true
    || result.facts.install.sourceMode !== 'local-staged'
    || result.facts.install.retained !== true
    || result.facts.invocation !== null
  ) {
    throw fail('Foundation complete-plugin observation did not satisfy the frozen local payload contract', {
      foundationStatus: result?.status ?? null,
      foundationReason: result?.reason ?? null,
      payloadMatches: result?.facts?.install?.payloadMatches ?? null,
      requiredActions: result?.requiredActions ?? [],
    });
  }
}

/**
 * Observe one frozen Kimi or CodeBuddy plugin payload through Foundation.
 *
 * @param {object} input
 * @param {object} input.plan
 * @param {object} input.action
 * @param {string} input.root
 * @param {string} input.runDir - Fresh per-action directory containing empty
 *   install, temporary and evidence children.
 * @param {Function} [input.runPluginVerificationFn]
 * @param {Function} [input.clock]
 * @returns {Promise<object>} local payload-observation receipt
 */
export async function verifyFrozenPluginWithFoundation({
  plan,
  action,
  root,
  runDir,
  runPluginVerificationFn = runPluginVerification,
  observeFilesystemTreeFn = observeFilesystemTree,
  installTreeState,
  clock = () => new Date().toISOString(),
} = {}) {
  const unit = (plan?.units ?? []).find((candidate) => candidate.id === action?.unitId);
  if (!unit?.frozenSnapshot?.path || !unit.frozenSnapshot.commit) {
    throw fail('Foundation plugin observation requires a frozen unit snapshot', {
      actionId: action?.id,
      unitId: action?.unitId,
    });
  }

  if (!isFoundationPluginVerificationEligible({ action, units: plan.units })) {
    throw fail('Foundation local plugin observation requires one identity-bound bundled-family payload', {
      actionId: action?.id,
      sourceForm: action?.parameters?.sourceDescriptor?.form ?? null,
      pluginSubpath: action?.parameters?.sourceDescriptor?.pluginSubpath ?? null,
    });
  }

  const platformId = action?.parameters?.consumer;
  const platform = getPlatform(platformId);
  if (!['kimi', 'codebuddy'].includes(platform.id)) {
    throw fail('Foundation local plugin observation is not configured for this release platform', {
      actionId: action?.id,
      platform: platform.id,
    });
  }
  const sourceDescriptor = action.parameters.sourceDescriptor;
  const distribution = (unit.distributions ?? []).find(
    (candidate) => candidate.type === platform.distributionType,
  );
  const manifestRelativePath = distribution?.installationContract?.manifestRelativePath;
  if (!manifestRelativePath) {
    throw fail('Foundation plugin observation requires the frozen installation manifest path', {
      actionId: action.id,
      distributionType: platform.distributionType,
    });
  }

  const frozen = await verifyFrozenSnapshot({
    root,
    snapshotPath: unit.frozenSnapshot.path,
    expectedDigest: unit.frozenSnapshot.manifestDigest,
  });
  const sourceRoot = frozen.snapshotDir;
  const sourceMembers = projectSourceMembers(frozen.entries);
  const sourceManifest = frozen.entries.find((entry) => entry.path === manifestRelativePath);
  if (!sourceManifest) {
    throw fail('Foundation plugin observation manifest is not part of the frozen payload', {
      actionId: action.id,
      manifestRelativePath,
    });
  }

  const hostsRoot = bundledHostProfilesRoot();
  const hostId = await normalizeHostId(platform.buildAdapter.name);
  const descriptor = await describeHost({ hostId, hostsRoot });
  const hostsBinding = await createFilesystemRootBinding(hostsRoot);
  const descriptorFile = await readFileBound(hostsRoot, `${hostId}/host-descriptor.json`, {
    rootBinding: hostsBinding,
  });
  if (!descriptor.verification?.driverId) {
    throw fail('Foundation host has no complete-plugin verification driver', { hostId });
  }

  const request = {
    schemaVersion: 1,
    kind: 'skill-family.plugin-verification-request',
    operation: 'plugin-verification',
    verificationSetId: `${plan.digest}:${action.id}`,
    goal: 'install-only',
    source: {
      type: 'local-staged',
      candidateRef: sourceDescriptor.commit,
      sourceManifestSha256: sourceManifest.contentDigest,
      membersDigest: digestDocument(sourceMembers),
    },
    host: {
      hostId,
      descriptorSha256: descriptorFile.sha256,
      driverId: descriptor.verification.driverId,
      driverVersion: FOUNDATION_PLUGIN_DRIVER_VERSION,
    },
    install: { mode: 'fresh-tree' },
  };
  const bindings = {
    sourceRoot,
    sourceManifestRelPath: manifestRelativePath,
    sourceMembers,
    installContainerRoot: join(runDir, 'install'),
    temporaryRoot: join(runDir, 'temporary'),
    privateEvidenceRoot: join(runDir, 'evidence'),
  };

  const result = await runPluginVerificationFn({ request, bindings, hostsRoot });
  assertResultMatchesRequest(result, request);

  // A3: the installation command (if Foundation reports one) must have
  // exited before the isolated tree is observed. The install-only Foundation
  // path reports no commands, which is the completed local materialization.
  if (!installCommandExited(result)) {
    throw fail('Foundation install tree observation requires an exited install command');
  }
  assertStableInstallTreeState(installTreeState);

  // Foundation's local install-only contract materializes the payload at the
  // stable child of the isolated install container. Observe that payload root
  // rather than the container, whose private siblings are not plugin bytes.
  const installRoot = join(runDir, 'install', 'payload');
  let treeObservation;
  try {
    const rootBinding = await createFilesystemRootBinding(installRoot);
    treeObservation = await observeFilesystemTreeFn({
      root: installRoot,
      rootBinding,
      symlinkPolicy: { mode: 'record' },
    });
    if (treeObservation?.rootBinding?.digest !== rootBinding.digest) {
      throw fail('Foundation install tree observation root binding drifted');
    }
  } catch (error) {
    if (error instanceof ReleaseError) throw error;
    throw fail('Foundation install tree observation failed closed', {
      cause: error?.message ?? String(error),
      code: error?.code ?? null,
    });
  }
  const extraInstallAudit = compareRecordedInstallTree(treeObservation, sourceMembers);

  return {
    planDigest: plan.digest,
    actionId: action.id,
    unitId: unit.id,
    requestDigest: result.requestDigest,
    hostId,
    goal: request.goal,
    sourceType: request.source.type,
    foundationStatus: result.status,
    payloadMatches: result.facts.install.payloadMatches,
    observationDigest: result.facts.install.observationDigest,
    observedAt: clock(),
    ...(extraInstallAudit.extraInstalledPaths.length > 0
      ? { extraInstalledPaths: extraInstallAudit.extraInstalledPaths }
      : {}),
    ...(extraInstallAudit.extraInstalledLinks.length > 0
      ? { extraInstalledLinks: extraInstallAudit.extraInstalledLinks }
      : {}),
  };
}
