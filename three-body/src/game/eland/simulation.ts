/**
 * ELAND 公共门面。
 *
 * 领域规则位于 domain/ 与 world/，月度用例编排位于 application/。
 * 其他层只依赖本文件，避免 HTTP、UI 或模型供应商反向渗入领域代码。
 */
export * from './simulation-runtime';
export { seededFraction } from './world/generator';
