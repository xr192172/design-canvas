/**
 * java_refactor —— Java 语言重构执行器（收敛：spring_mvc_layering 等 Java 专属能力装包）
 *
 * 收敛动机（用户洞悉）：spring_mvc_layering 不是独立 MCP 工具，而是 Java 语言包内
 * 的「中间草丛」能力——随 refactor 线在 Java 项目被探明时自动拾取，Agent 不必单独 list。
 * 本模块把该能力装成一个 LanguageRefactorExecutor（仿 python_refactor），
 * 注册进 DEFAULT_LANGS 后由 runRefactorPipeline 按项目探测命中。
 *
 * 分层语义（独立于工具触发）：类型级注解 → controller/service/repository/entity/config。
 */

export { springMvcLayeringHandler, renderLayeringText } from './layering.js';
export type {
  SpringLayeringInput,
  SpringLayeringPlan,
  SpringLayeringFile,
} from './layering.js';

export { buildSpringMvcStage, javaExecutor } from './executor.js';