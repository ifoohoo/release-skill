/**
 * Pure producer: build adapters from skills and plugin templates.
 *
 * Reads skill metadata from skills-src/ and plugin.json templates,
 * generates self-contained adapter directories for each platform
 * (claude, codex, kimi, and the build-only workbuddy adapter).
 *
 * Each adapter root contains:
 * - Plugin manifest (.claude-plugin/, .codex-plugin/, .kimi-plugin/, or
 *   .codebuddy-plugin/)
 * - Skills with host-specific root resolution
 * - bin/release-skill.mjs (wrapper) + bin/release-skill.bundle.mjs (self-contained bundle)
 * - schemas/ (JSON Schema files)
 * - native/safe-write/ (prebuilds.json + platform binaries)
 *
 * Deterministic: sorted directory enumeration, no timestamps, no randomness.
 *
 * @module producers/build-adapters
 */

import { readdir, mkdir, lstat, realpath, open, rm } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join, dirname, relative, isAbsolute, sep, resolve, posix as pathPosix } from 'node:path';

import { sha256Hex } from '../core/digest.mjs';
import { digestDocument } from 'skill-family-contracts';
import { digestBytes, readFileStrict } from 'skill-family-harness-node';
import { PLATFORMS as PLATFORM_REGISTRY } from '../platforms/registry.mjs';

/**
 * Assert that a resolved real path is contained within the allowed root.
 *
 * @param {string} resolvedPath - Absolute resolved (realpath) path.
 * @param {string} root - Absolute package root.
 * @param {string} label - Human-readable label for error messages.
 */
function assertWithinRoot(resolvedPath, root, label) {
  const rel = relative(root, resolvedPath);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(
      `SECURITY: ${label} escapes package root: resolved=${resolvedPath} root=${root}`,
    );
  }
}

function assertRegularSingleLink(fileStat, label) {
  if (fileStat.isSymbolicLink()) throw new Error(`SECURITY: ${label} is a symlink`);
  if (!fileStat.isFile()) throw new Error(`SECURITY: ${label} is not a regular file`);
  if (fileStat.nlink !== 1) throw new Error(`SECURITY: ${label} has an unexpected hard-link count`);
}

async function assertTrustedDirectory(dirPath, physicalRoot, label) {
  let dirStat;
  try {
    dirStat = await lstat(dirPath);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`SECURITY: ${label} is missing`);
    throw error;
  }
  if (dirStat.isSymbolicLink()) throw new Error(`SECURITY: ${label} is a symlink`);
  if (!dirStat.isDirectory()) throw new Error(`SECURITY: ${label} is not a directory`);
  const physicalPath = await realpath(dirPath);
  assertWithinRoot(physicalPath, physicalRoot, label);
  return physicalPath;
}

async function readTrustedFile(filePath, physicalRoot, label, encoding = null) {
  let lexicalStat;
  try {
    lexicalStat = await lstat(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`SECURITY: ${label} is missing`);
    throw error;
  }
  assertRegularSingleLink(lexicalStat, label);
  const physicalPath = await realpath(filePath);
  assertWithinRoot(physicalPath, physicalRoot, label);

  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const handle = await open(physicalPath, fsConstants.O_RDONLY | noFollow);
  try {
    const openedStat = await handle.stat();
    assertRegularSingleLink(openedStat, label);
    if (openedStat.dev !== lexicalStat.dev || openedStat.ino !== lexicalStat.ino) {
      throw new Error(`SECURITY: ${label} changed during trusted open`);
    }
    const content = await handle.readFile(encoding ? { encoding } : undefined);
    const finalStat = await handle.stat();
    if (finalStat.dev !== openedStat.dev
        || finalStat.ino !== openedStat.ino
        || finalStat.size !== openedStat.size
        || finalStat.mtimeMs !== openedStat.mtimeMs) {
      throw new Error(`SECURITY: ${label} changed during read`);
    }
    return content;
  } finally {
    await handle.close();
  }
}

