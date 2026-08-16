import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

import { SAFE_ID_RE, writeEvidenceAtomic } from '../adapters/contract.mjs';
import { ReleaseError, GATE_FAILED, MISSING_PARAMETERS } from '../core/errors.mjs';

const PLATFORM = Object.freeze({
  kimi: {
    directory: 'kimi-attestations',
    requirementFile: 'release-skill-kimi-manual-install.json',
  },
  codebuddy: {
    directory: 'codebuddy-attestations',
    requirementFile: 'release-skill-codebuddy-manual-install.json',
  },
});

async function validateInstalledConsumerClosure({
  root,
  platform,
  requirement,
  installPath,
}) {
  const planPath = resolve(root, '.release-skill', 'plans', `${requirement.planDigest}.json`);
  const [
    { validatePlan, computePlanDigest, assertImmutablePlanAuthority },
    { createPluginMarketplaceAdapter, verifyInstalledMarketplacePayload },
  ] = await Promise.all([
    import('../core/plan.mjs'),
    import('../adapters/plugin-marketplace.mjs'),
  ]);
  let plan;
  try {
    plan = JSON.parse(await readFile(planPath, 'utf8'));
  } catch (error) {
    throw new ReleaseError(
      GATE_FAILED,
      `cannot read the frozen plan required to verify the installed ${platform} payload: ${error.message}`,
    );
  }
  validatePlan(plan);
  assertImmutablePlanAuthority(planPath, plan);
  if (computePlanDigest(plan) !== requirement.planDigest) {
    throw new ReleaseError(GATE_FAILED, 'manual requirement planDigest does not match the frozen plan');
  }
  const actionType = `${platform}-marketplace-install`;
  const action = (plan.externalActions ?? []).find((candidate) => (
    candidate.type === actionType
    && candidate.parameters?.plugin === requirement.plugin
    && candidate.parameters?.version === requirement.version
  ));
  if (!action) {
    throw new ReleaseError(GATE_FAILED, `frozen plan has no matching ${platform} install action`);
  }
  const adapter = createPluginMarketplaceAdapter();
  const context = {
    externalWritesAuthorized: false,
    isolatedConsumerWritesAuthorized: false,
    plan,
    baseline: plan.baseline,
    root,
  };
  const actionInput = { actionType, ...action.parameters };
  const preflight = await adapter.preflight(actionInput, context);
  if (preflight.status !== 'PREFLIGHT_PASSED') {
    throw new ReleaseError(
      GATE_FAILED,
      `${platform} installed-payload preflight failed: ${preflight.error}`,
    );
  }
  const binding = await verifyInstalledMarketplacePayload(
    actionInput,
    context,
    installPath,
    platform,
  );
  return {
    payloadDigest: action.parameters.manifestDigest,
    manifestDigest: binding.manifestDigest,
    extraInstalledPaths: binding.extraInstalledPaths ?? [],
  };
}

/**
 * Record the human fact needed by an interactive-only consumer. Identity
 * fields come exclusively from the generated requirement; the operator only
 * supplies the result, actor and optional observed install facts.
 *
 * Proof-boundary note: the receipt is a local, self-declared record, not a
 * signed attestation. `--actor` is validated only as a non-empty string and
 * there is no external signature or identity verification, so any process
 * that can run the CLI can claim any actor name. Forging a receipt already
 * requires write access to the `.release-skill` authority directory, which
 * is the same trust boundary as the receipt files themselves. New plans do
 * not use this path: Kimi/CodeBuddy installations are collected as
 * `manualFollowUps` with `verifiedBySystem: false` and never participate in
 * the `VERIFIED` terminal state. This legacy command only supports old
 * frozen plans that predate the manualFollowUps strategy.
 */
export async function recordManualAttestation(options = {}, injected = {}) {
  const {
    root = process.cwd(),
    platform,
    plugin,
    actor,
    result,
    installPath,
    installChannel,
    note,
    clock = () => new Date().toISOString(),
  } = options;
  const descriptor = PLATFORM[platform];
  if (!descriptor || !SAFE_ID_RE.test(plugin ?? '')) {
    throw new ReleaseError(
      MISSING_PARAMETERS,
      'attest requires --platform <kimi|codebuddy> and a safe --plugin <id>',
    );
  }
  if (typeof actor !== 'string' || actor.trim() === '') {
    throw new ReleaseError(MISSING_PARAMETERS, 'attest requires --actor <person>');
  }
  if (result !== 'passed' && result !== 'failed') {
    throw new ReleaseError(MISSING_PARAMETERS, 'attest requires --result <passed|failed>');
  }

  const authorityDir = resolve(root, '.release-skill', descriptor.directory, plugin);
  const requirementPath = join(authorityDir, descriptor.requirementFile);
  let requirement;
  try {
    requirement = JSON.parse(await readFile(requirementPath, 'utf8'));
  } catch (error) {
    throw new ReleaseError(
      GATE_FAILED,
      `cannot read generated ${platform} requirement: ${error.message}`,
      { platform, plugin, requirementPath },
    );
  }
  if (
    requirement.platform !== platform
    || requirement.plugin !== plugin
    || typeof requirement.version !== 'string'
    || !/^[a-f0-9]{64}$/.test(requirement.planDigest ?? '')
    || typeof requirement.attestationFile !== 'string'
  ) {
    throw new ReleaseError(
      GATE_FAILED,
      `generated ${platform} requirement has invalid identity fields`,
      { platform, plugin, requirementPath },
    );
  }
  if (result === 'passed' && (typeof installPath !== 'string' || installPath === '')) {
    throw new ReleaseError(
      MISSING_PARAMETERS,
      `${platform} passed attestation requires --install-path for installed payload verification`,
    );
  }
  const needsInstallChannel = Object.hasOwn(requirement.attestationTemplate ?? {}, 'installChannel');
  if (
    result === 'passed'
    && needsInstallChannel
    && installChannel !== 'desktop'
    && installChannel !== 'cli'
  ) {
    throw new ReleaseError(
      MISSING_PARAMETERS,
      `${platform} passed attestation requires --install-channel <desktop|cli>`,
    );
  }

  const installBinding = result === 'passed'
    ? await (injected.validateInstalledConsumerClosure ?? validateInstalledConsumerClosure)({
        root,
        platform,
        requirement,
        installPath,
      })
    : null;
  const receipt = {
    platform,
    version: requirement.version,
    planDigest: requirement.planDigest,
    result,
    actor: actor.trim(),
    confirmedAt: clock(),
    ...(installPath ? { installPath } : {}),
    ...(installChannel ? { installChannel } : {}),
    ...(note ? { note } : {}),
    ...(installBinding ? {
      payloadDigest: installBinding.payloadDigest,
      installedClosureVerified: true,
      extraInstalledPaths: installBinding.extraInstalledPaths,
    } : {}),
  };
  const attestationPath = join(authorityDir, requirement.attestationFile);
  await writeEvidenceAtomic(attestationPath, receipt);
  return {
    command: 'attest',
    status: 'RECORDED',
    platform,
    plugin,
    version: requirement.version,
    planDigest: requirement.planDigest,
    requirementPath,
    attestationPath,
  };
}
