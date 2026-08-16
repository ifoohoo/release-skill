/**
 * 安装契约（Installation Contract）。
 *
 * 为每个平台构建一个可审计的规范化安装契约对象，并基于其规范 JSON 计算 SHA-256 摘要。
 * 用于在远端状态未变化时跳过重复验证（NOT_REQUIRED_UNCHANGED）。
 *
 * 契约对象包含：
 * - 算法版本
 * - distributionType
 * - 插件 manifest 的实际相对路径
 * - 规范化后的 manifest 安装内容
 * - marketplaceSourceType
 * - 是否纳入市场条目
 * - 若纳入：所选市场索引的相对路径/来源标识、规范化后的唯一插件条目
 * - verificationRecipeVersion
 *
 * 不纳入契约的字段（做静态一致性校验）：
 * - 版本号（version）
 * - 描述（description / shortDescription / longDescription）
 * - 默认提示词（defaultPrompt）
 * - 标签（tag）
 * - 提交信息（commit / commitSha / marketplaceCommitSha / sha）
 *
 * @module core/installation-contract
 */

import { digestDocument } from 'skill-family-contracts';

/**
 * 安装契约摘要算法版本。
 * 算法变更时递增；版本升级会强制重新验证。
 */
export const INSTALLATION_CONTRACT_ALGORITHM_VERSION = 1;

/**
 * 合法的 marketplaceSourceType 值。
 */
const VALID_MARKETPLACE_SOURCE_TYPES = new Set([
  'bundled-family',
  'standalone-index',
]);

/**
 * 合法的消费端验证结果类型（用于免验判定）。
 */
const VALID_CONSUMER_VERIFICATION_STATUSES = new Set([
  'PASSED_AUTOMATIC',
  'PASSED_MANUAL',
  'NOT_REQUIRED_UNCHANGED',
]);

/**
 * 需要从规范化对象中递归删除的展示/发布身份校验字段。
 */
const DISPLAY_FIELDS_TO_STRIP = new Set([
  'version',
  'description',
  'shortDescription',
  'longDescription',
  'defaultPrompt',
  'tag',
  'commit',
  'commitSha',
  'marketplaceCommitSha',
  'sha',
]);

/**
 * 递归删除对象中的展示字段（深度克隆）。
 *
 * @param {Object} obj - 源对象
 * @returns {Object} 规范化后的对象
 */
function stripDisplayFields(obj) {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => stripDisplayFields(item));
  }

  const result = {};
  for (const key of Object.keys(obj)) {
    if (DISPLAY_FIELDS_TO_STRIP.has(key)) {
      continue;
    }
    result[key] = stripDisplayFields(obj[key]);
  }
  return result;
}

/**
 * 深度冻结对象（递归）。
 *
 * @param {Object} obj - 要冻结的对象
 * @returns {Object} 冻结后的对象
 */
function deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  Object.freeze(obj);

  if (Array.isArray(obj)) {
    for (const item of obj) {
      deepFreeze(item);
    }
  } else {
    for (const value of Object.values(obj)) {
      deepFreeze(value);
    }
  }

  return obj;
}

/**
 * 验证路径是否为相对路径。
 *
 * @param {string} path - 路径
 * @param {string} fieldName - 字段名（用于错误信息）
 */
function assertRelativePath(path, fieldName) {
  if (typeof path !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }

  if (path === '') {
    throw new Error(`${fieldName} must be a non-empty string`);
  }

  // Unix 绝对路径
  if (path.startsWith('/')) {
    throw new Error(`${fieldName} must be a relative path, got absolute path: ${path}`);
  }

  // Windows 绝对路径
  if (/^[a-zA-Z]:\\/.test(path) || /^[a-zA-Z]:\//.test(path)) {
    throw new Error(`${fieldName} must be a relative path, got absolute path: ${path}`);
  }

  // UNC 路径
  if (path.startsWith('\\\\')) {
    throw new Error(`${fieldName} must be a relative path, got UNC path: ${path}`);
  }

  // 目录穿越检查
  const segments = path.split('/');
  for (const seg of segments) {
    if (seg === '..') {
      throw new Error(`${fieldName} must not contain ".." traversal, got: ${path}`);
    }
    if (seg === '.') {
      throw new Error(`${fieldName} must not contain "." component, got: ${path}`);
    }
  }
}