async function assertSafeNewOutputRoot(requestedPath, label) {
  if (typeof requestedPath !== 'string' || requestedPath.trim() === '') {
    throw new Error(`SECURITY: ${label} must be a non-empty path`);
  }
  const absolutePath = resolve(requestedPath);
  try {
    const targetStat = await lstat(absolutePath);
    if (targetStat.isSymbolicLink()) {
      throw new Error(`SECURITY: ${label} is a symlink: ${absolutePath}`);
    }
    throw new Error(`SECURITY: ${label} already exists: ${absolutePath}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  let cursor = dirname(absolutePath);
  while (true) {
    const ancestorStat = await lstat(cursor);
    if (ancestorStat.isSymbolicLink()) {
      const physicalAncestor = await realpath(cursor);
      const allowedSystemAlias = (cursor === '/var' && physicalAncestor === '/private/var')
        || (cursor === '/tmp' && physicalAncestor === '/private/tmp');
      if (!allowedSystemAlias) {
        throw new Error(`SECURITY: ${label} ancestor is a symlink: ${cursor}`);
      }
    } else if (!ancestorStat.isDirectory()) {
      throw new Error(`SECURITY: ${label} ancestor is not a directory: ${cursor}`);
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return absolutePath;
}

function assertDisjointOutputRoots(entries) {
  for (let index = 0; index < entries.length; index += 1) {
    for (let otherIndex = index + 1; otherIndex < entries.length; otherIndex += 1) {
      const [leftName, leftPath] = entries[index];
      const [rightName, rightPath] = entries[otherIndex];
      const leftToRight = relative(leftPath, rightPath);
      const rightToLeft = relative(rightPath, leftPath);
      const rightInsideLeft = leftToRight === ''
        || (!leftToRight.startsWith(`..${sep}`) && leftToRight !== '..' && !isAbsolute(leftToRight));
      const leftInsideRight = rightToLeft === ''
        || (!rightToLeft.startsWith(`..${sep}`) && rightToLeft !== '..' && !isAbsolute(rightToLeft));
      if (rightInsideLeft || leftInsideRight) {
        throw new Error(`SECURITY: output roots overlap: ${leftName}=${leftPath} ${rightName}=${rightPath}`);
      }
    }
  }
}

async function assertOwnedOutputRoot(rootPath, identity, label) {
  const current = await lstat(rootPath);
  if (current.isSymbolicLink() || !current.isDirectory()
      || current.dev !== identity.dev || current.ino !== identity.ino) {
    throw new Error(`SECURITY: ${label} changed during output generation`);
  }
}

async function ensureTrustedOutputDirectory(rootPath, rootIdentity, relativeDir, label) {
  let cursor = rootPath;
  for (const segment of relativeDir.split(sep).filter(Boolean)) {
    await assertOwnedOutputRoot(rootPath, rootIdentity, label);
    cursor = join(cursor, segment);
    try {
      await mkdir(cursor, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    const current = await lstat(cursor);
    if (current.isSymbolicLink() || !current.isDirectory()) {
      throw new Error(`SECURITY: ${label} output directory is untrusted: ${cursor}`);
    }
    const physicalCursor = await realpath(cursor);
    const physicalRoot = await realpath(rootPath);
    assertWithinRoot(physicalCursor, physicalRoot, `${label} output directory`);
  }
  return cursor;
}

/**
 * Compute an implementation digest from the source bytes of this module.
 *
 * @param {Buffer[]} sourceBytes
 * @returns {string}
 */
export function computeBuildAdaptersDigest(sourceBytes) {
  // 多段哈希（源字节 + node 版本 + 固定 locale/timezone）等价于对拼接字节
  // 的 sha256，委托 Foundation digestBytes 实现，字节逐位一致。
  const bytes = Buffer.concat([
    ...sourceBytes,
    Buffer.from(`node:${process.version}`),
    Buffer.from('locale:en-US timezone:UTC'),
  ]);
  return `sha256:${digestBytes(bytes)}`;
}

// Platform definitions, derived from the platform registry (the single source
// of platform knowledge). The build shape mirrors the legacy inline table
// byte-for-byte: marketplaceFileName is present only when the platform
// co-locates a marketplace manifest in its plugin dir (claude).
//
// The build adapter NAME defaults to the platform id, but a platform may keep a
// historical directory name distinct from its pipeline id via
// `buildAdapter.name`: codebuddy (pipeline id) builds the `workbuddy` adapter
// tree (adapters/workbuddy/, manifest .codebuddy-plugin/plugin.json). This is
// what lets codebuddy join the publish pipeline WITHOUT changing a single byte
// of the generated workbuddy adapter (the former BUILD_ONLY workbuddy entry).
const REGISTRY_PLATFORMS = PLATFORM_REGISTRY.map((platform) => ({
  name: platform.buildAdapter?.name ?? platform.id,
  pluginDirName: platform.buildAdapter.pluginDirName,
  templateFileName: platform.buildAdapter.templateFileName,
  ...(platform.buildAdapter.hasMarketplace
    ? { marketplaceFileName: platform.buildAdapter.marketplaceFileName }
    : {}),
  hasMarketplace: platform.buildAdapter.hasMarketplace,
}));

/**
 * Build-only distribution adapters: generated, self-contained plugin trees
 * that are NOT wired into the automated publish/reconcile/verify pipeline —
 * no registry PLATFORMS membership, no distributionType/actionType in the
 * plan schemas, no automated install checkpoint. A host joins the pipeline
 * only with a full registry descriptor (strategy, CLI protocol, schema enum);
 * until then a build-only entry lets the build emit an installable adapter
 * tree without fabricating an unverified install protocol.
 *
 * Currently EMPTY: every platform the build emits now has a full registry
 * descriptor. workbuddy (the CodeBuddy/WorkBuddy plugin, manifest
 * `.codebuddy-plugin/plugin.json`, `${CODEBUDDY_PLUGIN_ROOT}` expanded inline
 * in skill content) moved into the registry as the `codebuddy` platform with
 * `buildAdapter.name = 'workbuddy'`, so its adapter tree is still produced —
 * byte-for-byte unchanged — via REGISTRY_PLATFORMS. This constant is retained
 * (still exported and consumed below) for future build-only hosts that have an
 * installable adapter tree but no verified install protocol yet.
 */
export const BUILD_ONLY_ADAPTERS = Object.freeze([]);

export const PLATFORMS = Object.freeze([...REGISTRY_PLATFORMS, ...BUILD_ONLY_ADAPTERS]);

const REQUIRED_SCHEMA_FILES = Object.freeze([
  'approval-record.schema.json',
  'artifact-policy.schema.json',
  'release-plan.schema.json',
  'release-project.schema.json',
  'release-run.schema.json',
]);

/**
 * Collect skill metadata from skills-src/.
 *
 * @param {string} srcDir - Absolute path to skills-src/.
 * @returns {Promise<Array<{name:string,description:string,content:string}>>}
 */
async function collectSkills(srcDir, physicalRoot) {
  const physicalSrcDir = await assertTrustedDirectory(srcDir, physicalRoot, 'skills-src/');
  const entries = await readdir(physicalSrcDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw new Error(`SECURITY: skills-src/${entry.name} is a symlink`);
    }
  }
  const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  dirs.sort();

  const skills = [];
  for (const dirName of dirs) {
    const skillDirPath = join(physicalSrcDir, dirName);
    const skillMdPath = join(skillDirPath, 'SKILL.md');

    // Reject symlinks at any level: skill directory itself must resolve within root.
    await assertTrustedDirectory(skillDirPath, physicalRoot, `skill directory ${dirName}`);
    const content = await readTrustedFile(
      skillMdPath,
      physicalRoot,
      `skills-src/${dirName}/SKILL.md`,
      'utf-8',
    );

    // Extract description: first paragraph of the first ## section.
    const lines = content.split('\n');
    let inFirstSection = false;
    let pastSectionHeader = false;
    const descLines = [];
    for (const line of lines) {
      if (line.startsWith('## ')) {
        if (inFirstSection) break;
        inFirstSection = true;
        continue;
      }
      if (inFirstSection && !pastSectionHeader) {
        if (line.trim() === '') pastSectionHeader = true;
        continue;
      }
      if (pastSectionHeader) {
        if (line.trim() === '') break;
        descLines.push(line);
      }
    }
    const description = descLines.join('\n').trim();
    skills.push({ name: dirName, description, content });
  }
  return skills;
}

/**
 * Preamble prepended to every Codex SKILL.md.
 *
 * Codex agents load SKILL.md as data, not as a shell script.
 * BASH_SOURCE / $0 do NOT point to SKILL.md — they point to the
 * invoking shell or are unset entirely (verified in zsh -c / bash -c).
 * The agent MUST resolve the entry point from the SKILL.md file path
 * that the host already provided/loaded.
 */
const CODEX_PREAMBLE = `\
> **Codex 安装入口解析协议**：在调用 CLI 前，Agent 必须从宿主当前已加载技能的元数据中取得本 \`SKILL.md\` 的实际绝对路径，并将该字面量记为 \`SKILL_FILE\`。\n\
> \`SKILL_FILE\` 不是环境变量；禁止从工作目录、可执行搜索路径、源码仓库或 shell 调用上下文猜测。若宿主未提供该绝对路径，立即停止并报告安装定位失败。\n\
> 对 \`SKILL_FILE\` 执行 \`realpath\`，取其目录向上两级得到 \`PLUGIN_ROOT\`；校验真实技能路径匹配 \`PLUGIN_ROOT/skills/*/SKILL.md\` 且仍位于插件根内（路径包含检查）。\n\
> 令 \`RELEASE_SKILL_ENTRY=PLUGIN_ROOT/bin/release-skill.mjs\`，对入口执行 \`realpath\` containment、\`lstat\` 非符号链接且为普通文件校验。\n\
> 每一次 shell 工具调用都必须在同一个调用中用上述已验证绝对值设置 \`RELEASE_SKILL_ENTRY\`，然后执行 \`node "$RELEASE_SKILL_ENTRY" ...\`；不得依赖前一次 shell 的变量。\n\
>\n\
`;

/**
 * Preamble prepended to every Kimi Code SKILL.md.
 *
 * Kimi Code's official Agent Skills contract defines the body placeholder
 * `${KIMI_SKILL_DIR}`: the host expands it to the absolute directory containing
 * the current SKILL.md before sending the body to the agent. This is the ONLY
 * authoritative input for locating the entry point — the agent must NOT guess
 * any undocumented host-metadata path. The literal placeholder is emitted
 * verbatim (the generator does not pre-expand it); the host expands it at load
 * time. Generated skills live at `<pluginRoot>/skills/<name>/SKILL.md`, so the
 * plugin root is two levels above the expanded skill directory.
 */
const KIMI_PREAMBLE = `\
> **Kimi Code 安装入口解析协议**：Kimi Code 官方技能契约提供正文占位符 \`\${KIMI_SKILL_DIR}\`，宿主在向 Agent 发送正文前会将其展开为当前 \`SKILL.md\` 所在目录的绝对路径。必须把展开后的字面量作为当前技能目录的唯一权威输入，记为 \`SKILL_DIR\`。\n\
> 禁止从工作目录、可执行搜索路径、源码仓库、shell 调用上下文或任何未记载的宿主元数据路径猜测技能目录。若正文中的 \`\${KIMI_SKILL_DIR}\` 未被宿主展开（仍是字面量占位符），立即停止并报告安装定位失败。\n\
> 对 \`SKILL_DIR\` 执行 \`realpath\`，取其目录向上两级得到 \`PLUGIN_ROOT\`；校验真实技能路径匹配 \`PLUGIN_ROOT/skills/*/SKILL.md\` 且仍位于插件根内（路径包含检查）。\n\
> 令 \`RELEASE_SKILL_ENTRY=PLUGIN_ROOT/bin/release-skill.mjs\`，对入口执行 \`realpath\` containment、\`lstat\` 非符号链接且为普通文件校验。\n\
> 每一次 shell 工具调用都必须在同一个调用中用上述已验证绝对值设置 \`RELEASE_SKILL_ENTRY\`，然后执行 \`node "$RELEASE_SKILL_ENTRY" ...\`；不得依赖前一次 shell 的变量。\n\
>\n\
`;

/**
 * Render SKILL.md content for a specific platform.
 *
 * - Claude: verbatim copy (uses ${CLAUDE_PLUGIN_ROOT})
 * - Codex: replaces the Claude-only path with $RELEASE_SKILL_ENTRY,
 *   and prepends the path resolution protocol preamble.
 * - Kimi: same substitution as Codex, with the Kimi Code preamble.
 * - WorkBuddy: pure variable substitution (${CLAUDE_PLUGIN_ROOT} ->
 *   ${CODEBUDDY_PLUGIN_ROOT}); CodeBuddy expands the variable inline in
 *   skill content (official plugin reference), the same mechanism Claude
 *   uses, so no entry-resolution preamble is needed.
 *
 * @param {string} content - Canonical SKILL.md content.
 * @param {string} platformName - 'claude', 'codex', 'kimi', or 'workbuddy'.
 * @returns {string}
 */
function renderSkillForPlatform(content, platformName) {
  if (platformName === 'claude') return content;

  if (platformName === 'workbuddy') {
    return content.replaceAll('${CLAUDE_PLUGIN_ROOT}', '${CODEBUDDY_PLUGIN_ROOT}');
  }

  if (platformName === 'codex' || platformName === 'kimi') {
    const hostLabel = platformName === 'codex' ? 'Codex' : 'Kimi';
    const preamble = platformName === 'codex' ? CODEX_PREAMBLE : KIMI_PREAMBLE;
    let rendered = content.replaceAll(
      '${CLAUDE_PLUGIN_ROOT}/bin/release-skill.mjs',
      '$RELEASE_SKILL_ENTRY',
    );
    // A remaining bare host-root reference has no safe path-derived equivalent.
    if (rendered.includes('${CLAUDE_PLUGIN_ROOT}')) {
      throw new Error(`${hostLabel} rendering found an unsupported bare CLAUDE_PLUGIN_ROOT reference`);
    }
    // Preserve YAML frontmatter as the first bytes so the host can discover
    // the skill. Insert the host-specific protocol immediately after it.
    const frontmatterEnd = rendered.indexOf('\n---\n', 4);
    if (!rendered.startsWith('---\n') || frontmatterEnd < 0) {
      throw new Error(`${hostLabel} rendering requires a valid leading YAML frontmatter block`);
    }
    const insertionPoint = frontmatterEnd + '\n---\n'.length;
    return `${rendered.slice(0, insertionPoint)}\n${preamble}${rendered.slice(insertionPoint)}`;
  }

  return content;
}

/**
 * Collect binary file paths from a source directory recursively.
 * Returns array of relative paths.
 *
 * `excludedTopDirs` names top-level directories that are skipped entirely.
 * It only exists for subtrees that are already excluded from the shipped
 * output (see the native/safe-write build/ exclusion below): their contents
 * are never read and never shipped, so descending into them would only let
 * transient, regeneratable artifacts (node-gyp creates a
 * build/node_gyp_bins/python3 symlink while a rebuild is running) fail the
 * collection without protecting any shipped byte.
 */
async function collectBinaryFiles(baseDir, physicalRoot, relPrefix = '', excludedTopDirs) {
  const results = [];
  const physicalDir = await assertTrustedDirectory(
    baseDir,
    physicalRoot,
    relPrefix || relative(physicalRoot, baseDir),
  );
  const entries = await readdir(physicalDir, { withFileTypes: true });
  for (const entry of entries) {
    const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) {
      throw new Error(`SECURITY: symlink in resource tree: ${relPath}`);
    }
    if (entry.isDirectory()) {
      if (relPrefix === '' && excludedTopDirs?.has(entry.name)) continue;
      results.push(...await collectBinaryFiles(join(physicalDir, entry.name), physicalRoot, relPath));
    } else if (entry.isFile()) {
      results.push({ relPath, sourcePath: join(physicalDir, entry.name) });
    } else {
      throw new Error(`SECURITY: resource is not a regular file: ${relPath}`);
    }
  }
  return results;
}

/**
 * Generate the full file tree for an adapter platform.
 *
 * @param {object} platform - Platform definition.
 * @param {Array} skills - Skill metadata array.
 * @param {object} templateJson - Parsed plugin.json template.
 * @param {string} root - Package root (for reading binary assets).
 * @param {object|null} marketplaceTemplateJson - Parsed marketplace template.
 * @returns {Promise<Array<{relPath:string,content:Buffer,isBinary:boolean}>>}
 */
async function generateAdapterFiles(platform, skills, templateJson, root, marketplaceTemplateJson = null) {
  const files = [];

  // Transform plugin.json: rewrite source paths
  const adapted = JSON.parse(JSON.stringify(templateJson));

  // Preserve platform-supported directory auto-discovery in generated adapters.
  // The CodeBuddy server-side validator (`codebuddy plugin validate`) requires
  // `skills` to be an array of component paths, so the workbuddy adapter emits
  // ["./skills/"]; claude/codex/kimi hosts keep the directory-string form.
  if (typeof adapted.skills === 'string') {
    adapted.skills = platform.name === 'workbuddy' ? ['./skills/'] : './skills/';
  } else if (Array.isArray(adapted.skills)) {
    // Handle both string array and object array forms
    adapted.skills = adapted.skills.map((skill) => {
      if (typeof skill === 'string') {
        // String array: transform to relative path for the adapter
        return platform.name === 'workbuddy' ? './skills/' : skill;
      }
      // Object array: preserve existing behavior
      skill.source = `../skills/${skill.name}/SKILL.md`;
      return skill;
    });
  }

  const pluginJsonContent = JSON.stringify(adapted, null, 2) + '\n';
  files.push({
    relPath: join(platform.pluginDirName, 'plugin.json'),
    content: Buffer.from(pluginJsonContent, 'utf-8'),
    isBinary: false,
  });

  // Generate marketplace.json for platforms that need it
  if (platform.hasMarketplace) {
    const marketplace = JSON.parse(JSON.stringify(marketplaceTemplateJson));
    marketplace.name = adapted.name;
    marketplace.description = adapted.description;
    marketplace.owner = marketplace.owner ?? adapted.author;
    marketplace.plugins = [{
      ...(marketplace.plugins?.[0] ?? {}),
      name: adapted.name,
      source: './',
      version: adapted.version,
      description: adapted.description,
    }];
    const marketplaceContent = JSON.stringify(marketplace, null, 2) + '\n';
    files.push({
      relPath: join(platform.pluginDirName, 'marketplace.json'),
      content: Buffer.from(marketplaceContent, 'utf-8'),
      isBinary: false,
    });
  }

  // Copy SKILL.md files with host-specific rendering
  for (const skill of skills) {
    const rendered = renderSkillForPlatform(skill.content, platform.name);
    files.push({
      relPath: join('skills', skill.name, 'SKILL.md'),
      content: Buffer.from(rendered, 'utf-8'),
      isBinary: false,
    });
  }

  // Copy bin/ entry point and bundle (text files). The binding record
  // (bin/foundation-resource-binding.json) is the single source of truth for
  // the Foundation runtime closure: every bin/ member is either a host file
  // (wrapper, bundle, source CLI, record) or a recorded closure resource.
  // An unrecorded bin member — e.g. a stray fixture — fails closed before
  // any write (ruling 10 / B2-B4: no bin/ skip, no second member table).

  // Read the binding record with a strict no-follow bound read first.
  let recordReceipt;
  try {
    recordReceipt = await readFileStrict(root, 'bin/foundation-resource-binding.json', { encoding: 'utf8' });
  } catch (cause) {
    throw new Error(`SECURITY: binding record cannot be strictly read: ${cause?.message ?? cause}`);
  }
  const recordLstat = await lstat(join(root, 'bin', 'foundation-resource-binding.json'));
  if (recordLstat.nlink !== 1) {
    throw new Error('SECURITY: binding record has an unexpected hard-link count');
  }
  const bindingRecord = JSON.parse(recordReceipt.content);
  const recorded = new Map((bindingRecord.resources ?? []).map((entry) => [entry.path, entry]));
  if (recorded.size === 0) {
    throw new Error('SECURITY: binding record declares an empty Foundation closure');
  }

  const HOST_BIN_FILES = new Set([
    'release-skill.mjs',
    'release-skill.bundle.mjs',
    'release-skill-cli.mjs',
    'foundation-resource-binding.json',
  ]);
  const recordedBinRels = new Set(
    [...recorded.keys()].filter((path) => path.startsWith('bin/')).map((path) => path.slice('bin/'.length)),
  );

  const binFileEntries = await collectBinaryFiles(join(root, 'bin'), root);
  const binRelPaths = binFileEntries.map(({ relPath }) => relPath);
  for (const required of ['release-skill.mjs', 'release-skill.bundle.mjs', 'foundation-resource-binding.json']) {
    if (!binRelPaths.includes(required)) {
      throw new Error(`SECURITY: required bundle entry is missing: bin/${required}`);
    }
  }
  for (const { relPath: rel, sourcePath } of binFileEntries) {
    if (rel === 'release-skill-cli.mjs') continue; // source CLI never ships into adapters
    if (recordedBinRels.has(rel)) continue; // recorded closure member; copied from the record below
    if (!HOST_BIN_FILES.has(rel)) {
      throw new Error(`SECURITY: bin member not covered by the binding record: bin/${rel}`);
    }
    const content = await readTrustedFile(sourcePath, root, `bin/${rel}`);
    files.push({ relPath: join('bin', rel), content, isBinary: false });
  }

  // Copy the Foundation runtime closure recorded by build:bundle — every
  // entry, bin/-adjacent or bundle-relative, with a digest-bound strict read
  // (sha256 + size re-verification before copying). data/hosts + data/licensing
  // land at the adapter root (the bundle inside bin/ resolves ../data/... from
  // its own location), src/schemas likewise (../src/...).
  for (const [rel, entry] of recorded) {
    let receipt;
    try {
      receipt = await readFileStrict(root, rel, { expectedSha256: entry.sha256 });
    } catch (cause) {
      throw new Error(`SECURITY: recorded member cannot be strictly read: ${rel} (${cause?.message ?? cause})`);
    }
    if (receipt.bytes !== entry.size) {
      throw new Error(`SECURITY: recorded member size drift: ${rel} (recorded ${entry.size}, live ${receipt.bytes})`);
    }
    const memberLstat = await lstat(join(root, rel));
    if (memberLstat.nlink !== 1) {
      throw new Error(`SECURITY: recorded member has an unexpected hard-link count: ${rel}`);
    }
    files.push({
      relPath: rel,
      content: receipt.content,
      isBinary: false,
      ...(entry.path.endsWith('.node') ? { mode: 0o644 } : {}),
    });
  }

  // Copy schemas/ directory
  const schemaFiles = await collectBinaryFiles(join(root, 'schemas'), root);
  const schemaPaths = new Set(schemaFiles.map(({ relPath }) => relPath));
  for (const requiredSchema of REQUIRED_SCHEMA_FILES) {
    if (!schemaPaths.has(requiredSchema)) {
      throw new Error(`SECURITY: required schema is missing: schemas/${requiredSchema}`);
    }
  }
  for (const { relPath: rel, sourcePath } of schemaFiles) {
    const content = await readTrustedFile(sourcePath, root, `schemas/${rel}`);
    files.push({
      relPath: join('schemas', rel),
      content,
      isBinary: false,
    });
  }

  // Copy native/safe-write/ directory (prebuilds.json, prebuilds/, src/).
  // Exclude build/ — it contains platform-specific build artifacts that are
  // regenerated by node-gyp and should not be in the published adapter.
  // Collection never descends into build/: it is output-excluded anyway, and
  // a concurrent node-gyp rebuild transiently places symlinked helper bins
  // there (node_gyp_bins/python3) that must not fail the derived-artifact
  // gates.
  const nativeBase = join(root, 'native', 'safe-write');
  const nativeFiles = await collectBinaryFiles(nativeBase, root, '', new Set(['build']));
  if (!nativeFiles.some(({ relPath }) => relPath === 'prebuilds.json')) {
    throw new Error('SECURITY: required native resource is missing: native/safe-write/prebuilds.json');
  }

  // Semantic closure: validate prebuilds.json declarations against collected files.
  const prebuildsEntry = nativeFiles.find(({ relPath }) => relPath === 'prebuilds.json');
  const prebuildsRaw = await readTrustedFile(prebuildsEntry.sourcePath, root, 'native/safe-write/prebuilds.json', 'utf-8');
  const prebuildsJson = JSON.parse(prebuildsRaw);
  if (!prebuildsJson.prebuilds || typeof prebuildsJson.prebuilds !== 'object'
      || Array.isArray(prebuildsJson.prebuilds)
      || Object.keys(prebuildsJson.prebuilds).length === 0) {
    throw new Error('SECURITY: prebuilds.json missing "prebuilds" object');
  }
  for (const [platformId, declaration] of Object.entries(prebuildsJson.prebuilds)) {
    if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration)
        || !declaration.path || typeof declaration.path !== 'string') {
      throw new Error(`SECURITY: prebuilds.json platform "${platformId}" missing "path"`);
    }
    const portablePath = declaration.path.replace(/\\/g, '/');
    const normalised = pathPosix.normalize(portablePath);
    if (portablePath !== normalised
        || pathPosix.isAbsolute(normalised)
        || normalised === '.'
        || normalised.split('/').some((segment) => segment === '..' || segment === '')) {
      throw new Error(`SECURITY: prebuilds.json path escapes collection tree: ${declaration.path}`);
    }
    if (!/^[a-f0-9]{64}$/.test(declaration.sha256 ?? '')) {
      throw new Error(`SECURITY: prebuilds.json platform "${platformId}" has invalid sha256`);
    }
    if (normalised === 'build' || normalised.startsWith('build/')) {
      throw new Error(`SECURITY: prebuilds.json declares an output-excluded build resource: ${declaration.path}`);
    }
    const matching = nativeFiles.find(({ relPath }) => relPath === normalised);
    if (!matching) {
      throw new Error(`SECURITY: prebuilds.json declares missing file: ${declaration.path}`);
    }
    const declaredContent = await readTrustedFile(matching.sourcePath, root, `native/safe-write/${normalised}`);
    assertRegularSingleLink(await lstat(matching.sourcePath), `native/safe-write/${normalised}`);
    const actualHash = sha256Hex(declaredContent);
    if (declaration.sha256 !== actualHash) {
      throw new Error(`SECURITY: prebuilds.json SHA-256 mismatch for ${declaration.path}: declared=${declaration.sha256} actual=${actualHash}`);
    }
  }
  for (const { relPath: rel, sourcePath } of nativeFiles) {
    // Skip build/ directory — platform-specific build artifacts.
    if (rel.startsWith('build/') || rel.startsWith('build\\')) continue;
    const content = await readTrustedFile(sourcePath, root, `native/safe-write/${rel}`);
    files.push({
      relPath: join('native', 'safe-write', rel),
      content,
      isBinary: true,
    });
  }

  // Sort for deterministic output
  files.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return files;
}

