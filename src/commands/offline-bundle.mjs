/**
 * 离线分发归档包导出与纯离线完整性核验子命令（`bundle-offline` / `verify-offline`，覆盖 `US-061`）。
 *
 * 核心保证：
 * 1. `bundle-offline` 仅读取工作区配置与白名单公开文件，在工作区外独立空目录生成：
 *    - 确定性源码/多宿主快照归档 `payload/<unit>-<ver>-snapshot.tgz`
 *    - 可选 npm 离线安装包 `payload/<pkg-slug>-<ver>.tgz`（标准 `package/` 前缀）
 *    - 零外网依赖的本地市场索引片段 `marketplace/offline-marketplace-index.json`
 *    - 自然中文离线安装与验真说明 `OFFLINE-INSTALL.md`
 *    - 逐文件 SHA-256 清单与整体摘要 `offline-manifest.json`
 * 2. 强制拦截将输出目录设在受检仓库根目录内或非空目录，杜绝污染工作区。
 * 3. `verify-offline` 全程零网络请求，逐字节核验归档文件集、SHA-256 摘要、包内载荷、
 *    多端清单版本一致性、零外网地址依赖与零明文凭证/本机路径泄漏。
 *
 * @module commands/offline-bundle
 */
// @decision D-RS-001
// @feature REL006
// @scenario S-007

import { createHash } from 'node:crypto';
import { execFile as execFileCb } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  posix as pathPosix,
  relative,
  resolve,
  sep,
} from 'node:path';
import { promisify } from 'node:util';
import { gunzipSync, gzipSync } from 'node:zlib';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { writeFileAtomic } from 'skill-family-harness-node';

import { loadProjectConfig } from '../core/config.mjs';
import { canonicalJson, sha256Hex } from '../core/digest.mjs';
import {
  CONFIG_INVALID,
  FORBIDDEN_CONTENT_DETECTED,
  GATE_FAILED,
  MISSING_PARAMETERS,
  ReleaseError,
  SECRET_DETECTED,
} from '../core/errors.mjs';
import { hasEmbeddedUrlCredentials } from '../core/git-url-policy.mjs';
import { readTrustedPackageResourceSync } from '../core/trusted-resource.mjs';
import { buildSnapshot } from '../snapshot/export.mjs';
import { scanSnapshot } from '../snapshot/scan.mjs';
import { parseSemverVersion } from './assess.mjs';
import { resolveUnitVersion } from './prepare.mjs';

const execFile = promisify(execFileCb);

const OFFLINE_SCHEMA = JSON.parse(
  readTrustedPackageResourceSync('schemas/offline-bundle.schema.json').toString('utf8'),
);
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(OFFLINE_SCHEMA);
const validateManifestSchema = ajv.compile({
  $ref: `${OFFLINE_SCHEMA.$id}#/definitions/offlineBundleManifest`,
});
const validateMarketplaceIndexSchema = ajv.compile({
  $ref: `${OFFLINE_SCHEMA.$id}#/definitions/offlineMarketplaceIndex`,
});

const PLUGIN_MANIFEST_CANDIDATES = Object.freeze([
  'plugin.json',
  '.claude-plugin/plugin.json',
  '.codebuddy-plugin/plugin.json',
  '.workbuddy-plugin/plugin.json',
  '.codex-plugin/plugin.json',
  '.kimi-plugin/plugin.json',
  '.qoder-plugin/plugin.json',
  '.cursor-plugin/plugin.json',
  '.grok-plugin/plugin.json',
]);

function parseJsonSafe(bytes, message, reason, extraDetails = {}) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new ReleaseError(GATE_FAILED, message, { reason, ...extraDetails });
  }
}

const BINARY_EXTS = new Set([
  '.tgz', '.gz', '.tar', '.zip', '.node', '.wasm', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf',
]);

const URL_CANDIDATE_RE = /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s'"<>`]+/g;
const EXTERNAL_URL_RE = /\b(?:https?|ssh|git):\/\/|\bgit@[A-Za-z0-9._-]+:/i;

