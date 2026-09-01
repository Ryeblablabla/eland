/**
 * ELAND 公共门面。
 *
 * 领域规则位于 domain/ 与 world/，月度用例编排位于 application/。
 * 产品、HTTP 用例与 UI 通过本文件进入模拟；持久化、会话与模型适配器
 * 需要的额外窄能力统一由 infrastructure-api.ts 暴露。
 * codec / projection adapter 可以读取稳定领域语义，但不能反向渗入内核。
 */
export * from './simulation-runtime';
export { seededFraction } from './world/generator';
