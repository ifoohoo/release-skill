/**
 * 供应链密码学溯源签名与纯离线验签子命令（`CAP-P7-02`）。
 *
 * 硬性安全边界：
 * - 零新增第三方密码学依赖：仅使用 Node.js 内置 `node:crypto` 原生 `Ed25519`（RFC 8032）；
 * - 零明文私钥落盘与零入仓容忍：严禁读取位于受检仓库目录之内的私钥文件（拒绝软链接），
 *   严禁将私钥材料或本机绝对路径写入磁盘、错误详情、日志或生成的证明文件；
 * - 单向专业结论摘要绑定：复用 `professional-proof.mjs` 的 `readAuditProfessionalProof`
 *   与 `readEvalProfessionalProof` 完成零反向子进程单向核验，将静态审计与动态评测摘要共同纳入签名体；
 * - 纯离线验签（`verify-provenance`）：零网络请求完成 Schema 闭世界校验、规范化声明摘要复算、
 *   公钥 SPKI 指纹核对、Ed25519 数字签名校验及冻结计划 `plan.digest` 交叉一致性校验。
 *
 * @module commands/provenance
 */
// @decision D-RS-001
// @decision D-RS-005
// @feature REL007
// @scenario S-008

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, parse, relative, resolve, sep } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { writeFileAtomic } from 'skill-family-harness-node';

import { acquireProjectLock } from '../artifacts/project-lock.mjs';
import { loadProjectConfig } from '../core/config.mjs';
import { canonicalJson, sha256Hex } from '../core/digest.mjs';
import {
  CONFIG_INVALID,
  GATE_FAILED,
  MISSING_PARAMETERS,
  PATH_UNSAFE,
  ReleaseError,
  STRUCTURE_INVALID,
} from '../core/errors.mjs';
import { readTrustedPackageResourceSync } from '../core/trusted-resource.mjs';
import { resolveUnitVersion } from './prepare.mjs';
import {
  readAuditProfessionalProof,
  readEvalProfessionalProof,
  resolveAllowedConclusionSubjectRefs,
} from './professional-proof.mjs';

export const PROVENANCE_STATEMENT_TYPE = 'https://release-skill.dev/provenance/statement/v1';

const STRICT_SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

const PROVENANCE_SCHEMA = JSON.parse(
  readTrustedPackageResourceSync('schemas/supply-chain-provenance.schema.json').toString('utf8'),
);

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(PROVENANCE_SCHEMA);
const validateAttestationSchema = ajv.compile({
  $ref: `${PROVENANCE_SCHEMA.$id}#/definitions/provenanceAttestation`,
});

function isStrictSemver(version) {
  return typeof version === 'string' && STRICT_SEMVER_RE.test(version);
}

function toPosixRelative(fromRoot, targetAbs) {
  return relative(fromRoot, targetAbs).split(sep).join('/');
}

async function resolveSafeDirectoryRoot(rawDir, label = 'root') {
  let realDir;
  try {
    const stat = await lstat(resolve(rawDir));
    if (!stat.isDirectory() && !stat.isSymbolicLink()) {
      throw new Error('not-directory');
    }
    realDir = await realpath(resolve(rawDir));
  } catch {
    throw new ReleaseError(
      PATH_UNSAFE,
      `无法访问指定的 ${label} 目录（路径不存在或无读取权限）`,
      { reason: 'DIRECTORY_UNREADABLE', field: label },
    );
  }
  return realDir;
}