function isInsidePath(parentPath, candidatePath) {
  const rel = relative(parentPath, candidatePath);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function normalizePosixSafePath(rawPath, label = 'archive path') {
  if (typeof rawPath !== 'string' || rawPath.length === 0 || rawPath.includes('\0')) {
    throw new ReleaseError(GATE_FAILED, `${label} 非法：路径不能为空或包含空字符`, { reason: 'UNSAFE_ARCHIVE_PATH' });
  }
  if (rawPath.startsWith('/') || rawPath.includes('\\')) {
    throw new ReleaseError(GATE_FAILED, `${label} 非法：禁止绝对路径或反斜杠`, { reason: 'UNSAFE_ARCHIVE_PATH' });
  }
  const trimmed = rawPath.replace(/^\.\//, '');
  const segments = trimmed.split('/');
  if (trimmed.length === 0 || segments.some((seg) => seg === '' || seg === '.' || seg === '..')) {
    throw new ReleaseError(GATE_FAILED, `${label} 非法：包含不安全的路径段`, { reason: 'UNSAFE_ARCHIVE_PATH' });
  }
  return trimmed;
}

function writeTarHeader({ name, size, mode = 0o644, typeflag = '0', prefix = '' }) {
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, 100, 'utf8');
  header.write(`${(mode & 0o7777).toString(8).padStart(7, '0')}\0`, 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.fill(0x20, 148, 156);
  header.write(typeflag, 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  if (prefix) header.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += header[i];
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

function buildPaxPathBlock(fullPath) {
  const recordBody = ` path=${fullPath}\n`;
  let len = Buffer.byteLength(recordBody, 'utf8') + 3;
  let line = `${len}${recordBody}`;
  while (Buffer.byteLength(line, 'utf8') !== len) {
    len = Buffer.byteLength(recordBody, 'utf8') + String(len).length;
    line = `${len}${recordBody}`;
  }
  const paxBytes = Buffer.from(line, 'utf8');
  const paxHeader = writeTarHeader({
    name: 'PaxHeaders.0/entry',
    size: paxBytes.length,
    mode: 0o644,
    typeflag: 'x',
  });
  const padded = Buffer.alloc(Math.ceil(paxBytes.length / 512) * 512, 0);
  paxBytes.copy(padded);
  return Buffer.concat([paxHeader, padded]);
}

/**
 * 将排序后的内存文件列表打包为确定性 `.tgz`（支持任意长度 UTF-8 路径的 PAX + ustar 格式）。
 *
 * @param {Array<{ path: string, bytes: Buffer, mode?: number }>} entries
 * @param {{ pathPrefix?: string }} [options]
 * @returns {Buffer}
 */
export function packDeterministicTgz(entries, { pathPrefix = '' } = {}) {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const chunks = [];
  for (const item of sorted) {
    const cleanRel = normalizePosixSafePath(item.path, 'tar entry');
    const fullPath = pathPrefix ? `${pathPrefix}/${cleanRel}` : cleanRel;
    const pathBytes = Buffer.byteLength(fullPath, 'utf8');
    let shortName = fullPath;
    if (pathBytes > 100) {
      chunks.push(buildPaxPathBlock(fullPath));
      shortName = fullPath.slice(-96);
    }
    const mode = (item.mode ?? 0o644) & 0o111 ? 0o755 : 0o644;
    chunks.push(writeTarHeader({
      name: shortName,
      size: item.bytes.length,
      mode,
      typeflag: '0',
    }));
    const padded = Buffer.alloc(Math.ceil(item.bytes.length / 512) * 512, 0);
    item.bytes.copy(padded);
    chunks.push(padded);
  }
  chunks.push(Buffer.alloc(1024, 0));
  const tarBuffer = Buffer.concat(chunks);
  const gz = Buffer.from(gzipSync(tarBuffer, { level: 9 }));
  if (gz.length >= 10) {
    gz.writeUInt32LE(0, 4); // 固定 mtime = 0，消除不同时刻/平台构建的字节差异
    gz[9] = 3; // Unix OS 标记
  }
  return gz;
}

function readNullTerminatedUtf8(buf, start, end) {
  let stop = start;
  while (stop < end && buf[stop] !== 0) stop += 1;
  return buf.subarray(start, stop).toString('utf8');
}

function parsePaxPathOverride(paxBytes) {
  const text = paxBytes.toString('utf8');
  let offset = 0;
  let resolvedPath = null;
  while (offset < text.length) {
    const spaceIdx = text.indexOf(' ', offset);
    if (spaceIdx === -1) break;
    const recordLen = Number.parseInt(text.slice(offset, spaceIdx), 10);
    if (!Number.isFinite(recordLen) || recordLen <= 0) break;
    const rawSlice = Buffer.from(text.slice(offset), 'utf8').subarray(0, recordLen).toString('utf8');
    const eqIdx = rawSlice.indexOf('=');
    if (eqIdx !== -1) {
      const key = rawSlice.slice(rawSlice.indexOf(' ') + 1, eqIdx);
      const val = rawSlice.slice(eqIdx + 1).replace(/\n$/, '');
      if (key === 'path') resolvedPath = val;
    }
    offset += rawSlice.length;
  }
  return resolvedPath;
}

/**
 * 在内存中安全解包 `.tgz` 归档，严格拒绝软硬链接、绝对路径、目录穿越与重复条目。
 *
 * @param {Buffer} tgzBytes
 * @param {string} [label]
 * @returns {Map<string, Buffer>}
 */
export function unpackDeterministicTgz(tgzBytes, label = 'offline archive') {
  let tarBuf;
  try {
    tarBuf = gunzipSync(tgzBytes);
  } catch {
    throw new ReleaseError(GATE_FAILED, `${label} 解压失败：不是合法的 gzip 归档`, { reason: 'ARCHIVE_CORRUPTED' });
  }
  if (tarBuf.length === 0 || tarBuf.length % 512 !== 0) {
    throw new ReleaseError(GATE_FAILED, `${label} 结构损坏：tar 块长度不是 512 字节整数倍`, { reason: 'ARCHIVE_CORRUPTED' });
  }
  const files = new Map();
  let offset = 0;
  let pendingPaxPath = null;

  while (offset + 512 <= tarBuf.length) {
    const header = tarBuf.subarray(offset, offset + 512);
    offset += 512;
    let allZero = true;
    for (let i = 0; i < 512; i += 1) {
      if (header[i] !== 0) {
        allZero = false;
        break;
      }
    }
    if (allZero) continue;

    const typeflag = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    const sizeOctal = readNullTerminatedUtf8(header, 124, 136).trim();
    const size = sizeOctal === '' ? 0 : Number.parseInt(sizeOctal, 8);
    if (!Number.isFinite(size) || size < 0 || offset + Math.ceil(size / 512) * 512 > tarBuf.length) {
      throw new ReleaseError(GATE_FAILED, `${label} 结构损坏：条目大小超出归档边界`, { reason: 'ARCHIVE_CORRUPTED' });
    }
    const body = Buffer.from(tarBuf.subarray(offset, offset + size));
    offset += Math.ceil(size / 512) * 512;

    if (typeflag === 'x' || typeflag === 'g') {
      if (typeflag === 'x') pendingPaxPath = parsePaxPathOverride(body);
      continue;
    }
    const rawName = readNullTerminatedUtf8(header, 0, 100);
    const rawPrefix = readNullTerminatedUtf8(header, 345, 500);
    const combinedName = pendingPaxPath ?? (rawPrefix ? `${rawPrefix}/${rawName}` : rawName);
    pendingPaxPath = null;

    if (typeflag === '5') {
      normalizePosixSafePath(combinedName.replace(/\/+$/, ''), label);
      continue;
    }
    if (typeflag !== '0') {
      throw new ReleaseError(
        GATE_FAILED,
        `${label} 包含非普通文件条目（typeflag=${typeflag}）：离线包严禁携带软链接、硬链接或特殊设备节点`,
        { reason: 'UNSAFE_ARCHIVE_ENTRY_TYPE', typeflag },
      );
    }
    const safePath = normalizePosixSafePath(combinedName, label);
    if (files.has(safePath)) {
      throw new ReleaseError(GATE_FAILED, `${label} 包含重复文件路径：${safePath}`, {
        reason: 'DUPLICATE_ARCHIVE_PATH',
        path: safePath,
      });
    }
    files.set(safePath, body);
  }
  if (files.size === 0) {
    throw new ReleaseError(GATE_FAILED, `${label} 不包含任何有效载荷文件`, { reason: 'EMPTY_ARCHIVE' });
  }
  return files;
}

async function resolvePhysicalTargetPath(rawTarget) {
  const lexical = resolve(rawTarget);
  const missingSegments = [];
  let probe = lexical;
  for (;;) {
    try {
      const st = await lstat(probe);
      if (st.isSymbolicLink()) {
        throw new ReleaseError(
          GATE_FAILED,
          '离线包输出路径不能指向或穿过符号链接目录',
          { reason: 'OFFLINE_OUTPUT_SYMLINK_FORBIDDEN' },
        );
      }
      const realBase = await realpath(probe);
      return missingSegments.length > 0
        ? join(realBase, ...missingSegments.reverse())
        : realBase;
    } catch (err) {
      if (err instanceof ReleaseError) throw err;
      if (err?.code !== 'ENOENT') throw err;
      const parent = dirname(probe);
      if (parent === probe) return lexical;
      missingSegments.push(basename(probe));
      probe = parent;
    }
  }
}

async function resolveSafeExternalOutputDir(projectRoot, rawOutputDir) {
  if (typeof rawOutputDir !== 'string' || rawOutputDir.trim().length === 0) {
    throw new ReleaseError(
      MISSING_PARAMETERS,
      'bundle-offline 必须通过 --output-dir <path> 指定位于受检仓库根之外的输出目录',
    );
  }
  const realProjectRoot = await realpath(resolve(projectRoot));
  const targetReal = await resolvePhysicalTargetPath(rawOutputDir);
  if (isInsidePath(realProjectRoot, targetReal)) {
    throw new ReleaseError(
      GATE_FAILED,
      '离线归档输出目录必须位于受检项目根目录之外，严禁污染工作区源码树',
      { reason: 'OFFLINE_OUTPUT_INSIDE_PROJECT_ROOT' },
    );
  }
  try {
    const st = await lstat(targetReal);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new ReleaseError(GATE_FAILED, '离线归档输出路径已存在且不是普通目录', {
        reason: 'OFFLINE_OUTPUT_INVALID_TARGET',
      });
    }
    const existingEntries = await readdir(targetReal);
    if (existingEntries.length > 0) {
      throw new ReleaseError(GATE_FAILED, '离线归档输出目录必须为空目录，禁止覆盖既有文件', {
        reason: 'OFFLINE_OUTPUT_NOT_EMPTY',
      });
    }
  } catch (err) {
    if (err instanceof ReleaseError) throw err;
    if (err?.code !== 'ENOENT') throw err;
  }
  return targetReal;
}

function assertNoEmbeddedCredentialsInText(relPath, textContent) {
  for (const match of textContent.matchAll(URL_CANDIDATE_RE)) {
    if (hasEmbeddedUrlCredentials(match[0])) {
      throw new ReleaseError(
        SECRET_DETECTED,
        `离线载荷文件 "${relPath}" 检测到内嵌账号或密码凭据的 URL（已拒绝输出，且未回显敏感值）`,
        { file: relPath, reason: 'EMBEDDED_URL_CREDENTIALS' },
      );
    }
  }
}

function computeOfflineBundleDigest(manifestCore) {
  const { bundleDigest: _omit, ...rest } = manifestCore;
  return sha256Hex(canonicalJson(rest));
}

function buildOfflineMarketplaceIndex({
  unit,
  version,
  tag,
  snapshotArchiveRel,
  snapshotSha256,
  npmTarballRel,
  npmPackage,
}) {
  const localRef = `./${snapshotArchiveRel}`;
  const npmRef = npmTarballRel ? `./${npmTarballRel}` : null;
  const distTypes = new Set((unit.distributions ?? []).map((d) => d.type));
  const pluginDist = (type) => (unit.distributions ?? []).find((d) => d.type === type);

  const claudeDist = pluginDist('claude-plugin');
  const codebuddyDist = pluginDist('codebuddy-plugin');
  const workbuddyDist = pluginDist('workbuddy-plugin') ?? codebuddyDist;
  const codexDist = pluginDist('codex-plugin');
  const kimiDist = pluginDist('kimi-plugin');
  const qoderDist = pluginDist('qoder-plugin');
  const cursorDist = pluginDist('cursor-plugin');
  const antigravityDist = pluginDist('antigravity-plugin');

  return {
    schemaVersion: 1,
    kind: 'release-skill/offline-marketplace-index',
    unitId: unit.id,
    version,
    tag,
    networkDependencies: 'none',
    snapshotArchive: localRef,
    snapshotSha256,
    npmTarball: npmRef,
    npmPackage: npmPackage ?? null,
    hostEntries: {
      claude: distTypes.has('claude-plugin') ? {
        name: claudeDist?.plugin ?? unit.id,
        version,
        source: { source: 'offline-archive', archive: localRef, sha256: snapshotSha256 },
      } : null,
      codebuddy: distTypes.has('codebuddy-plugin') ? {
        name: codebuddyDist?.plugin ?? unit.id,
        version,
        source: { source: 'offline-archive', archive: localRef, sha256: snapshotSha256 },
      } : null,
      codex: distTypes.has('codex-plugin') ? {
        name: codexDist?.plugin ?? unit.id,
        version,
        source: { source: 'offline-archive', archive: localRef, sha256: snapshotSha256 },
      } : null,
      kimi: distTypes.has('kimi-plugin') ? {
        id: kimiDist?.plugin ?? unit.id,
        version,
        source: localRef,
        sha256: snapshotSha256,
      } : null,
      qoder: distTypes.has('qoder-plugin') ? {
        name: qoderDist?.plugin ?? unit.id,
        version,
        strict: true,
        source: { source: 'offline-archive', archive: localRef, sha256: snapshotSha256 },
      } : null,
      cursor: distTypes.has('cursor-plugin') ? {
        name: cursorDist?.plugin ?? unit.id,
        entrySkill: cursorDist?.entrySkill ?? null,
        version,
        source: { source: 'offline-archive', archive: localRef, sha256: snapshotSha256 },
      } : null,
      antigravity: distTypes.has('antigravity-plugin') ? {
        name: antigravityDist?.plugin ?? unit.id,
        entrySkill: antigravityDist?.entrySkill ?? null,
        version,
        source: { source: 'offline-archive', archive: localRef, sha256: snapshotSha256 },
      } : null,
      workbuddy: (distTypes.has('workbuddy-plugin') || distTypes.has('codebuddy-plugin')) ? {
        name: workbuddyDist?.plugin ?? unit.id,
        version,
        source: { source: 'offline-archive', archive: localRef, sha256: snapshotSha256 },
      } : null,
    },
  };
}

function renderOfflineInstallGuideZh({
  projectName,
  unit,
  version,
  tag,
  snapshotArchiveRel,
  snapshotSha256,
  npmTarballRel,
  npmPackage,
  npmTarballSha256,
  snapshotContentDigest,
}) {
  const lines = [
    `# 离线分发归档包安装与验真说明：${unit.id}@${version}`,
    '',
    '本归档包面向无外网隔离环境、强代理企业内网或受控私有镜像分发场景生成，包内已封装完整可安装载荷、逐文件 SHA-256 清单与本地市场索引片段，安装全程不发起任何公网请求。',
    '',
    '## 一、归档包身份与摘要',
    '',
    '| 项目 | 内容 |',
    '| --- | --- |',
    `| 所属项目 / 发布单元 | \`${projectName}\` / \`${unit.id}\` |`,
    `| 版本与标签 | \`${version}\`（\`${tag}\`） |`,
    `| 分发通道可见性 | \`${unit.visibility ?? 'public'}\` |`,
    `| 快照归档文件 | \`${snapshotArchiveRel}\`（SHA-256：\`${snapshotSha256}\`） |`,
    ...(npmTarballRel
      ? [`| npm 离线安装包 | \`${npmTarballRel}\`（包名：\`${npmPackage}\`，SHA-256：\`${npmTarballSha256}\`） |`]
      : []),
    `| 快照内容摘要（snapshotContentDigest） | \`${snapshotContentDigest}\` |`,
    '',
    '## 二、安装前离线完整性核验（必做）',
    '',
    '在目标内网机器解压或拷贝本目录后，先运行离线核验命令确认字节完整性、版本一致性且无外网依赖与凭证残留：',
    '',
    '```bash',
    `release-skill verify-offline --bundle-dir <离线归档目录> --unit ${unit.id} --target-version ${version}`,
    '```',
    '',
    '若目标环境尚未安装 `release-skill`，也可直接用系统自带工具核对核心载荷哈希：',
    '',
    '```bash',
    `shasum -a 256 ${snapshotArchiveRel}`,
    `# 预期输出首列应精确等于：${snapshotSha256}`,
    '```',
    '',
    '## 三、离线安装与内网镜像导入步骤',
    '',
  ];
  if (npmTarballRel) {
    lines.push(
      '### 1. npm 包离线直装或导入私有注册表',
      '',
      '```bash',
      '# 在消费者项目中直接从本地 tarball 离线安装（禁用生命周期脚本）',
      `npm install ./${npmTarballRel} --offline --ignore-scripts`,
      '',
      '# 如需同步至企业受控私有 npm Registry（令牌仅从本机环境或 .npmrc 读取，严禁写进 URL）',
      `npm publish ./${npmTarballRel} --registry https://<企业私有Registry域名>/`,
      '```',
      '',
    );
  }
  lines.push(
    `### ${npmTarballRel ? '2' : '1'}. 多宿主插件离线解压与本地市场接入`,
    '',
    '```bash',
    '# 解压完整插件快照至受控本地插件目录',
    'mkdir -p ./installed-plugin',
    `tar -xzf ./${snapshotArchiveRel} -C ./installed-plugin`,
    '```',
    '',
    '- 解压后的目录保留原生的 `.claude-plugin/`、`.codebuddy-plugin/`、`.workbuddy-plugin/`、`.codex-plugin/`、`.kimi-plugin/`、`.qoder-plugin/`、`.cursor-plugin/` 等清单与 `adapters/`、`skills/` 载荷，可直接挂载到各宿主的本地插件目录或推送至企业内部受控 GitLab / Gitea 镜像仓库。',
    '- `marketplace/offline-marketplace-index.json` 已提供离线市场索引片段，仅绑定本地 `./payload/...` 相对路径与 SHA-256，不含任何公网 GitHub 或 npm 地址。',
    '',
    '## 四、代理与凭证安全红线',
    '',
    '- 严禁在任何 Git 远端地址、npm 注册表地址或市场索引链接中直接拼接明文用户名、密码或个人访问令牌。',
    '- 内网镜像同步所需的认证凭据只能通过目标主机的 Git Credential Helper、系统钥匙串或受权限保护的本机 `.npmrc` 环境变量注入。',
    '',
  );
  return lines.join('\n');
}

async function readGitHeadReadOnly(root) {
  try {
    const { stdout } = await execFile('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      shell: false,
      encoding: 'utf8',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      timeout: 5000,
    });
    const sha = stdout.trim();
    return /^[a-f0-9]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

async function collectRawSnapshotEntries(snapshotDir) {
  const entries = [];
  async function walk(current) {
    const items = await readdir(current, { withFileTypes: true });
    items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const item of items) {
      if (item.name === '.git') continue;
      const abs = join(current, item.name);
      const rel = relative(snapshotDir, abs).split(sep).join('/');
      const st = await lstat(abs);
      if (st.isSymbolicLink()) {
        throw new ReleaseError(GATE_FAILED, `离线快照严禁包含符号链接：${rel}`, { reason: 'SYMLINK_IN_SNAPSHOT' });
      }
      if (st.isDirectory()) {
        await walk(abs);
      } else if (st.isFile()) {
        const bytes = await readFile(abs);
        entries.push({
          path: rel,
          bytes,
          mode: st.mode,
          size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        });
      }
    }
  }
  await walk(snapshotDir);
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return entries;
}

export function formatOfflineBundleSummary(result) {
  const modeLabel = result.executionMode === 'dry-run'
    ? '仅预览校验（dry-run，未写入输出目录）'
    : '离线归档包已生成（零远端请求、零工作区污染）';
  const lines = [
    `离线分发归档：${result.unitId}@${result.version}（${result.status}）`,
    `执行模式：${modeLabel}`,
    `快照归档：${result.manifest.payload.snapshotArchive}（${result.manifest.payload.snapshotFileCount} 个文件，SHA-256: ${result.manifest.payload.snapshotSha256}）`,
  ];
  if (result.manifest.payload.npmTarball) {
    lines.push(`npm 安装包：${result.manifest.payload.npmTarball}（SHA-256: ${result.manifest.payload.npmTarballSha256}）`);
  }
  lines.push(
    `离线市场片段：${result.manifest.payload.marketplaceIndexFile}`,
    `中文安装说明：${result.manifest.payload.installGuideFile}`,
    `归档整体摘要：${result.bundleDigest}`,
  );
  return lines.join('\n');
}

export function formatOfflineVerifySummary(result) {
  return [
    `离线归档核验：${result.unitId}@${result.version}（${result.status}）`,
    `归档整体摘要：${result.bundleDigest}`,
    `已核验外层文件：${result.verifiedBundleFileCount} 个；已核验包内快照文件：${result.verifiedSnapshotFileCount} 个`,
    '安全核验结论：SHA-256 逐字节一致、多端版本一致、零外网地址依赖、零明文凭证与本机私有路径泄漏',
  ].join('\n');
}

/**
 * 打包导出指定发布单元的离线分发归档包（`release-skill bundle-offline`）。
 */
export async function bundleOfflineRelease(options = {}) {
  const {
    root = process.cwd(),
    unitId: requestedUnitId,
    outputDir: rawOutputDir,
    targetVersion: expectedVersion,
    dryRun = false,
    online = false,
    clock = () => new Date().toISOString(),
  } = options;

  if (online === true) {
    throw new ReleaseError(
      GATE_FAILED,
      'bundle-offline 仅在本地离线运行，禁止传入 --online 或触发远端网络访问',
      { reason: 'OFFLINE_BUNDLE_REMOTE_ACCESS_DISABLED' },
    );
  }

  const projectRoot = await realpath(resolve(root)).catch(() => resolve(root));
  const safeOutputDir = await resolveSafeExternalOutputDir(projectRoot, rawOutputDir);
  const { config } = await loadProjectConfig({ root: projectRoot });
  const units = config.releaseUnits ?? [];
  let unit;
  if (requestedUnitId) {
    unit = units.find((candidate) => candidate.id === requestedUnitId);
    if (!unit) {
      throw new ReleaseError(CONFIG_INVALID, `未找到发布单元 "${requestedUnitId}"`, { unitId: requestedUnitId });
    }
  } else if (units.length === 1) {
    unit = units[0];
  } else {
    throw new ReleaseError(
      MISSING_PARAMETERS,
      `项目声明了 ${units.length} 个发布单元，请通过 --unit <id> 指定要打包的单元`,
    );
  }

  const resolvedVersion = await resolveUnitVersion(unit, projectRoot);
  if (expectedVersion !== undefined) {
    if (!parseSemverVersion(expectedVersion)) {
      throw new ReleaseError(CONFIG_INVALID, `--target-version "${expectedVersion}" 不是合法的 SemVer 版本号`);
    }
    if (expectedVersion !== resolvedVersion) {
      throw new ReleaseError(
        GATE_FAILED,
        `目标版本 "${expectedVersion}" 与发布单元 "${unit.id}" 当前版本源 "${resolvedVersion}" 不一致`,
        { expectedVersion, resolvedVersion, unitId: unit.id },
      );
    }
  }

  const tag = unit.version.tagTemplate.replaceAll('{version}', resolvedVersion);
  const sourceCommit = await readGitHeadReadOnly(projectRoot);
  const stagingRoot = await realpath(await mkdtemp(join(tmpdir(), 'release-skill-offline-stage-')));

  try {
    const tmpSnapshotDir = join(stagingRoot, 'snapshot');
    await buildSnapshot({ sourceRoot: projectRoot, unit, outputDir: tmpSnapshotDir });

    const scanFindings = await scanSnapshot({
      snapshotDir: tmpSnapshotDir,
      policy: config.policy ?? {},
    });
    if (scanFindings.length > 0) {
      const first = scanFindings[0];
      throw new ReleaseError(
        first.kind?.includes('SECRET') || first.kind?.includes('TOKEN') ? SECRET_DETECTED : FORBIDDEN_CONTENT_DETECTED,
        `离线快照未通过安全泄漏扫描（共 ${scanFindings.length} 项）：${first.message}`,
        { findingCount: scanFindings.length, firstKind: first.kind, firstFile: first.file },
      );
    }

    const rawEntries = await collectRawSnapshotEntries(tmpSnapshotDir);
    for (const item of rawEntries) {
      if (!BINARY_EXTS.has(extname(item.path).toLowerCase()) && !item.bytes.subarray(0, 4096).includes(0)) {
        assertNoEmbeddedCredentialsInText(item.path, item.bytes.toString('utf8'));
      }
    }

    const snapshotFiles = rawEntries.map(({ path, sha256, size }) => ({ path, sha256, size }));
    const snapshotContentDigest = sha256Hex(canonicalJson(snapshotFiles));
    const snapshotArchiveRel = `payload/${unit.id}-${resolvedVersion}-snapshot.tgz`;
    const snapshotArchiveBytes = packDeterministicTgz(rawEntries);
    const snapshotSha256 = sha256Hex(snapshotArchiveBytes);

    const npmDist = (unit.distributions ?? []).find((d) => d.type === 'npm') ?? null;
    let npmTarballRel = null;
    let npmTarballBytes = null;
    let npmTarballSha256 = null;
    const npmPackage = npmDist?.package ?? null;

    if (npmDist) {
      const pkgEntry = rawEntries.find((item) => item.path === 'package.json');
      if (!pkgEntry) {
        throw new ReleaseError(GATE_FAILED, `发布单元 "${unit.id}" 声明了 npm 分发，但公开快照缺少 package.json`);
      }
      const pkgParsed = parseJsonSafe(
        pkgEntry.bytes,
        '公开快照 package.json 不是合法的 JSON 文档',
        'PACKAGE_JSON_PARSE_FAILED',
        { file: 'package.json' },
      );
      if (pkgParsed.name !== npmPackage || pkgParsed.version !== resolvedVersion) {
        throw new ReleaseError(
          GATE_FAILED,
          `公开快照 package.json 身份（${pkgParsed.name}@${pkgParsed.version}）与单元声明（${npmPackage}@${resolvedVersion}）不一致`,
        );
      }
      const npmSlug = npmPackage.replace(/^@/, '').replaceAll('/', '-');
      npmTarballRel = `payload/${npmSlug}-${resolvedVersion}.tgz`;
      npmTarballBytes = packDeterministicTgz(rawEntries, { pathPrefix: 'package' });
      npmTarballSha256 = sha256Hex(npmTarballBytes);
    }

    const marketplaceIndexRel = 'marketplace/offline-marketplace-index.json';
    const marketplaceIndexObj = buildOfflineMarketplaceIndex({
      unit,
      version: resolvedVersion,
      tag,
      snapshotArchiveRel,
      snapshotSha256,
      npmTarballRel,
      npmPackage,
    });
    if (!validateMarketplaceIndexSchema(marketplaceIndexObj)) {
      throw new ReleaseError(GATE_FAILED, '生成的离线市场索引片段未通过 Schema 校验');
    }
    const marketplaceIndexBytes = Buffer.from(`${JSON.stringify(marketplaceIndexObj, null, 2)}\n`, 'utf8');

    const installGuideRel = 'OFFLINE-INSTALL.md';
    const createdAt = clock();
    const provisionalBundleFiles = [
      ...(npmTarballRel ? [{ path: npmTarballRel, sha256: npmTarballSha256, size: npmTarballBytes.length }] : []),
      { path: snapshotArchiveRel, sha256: snapshotSha256, size: snapshotArchiveBytes.length },
      { path: marketplaceIndexRel, sha256: sha256Hex(marketplaceIndexBytes), size: marketplaceIndexBytes.length },
    ];

    const installGuideText = renderOfflineInstallGuideZh({
      projectName: config.project.name,
      unit,
      version: resolvedVersion,
      tag,
      snapshotArchiveRel,
      snapshotSha256,
      npmTarballRel,
      npmPackage,
      npmTarballSha256,
      snapshotContentDigest,
    });
    const installGuideBytes = Buffer.from(installGuideText, 'utf8');

    const bundleFiles = [
      ...provisionalBundleFiles,
      { path: installGuideRel, sha256: sha256Hex(installGuideBytes), size: installGuideBytes.length },
    ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    const manifestWithoutDigest = {
      schemaVersion: 1,
      kind: 'release-skill/offline-bundle-manifest',
      projectName: config.project.name,
      unitId: unit.id,
      publicRepo: unit.publicRepo,
      visibility: unit.visibility ?? 'public',
      version: resolvedVersion,
      tag,
      sourceCommit,
      createdAt,
      offlineSelfContained: true,
      remoteWritesPerformed: false,
      networkDependencies: 'none',
      payload: {
        snapshotArchive: snapshotArchiveRel,
        snapshotSha256,
        snapshotContentDigest,
        snapshotFileCount: snapshotFiles.length,
        npmTarball: npmTarballRel,
        npmPackage,
        npmTarballSha256,
        marketplaceIndexFile: marketplaceIndexRel,
        installGuideFile: installGuideRel,
      },
      snapshotFiles,
      bundleFiles,
    };
    const bundleDigest = computeOfflineBundleDigest(manifestWithoutDigest);
    const manifest = { ...manifestWithoutDigest, bundleDigest };

    if (!validateManifestSchema(manifest)) {
      const msg = (validateManifestSchema.errors ?? []).map((e) => `${e.instancePath || '/'}: ${e.message}`).join('; ');
      throw new ReleaseError(GATE_FAILED, `生成的 offline-manifest.json 未通过 Schema 校验：${msg}`);
    }

    if (!dryRun) {
      await mkdir(join(safeOutputDir, 'payload'), { recursive: true });
      await mkdir(join(safeOutputDir, 'marketplace'), { recursive: true });
      await writeFileAtomic(safeOutputDir, snapshotArchiveRel, snapshotArchiveBytes);
      if (npmTarballRel && npmTarballBytes) {
        await writeFileAtomic(safeOutputDir, npmTarballRel, npmTarballBytes);
      }
      await writeFileAtomic(safeOutputDir, marketplaceIndexRel, marketplaceIndexBytes);
      await writeFileAtomic(safeOutputDir, installGuideRel, installGuideBytes);
      await writeFileAtomic(safeOutputDir, 'offline-manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
    }

    const response = {
      command: 'bundle-offline',
      status: dryRun ? 'DRY_RUN_READY' : 'BUNDLED',
      executionMode: dryRun ? 'dry-run' : 'offline',
      remoteWritesPerformed: false,
      unitId: unit.id,
      version: resolvedVersion,
      tag,
      bundleDigest,
      manifest,
    };
    response.summary = formatOfflineBundleSummary(response);
    return response;
  } finally {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
  }
}

function assertZeroExternalNetworkReferences(node, jsonPath = '$') {
  if (typeof node === 'string') {
    if (EXTERNAL_URL_RE.test(node)) {
      throw new ReleaseError(
        GATE_FAILED,
        `离线市场索引字段 "${jsonPath}" 检测到外部网络地址依赖（离线包索引仅允许引用本地 ./payload/*.tgz）`,
        { reason: 'EXTERNAL_NETWORK_DEPENDENCY_DETECTED', jsonPath },
      );
    }
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item, idx) => assertZeroExternalNetworkReferences(item, `${jsonPath}[${idx}]`));
    return;
  }
  if (node && typeof node === 'object') {
    for (const [key, val] of Object.entries(node)) {
      assertZeroExternalNetworkReferences(val, `${jsonPath}.${key}`);
    }
  }
}

/**
 * 纯离线核验归档包的逐字节完整性、多端版本一致性、零外网依赖与零凭证/路径泄漏（`release-skill verify-offline`）。
 */
export async function verifyOfflineBundle(options = {}) {
  const {
    bundleDir: rawBundleDir,
    unitId: expectedUnitId,
    targetVersion: expectedVersion,
    online = false,
  } = options;

  if (online === true) {
    throw new ReleaseError(
      GATE_FAILED,
      'verify-offline 必须在完全无网络依赖模式下运行，禁止传入 --online',
      { reason: 'OFFLINE_VERIFY_REMOTE_ACCESS_DISABLED' },
    );
  }
  if (typeof rawBundleDir !== 'string' || rawBundleDir.trim().length === 0) {
    throw new ReleaseError(MISSING_PARAMETERS, 'verify-offline 必须通过 --bundle-dir <path> 指定待核验的离线归档目录');
  }

  const resolvedLexical = resolve(rawBundleDir);
  let rootStat;
  try {
    rootStat = await lstat(resolvedLexical);
  } catch {
    throw new ReleaseError(GATE_FAILED, '待核验的离线归档目录不存在', { reason: 'BUNDLE_DIR_MISSING' });
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new ReleaseError(GATE_FAILED, '待核验的离线归档目录必须是普通目录，禁止使用符号链接', {
      reason: 'BUNDLE_DIR_INVALID',
    });
  }
  const bundleRoot = await realpath(resolvedLexical);

  const diskFiles = new Map();
  async function walkBundle(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const abs = join(current, entry.name);
      const rel = relative(bundleRoot, abs).split(sep).join('/');
      const st = await lstat(abs);
      if (st.isSymbolicLink() || (!st.isDirectory() && !st.isFile())) {
        throw new ReleaseError(GATE_FAILED, `离线归档目录包含非法符号链接或特殊文件：${rel}`, {
          reason: 'UNSAFE_BUNDLE_ENTRY',
          file: rel,
        });
      }
      if (st.isDirectory()) {
        await walkBundle(abs);
      } else {
        diskFiles.set(rel, await readFile(abs));
      }
    }
  }
  await walkBundle(bundleRoot);

  const manifestBytes = diskFiles.get('offline-manifest.json');
  if (!manifestBytes) {
    throw new ReleaseError(GATE_FAILED, '离线归档目录缺少核心清单 offline-manifest.json', {
      reason: 'MANIFEST_MISSING',
    });
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    throw new ReleaseError(GATE_FAILED, 'offline-manifest.json 不是合法的 JSON 文档', {
      reason: 'MANIFEST_PARSE_FAILED',
    });
  }
  if (!validateManifestSchema(manifest)) {
    const summary = (validateManifestSchema.errors ?? []).map((e) => `${e.instancePath || '/'}: ${e.message}`).join('; ');
    throw new ReleaseError(GATE_FAILED, `offline-manifest.json 未通过结构契约校验：${summary}`, {
      reason: 'MANIFEST_SCHEMA_INVALID',
    });
  }

  if (expectedUnitId && manifest.unitId !== expectedUnitId) {
    throw new ReleaseError(
      GATE_FAILED,
      `离线包单元身份不匹配：清单为 "${manifest.unitId}"，期望 "${expectedUnitId}"`,
      { reason: 'UNIT_MISMATCH', actual: manifest.unitId, expected: expectedUnitId },
    );
  }
  if (expectedVersion && manifest.version !== expectedVersion) {
    throw new ReleaseError(
      GATE_FAILED,
      `离线包版本不匹配：清单为 "${manifest.version}"，期望 "${expectedVersion}"`,
      { reason: 'VERSION_MISMATCH', actual: manifest.version, expected: expectedVersion },
    );
  }

  const recomputedDigest = computeOfflineBundleDigest(manifest);
  if (recomputedDigest !== manifest.bundleDigest) {
    throw new ReleaseError(GATE_FAILED, 'offline-manifest.json 的 bundleDigest 校验失败（清单已被篡改）', {
      reason: 'MANIFEST_DIGEST_MISMATCH',
    });
  }

  const actualOuterRelPaths = [...diskFiles.keys()].filter((p) => p !== 'offline-manifest.json').sort();
  const expectedOuterRelPaths = manifest.bundleFiles.map((f) => f.path).sort();
  if (JSON.stringify(actualOuterRelPaths) !== JSON.stringify(expectedOuterRelPaths)) {
    throw new ReleaseError(
      GATE_FAILED,
      '离线归档外层文件集合与 offline-manifest.json 记录不一致（存在缺失或未授权附加文件）',
      { reason: 'BUNDLE_FILE_SET_MISMATCH', actual: actualOuterRelPaths, expected: expectedOuterRelPaths },
    );
  }
  for (const item of manifest.bundleFiles) {
    const bytes = diskFiles.get(item.path);
    const actualSha = sha256Hex(bytes);
    if (bytes.length !== item.size || actualSha !== item.sha256) {
      throw new ReleaseError(
        GATE_FAILED,
        `离线归档文件 "${item.path}" 字节长度或 SHA-256 摘要不匹配`,
        { reason: 'BUNDLE_FILE_HASH_MISMATCH', file: item.path },
      );
    }
  }

  const mktBytes = diskFiles.get(manifest.payload.marketplaceIndexFile);
  if (!mktBytes) {
    throw new ReleaseError(GATE_FAILED, `缺少离线市场索引文件：${manifest.payload.marketplaceIndexFile}`, {
      reason: 'MARKETPLACE_INDEX_MISSING',
    });
  }
  const mktObj = parseJsonSafe(
    mktBytes,
    '离线市场索引片段不是合法的 JSON 文档',
    'MARKETPLACE_INDEX_PARSE_FAILED',
    { file: manifest.payload.marketplaceIndexFile },
  );
  if (!validateMarketplaceIndexSchema(mktObj)) {
    throw new ReleaseError(GATE_FAILED, '离线市场索引片段未通过 Schema 校验', {
      reason: 'MARKETPLACE_INDEX_INVALID',
    });
  }
  assertZeroExternalNetworkReferences(mktObj);
  if (
    mktObj.unitId !== manifest.unitId
    || mktObj.version !== manifest.version
    || mktObj.tag !== manifest.tag
    || mktObj.snapshotSha256 !== manifest.payload.snapshotSha256
    || mktObj.snapshotArchive !== `./${manifest.payload.snapshotArchive}`
  ) {
    throw new ReleaseError(GATE_FAILED, '离线市场索引片段的身份、版本或载荷哈希与 offline-manifest.json 不一致', {
      reason: 'MARKETPLACE_INDEX_MISMATCH',
    });
  }

  const snapshotBytes = diskFiles.get(manifest.payload.snapshotArchive);
  if (!snapshotBytes || sha256Hex(snapshotBytes) !== manifest.payload.snapshotSha256) {
    throw new ReleaseError(GATE_FAILED, '核心快照归档缺失或 SHA-256 不匹配', { reason: 'SNAPSHOT_ARCHIVE_MISMATCH' });
  }
  const extractedSnapshot = unpackDeterministicTgz(snapshotBytes, manifest.payload.snapshotArchive);
  const extractedSnapshotList = [...extractedSnapshot.entries()]
    .map(([path, buf]) => ({ path, sha256: sha256Hex(buf), size: buf.length }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  if (
    extractedSnapshotList.length !== manifest.payload.snapshotFileCount
    || JSON.stringify(extractedSnapshotList) !== JSON.stringify(manifest.snapshotFiles)
    || sha256Hex(canonicalJson(extractedSnapshotList)) !== manifest.payload.snapshotContentDigest
  ) {
    throw new ReleaseError(GATE_FAILED, '快照归档内部文件逐字节校验与 offline-manifest.json.snapshotFiles 不一致', {
      reason: 'SNAPSHOT_CONTENT_MISMATCH',
    });
  }

  if (manifest.payload.npmTarball) {
    const npmBytes = diskFiles.get(manifest.payload.npmTarball);
    if (!npmBytes || sha256Hex(npmBytes) !== manifest.payload.npmTarballSha256) {
      throw new ReleaseError(GATE_FAILED, 'npm 离线安装包缺失或 SHA-256 不匹配', { reason: 'NPM_TARBALL_MISMATCH' });
    }
    const extractedNpm = unpackDeterministicTgz(npmBytes, manifest.payload.npmTarball);
    const strippedNpmList = [];
    for (const [entryPath, buf] of extractedNpm.entries()) {
      if (!entryPath.startsWith('package/') || entryPath === 'package/') {
        throw new ReleaseError(GATE_FAILED, `npm 离线包包含非标准 package/ 前缀条目：${entryPath}`, {
          reason: 'NPM_TARBALL_LAYOUT_INVALID',
        });
      }
      strippedNpmList.push({
        path: entryPath.slice('package/'.length),
        sha256: sha256Hex(buf),
        size: buf.length,
      });
    }
    strippedNpmList.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    if (JSON.stringify(strippedNpmList) !== JSON.stringify(manifest.snapshotFiles)) {
      throw new ReleaseError(GATE_FAILED, 'npm 离线包内容与已核验快照文件集不一致', {
        reason: 'NPM_TARBALL_CONTENT_MISMATCH',
      });
    }
  }

  if (!manifest.tag.includes(manifest.version)) {
    throw new ReleaseError(GATE_FAILED, `标签 "${manifest.tag}" 未包含版本号 "${manifest.version}"`, {
      reason: 'VERSION_INCONSISTENT',
    });
  }
  const pkgBuf = extractedSnapshot.get('package.json');
  if (pkgBuf) {
    const pkgJson = parseJsonSafe(
      pkgBuf,
      '快照内 package.json 不是合法的 JSON 文档',
      'PACKAGE_JSON_PARSE_FAILED',
      { file: 'package.json' },
    );
    if (pkgJson.version && pkgJson.version !== manifest.version) {
      throw new ReleaseError(
        GATE_FAILED,
        `快照内 package.json 版本 "${pkgJson.version}" 与清单版本 "${manifest.version}" 不一致`,
        { reason: 'VERSION_INCONSISTENT', file: 'package.json' },
      );
    }
    if (manifest.payload.npmPackage && pkgJson.name !== manifest.payload.npmPackage) {
      throw new ReleaseError(
        GATE_FAILED,
        `快照内 package.json 名称 "${pkgJson.name}" 与清单 npmPackage "${manifest.payload.npmPackage}" 不一致`,
        { reason: 'PACKAGE_NAME_INCONSISTENT', file: 'package.json' },
      );
    }
  }
  for (const manifestRel of PLUGIN_MANIFEST_CANDIDATES) {
    const rawPlugin = extractedSnapshot.get(manifestRel);
    if (!rawPlugin) continue;
    const pluginJson = parseJsonSafe(
      rawPlugin,
      `宿主插件清单 "${manifestRel}" 不是合法的 JSON 文档`,
      'PLUGIN_MANIFEST_PARSE_FAILED',
      { file: manifestRel },
    );
    if (pluginJson.version !== undefined && pluginJson.version !== manifest.version) {
      throw new ReleaseError(
        GATE_FAILED,
        `宿主插件清单 "${manifestRel}" 版本 "${pluginJson.version}" 与离线包版本 "${manifest.version}" 不一致`,
        { reason: 'VERSION_INCONSISTENT', file: manifestRel },
      );
    }
  }

  const scanTemp = await mkdtemp(join(tmpdir(), 'release-skill-offline-verify-'));
  try {
    for (const [rel, buf] of extractedSnapshot.entries()) {
      const dest = join(scanTemp, 'snapshot', rel);
      await mkdir(dirname(dest), { recursive: true });
      await writeFileAtomic(dirname(dest), basename(dest), buf);
      if (!BINARY_EXTS.has(extname(rel).toLowerCase()) && !buf.subarray(0, 4096).includes(0)) {
        assertNoEmbeddedCredentialsInText(rel, buf.toString('utf8'));
      }
    }
    for (const [rel, buf] of diskFiles.entries()) {
      if (BINARY_EXTS.has(extname(rel).toLowerCase())) continue;
      const dest = join(scanTemp, 'outer', rel);
      await mkdir(dirname(dest), { recursive: true });
      await writeFileAtomic(dirname(dest), basename(dest), buf);
      assertNoEmbeddedCredentialsInText(rel, buf.toString('utf8'));
    }
    const leakFindings = await scanSnapshot({ snapshotDir: scanTemp, policy: {} });
    if (leakFindings.length > 0) {
      const first = leakFindings[0];
      throw new ReleaseError(
        first.kind?.includes('SECRET') || first.kind?.includes('TOKEN') ? SECRET_DETECTED : FORBIDDEN_CONTENT_DETECTED,
        `离线归档包存在凭证或本机私有路径泄漏（共 ${leakFindings.length} 项）：${first.message}`,
        { reason: 'CREDENTIAL_OR_LEAK_DETECTED', findingCount: leakFindings.length, firstKind: first.kind },
      );
    }
  } finally {
    await rm(scanTemp, { recursive: true, force: true }).catch(() => {});
  }

  const response = {
    command: 'verify-offline',
    status: 'VERIFIED',
    offlineVerified: true,
    networkRequestsPerformed: 0,
    unitId: manifest.unitId,
    version: manifest.version,
    tag: manifest.tag,
    visibility: manifest.visibility,
    bundleDigest: manifest.bundleDigest,
    verifiedBundleFileCount: manifest.bundleFiles.length,
    verifiedSnapshotFileCount: manifest.snapshotFiles.length,
  };
  response.summary = formatOfflineVerifySummary(response);
  return response;
}
