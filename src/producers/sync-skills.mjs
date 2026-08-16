/**
 * Pure producer: sync skills from skills-src/ to skills/.
 *
 * Reads each subdirectory in the source path, copies SKILL.md files
 * to the output directory. No side effects beyond the output directory.
 *
 * Deterministic: sorted directory enumeration, no timestamps, no randomness.
 *
 * @module producers/sync-skills
 */

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { canonicalJson, sha256Hex } from '../core/digest.mjs';
import { digestDocument } from 'skill-family-contracts';
import { digestBytes } from 'skill-family-harness-node';

/**
 * Compute an implementation digest from the source bytes of this module.
 *
 * @param {Buffer[]} sourceBytes
 * @returns {string}
 */
export function computeSyncSkillsDigest(sourceBytes) {
  // 多段哈希（源字节 + node 版本 + 固定 locale/timezone）等价于对拼接字节
  // 的 sha256，委托 Foundation digestBytes 实现，字节逐位一致。
  const bytes = Buffer.concat([
    ...sourceBytes,
    Buffer.from(`node:${process.version}`),
    Buffer.from('locale:en-US timezone:UTC'),
  ]);
  return `sha256:${digestBytes(bytes)}`;
}

/**
 * Pure producer function for syncing skills.
 *
 * Reads subdirectories from `inputs` (or default skills-src/),
 * copies SKILL.md files to `output`.
 *
 * @param {object} options
 * @param {string} [options.inputs] - Source directory path. Defaults to skills-src/ relative to module.
 * @param {string} options.output - Output directory path.
 */
export async function produceSyncSkills({ inputs, output } = {}) {
  const defaultSrc = new URL('../../skills-src', import.meta.url).pathname;
  const srcDir = inputs ?? defaultSrc;

  const skillDirs = [];
  for (const item of await readdir(srcDir, { withFileTypes: true })) {
    if (item.isDirectory()) skillDirs.push(item.name);
  }
  skillDirs.sort();

  const outputs = [];

  for (const dirName of skillDirs) {
    const srcFile = join(srcDir, dirName, 'SKILL.md');
    let content;
    try {
      content = await readFile(srcFile);
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }

    const dstDir = join(output, 'skills', dirName);
    await mkdir(dstDir, { recursive: true });
    const dstFile = join(dstDir, 'SKILL.md');
    await writeFile(dstFile, content);

    outputs.push(Object.freeze({
      path: `skills/${dirName}/SKILL.md`,
      type: 'blob',
      mode: '100644',
      content,
      sha256: sha256Hex(content),
      size: content.length,
    }));
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
  // 纯 JSON 投影（定字段），直接委托 Foundation digestDocument。
  const canonical = entries.map(({ path, type, mode, sha256, size }) => ({
    path, type, mode, size, sha256,
  }));
  return `sha256:${digestDocument(canonical)}`;
}