async function prepareSafeContainedOutputDir(realRoot, customOutputDir, defaultRelDir) {
  let candidate;
  if (typeof customOutputDir === 'string' && customOutputDir.trim().length > 0) {
    const trimmed = customOutputDir.trim();
    if (isAbsolute(trimmed) || trimmed.includes('\\')) {
      throw new ReleaseError(
        PATH_UNSAFE,
        '--output-dir 必须为项目根目录内的 POSIX 相对路径，禁止传入本机绝对路径',
        { reason: 'OUTPUT_DIR_UNSAFE' },
      );
    }
    candidate = resolve(realRoot, trimmed);
    const rel = relative(realRoot, candidate);
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new ReleaseError(
        PATH_UNSAFE,
        '--output-dir 不得逃逸出项目根目录',
        { reason: 'OUTPUT_DIR_ESCAPE' },
      );
    }
  } else {
    candidate = resolve(realRoot, defaultRelDir);
  }

  // 检查从 realRoot 到 candidate 的每一级既有祖先目录均非符号链接且物理包含在 realRoot 内
  const relSegments = relative(realRoot, candidate).split(sep).filter(Boolean);
  let cursor = realRoot;
  for (const seg of relSegments) {
    cursor = resolve(cursor, seg);
    let st = null;
    try {
      st = await lstat(cursor);
    } catch (err) {
      if (err?.code === 'ENOENT') continue;
      throw new ReleaseError(PATH_UNSAFE, '输出目录状态检查失败', { reason: 'OUTPUT_DIR_STAT_FAILED' });
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new ReleaseError(
        PATH_UNSAFE,
        '输出目录包含符号链接或非目录祖先，已拒绝写入以防止路径逃逸',
        { reason: 'OUTPUT_DIR_SYMLINK_ANCESTOR' },
      );
    }
    const curReal = await realpath(cursor);
    const checkRel = relative(realRoot, curReal);
    if (checkRel === '..' || checkRel.startsWith(`..${sep}`) || isAbsolute(checkRel)) {
      throw new ReleaseError(
        PATH_UNSAFE,
        '输出目录真实路径逃逸出受检仓库根，已拒绝写入',
        { reason: 'OUTPUT_DIR_REALPATH_ESCAPE' },
      );
    }
  }

  return candidate;
}

function selectReleaseUnit(config, requestedUnitId) {
  const units = config.releaseUnits ?? [];
  if (typeof requestedUnitId === 'string' && requestedUnitId.trim().length > 0) {
    const unit = units.find((entry) => entry.id === requestedUnitId.trim()) ?? null;
    if (!unit) {
      throw new ReleaseError(
        CONFIG_INVALID,
        `未在项目配置中找到发布单元 "${requestedUnitId}"；可选单元：${units.map((u) => u.id).join(', ')}`,
        { unitId: requestedUnitId, availableUnits: units.map((u) => u.id) },
      );
    }
    return unit;
  }
  if (units.length === 1) return units[0];
  throw new ReleaseError(
    MISSING_PARAMETERS,
    `项目包含多个发布单元（${units.map((u) => u.id).join(', ')}），请使用 --unit <id> 显式指定目标单元`,
    { availableUnits: units.map((u) => u.id) },
  );
}

function computePublicKeyFingerprint(publicKeyObj) {
  const spkiDer = publicKeyObj.export({ type: 'spki', format: 'der' });
  return sha256Hex(spkiDer);
}

