# ai-base 拆分规划报告

> 生成时间：2026/8/7 15:29:38 · 只读分析（临时副本，未改真实项目）
> 索引：321 文件 / 4422 符号 / 2580 依赖边 · 建议再拆社区 5 个 · 计划拆分单元 14 个

> 说明：每个"单元"= 一个 owner 在**一个文件**里的一组方法，将抽到同目录新文件 `${basename}_${owner}${ext}`。
> 是否执行取决于你确认；确认后由 derive_split 落盘 + 编译/测试级验收，失败自动回滚。

## 社区 1：HubConfig

> 共 2 个实质类型单元，组间跨组调用占比 6%

### Hub（56 方法 / 约 1303 行）

- **单元 1**：internal/hub/v2/builtin_services.go → internal/hub/v2/builtin_services_Hub.go
  - 抽取 2 个方法：appendToSession, autoSaveIfActive
- **单元 2**：internal/hub/v2/hub.go → internal/hub/v2/hub_Hub.go
  - 抽取 47 个方法：register, findHandlerOwner, buildMux, buildContacts, brainRoles, SetBrainManager, BrainManager, SetBrainRegistry, BrainRegistry, RegisterPlugin, Start, Serve, serve, Shutdown, handleWS, isRoleAllowed, notifyPluginsConnect, readLoop, ensureSession, loadClientSessions, saveClientSessions, migrateClientSessions, cleanupStaleClientSessions, handleLocal, writeLoop, handleDisconnect, handleFragment, fragmentCleanupLoop, launchAutoSave, cleanupFragments, HandleFragmentForTest, CleanupFragmentsForTest, HandleLocalForTest, AppendToSessionForTest, IsRoleAllowedForTest, NotifyPluginsConnectForTest, Router, FragmentReassemblyForTest, SessionBindForTest, TranscriptRecordForTest, DispatchForTest, TurnCleanupForTest, BuildInboundPipelineForTest, SessionIDForTest, CreateSessionForTest, LinkClientForTest, LinkClientForTestRole
- **单元 3**：internal/hub/v2/pipeline.go → internal/hub/v2/pipeline_Hub.go
  - 抽取 7 个方法：fragmentReassemblyStage, sessionBindStage, sessionIDInjectStage, transcriptRecordStage, dispatchStage, turnCleanupStage, buildInboundPipeline

### HubConfig（3 方法 / 约 41 行）

- **单元 4**：internal/hub/v2/hub.go → internal/hub/v2/hub_HubConfig.go
  - 抽取 3 个方法：Defaults, listenAddr, DisplayAddr

## 社区 10：NoopNotifier

> 共 2 个实质类型单元，组间跨组调用占比 16%

### Engine（26 方法 / 约 322 行）

- **单元 5**：internal/hub/v2/orchestrator/engine.go → internal/hub/v2/orchestrator/engine_Engine.go
  - 抽取 21 个方法：logWarn, RegisterCustomAction, Start, Stop, Stacks, HandleSignal, executeAction, actionPullNextTask, actionNotify, actionLog, actionCustom, armTimerForCurrentState, armTimerForCurrentStateLocked, disarmTimer, CurrentState, WorkbenchID, Workbench, Tasks, Events, IsTerminal, HandleTaskError
- **单元 6**：internal/hub/v2/orchestrator/engine_approval.go → internal/hub/v2/orchestrator/engine_approval_Engine.go
  - 抽取 5 个方法：checkApprovalLocked, ResumeAfterApproval, handleSignalBypass, PendingApprovals, SetApprovalManager

### NoopNotifier（3 方法 / 约 5 行）

- **单元 7**：internal/hub/v2/orchestrator/engine.go → internal/hub/v2/orchestrator/engine_NoopNotifier.go
  - 抽取 3 个方法：NotifyBrain, NotifyUser, BroadcastStateChange

## 社区 12：ShallowRetriever

> 共 2 个实质类型单元，组间跨组调用占比 3%

### DeepRetriever（15 方法 / 约 262 行）

- **单元 8**：internal/memory/retriever.go → internal/memory/retriever_DeepRetriever.go
  - 抽取 15 个方法：SetSessionRepository, SetVectorStore, SetProjectScope, SetQueryRewriter, SetLLMReranker, SetCache, AddDynamicPath, Name, load, Retrieve, keywordRetrieve, RecentItems, SearchDiverse, SearchDiverseWithOptions, connectedTo

### ShallowRetriever（3 方法 / 约 54 行）

- **单元 9**：internal/memory/retriever.go → internal/memory/retriever_ShallowRetriever.go
  - 抽取 3 个方法：StateFilePath, stateFilePath, Retrieve

## 社区 14：CDP

> 共 2 个实质类型单元，组间跨组调用占比 39%

### PageSession（21 方法 / 约 319 行）

- **单元 10**：internal/browser/cdp.go → internal/browser/cdp_PageSession.go
  - 抽取 7 个方法：readLoop, Send, Close, Navigate, Evaluate, EvaluateString, Screenshot
- **单元 11**：internal/browser/cdp_ext.go → internal/browser/cdp_ext_PageSession.go
  - 抽取 14 个方法：WaitForSelector, WaitForLoadState, WaitUntilScrollStable, ScrollToBottom, ScrollToTop, ScrollToElement, GetText, GetAttribute, ExtractList, GetElementsRects, GetCookies, SetCookies, SaveStorageState, LoadStorageState

### CDPClient（7 方法 / 约 97 行）

- **单元 12**：internal/browser/cdp.go → internal/browser/cdp_CDPClient.go
  - 抽取 7 个方法：IsAlive, GetVersion, NewTab, CloseTab, ListTabs, ConnectPage, FetchHTML

## 社区 90：MCPServerPlugin

> 共 2 个实质类型单元，组间跨组调用占比 35%

### MCPServerPlugin（5 方法 / 约 187 行）

- **单元 13**：internal/hub/v2/mcp_server_plugin.go → internal/hub/v2/mcp_server_plugin_MCPServerPlugin.go
  - 抽取 5 个方法：ServeMCP, writeError, writeToolError, serveMCPStream, writeSSEEvent

### sseResponseWriter（3 方法 / 约 13 行）

- **单元 14**：internal/hub/v2/mcp_server_plugin.go → internal/hub/v2/mcp_server_plugin_sseResponseWriter.go
  - 抽取 3 个方法：Write, Header, WriteHeader

