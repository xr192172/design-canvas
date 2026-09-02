/**
 * lifecycle —— 长驻 MCP server 的进程级稳定性兜底
 *
 * 背景（运行稳定性 / 障碍 #5 的运行时侧）：design-canvas 是长驻 stdio MCP server。
 * Node 自 v15 起，**未捕获的 Promise rejection 默认直接让进程崩溃**——任何一个后台异步
 * 回调（watch/rebuild/drift/impact 任务、或某次工具调用的 stray rejection）漏了 catch，
 * 整个 server 就退出、所有 MCP 客户端掉线；硬杀进程还会留下 fs.watch 句柄/ SQLite 锁
 * （Windows EBUSY 的常见根因之一），下一次启动/清理会撞文件占用。
 *
 * 本模块给的兜底（只改 server 入口，不改各工具语义）：
 *   - unhandledRejection：结构化日志 + **保持服务**（不再默认退进程）——消除「一次异步
 *     失误拖垮整个长驻 server」的头号掉线源。
 *   - uncaughtException：结构化日志 + 尽力清理（关 watch 句柄 + 关项目 SQLite）后再退出，
 *     让监督者能干净重启，而不是留半坏进程。
 *   - SIGINT / SIGTERM：优雅收尾（同理清理）再退出 0，避免句柄/锁泄漏。
 *
 * 注入依赖（log/exit/cleanup）以便单元测试直接断言决策；installLifecycle 只负责挂到
 * process 事件上（决策逻辑在 createLifecycleHandlers 里，与事件派发解耦、可测）。
 */

export interface LifecycleDeps {
  /** 收到退出/崩溃信号时执行的清理（幂等）；通常是关 watch + 关 SQLite */
  cleanup: () => void | Promise<void>;
  /** 结构化日志（到 stderr） */
  log: (msg: string) => void;
  /** 进程退出（可注入假实现测试） */
  exit: (code: number) => void;
  /** true=unhandledRejection 保持服务（默认 true）；false=清理后退出 */
  keepAliveOnRejection?: boolean;
}

export interface LifecycleHook {
  onUnhandledRejection?: (reason: unknown) => void;
  onUncaughtException?: (err: unknown) => void;
  onSignal?: (signal: string) => void;
}

export interface LifecycleHandle {
  uninstall(): void;
}

export interface LifecycleHandlers {
  onUnhandledRejection: (reason: unknown) => void;
  onUncaughtException: (err: unknown) => void;
  onSignal: (signal: string) => void;
}

function describeError(e: unknown): string {
  return e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
}

/**
 * 构造决策手柄（纯逻辑，不碰 process 副作用）：
 *  - unhandledRejection：keepAlive → 只日志；否则清理 + exit(1)
 *  - uncaughtException：日志 + 清理 + exit(1)（同步异常后 Node 态可能已坏，退出让监督者重启）
 *  - 信号：日志 + 清理 + exit(0)；同信号短时重复只清一次（去抖）
 */
export function createLifecycleHandlers(deps: LifecycleDeps, hooks: LifecycleHook = {}): LifecycleHandlers {
  const keepAlive = deps.keepAliveOnRejection !== false;
  let cleaned = false;

  const doCleanup = (label: string): void => {
    if (cleaned) return;
    cleaned = true;
    try {
      deps.log(`[lifecycle] ${label}：清理中…`);
      const r = deps.cleanup();
      if (r && typeof (r as Promise<void>).then === 'function') {
        (r as Promise<void>).then(
          () => deps.log(`[lifecycle] ${label}：清理完成`),
          (e) => deps.log(`[lifecycle] ${label}：清理部分失败 ${(e as Error).message}`),
        );
      } else {
        deps.log(`[lifecycle] ${label}：清理完成`);
      }
    } catch (e) {
      deps.log(`[lifecycle] ${label}：清理异常 ${(e as Error).message}`);
    }
  };

  const onUnhandledRejection = (reason: unknown): void => {
    deps.log(`[lifecycle] unhandledRejection: ${describeError(reason)}`);
    hooks.onUnhandledRejection?.(reason);
    if (keepAlive) return; // 长驻 server 不掉线
    doCleanup('unhandledRejection');
    deps.exit(1);
  };

  const onUncaughtException = (err: unknown): void => {
    deps.log(`[lifecycle] uncaughtException: ${describeError(err)}`);
    hooks.onUncaughtException?.(err);
    doCleanup('uncaughtException');
    deps.exit(1);
  };

  const onSignal = (signal: string): void => {
    deps.log(`[lifecycle] 收到 ${signal}，开始优雅退出`);
    hooks.onSignal?.(signal);
    doCleanup(signal);
    deps.exit(0);
  };

  return { onUnhandledRejection, onUncaughtException, onSignal };
}

/** 安装到当前 process 事件，返回卸载函数 */
export function installLifecycle(deps: LifecycleDeps, hooks: LifecycleHook = {}): LifecycleHandle {
  const h = createLifecycleHandlers(deps, hooks);
  process.on('unhandledRejection', h.onUnhandledRejection);
  process.on('uncaughtException', h.onUncaughtException);
  process.on('SIGINT', h.onSignal as () => void);
  process.on('SIGTERM', h.onSignal as () => void);
  return {
    uninstall(): void {
      process.removeListener('unhandledRejection', h.onUnhandledRejection);
      process.removeListener('uncaughtException', h.onUncaughtException);
      process.removeListener('SIGINT', h.onSignal as () => void);
      process.removeListener('SIGTERM', h.onSignal as () => void);
    },
  };
}