/**
 * Pure producer function for building adapters.
 *
 * @param {object} options
 * @param {string} [options.inputs] - Root directory path. Defaults to package root.
 * @param {string} [options.output] - Single-platform output directory path.
 * @param {Record<string,string>} [options.outputRoots] - Per-platform output roots.
 * @param {string} [options.platformFilter] - Only generate for this platform name.
 */
export async function produceBuildAdapters({ inputs, output, outputRoots, platformFilter } = {}) {
  const defaultRoot = new URL('../..', import.meta.url).pathname;
  const requestedRoot = inputs ?? defaultRoot;

  // ── Phase 1: Validate input root is not a symlink ──
  let rootStat;
  try {
    rootStat = await lstat(requestedRoot);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`SECURITY: input root is missing: ${requestedRoot}`);
    throw error;
  }
  if (rootStat.isSymbolicLink()) {
    throw new Error(`SECURITY: input root is a symlink: ${requestedRoot}`);
  }
  if (!rootStat.isDirectory()) throw new Error('SECURITY: input root is not a directory');
  const root = await realpath(requestedRoot);
  const srcDir = join(root, 'skills-src');

  if (platformFilter && !PLATFORMS.some(({ name }) => name === platformFilter)) {
    throw new Error(`Unsupported adapter platform: ${platformFilter}`);
  }
  const selectedPlatforms = PLATFORMS.filter(({ name }) => !platformFilter || name === platformFilter);
  if (!outputRoots && selectedPlatforms.length !== 1) {
    throw new Error('SECURITY: multi-platform generation requires outputRoots');
  }

  // ── Phase 2: Collect skills (validates symlinks inside) ──
  const skills = await collectSkills(srcDir, root);
  if (skills.length === 0) {
    throw new Error('At least one skill is required; found 0 in skills-src/');
  }

  // ── Phase 3: Validate all platform inputs (no writes yet) ──
  for (const platform of selectedPlatforms) {
    await readTrustedFile(
      join(root, platform.pluginDirName, platform.templateFileName),
      root,
      `${platform.pluginDirName}/${platform.templateFileName}`,
      'utf-8',
    );
    if (platform.hasMarketplace) {
      await readTrustedFile(
        join(root, platform.pluginDirName, platform.marketplaceFileName),
        root,
        `${platform.pluginDirName}/${platform.marketplaceFileName}`,
        'utf-8',
      );
    }
  }

  // ── Phase 4: Validate every output root before any target is created ──
  const outputRootEntries = [];
  for (const platform of selectedPlatforms) {
    const requestedOutput = outputRoots?.[platform.name] ?? output;
    const safeRoot = await assertSafeNewOutputRoot(requestedOutput, `${platform.name} output root`);
    outputRootEntries.push([platform.name, safeRoot]);
  }
  assertDisjointOutputRoots(outputRootEntries);
  const safeOutputRoots = new Map(outputRootEntries);

  // ── Phase 5: Generate files (all inputs already validated) ──
  const allPlatformFiles = [];
  for (const platform of selectedPlatforms) {
    const templatePath = join(root, platform.pluginDirName, platform.templateFileName);
    const templateRaw = await readTrustedFile(
      templatePath,
      root,
      `${platform.pluginDirName}/${platform.templateFileName}`,
      'utf-8',
    );
    const templateJson = JSON.parse(templateRaw);
    let marketplaceTemplateJson = null;
    if (platform.hasMarketplace) {
      marketplaceTemplateJson = JSON.parse(
        await readTrustedFile(
          join(root, platform.pluginDirName, platform.marketplaceFileName),
          root,
          `${platform.pluginDirName}/${platform.marketplaceFileName}`,
          'utf-8',
        ),
      );
    }

    const files = await generateAdapterFiles(platform, skills, templateJson, root, marketplaceTemplateJson);
    allPlatformFiles.push({ platform, files });
  }

  // ── Phase 6: Create all roots, then write with exclusive/no-follow opens ──
  const outputs = [];
  const createdRoots = [];
  try {
    for (const [platformName, rootPath] of outputRootEntries) {
      await mkdir(rootPath, { mode: 0o700 });
      const identity = await lstat(rootPath);
      if (identity.isSymbolicLink() || !identity.isDirectory()) {
        throw new Error(`SECURITY: ${platformName} output root was not created safely`);
      }
      createdRoots.push({ platformName, rootPath, identity });
    }

    for (const { platform, files } of allPlatformFiles) {
      const rootPath = safeOutputRoots.get(platform.name);
      const rootRecord = createdRoots.find((entry) => entry.platformName === platform.name);
      for (const file of files) {
        const parentDir = await ensureTrustedOutputDirectory(
          rootPath,
          rootRecord.identity,
          dirname(file.relPath),
          `${platform.name} output root`,
        );
        await assertOwnedOutputRoot(rootPath, rootRecord.identity, `${platform.name} output root`);
        const dstPath = join(parentDir, file.relPath.split(sep).at(-1));
        const createFlags = fsConstants.O_CREAT
          | fsConstants.O_WRONLY
          | fsConstants.O_EXCL
          | (fsConstants.O_NOFOLLOW ?? 0);
        const handle = await open(dstPath, createFlags, file.mode ?? 0o600);
        try {
          await handle.writeFile(file.content);
          const writtenStat = await handle.stat();
          assertRegularSingleLink(writtenStat, `${platform.name}/${file.relPath}`);
        } finally {
          await handle.close();
        }

        outputs.push(Object.freeze({
          platform: platform.name,
          path: file.relPath,
          type: 'blob',
          mode: '100644',
          content: file.content,
          sha256: sha256Hex(file.content),
          size: file.content.length,
        }));
      }
    }
  } catch (error) {
    for (const { rootPath, identity } of createdRoots.reverse()) {
      try {
        await assertOwnedOutputRoot(rootPath, identity, 'output root cleanup');
        await rm(rootPath, { recursive: true, force: false });
      } catch {
        // Fail closed: never follow or remove a root whose identity changed.
      }
    }
    throw error;
  }

  return Object.freeze({
    outputs: Object.freeze(outputs),
    outputManifestDigest: digestEntryOutputs(outputs),
  });
}

/**
 * Compute manifest digest from output entries.
 *
 * @param {Array<{path:string,type:string,mode:string,sha256:string,size:number}>} entries
 * @returns {string}
 */
export function digestEntryOutputs(entries) {
  // 纯 JSON 投影（platform 条件展开 + 定字段），直接委托 Foundation digestDocument。
  const canonical = entries.map(({ platform, path, type, mode, sha256, size }) => ({
    ...(platform ? { platform } : {}), path, type, mode, size, sha256,
  }));
  return `sha256:${digestDocument(canonical)}`;
}
