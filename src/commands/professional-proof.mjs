/**
 * Family projection and read of Foundation professional-conclusion files.
 *
 * Domain mapping stays here. Path containment, exclusive publication, and
 * schema validation are Foundation 0.22.0 calls, not local copies.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import { findSchemaByObject, validateDocument } from 'skill-family-contracts';
import {
  HARNESS_ERROR_KINDS,
  publishFileExclusive,
  readFileStrict,
  resolveContained,
} from 'skill-family-harness-node';

import {
  GATE_FAILED,
  PATH_UNSAFE,
  ReleaseError,
  STRUCTURE_INVALID,
} from '../core/errors.mjs';
import { PKG_ROOT } from '../core/pkg-root.mjs';

export const RELEASE_PROVIDER_ID = 'release-skill';

export const PROVIDER_ENTRY = Object.freeze({
  ADOPTION: 'setup --assess-adoption',
  ASSESS: 'assess --offline',
  RECORDS: 'verify-records',
});

export const READ_EXIT_CODES = Object.freeze({
  pass: 0,
  not_pass: 1,
  unavailable: 2,
});

const PASS_CODES = Object.freeze({
  [PROVIDER_ENTRY.ADOPTION]: Object.freeze(['ADOPTED', 'ADOPTED_WITH_SUGGESTIONS']),
  [PROVIDER_ENTRY.ASSESS]: Object.freeze(['ASSESSED']),
  [PROVIDER_ENTRY.RECORDS]: Object.freeze(['CONSISTENT']),
});

const NOT_PASS_CODES = Object.freeze({
  [PROVIDER_ENTRY.ADOPTION]: Object.freeze(['PARTIALLY_ADOPTED', 'NOT_CONFIGURED']),
  [PROVIDER_ENTRY.ASSESS]: Object.freeze(['NEEDS_INPUT', 'BLOCKED']),
  [PROVIDER_ENTRY.RECORDS]: Object.freeze(['CONTRADICTED', 'INSUFFICIENT']),
});

const INCOMPLETE_RECORD_CODES = Object.freeze([
  'INPUT_MISSING',
  'FORMAT_UNSUPPORTED',
  'HISTORICAL_TIME_MISSING',
]);

function providerVersion() {
  // Bundled adapters ship no package.json. Reuse the build-time identity
  // already injected as __bundlePkg; source mode still reads package.json.
  if (typeof __bundlePkg !== 'undefined' && __bundlePkg && typeof __bundlePkg.version === 'string' && __bundlePkg.version.length > 0) {
    return __bundlePkg.version;
  }
  const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'));
  if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
    throw new ReleaseError(STRUCTURE_INVALID, 'package.json version is required for professional-proof provider.version');
  }
  return pkg.version;
}

function professionalSchemaRegistration() {
  return findSchemaByObject('professional-conclusion');
}

function validateProfessionalConclusion(document) {
  const registration = professionalSchemaRegistration();
  if (!registration) {
    return {
      valid: false,
      errorCode: 'SFC1002',
      errors: [{ message: 'professional-conclusion schema is not registered in the installed skill-family-contracts' }],
    };
  }
  return validateDocument(document, {
    schemaId: registration.$id,
    dialect: registration.dialect,
  });
}

function assertValidConclusion(document) {
  const result = validateProfessionalConclusion(document);
  if (!result.valid) {
    throw new ReleaseError(
      STRUCTURE_INVALID,
      'professional conclusion failed Foundation schema validation',
      { errorCode: result.errorCode, errors: result.errors },
    );
  }
  return result;
}

function canonicalOutputPath(filePath) {
  const absolute = resolve(filePath);
  try {
    return realpathSync(absolute);
  } catch {
    const parts = [basename(absolute)];
    let cursor = dirname(absolute);
    while (true) {
      try {
        return join(realpathSync(cursor), ...parts);
      } catch {
        const parent = dirname(cursor);
        if (parent === cursor) return absolute;
        parts.unshift(basename(cursor));
        cursor = parent;
      }
    }
  }
}

export function assertConclusionOutputOption(conclusionOutput, { conflictPath } = {}) {
  if (conclusionOutput == null || conclusionOutput === '') return;
  if (typeof conclusionOutput !== 'string' || !isAbsolute(conclusionOutput)) {
    throw new ReleaseError(PATH_UNSAFE, '--conclusion-output must be an absolute file path');
  }
  if (conflictPath != null && conflictPath !== '') {
    if (canonicalOutputPath(conclusionOutput) === canonicalOutputPath(conflictPath)) {
      throw new ReleaseError(
        PATH_UNSAFE,
        'assess --output and --conclusion-output must not resolve to the same path',
      );
    }
  }
}

function nativeDetails(nativeResult) {
  if (!nativeResult || typeof nativeResult !== 'object' || Array.isArray(nativeResult)) {
    return { native: nativeResult ?? null };
  }
  const { conclusionPath: _conclusionPath, ...rest } = nativeResult;
  return rest;
}

function nativeSummary(nativeResult, code) {
  if (typeof nativeResult?.summary === 'string' && nativeResult.summary.trim().length > 0) {
    return nativeResult.summary;
  }
  if (code === 'CONSISTENT') {
    return '历史记录一致；不表示发布已经成功。';
  }
  if (code === 'INSUFFICIENT') {
    return '提供的历史记录不足以完成一致性判断。';
  }
  if (code === 'CONTRADICTED') {
    return '提供的历史记录互相矛盾。';
  }
  if (typeof code === 'string' && code.length > 0) {
    return `release-skill 原生状态 ${code}`;
  }
  return 'release-skill 专业检查已返回领域结果。';
}

function adoptionScope(nativeResult) {
  const limitations = [];
  for (const item of nativeResult?.unobserved ?? []) {
    if (typeof item?.note === 'string' && item.note.length > 0) limitations.push(item.note);
    else if (typeof item?.field === 'string' && item.field.length > 0) limitations.push(item.field);
  }
  const configLoadFailed = nativeResult?.status === 'PARTIALLY_ADOPTED'
    && nativeResult?.configDigest == null;
  if (configLoadFailed) {
    limitations.push('subsequent local adoption checks were not run because configuration is invalid');
    return {
      checked: ['setup --assess-adoption:config'],
      limitations,
      completion: 'partial',
    };
  }
  return {
    checked: ['setup --assess-adoption'],
    limitations,
    completion: 'complete',
  };
}

function assessScope(nativeResult) {
  const hasConfig = Boolean(nativeResult?.configDigest) || nativeResult?.status === 'ASSESSED';
  const configOnly = !hasConfig && nativeResult?.status === 'NEEDS_INPUT';
  if (configOnly) {
    return {
      checked: ['config'],
      limitations: ['topology and remaining local checks were not run because configuration is invalid or missing'],
      completion: 'partial',
    };
  }
  const limitations = [];
  if (nativeResult?.offline !== false) {
    limitations.push('remote-prerequisites skipped (--offline)');
  }
  return {
    checked: [
      'config',
      'topology',
      'common-docs',
      'plugin-manifests',
      'package-metadata',
      'readme-structure',
    ],
    limitations,
    completion: 'complete',
  };
}

function recordInputPresent(digest) {
  return typeof digest?.bytesSha256 === 'string' && digest.bytesSha256.length > 0;
}

function recordsScope(nativeResult) {
  const findings = nativeResult?.findings ?? [];
  const limitations = [];
  for (const finding of findings) {
    if (INCOMPLETE_RECORD_CODES.includes(finding?.code) && typeof finding.message === 'string' && finding.message.length > 0) {
      limitations.push(finding.message);
    }
  }
  const digests = nativeResult?.digests ?? {};
  const checked = [];
  if (recordInputPresent(digests.plan)) checked.push('explicit-plan');
  if (recordInputPresent(digests.approval)) checked.push('explicit-approval');
  if (recordInputPresent(digests.targetRun)) checked.push('explicit-target-run');
  const sourceDigests = Array.isArray(digests.sourceRuns) ? digests.sourceRuns : [];
  const sourcePresent = sourceDigests.some((digest) => recordInputPresent(digest));
  if (sourcePresent || (checked.length > 0 && limitations.length === 0)) {
    checked.push('explicit-source-runs');
  }
  if (checked.length === 0) {
    if (limitations.length === 0) {
      limitations.push('required historical records were not supplied');
    }
    return { checked, limitations, completion: 'not-performed' };
  }
  if (limitations.length > 0) {
    return { checked, limitations, completion: 'partial' };
  }
  return { checked, limitations, completion: 'complete' };
}

function scopeFor(entry, nativeResult) {
  if (entry === PROVIDER_ENTRY.ADOPTION) return adoptionScope(nativeResult);
  if (entry === PROVIDER_ENTRY.ASSESS) return assessScope(nativeResult);
  if (entry === PROVIDER_ENTRY.RECORDS) return recordsScope(nativeResult);
  return {
    checked: [],
    limitations: ['unknown family entry'],
    completion: 'not-performed',
  };
}

export function projectReleaseConclusion({
  entry,
  nativeResult,
  subjectRef,
  subjectRevision,
} = {}) {
  const code = typeof nativeResult?.status === 'string' && nativeResult.status.length > 0
    ? nativeResult.status
    : 'UNKNOWN';
  const scope = scopeFor(entry, nativeResult);
  const subject = { ref: typeof subjectRef === 'string' && subjectRef.length > 0 ? subjectRef : 'unspecified-subject' };
  if (typeof subjectRevision === 'string' && subjectRevision.length > 0) {
    subject.revision = subjectRevision;
  }
  return {
    schemaVersion: 1,
    kind: 'skill-family.professional-conclusion',
    provider: {
      id: RELEASE_PROVIDER_ID,
      version: providerVersion(),
      entry,
    },
    subject,
    scope: {
      checked: scope.checked,
      limitations: scope.limitations,
    },
    outcome: {
      completion: scope.completion,
      code,
      summary: nativeSummary(nativeResult, code),
    },
    details: nativeDetails(nativeResult),
  };
}

export function interpretReleaseConclusion(document) {
  const provider = document?.provider && typeof document.provider === 'object'
    ? {
      id: document.provider.id,
      version: document.provider.version,
      entry: document.provider.entry,
    }
    : null;
  const entry = provider?.entry;
  const code = document?.outcome?.code;
  const completion = document?.outcome?.completion;
  const passCodes = typeof entry === 'string' && Object.hasOwn(PASS_CODES, entry)
    ? PASS_CODES[entry]
    : undefined;
  const notPassCodes = typeof entry === 'string' && Object.hasOwn(NOT_PASS_CODES, entry)
    ? NOT_PASS_CODES[entry]
    : undefined;

  if (provider?.id && provider.id !== RELEASE_PROVIDER_ID) {
    return {
      status: 'unavailable',
      reason: '证明不属于 release-skill',
      provider,
    };
  }
  if (!entry || !passCodes || !notPassCodes) {
    return {
      status: 'unavailable',
      reason: '未知入口，无法解释本族领域码',
      provider,
    };
  }
  if (typeof code !== 'string' || code.length === 0) {
    return {
      status: 'unavailable',
      reason: '证明缺少原生领域码',
      provider,
    };
  }
  if (passCodes.includes(code)) {
    if (completion !== 'complete') {
      return {
        status: 'not_pass',
        reason: '声明范围尚未完成，不能把原生通过码当成专业通过',
        provider,
      };
    }
    if (entry === PROVIDER_ENTRY.RECORDS) {
      return {
        status: 'pass',
        reason: '历史记录一致；不表示发布已经成功。historicalTerminalStatus 保持原值。',
        provider,
      };
    }
    if (entry === PROVIDER_ENTRY.ASSESS) {
      return {
        status: 'pass',
        reason: '静态准备度检查完成；不表示已经发布。',
        provider,
      };
    }
    return {
      status: 'pass',
      reason: code === 'ADOPTED_WITH_SUGGESTIONS'
        ? '已接入，建议保留在原证明中。'
        : '接入检查通过。',
      provider,
    };
  }
  if (notPassCodes.includes(code)) {
    if (entry === PROVIDER_ENTRY.RECORDS) {
      return {
        status: 'not_pass',
        reason: code === 'INSUFFICIENT'
          ? '历史记录不足，不能据此声称发布成功。'
          : '历史记录互相矛盾。',
        provider,
      };
    }
    return {
      status: 'not_pass',
      reason: `原生状态 ${code} 表示证明记载的结果未通过。`,
      provider,
    };
  }
  return {
    status: 'unavailable',
    reason: `未知同版本领域码 ${code}`,
    provider,
  };
}

async function publishExclusiveAbsolute(absolutePath, bytes) {
  const root = dirname(absolutePath);
  const relPath = basename(absolutePath);
  if (!relPath || relPath === '.' || relPath === '..') {
    throw new ReleaseError(PATH_UNSAFE, '--conclusion-output must name a file');
  }
  await resolveContained(root, relPath);
  try {
    return await publishFileExclusive(root, relPath, bytes);
  } catch (cause) {
    const kind = cause?.details?.kind;
    if (kind === HARNESS_ERROR_KINDS.EXCLUSIVE_PUBLISH_CONFLICT) {
      throw new ReleaseError(
        GATE_FAILED,
        'professional conclusion already exists; exclusive create refused to overwrite',
        { kind },
      );
    }
    throw new ReleaseError(
      GATE_FAILED,
      `professional conclusion exclusive write failed: ${cause?.message ?? 'unknown'}`,
      { kind },
    );
  }
}

export async function attachProfessionalConclusion(nativeResult, {
  entry,
  subjectRef,
  subjectRevision,
  conclusionOutput,
  conflictPath,
} = {}) {
  if (conclusionOutput == null || conclusionOutput === '') {
    return nativeResult;
  }
  assertConclusionOutputOption(conclusionOutput, { conflictPath });
  const conclusion = projectReleaseConclusion({
    entry,
    nativeResult,
    subjectRef,
    subjectRevision,
  });
  assertValidConclusion(conclusion);
  const published = await publishExclusiveAbsolute(
    resolve(conclusionOutput),
    `${JSON.stringify(conclusion, null, 2)}\n`,
  );
  return { ...nativeResult, conclusionPath: published.path };
}

function unavailableRead(reason, extra = {}) {
  return {
    status: 'unavailable',
    reason,
    provider: extra.provider ?? null,
    conclusion: extra.conclusion ?? null,
  };
}

function extractProvider(document) {
  const provider = document?.provider;
  if (!provider || typeof provider !== 'object' || Array.isArray(provider)) return null;
  const extracted = {};
  if (typeof provider.id === 'string') extracted.id = provider.id;
  if (typeof provider.version === 'string') extracted.version = provider.version;
  if (typeof provider.entry === 'string') extracted.entry = provider.entry;
  return Object.keys(extracted).length > 0 ? extracted : null;
}

export async function readProfessionalProof({
  proofRoot,
  proofPath,
  expectedProviderId = RELEASE_PROVIDER_ID,
} = {}) {
  if (typeof proofRoot !== 'string' || proofRoot.length === 0 || typeof proofPath !== 'string' || proofPath.length === 0) {
    return unavailableRead('proofRoot 与 proof 均为必填');
  }

  let receipt;
  try {
    await resolveContained(proofRoot, proofPath);
    receipt = await readFileStrict(proofRoot, proofPath, { encoding: 'utf8' });
  } catch (cause) {
    return unavailableRead(`无法读取证明: ${cause?.message ?? 'unknown'}`);
  }

  let document;
  try {
    document = JSON.parse(receipt.content);
  } catch {
    return unavailableRead('证明不是合法 JSON');
  }

  const schema = validateProfessionalConclusion(document);
  const provider = extractProvider(document);
  if (!schema.valid) {
    if (provider?.id && provider.id !== expectedProviderId) {
      return unavailableRead('证明不属于 release-skill', { provider, conclusion: document });
    }
    return unavailableRead(
      `证明未通过 professional-conclusion 结构校验（${schema.errorCode ?? 'invalid'}）`,
      { provider },
    );
  }

  if (provider?.id !== expectedProviderId) {
    return unavailableRead('证明不属于 release-skill', { provider, conclusion: document });
  }

  const mapped = interpretReleaseConclusion(document);
  return {
    status: mapped.status,
    reason: mapped.reason,
    provider: mapped.provider,
    conclusion: document,
  };
}