async function loadEd25519SigningKey({
  realRoot,
  privateKeyFile,
  privateKeyPemEnv,
  ephemeralSelfTestKey = false,
  dryRun = false,
}) {
  if (ephemeralSelfTestKey === true) {
    if (!dryRun) {
      throw new ReleaseError(
        GATE_FAILED,
        '--ephemeral-self-test-key 一次性内存自检密钥仅允许在 --dry-run 预览模式下使用；正式落盘签名必须传入受检仓库外的 --private-key-file 或环境变量 RELEASE_SKILL_SIGNING_PRIVATE_KEY_PEM。',
        { reason: 'EPHEMERAL_KEY_PRODUCTION_FORBIDDEN' },
      );
    }
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const publicKeyFingerprintSha256 = computePublicKeyFingerprint(publicKey);
    return {
      privateKey,
      publicKeyPem,
      publicKeyFingerprintSha256,
      keySource: 'ephemeral-dry-run',
    };
  }

  let rawPem = null;
  let keySource = null;

  if (typeof privateKeyFile === 'string' && privateKeyFile.trim().length > 0) {
    const absKeyCandidate = resolve(privateKeyFile.trim());
    let keyStat;
    try {
      keyStat = await lstat(absKeyCandidate);
    } catch {
      throw new ReleaseError(
        PATH_UNSAFE,
        '无法读取指定的外部签名私钥文件（请检查路径是否存在且具备只读权限）',
        { reason: 'PRIVATE_KEY_FILE_UNREADABLE' },
      );
    }
    if (keyStat.isSymbolicLink() || !keyStat.isFile()) {
      throw new ReleaseError(
        PATH_UNSAFE,
        '签名私钥路径必须为独立常规文件，严禁使用符号链接或特殊设备文件',
        { reason: 'PRIVATE_KEY_NOT_REGULAR_FILE' },
      );
    }
    let realKeyPath;
    try {
      realKeyPath = await realpath(absKeyCandidate);
    } catch {
      throw new ReleaseError(
        PATH_UNSAFE,
        '无法解析外部签名私钥文件的真实路径',
        { reason: 'PRIVATE_KEY_FILE_UNREADABLE' },
      );
    }
    const relToRepo = relative(realRoot, realKeyPath);
    const insideRepo = relToRepo === '' || (!relToRepo.startsWith(`..${sep}`) && relToRepo !== '..' && !isAbsolute(relToRepo));
    if (insideRepo) {
      throw new ReleaseError(
        PATH_UNSAFE,
        '严禁读取位于受检仓库目录之内的私钥文件（防止私钥误入 Git 工作树或公开快照）；请将私钥保存在仓库物理目录之外。',
        { reason: 'PRIVATE_KEY_INSIDE_REPO_FORBIDDEN' },
      );
    }
    try {
      rawPem = await readFile(realKeyPath, 'utf8');
    } catch {
      throw new ReleaseError(
        PATH_UNSAFE,
        '外部签名私钥文件无读取权限或读取失败（已拒绝回显私钥路径）',
        { reason: 'PRIVATE_KEY_FILE_UNREADABLE' },
      );
    }
    keySource = 'external-file';
  } else if (typeof privateKeyPemEnv === 'string' && privateKeyPemEnv.trim().length > 0) {
    rawPem = privateKeyPemEnv;
    keySource = 'env-memory';
  } else {
    throw new ReleaseError(
      MISSING_PARAMETERS,
      'sign-provenance 需要通过受检仓库外的 --private-key-file <path> 或环境变量 RELEASE_SKILL_SIGNING_PRIVATE_KEY_PEM 提供 Ed25519 私钥（仅预览自检可加 --dry-run --ephemeral-self-test-key）。',
      { reason: 'SIGNING_KEY_REQUIRED' },
    );
  }

  let privateKey;
  let publicKey;
  try {
    privateKey = createPrivateKey({ key: rawPem, format: 'pem' });
    if (privateKey.asymmetricKeyType !== 'ed25519') {
      throw new Error(`unsupported key algorithm: ${privateKey.asymmetricKeyType}`);
    }
    publicKey = createPublicKey(privateKey);
  } catch {
    throw new ReleaseError(
      CONFIG_INVALID,
      '提供的签名私钥不是合法的 Ed25519 PEM 私钥（已拒绝回显私钥内容）',
      { reason: 'INVALID_ED25519_PRIVATE_KEY' },
    );
  }

  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const publicKeyFingerprintSha256 = computePublicKeyFingerprint(publicKey);
  return {
    privateKey,
    publicKeyPem,
    publicKeyFingerprintSha256,
    keySource,
  };
}

