/**
 * Foundation capability bridge (G4 conditional adoption, released form).
 *
 * 背景：1.5 revision 2 把 writePlanImmutable / writeRunAtomic / acquireProjectLock /
 * breakProjectLock 四条件项委托给 Foundation 能力（strict-file-publication 的
 * publishFileExclusive、token-lock 的 acquireFilesystemLock / releaseFilesystemLock /
 * recoverFilesystemLock / inspectFilesystemLock），其不在已发布
 * skill-family-harness-node@0.3.0 导出面，只存在于 Foundation 工作树在途改动。
 *
 * 解锁路径（用户裁决）：Foundation 0.4.0 于 2026-08-16 发布（npm 三包
 * contracts / harness-node / engineering-kit，latest=0.4.0），harness-node 0.4.0
 * index.mjs 导出 publishFileExclusive 与 token-lock 五函数及 HARNESS_ERROR_KINDS。
 * 本桥从 5 级相对路径 import（包外工作树引用）切换为包名 import
 * （'skill-family-harness-node'），随 npm 依赖发布，不再依赖 Foundation 工作树在旁。
 *
 * 0.5.1 依赖提升：skill-family-contracts / skill-family-harness-node 由 0.4.0
 * 提升至 0.5.0（npm latest，2026-08-16 发布）。harness-node 0.5.0 导出面已逐项
 * 核对：publishFileExclusive（atomic.mjs）、acquireFilesystemLock /
 * inspectFilesystemLock / releaseFilesystemLock / recoverFilesystemLock
 * （token-lock.mjs）、HARNESS_ERROR_KINDS（errors.mjs）均在 index.mjs 导出面，
 * 包名 import 无需改动。
 *
 * 发布形态：包名 import 可直接用于包内 src（node_modules 解析），bundle
 * （bin/release-skill.bundle.mjs，esbuild 内联）保持自包含。
 *
 * vendor/foundation-pin 与 scripts/materialize-foundation-pin.mjs 因语义失效
 * （pin 指向工作树在途字节）按 D4 裁决退役并归档，不再存在检查期漂移证据。
 */

import {
  publishFileExclusive,
  acquireFilesystemLock,
  inspectFilesystemLock,
  releaseFilesystemLock,
  recoverFilesystemLock,
  HARNESS_ERROR_KINDS,
} from 'skill-family-harness-node';

export {
  publishFileExclusive,
  acquireFilesystemLock,
  inspectFilesystemLock,
  releaseFilesystemLock,
  recoverFilesystemLock,
  HARNESS_ERROR_KINDS,
};