/**
 * 验证摘要格式是否为合法的 64 位十六进制字符串。
 *
 * @param {string} digest - 摘要
 * @returns {boolean} 是否合法
 */
function isValidDigest(digest) {
  return typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest);
}

/**
 * 构建可审计的安装契约对象。
 *
 * @param {Object} params
 * @param {string} params.distributionType - 分发类型（如 'claude-plugin', 'kimi-plugin'）
 * @param {string} params.manifestRelativePath - 插件 manifest 的相对路径
 * @param {Object} params.manifest - 插件 manifest 对象
 * @param {string} params.marketplaceSourceType - 市场来源类型
 * @param {boolean} params.includeMarketplaceEntry - 是否纳入市场条目
 * @param {string} [params.marketplaceIndexRelativePath] - 市场索引相对路径（includeMarketplaceEntry=true 时必需）
 * @param {Object} [params.selectedMarketplaceEntry] - 所选市场条目（includeMarketplaceEntry=true 时必需）
 * @param {string} params.verificationRecipeVersion - 验证配方版本
 * @returns {Object} 深度冻结的契约对象
 */
export function buildInstallationContract({
  distributionType,
  manifestRelativePath,
  manifest,
  marketplaceSourceType,
  includeMarketplaceEntry,
  marketplaceIndexRelativePath,
  selectedMarketplaceEntry,
  verificationRecipeVersion,
} = {}) {
  // 输入验证
  if (!distributionType || typeof distributionType !== 'string') {
    throw new Error('buildInstallationContract: distributionType must be a non-empty string');
  }

  if (!manifestRelativePath || typeof manifestRelativePath !== 'string') {
    throw new Error('buildInstallationContract: manifestRelativePath must be a non-empty string');
  }

  assertRelativePath(manifestRelativePath, 'manifestRelativePath');

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('buildInstallationContract: manifest must be a non-null plain object');
  }

  if (!marketplaceSourceType || typeof marketplaceSourceType !== 'string') {
    throw new Error('buildInstallationContract: marketplaceSourceType must be a non-empty string');
  }

  if (!VALID_MARKETPLACE_SOURCE_TYPES.has(marketplaceSourceType)) {
    throw new Error(
      `buildInstallationContract: invalid marketplaceSourceType "${marketplaceSourceType}", ` +
      `must be one of: ${[...VALID_MARKETPLACE_SOURCE_TYPES].join(', ')}`
    );
  }

  if (!verificationRecipeVersion || typeof verificationRecipeVersion !== 'string') {
    throw new Error('buildInstallationContract: verificationRecipeVersion must be a non-empty string');
  }

  if (typeof includeMarketplaceEntry !== 'boolean') {
    throw new Error('buildInstallationContract: includeMarketplaceEntry must be a boolean');
  }

  // 市场条目验证
  if (includeMarketplaceEntry) {
    if (!selectedMarketplaceEntry || typeof selectedMarketplaceEntry !== 'object' || Array.isArray(selectedMarketplaceEntry)) {
      throw new Error(
        'buildInstallationContract: selectedMarketplaceEntry is required when includeMarketplaceEntry is true'
      );
    }

    if (!marketplaceIndexRelativePath || typeof marketplaceIndexRelativePath !== 'string') {
      throw new Error(
        'buildInstallationContract: marketplaceIndexRelativePath is required when includeMarketplaceEntry is true'
      );
    }

    assertRelativePath(marketplaceIndexRelativePath, 'marketplaceIndexRelativePath');
  }

  // 构建契约对象
  const contract = {
    algorithmVersion: INSTALLATION_CONTRACT_ALGORITHM_VERSION,
    distributionType,
    manifestRelativePath,
    normalizedManifest: stripDisplayFields(manifest),
    marketplaceSourceType,
    includeMarketplaceEntry,
    verificationRecipeVersion,
  };

  // 纳入市场条目
  if (includeMarketplaceEntry) {
    contract.marketplaceIndexRelativePath = marketplaceIndexRelativePath;
    contract.normalizedSelectedEntry = stripDisplayFields(selectedMarketplaceEntry);
  }

  // 深度冻结并返回
  return deepFreeze(contract);
}

