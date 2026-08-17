/**
 * 全局未读影响提醒收件箱（响应注入通道，Step 3+
 *
 * MCP stdio 是请求-响应模型，server 无法主动向 LLM 推消息——"主动播报"只能
 * 借力下一次工具调用。watch 产出的一行影响摘要进入本收件箱后，任何 MCP
 * 工具响应都会自动附带未读提醒（读即清空，一次性投递），LLM 无需记得调
 * watch status。
 *
 * 语义：
 *   - pushAlert：watch doWork 产出摘要时入箱（新→旧，cap 内保留）
 *   - takeAlerts：原子读清——取走全部未读并清空（投递即已读）
 *   - appendPendingAlerts：把未读拼接到工具响应文本尾部（分发中间件用）
 *
 * 与 entry.alerts 的分工：entry.alerts 是项目内历史（watch status 回看，cap 20）；
 * 本收件箱是跨项目投递队列（一次投递即消费）。全文始终落盘 impact/ 目录，
 * 两者丢的都只是提醒行，不丢数据。
 */

export interface PendingAlert {
  project_dir: string;
  seq: number;
  line: string;
  created_at: string;
}

/** 收件箱上限：超出丢最旧（全文已落盘，丢的只是提醒行） */
const ALERT_INBOX_CAP = 10;

const inbox: PendingAlert[] = [];

/** 入箱（新在前） */
export function pushAlert(a: PendingAlert): void {
  inbox.unshift(a);
  if (inbox.length > ALERT_INBOX_CAP) inbox.length = ALERT_INBOX_CAP;
}

/** 原子取走全部未读并清空（投递即已读） */
export function takeAlerts(): PendingAlert[] {
  if (inbox.length === 0) return [];
  const out = inbox.slice();
  inbox.length = 0;
  return out;
}

/** 窥视未读（不动状态；测试/调试用） */
export function peekAlerts(): readonly PendingAlert[] {
  return inbox;
}

/** 清空（测试隔离） */
export function clearAlertInbox(): void {
  inbox.length = 0;
}

/** 响应自带 alerts piggyback 的工具：跳过注入避免同屏重复 */
const SELF_CARRYING_TOOLS = new Set(['watch_project']);

/**
 * 把未读提醒追加到工具响应文本尾部（分发中间件调用，一次投递即消费）。
 * 无未读、或该工具自带 piggyback 时原样返回。
 */
export function appendPendingAlerts(text: string, toolName: string): string {
  if (SELF_CARRYING_TOOLS.has(toolName)) return text;
  const pending = takeAlerts();
  if (pending.length === 0) return text;
  const lines = pending.map((p) => `- ${p.line}（${p.project_dir}，全文 watch action=impact seq=${p.seq}）`);
  return `${text}\n\n[未读影响提醒 · 自动附带] watch 侦测到代码变更影响：\n${lines.join('\n')}`;
}