async function computeUnitPublicManifestDigest(realRoot, unit) {
  const entries = [];
  for (const mapping of unit.publicFiles ?? []) {
    const absFrom = resolve(realRoot, mapping.from);
    const rel = relative(realRoot, absFrom);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new ReleaseError(PATH_UNSAFE, `publicFiles.from 路径越界：${mapping.from}`, { reason: 'PUBLIC_FILE_ESCAPE' });
    }
    let bytes;
    try {
      bytes = await readFile(absFrom);
    } catch {
      throw new ReleaseError(
        GATE_FAILED,
        `无法读取 publicFiles 声明的公开源文件：${mapping.from}`,
        { reason: 'PUBLIC_FILE_MISSING', file: mapping.from },
      );
    }
    entries.push({
      to: mapping.to,
      sha256: sha256Hex(bytes),
      bytes: bytes.byteLength,
    });
  }
  entries.sort((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
  return sha256Hex(canonicalJson({ unitId: unit.id, files: entries }));
}

function assertEmbeddedPlanDigestMatches(plan, recomputedPlanDigest) {
  const embedded = plan?.digest;
  if (typeof embedded !== 'string' || !/^[0-9a-f]{64}$/.test(embedded) || embedded !== recomputedPlanDigest) {
    throw new ReleaseError(
      GATE_FAILED,
      '冻结发布计划缺少合法的内嵌 digest 字段或与重新计算的规范摘要不一致（疑似计划文件被篡改）',
      { reason: 'PLAN_DIGEST_MISMATCH' },
    );
  }
}

async function collectSubjectArtifactsFromPlanOrWorkspace({
  realRoot,
  unit,
  planPath,
  expectedVersion,
}) {
  if (typeof planPath === 'string' && planPath.trim().length > 0) {
    const absPlan = resolve(realRoot, planPath.trim());
    let plan;
    try {
      plan = JSON.parse(await readFile(absPlan, 'utf8'));
    } catch {
      throw new ReleaseError(GATE_FAILED, '无法读取或解析指定的冻结发布计划 JSON 文件', { reason: 'PLAN_READ_FAILED' });
    }
    const { validatePlan, computePlanDigest } = await import('../core/plan.mjs');
    validatePlan(plan);
    const planDigest = computePlanDigest(plan);
    assertEmbeddedPlanDigestMatches(plan, planDigest);

    const planUnit = (plan.units ?? []).find((u) => u.id === unit.id);
    if (!planUnit) {
      throw new ReleaseError(
        GATE_FAILED,
        `冻结发布计划中不包含目标发布单元 "${unit.id}"`,
        { reason: 'PLAN_UNIT_MISSING', unitId: unit.id },
      );
    }
    if (!isStrictSemver(planUnit.targetVersion)) {
      throw new ReleaseError(
        CONFIG_INVALID,
        `冻结发布计划目标版本 "${planUnit.targetVersion}" 不是严格合法的 SemVer 2.0.0 版本号`,
        { reason: 'INVALID_PLAN_UNIT_VERSION' },
      );
    }
    if (expectedVersion && planUnit.targetVersion !== expectedVersion) {
      throw new ReleaseError(
        GATE_FAILED,
        `冻结发布计划目标版本 (${planUnit.targetVersion}) 与请求版本 (${expectedVersion}) 不一致`,
        { reason: 'PLAN_VERSION_MISMATCH', planVersion: planUnit.targetVersion, expectedVersion },
      );
    }

    const artifacts = [];
    const seen = new Set();
    const pushUnique = (role, label, sha256) => {
      const key = `${role}:${sha256}`;
      if (seen.has(key)) return;
      seen.add(key);
      artifacts.push({ role, label, sha256 });
    };

    pushUnique('plan-document', `plan:${unit.id}@${planUnit.targetVersion}`, planDigest);
    if (typeof planUnit.snapshotDigest === 'string' && /^[0-9a-f]{64}$/.test(planUnit.snapshotDigest)) {
      pushUnique('public-manifest', `snapshot:${unit.id}@${planUnit.targetVersion}`, planUnit.snapshotDigest);
    }

    const multiUnitPlan = Array.isArray(plan.units) && plan.units.length > 1;
    for (const action of plan.externalActions ?? []) {
      const p = action?.parameters ?? {};
      const actionUnitId = typeof action?.unitId === 'string' && action.unitId.length > 0
        ? action.unitId
        : (typeof p.unitId === 'string' && p.unitId.length > 0 ? p.unitId : null);
      if (actionUnitId) {
        if (actionUnitId !== unit.id) continue;
      } else if (multiUnitPlan) {
        continue;
      }
      if (typeof p.tarballSha256 === 'string' && /^[0-9a-f]{64}$/.test(p.tarballSha256)) {
        pushUnique('npm-tarball', `npm:${p.package ?? unit.id}@${planUnit.targetVersion}`, p.tarballSha256);
      }
      if (typeof p.archiveSha256 === 'string' && /^[0-9a-f]{64}$/.test(p.archiveSha256)) {
        pushUnique('git-snapshot-archive', `git:${unit.publicRepo}@${planUnit.targetVersion}`, p.archiveSha256);
      }
    }

    return {
      resolvedVersion: planUnit.targetVersion,
      planDigest,
      subjectArtifacts: artifacts,
    };
  }

  const resolvedVersion = expectedVersion || await resolveUnitVersion(unit, realRoot);
  if (!isStrictSemver(resolvedVersion)) {
    throw new ReleaseError(
      CONFIG_INVALID,
      `无法解析发布单元 "${unit.id}" 的严格 SemVer 2.0.0 版本号`,
      { unitId: unit.id },
    );
  }
  const manifestDigest = await computeUnitPublicManifestDigest(realRoot, unit);
  return {
    resolvedVersion,
    planDigest: null,
    subjectArtifacts: [
      {
        role: 'public-manifest',
        label: `workspace-public-files:${unit.id}@${resolvedVersion}`,
        sha256: manifestDigest,
      },
    ],
  };
}

export function formatProvenanceSignSummary(result) {
  const modeLabel = result.executionMode === 'dry-run' ? '仅预览（dry-run，未写入磁盘）' : '本地离线密码学证明已签发（零私钥落盘、零远端写入）';
  const lines = [
    `供应链溯源签名：${result.unitId}@${result.version}（${result.status}）`,
    `执行模式：${modeLabel}`,
    `签名算法：Ed25519 ｜ 密钥标识：${result.attestation.signature.keyId}`,
    `公钥指纹（SPKI SHA-256）：${result.publicKeyFingerprintSha256}`,
    `声明摘要（SHA-256）：${result.statementDigestSha256}`,
  ];
  if (result.attestation.statement.planDigest) {
    lines.push(`冻结计划摘要：${result.attestation.statement.planDigest}`);
  }
  if (result.executionMode !== 'dry-run' && result.artifacts) {
    lines.push(`溯源证明文件：${result.artifacts.attestationFile}`);
    lines.push(`公开验签公钥：${result.artifacts.publicKeyFile}`);
  }
  return lines.join('\n');
}

export async function signReleaseProvenance(options = {}) {
  const {
    root = process.cwd(),
    unitId: requestedUnitId,
    targetVersion,
    planPath,
    privateKeyFile,
    privateKeyPemEnv = process.env.RELEASE_SKILL_SIGNING_PRIVATE_KEY_PEM,
    ephemeralSelfTestKey = false,
    keyId: requestedKeyId,
    proofRoot: customProofRoot,
    auditProofPath,
    auditConclusionSha256,
    evalProofPath,
    evalConclusionSha256,
    minEvalGrade = 'B',
    actor,
    outputDir: customOutputDir,
    dryRun = false,
    online = false,
    clock = () => new Date().toISOString(),
  } = options;

  if (online === true) {
    throw new ReleaseError(
      GATE_FAILED,
      'sign-provenance 仅支持纯本地离线签发密码学证明（--offline / --dry-run），禁止发起任何远端写请求。',
      { reason: 'PROVENANCE_REMOTE_WRITE_DISABLED' },
    );
  }
  if (typeof actor !== 'string' || actor.trim().length === 0) {
    throw new ReleaseError(MISSING_PARAMETERS, 'sign-provenance 需要提供 --actor <签发责任人标识>', { field: 'actor' });
  }
  if (targetVersion !== undefined && targetVersion !== null && !isStrictSemver(String(targetVersion).trim())) {
    throw new ReleaseError(CONFIG_INVALID, `--target-version "${targetVersion}" 不是合法的严格 SemVer 2.0.0 版本号`, { field: 'targetVersion' });
  }

  const realRoot = await resolveSafeDirectoryRoot(root, 'root');
  const { config } = await loadProjectConfig({ root: realRoot });
  const unit = selectReleaseUnit(config, requestedUnitId);

  const keyMaterial = await loadEd25519SigningKey({
    realRoot,
    privateKeyFile,
    privateKeyPemEnv,
    ephemeralSelfTestKey,
    dryRun,
  });

  const { resolvedVersion, planDigest, subjectArtifacts } = await collectSubjectArtifactsFromPlanOrWorkspace({
    realRoot,
    unit,
    planPath,
    expectedVersion: typeof targetVersion === 'string' ? targetVersion.trim() : null,
  });

  const effectiveProofRoot = customProofRoot
    ? await resolveSafeDirectoryRoot(customProofRoot, 'proof-root')
    : realRoot;
  const allowedRefs = resolveAllowedConclusionSubjectRefs({
    projectName: config.project.name,
    units: [unit],
    resolvedVersions: [resolvedVersion],
  });

  let auditBinding = null;
  if (typeof auditProofPath === 'string' && auditProofPath.trim().length > 0) {
    const auditRes = await readAuditProfessionalProof({
      proofRoot: effectiveProofRoot,
      proofPath: auditProofPath.trim(),
      expectedSubjectRef: allowedRefs,
      expectedDigestSha256: auditConclusionSha256 ?? null,
      requireDigest: Boolean(auditConclusionSha256),
    });
    if (auditRes.status !== 'pass') {
      throw new ReleaseError(
        GATE_FAILED,
        `静态审计专业结论未通过核验，拒绝签发供应链溯源证明：${auditRes.reason}`,
        { reason: 'AUDIT_PROOF_NOT_PASSED', auditStatus: auditRes.status },
      );
    }
    auditBinding = {
      providerId: 'skill-family-audit',
      providerVersion: auditRes.provider.version,
      outcomeCode: auditRes.conclusion.outcome.code,
      digestSha256: auditRes.digestSha256,
    };
  }

  let evalBinding = null;
  if (typeof evalProofPath === 'string' && evalProofPath.trim().length > 0) {
    const evalRes = await readEvalProfessionalProof({
      proofRoot: effectiveProofRoot,
      proofPath: evalProofPath.trim(),
      expectedSubjectRef: allowedRefs,
      expectedDigestSha256: evalConclusionSha256 ?? null,
      requireDigest: Boolean(evalConclusionSha256),
      minGrade: minEvalGrade,
    });
    if (evalRes.status !== 'pass') {
      throw new ReleaseError(
        GATE_FAILED,
        `动态评测专业结论未通过核验，拒绝签发供应链溯源证明：${evalRes.reason}`,
        { reason: 'EVAL_PROOF_NOT_PASSED', evalStatus: evalRes.status },
      );
    }
    evalBinding = {
      providerId: 'skill-family-eval',
      providerVersion: evalRes.provider.version,
      grade: evalRes.grade,
      overallScoreBp: evalRes.overallScoreBp,
      scorecardDigestSha256: evalRes.scorecardDigestSha256,
      digestSha256: evalRes.digestSha256,
    };
  }

  const signedAt = new Date(Date.parse(clock())).toISOString();
  const statement = {
    statementType: PROVENANCE_STATEMENT_TYPE,
    projectName: config.project.name,
    unitId: unit.id,
    publicRepo: unit.publicRepo,
    version: resolvedVersion,
    planDigest,
    subjectArtifacts,
    qualityBindings: {
      auditConclusion: auditBinding,
      evalConclusion: evalBinding,
    },
    actor: actor.trim(),
    signedAt,
  };

  const canonicalStatement = canonicalJson(statement);
  const statementBytes = Buffer.from(canonicalStatement, 'utf8');
  const statementDigestSha256 = sha256Hex(statementBytes);
  const sigBuffer = cryptoSign(null, statementBytes, keyMaterial.privateKey);
  const keyId = typeof requestedKeyId === 'string' && requestedKeyId.trim().length > 0
    ? requestedKeyId.trim()
    : `ed25519:${keyMaterial.publicKeyFingerprintSha256.slice(0, 16)}`;

  const attestation = {
    schemaVersion: 1,
    kind: 'release-skill/provenance-attestation',
    executionMode: dryRun ? 'dry-run' : 'offline',
    remoteWritesPerformed: false,
    statement,
    statementDigestSha256,
    signature: {
      algorithm: 'ed25519',
      keyId,
      publicKeyFingerprintSha256: keyMaterial.publicKeyFingerprintSha256,
      publicKeyPem: keyMaterial.publicKeyPem,
      signatureBase64: sigBuffer.toString('base64'),
    },
  };

  if (!validateAttestationSchema(attestation)) {
    throw new ReleaseError(
      STRUCTURE_INVALID,
      `生成的供应链溯源证明未通过 Schema 校验：${ajv.errorsText(validateAttestationSchema.errors)}`,
      { errors: validateAttestationSchema.errors },
    );
  }

  const outDirAbs = await prepareSafeContainedOutputDir(
    realRoot,
    customOutputDir,
    `.release-skill/provenance/${unit.id}-${resolvedVersion}`,
  );
  const outRel = toPosixRelative(realRoot, outDirAbs);
  const artifacts = {
    attestationFile: `${outRel}/provenance-attestation.json`,
    publicKeyFile: `${outRel}/signing-public-key.pem`,
  };

  if (!dryRun) {
    const lock = await acquireProjectLock({ root: realRoot, command: 'sign-provenance', mode: 'exclusive' });
    try {
      await mkdir(outDirAbs, { recursive: true });
      await prepareSafeContainedOutputDir(realRoot, customOutputDir, `.release-skill/provenance/${unit.id}-${resolvedVersion}`);
      await writeFileAtomic(outDirAbs, 'provenance-attestation.json', `${JSON.stringify(attestation, null, 2)}\n`);
      await writeFileAtomic(outDirAbs, 'signing-public-key.pem', keyMaterial.publicKeyPem);
    } finally {
      await lock.release();
    }
  }

  const result = {
    command: 'sign-provenance',
    status: dryRun ? 'DRY_RUN_SIGNED' : 'SIGNED',
    executionMode: attestation.executionMode,
    remoteWritesPerformed: false,
    keySource: keyMaterial.keySource,
    unitId: unit.id,
    version: resolvedVersion,
    statementDigestSha256,
    publicKeyFingerprintSha256: keyMaterial.publicKeyFingerprintSha256,
    artifacts: dryRun ? null : artifacts,
    attestation,
  };
  result.summary = formatProvenanceSignSummary(result);
  return result;
}

export async function verifyReleaseProvenance(options = {}) {
  const {
    attestationPath,
    publicKeyFile,
    expectedKeyFingerprint,
    planPath,
    unitId: expectedUnitId,
    targetVersion: expectedVersion,
    requireAuditProof = false,
    requireEvalProof = false,
    online = false,
  } = options;

  if (online === true) {
    throw new ReleaseError(
      GATE_FAILED,
      'verify-provenance 为纯本地离线密码学验签命令，禁止开启 --online 访问远端。',
      { reason: 'PROVENANCE_VERIFY_OFFLINE_ONLY' },
    );
  }
  if (typeof attestationPath !== 'string' || attestationPath.trim().length === 0) {
    throw new ReleaseError(
      MISSING_PARAMETERS,
      'verify-provenance 需要提供 --attestation <provenance-attestation.json 路径>',
      { field: 'attestationPath' },
    );
  }

  const absAtt = resolve(attestationPath.trim());
  let attStat;
  try {
    attStat = await lstat(absAtt);
  } catch {
    throw new ReleaseError(GATE_FAILED, '无法读取指定的供应链溯源证明文件', { reason: 'ATTESTATION_UNREADABLE' });
  }
  if (attStat.isSymbolicLink() || !attStat.isFile()) {
    throw new ReleaseError(PATH_UNSAFE, '溯源证明路径必须为常规文件，禁止符号链接', { reason: 'ATTESTATION_SYMLINK' });
  }

  let attRaw;
  try {
    attRaw = await readFile(absAtt, 'utf8');
  } catch {
    throw new ReleaseError(GATE_FAILED, '无法读取指定的供应链溯源证明文件内容', { reason: 'ATTESTATION_UNREADABLE' });
  }

  let attestation;
  try {
    attestation = JSON.parse(attRaw);
  } catch {
    throw new ReleaseError(GATE_FAILED, '溯源证明文件不是合法的 JSON', { reason: 'ATTESTATION_INVALID_JSON' });
  }

  if (!validateAttestationSchema(attestation)) {
    throw new ReleaseError(
      GATE_FAILED,
      `溯源证明文件未通过 Schema 闭世界校验：${ajv.errorsText(validateAttestationSchema.errors)}`,
      { reason: 'ATTESTATION_SCHEMA_INVALID', errors: validateAttestationSchema.errors },
    );
  }

  const canonicalStatement = canonicalJson(attestation.statement);
  const statementBytes = Buffer.from(canonicalStatement, 'utf8');
  const recomputedDigest = sha256Hex(statementBytes);
  if (recomputedDigest !== attestation.statementDigestSha256) {
    throw new ReleaseError(
      GATE_FAILED,
      `溯源声明规范化 SHA-256 摘要失配（疑似篡改）：期望 ${attestation.statementDigestSha256}，实际 ${recomputedDigest}`,
      { reason: 'STATEMENT_DIGEST_MISMATCH', expected: attestation.statementDigestSha256, actual: recomputedDigest },
    );
  }

  let publicKeyPem = attestation.signature.publicKeyPem;
  if (typeof publicKeyFile === 'string' && publicKeyFile.trim().length > 0) {
    const absPub = resolve(publicKeyFile.trim());
    const pubStat = await lstat(absPub).catch(() => null);
    if (!pubStat || pubStat.isSymbolicLink() || !pubStat.isFile()) {
      throw new ReleaseError(PATH_UNSAFE, '--public-key-file 必须为可读的常规公钥文件', { reason: 'PUBLIC_KEY_UNREADABLE' });
    }
    try {
      publicKeyPem = await readFile(absPub, 'utf8');
    } catch {
      throw new ReleaseError(PATH_UNSAFE, '--public-key-file 无读取权限或读取失败', { reason: 'PUBLIC_KEY_UNREADABLE' });
    }
  }

  let publicKeyObj;
  try {
    publicKeyObj = createPublicKey({ key: publicKeyPem, format: 'pem' });
    if (publicKeyObj.asymmetricKeyType !== 'ed25519') {
      throw new Error('not ed25519');
    }
  } catch {
    throw new ReleaseError(GATE_FAILED, '验签公钥不是合法的 Ed25519 SPKI PEM 公钥', { reason: 'INVALID_PUBLIC_KEY' });
  }

  const actualFingerprint = computePublicKeyFingerprint(publicKeyObj);
  if (actualFingerprint !== attestation.signature.publicKeyFingerprintSha256) {
    throw new ReleaseError(
      GATE_FAILED,
      `验签公钥指纹与证明内嵌的公钥指纹不一致：证明记录 ${attestation.signature.publicKeyFingerprintSha256}，提供公钥 ${actualFingerprint}`,
      { reason: 'PUBLIC_KEY_FINGERPRINT_MISMATCH' },
    );
  }
  if (typeof expectedKeyFingerprint === 'string' && expectedKeyFingerprint.trim().length > 0) {
    const cleanExpFp = expectedKeyFingerprint.trim().toLowerCase();
    if (actualFingerprint !== cleanExpFp) {
      throw new ReleaseError(
        GATE_FAILED,
        `验签公钥指纹与调用方期望受信任指纹不一致：期望 ${cleanExpFp}，实际 ${actualFingerprint}`,
        { reason: 'TRUSTED_KEY_FINGERPRINT_MISMATCH' },
      );
    }
  }

  const sigBytes = Buffer.from(attestation.signature.signatureBase64, 'base64');
  const signatureValid = cryptoVerify(null, statementBytes, publicKeyObj, sigBytes);
  if (!signatureValid) {
    throw new ReleaseError(
      GATE_FAILED,
      'Ed25519 数字签名校验失败（声明或签名已被篡改，或使用了错误的公钥）',
      { reason: 'SIGNATURE_VERIFICATION_FAILED' },
    );
  }

  if (expectedUnitId && attestation.statement.unitId !== expectedUnitId.trim()) {
    throw new ReleaseError(
      GATE_FAILED,
      `溯源证明绑定单元不一致：期望 "${expectedUnitId.trim()}"，实际 "${attestation.statement.unitId}"`,
      { reason: 'UNIT_MISMATCH' },
    );
  }
  if (expectedVersion && attestation.statement.version !== expectedVersion.trim()) {
    throw new ReleaseError(
      GATE_FAILED,
      `溯源证明绑定版本不一致：期望 "${expectedVersion.trim()}"，实际 "${attestation.statement.version}"`,
      { reason: 'VERSION_MISMATCH' },
    );
  }
  if (requireAuditProof && !attestation.statement.qualityBindings.auditConclusion) {
    throw new ReleaseError(
      GATE_FAILED,
      '调用方要求溯源证明必须包含 skill-family-audit 静态合规摘要绑定，但当前证明未绑定审计结论',
      { reason: 'MISSING_REQUIRED_AUDIT_BINDING' },
    );
  }
  if (requireEvalProof && !attestation.statement.qualityBindings.evalConclusion) {
    throw new ReleaseError(
      GATE_FAILED,
      '调用方要求溯源证明必须包含 skill-family-eval 动态评测摘要绑定，但当前证明未绑定评测结论',
      { reason: 'MISSING_REQUIRED_EVAL_BINDING' },
    );
  }

  if (typeof planPath === 'string' && planPath.trim().length > 0) {
    const absPlan = resolve(dirname(absAtt), planPath.trim());
    const resolvedPlanPath = isAbsolute(planPath.trim()) ? resolve(planPath.trim()) : resolve(process.cwd(), planPath.trim());
    let plan;
    try {
      plan = JSON.parse(await readFile(resolvedPlanPath, 'utf8'));
    } catch {
      try {
        plan = JSON.parse(await readFile(absPlan, 'utf8'));
      } catch {
        throw new ReleaseError(GATE_FAILED, '无法读取用于交叉核对的冻结发布计划文件', { reason: 'PLAN_READ_FAILED' });
      }
    }
    const { validatePlan, computePlanDigest } = await import('../core/plan.mjs');
    validatePlan(plan);
    const planDigest = computePlanDigest(plan);
    assertEmbeddedPlanDigestMatches(plan, planDigest);
    if (attestation.statement.planDigest !== planDigest) {
      throw new ReleaseError(
        GATE_FAILED,
        `溯源证明绑定的 planDigest (${attestation.statement.planDigest}) 与提供的冻结计划摘要 (${planDigest}) 不一致`,
        { reason: 'PLAN_DIGEST_MISMATCH' },
      );
    }
  }

  const summary = [
    `供应链溯源离线验签：VERIFIED（${attestation.statement.unitId}@${attestation.statement.version}）`,
    `声明摘要（SHA-256）：${recomputedDigest}`,
    `签名密钥指纹：${actualFingerprint}（${attestation.signature.keyId}）`,
    `质量结论共签：audit=${attestation.statement.qualityBindings.auditConclusion ? 'BOUND' : 'NONE'}，eval=${attestation.statement.qualityBindings.evalConclusion ? `BOUND(${attestation.statement.qualityBindings.evalConclusion.grade})` : 'NONE'}`,
  ].join('\n');

  return {
    command: 'verify-provenance',
    status: 'VERIFIED',
    remoteWritesPerformed: false,
    unitId: attestation.statement.unitId,
    version: attestation.statement.version,
    planDigest: attestation.statement.planDigest,
    statementDigestSha256: recomputedDigest,
    publicKeyFingerprintSha256: actualFingerprint,
    qualityBindings: attestation.statement.qualityBindings,
    summary,
  };
}