/**
 * 计算安装契约摘要。
 *
 * @param {Object} params - buildInstallationContract 的参数
 * @returns {string} SHA-256 摘要（64 位十六进制）
 */
export function computeInstallationContractDigest(params) {
  // 契约对象为纯 JSON（深度冻结、无 undefined/Date/NaN），直接委托 Foundation
  // digestDocument（= sha256(contracts canonicalJson)，与迁移前字节一致）。
  const contract = buildInstallationContract(params);
  return digestDocument(contract);
}

/**
 * 判断是否可以跳过验证。
 *
 * 以下条件同时成立才返回 NOT_REQUIRED_UNCHANGED：
 * 1. 当前摘要是合法 64 位十六进制
 * 2. 上次摘要相同
 * 3. 上次结果明确是消费端验证已解决类型（PASSED_AUTOMATIC / PASSED_MANUAL / NOT_REQUIRED_UNCHANGED）
 * 4. 上次收据中记录的算法版本与当前算法版本相同
 * 5. 上次收据自身绑定相同的 installationContractDigest
 *
 * @param {Object} params
 * @param {string} params.currentDigest - 当前计算的安装契约摘要
 * @param {string|null} params.previousDigest - 上一成功验证的摘要（可为 null）
 * @param {Object|null} params.previousReceipt - 上一成功验证的收据（可为 null）
 * @param {number} params.algorithmVersion - 当前算法版本
 * @returns {'NOT_REQUIRED_UNCHANGED' | 'REQUIRE_VERIFICATION'}
 */
export function shouldSkipVerification({
  currentDigest,
  previousDigest,
  previousReceipt,
  algorithmVersion,
} = {}) {
  // 条件 1：当前摘要必须合法
  if (!isValidDigest(currentDigest)) {
    return 'REQUIRE_VERIFICATION';
  }

  // 条件 2：前次摘要必须存在且相同
  if (!previousDigest || currentDigest !== previousDigest) {
    return 'REQUIRE_VERIFICATION';
  }

  // 条件 3：前次收据必须存在
  if (!previousReceipt || typeof previousReceipt !== 'object') {
    return 'REQUIRE_VERIFICATION';
  }

  // 条件 4：前次收据结果必须是合法的消费端验证结果
  // 只认 result 字段（schema 定义的正式字段）；新消费端收据此前不存在正式 status，
  // 仅有 status 无 result 时要求重新验证。
  if (!VALID_CONSUMER_VERIFICATION_STATUSES.has(previousReceipt.result)) {
    return 'REQUIRE_VERIFICATION';
  }

  // 条件 5：算法版本必须一致
  const previousAlgorithmVersion = previousReceipt.algorithmVersion
    ?? previousReceipt.installationContractAlgorithmVersion;
  if (previousAlgorithmVersion !== algorithmVersion) {
    return 'REQUIRE_VERIFICATION';
  }

  // 条件 6：收据自身绑定的摘要必须一致
  if (!isValidDigest(previousReceipt.installationContractDigest)) {
    return 'REQUIRE_VERIFICATION';
  }

  if (previousReceipt.installationContractDigest !== currentDigest) {
    return 'REQUIRE_VERIFICATION';
  }

  // 全部条件满足 => 跳过验证
  return 'NOT_REQUIRED_UNCHANGED';
}
