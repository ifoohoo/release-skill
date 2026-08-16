/**
 * Read package-owned runtime resources without following untrusted links.
 * Installed adapters use this for schemas and native manifests.
 *
 * 机制已委托 Foundation（skill-family-foundation-adoption-20260815 节点 1.6）：
 * - 异步变体 `readTrustedPackageResource`：路径包含三层校验（词法/符号链接/
 *   realpath 逃逸）委托 `resolveContained`，读取委托 `readFileContained`；
 *   本地保留域策略前置校验 `assertStat`（拒绝任何符号链接、非常规文件与
 *   硬链接），失败原因映射保持原语义。
 * - 同步变体 `readTrustedPackageResourceSync`：Foundation 无同步路径 API，
 *   词法分类委托同步纯函数 `classifyPathInput`，其余本地同步实现保留
 *   （残留，见 1.6 run-report 剩余风险）。
 */

import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { classifyPathInput, readFileContained, resolveContained } from 'skill-family-harness-node';

import { CONFIG_INVALID, ReleaseError } from './errors.mjs';
import { PKG_ROOT } from './pkg-root.mjs';

function fail(code, resource, reason) {
  throw new ReleaseError(
    code,
    `package resource is untrusted or unavailable: ${resource}`,
    { resource, reason },
  );
}

// ---- 同步变体保留的本地实现（Foundation 无同步路径 API，文档化残留） ----

function lexicalPath(resource, code) {
  if (typeof resource !== 'string' || resource.length === 0 || isAbsolute(resource)) {
    fail(code, String(resource), 'INVALID_RESOURCE_PATH');
  }
  const path = resolve(PKG_ROOT, resource);
  const rel = relative(PKG_ROOT, path);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    fail(code, resource, 'RESOURCE_PATH_ESCAPE');
  }
  return path;
}

function assertStat(stat, resource, code) {
  if (stat.isSymbolicLink()) fail(code, resource, 'SYMLINK');
  if (!stat.isFile()) fail(code, resource, 'NOT_REGULAR_FILE');
  if (stat.nlink !== 1) fail(code, resource, 'UNEXPECTED_HARDLINK_COUNT');
}

function assertPhysicalContainment(physicalRoot, physicalPath, resource, code) {
  const rel = relative(physicalRoot, physicalPath);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    fail(code, resource, 'PHYSICAL_PATH_ESCAPE');
  }
}

// ---- Foundation 机制错误 → 本地失败语义映射 ----

/** 把 Foundation HarnessError（SFC2004 + details.kind）映射为本地失败原因。 */
function harnessKindToReason(kind) {
  switch (kind) {
    case 'path-traversal':
      return 'RESOURCE_PATH_ESCAPE';
    case 'symlink-escape':
      // 本地语义：lstat 前置校验对任何符号链接一律报 SYMLINK（不区分指向）。
      // Foundation 对指向包外的符号链接先抛 symlink-escape，映射回 SYMLINK
      // 保持原失败原因；包内符号链接由本地 assertStat 以 SYMLINK 拦截。
      return 'SYMLINK';
    case 'realpath-escape':
      return 'PHYSICAL_PATH_ESCAPE';
    case 'missing-resource':
      return 'MISSING';
    case 'read-failed':
      return 'READ_FAILED';
    default:
      // invalid-path / absolute-path / windows-drive-path / unc-path /
      // windows-path / invalid-root 等统一归入无效资源路径。
      return 'INVALID_RESOURCE_PATH';
  }
}

function mapHarnessError(cause, resource, code) {
  if (cause && cause.code === 'SFC2004' && cause.details && typeof cause.details.kind === 'string') {
    fail(code, resource, harnessKindToReason(cause.details.kind));
  }
  throw cause;
}

export function readTrustedPackageResourceSync(resource, { code = CONFIG_INVALID } = {}) {
  // 词法分类委托 Foundation classifyPathInput（同步纯函数；比本地词法检查
  // 更严格地拒绝反斜杠/NUL/UNC/盘符相对等跨平台歧义输入，fail-closed）。
  const classification = classifyPathInput(resource, process.platform);
  if (!classification.ok) fail(code, String(resource), 'INVALID_RESOURCE_PATH');

  const path = lexicalPath(resource, code);
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    fail(code, resource, 'MISSING');
  }
  assertStat(stat, resource, code);

  let physicalRoot;
  let physicalPath;
  try {
    physicalRoot = realpathSync(PKG_ROOT);
    physicalPath = realpathSync(path);
  } catch {
    fail(code, resource, 'REALPATH_FAILED');
  }
  assertPhysicalContainment(physicalRoot, physicalPath, resource, code);
  try {
    return readFileSync(physicalPath);
  } catch {
    fail(code, resource, 'READ_FAILED');
  }
}

export async function readTrustedPackageResource(resource, { code = CONFIG_INVALID } = {}) {
  // 机制委托：resolveContained（词法/符号链接/realpath 三层包含校验）。
  let target;
  try {
    target = await resolveContained(PKG_ROOT, resource);
  } catch (cause) {
    mapHarnessError(cause, resource, code);
  }

  // 本地域策略前置：拒绝任何符号链接（含指向包内目标的）、非常规文件与硬链接。
  let stat;
  try {
    stat = await lstat(target);
  } catch {
    fail(code, resource, 'MISSING');
  }
  assertStat(stat, resource, code);

  try {
    return await readFileContained(PKG_ROOT, resource);
  } catch (cause) {
    mapHarnessError(cause, resource, code);
  }
}
