/**
 * Release-domain thin adapter for Foundation 0.13 complete-plugin observation.
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
  readFileBound,
} from 'skill-family-harness-node';

import { getPlatform, normalizeHostId } from '../platforms/registry.mjs';
import { verifyFrozenSnapshot } from '../snapshot/frozen.mjs';
import { ReleaseError, POST_PUBLISH_VERIFY_FAILED } from './errors.mjs';

// Foundation's public plugin-verification request freezes the built-in driver
// contract at 1.0.0. The real API integration test intentionally exercises
// this value so an upstream contract change fails closed during adoption.
const FOUNDATION_PLUGIN_DRIVER_VERSION = '1.0.0';

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
  };
}
