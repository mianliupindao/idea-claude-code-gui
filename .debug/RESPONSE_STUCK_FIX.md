# 响应卡住问题修复记录

## 问题描述

用户报告项目一直显示"响应中"状态，但没有任何响应内容输出。

## 问题诊断

通过代码分析和日志追踪，发现了以下问题：

### 1. 核心问题：streamEnd 事件未触发

**症状**：
- 前端显示"响应中"（loading = true）
- 没有任何内容显示
- `WaitingIndicator` 组件持续显示

**根本原因**：
- 前端的 loading 状态依赖于 `window.onStreamEnd` 回调来重置
- `onStreamEnd` 需要 ai-bridge 发送 `streamEnd` 事件
- `streamEnd` 事件在 `handleSendMessage` 函数的最后一行发送
- 如果 `handleClaudeCommand` 被阻塞或挂起，这一行永远不会执行

**关键代码路径**：
```
Frontend (App.tsx)
  └─ setLoading(true) [发送消息时]
     └─ 等待 window.onStreamEnd 回调
        └─ 依赖 MessageRouter 接收 streamEnd 事件
           └─ 依赖 ai-bridge 发送 streamEnd
              └─ 在 handleSendMessage 最后一行
```

### 2. Heartbeat 消息干扰

**症状**：
- 日志中出现大量 "Unknown message type: heartbeat" 错误
- 虽然不影响功能，但产生日志噪音

**原因**：
- WebView 每 5 秒发送一次 heartbeat 消息
- ai-bridge server.js 没有处理 heartbeat 消息
- 进入 default case，被标记为 "Unknown message type"

**相关文件**：
- `webview/src/main.tsx:45-56` - heartbeat 发送逻辑
- `ai-bridge/server.js:1687-1690` - default case 处理

### 3. 可能的阻塞点

`handleClaudeCommand` 调用可能被阻塞的原因：
1. Claude SDK 没有返回任何内容
2. 网络请求超时
3. SDK 内部错误导致挂起
4. API 密钥无效或配额耗尽
5. 消息格式错误导致 SDK 无法处理

## 修复方案

### ✅ 修复 1：添加 heartbeat 消息处理

**文件**：`ai-bridge/server.js:1681-1685`

```javascript
// === Heartbeat (from WebView) ===
case 'heartbeat':
  // Silently acknowledge heartbeat without logging
  // No need to send response, this is a one-way keep-alive signal
  break;
```

**效果**：消除日志噪音，避免不必要的空响应

### ✅ 修复 2：添加详细调试日志

**文件**：`ai-bridge/server.js`

添加了以下关键日志点：
1. `handleSendMessage` 开始时的日志（行 1703、1706）
2. `streamStart` 发送确认（行 1732）
3. `handleClaudeCommand` 调用前后的计时日志（行 1872-1883）
4. `streamEnd` 发送前后的确认（行 1960-1962）
5. 错误处理的增强日志（行 1953）

**效果**：
- 可以精确追踪消息处理流程
- 可以发现 handleClaudeCommand 是否被阻塞
- 可以确认 streamEnd 是否被发送

### 🔍 修复 3：错误追踪增强

**文件**：`ai-bridge/server.js:1875-1883`

```javascript
const commandStartTime = Date.now();

try {
  await handleClaudeCommand(claudeCommand, [], stdinData);
  const commandDuration = Date.now() - commandStartTime;
  console.error(`[server] handleClaudeCommand completed in ${commandDuration}ms`);
} catch (error) {
  const commandDuration = Date.now() - commandStartTime;
  console.error(`[server] handleClaudeCommand failed after ${commandDuration}ms:`, error.message);
  throw error;
}
```

**效果**：
- 可以监控 handleClaudeCommand 的执行时间
- 可以快速识别超时或阻塞问题
- 即使出错也能确保 streamEnd 被发送

## 验证步骤

### 1. 重启 VSCode

修改了 ai-bridge/server.js，需要重启 VSCode 让修改生效：

```bash
# 方法 1：通过命令面板
Cmd+Shift+P → "Developer: Reload Window"

# 方法 2：完全退出重启
Cmd+Q → 重新打开 VSCode
```

### 2. 开启开发者工具

```bash
Cmd+Shift+P → "Developer: Toggle Developer Tools"
```

### 3. 发送测试消息

发送一条简单的消息，例如："你好"

### 4. 检查日志

在开发者工具的 Console 中，应该看到以下日志序列：

#### ✅ 正常流程日志：

```
[server] handleSendMessage started, requestId: req_xxx
[server] Message text length: 6, sessionId: session_xxx, provider: claude
[server] Sending streamStart for session: session_xxx, streamingEnabled: true
[VSCodeAdapter] Received message: streamStart
[Frontend] Stream started
[server] Calling handleClaudeCommand: send
[ai-bridge][CONTENT_DELTA] parsed delta: "你好！我是 Claude..."
[VSCodeAdapter] Received message: streamChunk
[VSCodeAdapter] Called onContentDelta with delta
[server] handleClaudeCommand completed in 1234ms
[server] Sending streamEnd for session: session_xxx
[server] streamEnd sent successfully
[VSCodeAdapter] Received message: streamEnd
[Frontend] Stream ended
```

#### ❌ 如果仍然卡住，日志会停在：

```
[server] handleSendMessage started, requestId: req_xxx
[server] Message text length: 6, sessionId: session_xxx, provider: claude
[server] Sending streamStart for session: session_xxx, streamingEnabled: true
[server] Calling handleClaudeCommand: send
... (长时间没有后续日志) ...
```

### 5. 常见问题排查

#### 问题 A：看到 streamStart 但没有 streamEnd

**原因**：`handleClaudeCommand` 被阻塞

**可能的根本原因**：
1. **API 密钥问题**：
   - 检查 Claude API 密钥是否有效
   - 打开设置 → Provider Management → 验证 API Key

2. **网络问题**：
   - 检查网络连接
   - 尝试访问 https://api.anthropic.com/v1/messages

3. **SDK 未安装**：
   - 打开设置 → SDK 依赖 → 检查 Claude SDK 状态
   - 如果未安装，点击"安装"按钮

4. **配额耗尽**：
   - 检查 Anthropic 账户余额
   - 查看是否有使用限制

**临时解决方法**：
- 点击"中断会话"按钮强制停止
- 或等待自动超时（如果有）

#### 问题 B：看到 streamEnd 但前端仍然显示"响应中"

**原因**：`streamEnd` 事件没有正确到达前端

**排查步骤**：
1. 检查 `VSCodeAdapter` 是否收到 streamEnd 消息：
   ```
   [VSCodeAdapter] Received message: streamEnd
   ```

2. 检查 `onStreamEnd` 回调是否被调用：
   ```
   [Frontend] Stream ended
   ```

3. 如果没有，检查 `useWindowCallbacks.ts:603` 的 window.onStreamEnd 是否正确注册

#### 问题 C：Heartbeat 仍然显示为 Unknown

**原因**：修改未生效

**解决**：
- 确认已重启 VSCode
- 检查 ai-bridge/server.js 是否包含 heartbeat case
- 查看文件保存时间戳

## 性能监控

### 正常响应时间基准

- **简单问题**（如"你好"）：500-2000ms
- **中等问题**（代码解释）：2000-5000ms
- **复杂问题**（代码生成）：5000-15000ms

如果 `handleClaudeCommand` 持续超过 30 秒没有响应，说明存在阻塞问题。

### 监控指标

通过日志中的 "completed in Xms" 来监控：

```bash
# 在开发者工具 Console 中过滤日志
Cmd+F → 搜索 "completed in"
```

正常情况下应该看到：
```
[server] handleClaudeCommand completed in 1234ms
```

## 下一步优化建议

### 1. 添加超时机制

为 `handleClaudeCommand` 添加超时保护：

```javascript
const COMMAND_TIMEOUT = 60000; // 60 seconds

const timeoutPromise = new Promise((_, reject) => {
  setTimeout(() => reject(new Error('Command timeout')), COMMAND_TIMEOUT);
});

try {
  await Promise.race([
    handleClaudeCommand(claudeCommand, [], stdinData),
    timeoutPromise
  ]);
} catch (error) {
  // ... error handling
}
```

### 2. 添加进度反馈

在长时间运行的命令中，定期发送进度更新：

```javascript
// 每 5 秒发送一次心跳
const heartbeatInterval = setInterval(() => {
  sendToHost('commandProgress', {
    sessionId,
    elapsed: Date.now() - commandStartTime
  }, requestId);
}, 5000);

// 命令完成后清除
clearInterval(heartbeatInterval);
```

### 3. 用户友好的超时提示

在前端添加超时检测：

```typescript
// useWindowCallbacks.ts
useEffect(() => {
  if (loading && loadingStartTime) {
    const timeoutId = setTimeout(() => {
      if (loading) {
        addToast('响应超时，请尝试重新发送或中断会话', 'warning');
      }
    }, 30000); // 30 seconds

    return () => clearTimeout(timeoutId);
  }
}, [loading, loadingStartTime]);
```

## 相关文件清单

### 修改的文件

1. **ai-bridge/server.js**
   - 添加 heartbeat 处理（行 1681-1685）
   - 添加调试日志（多处）
   - 增强错误追踪（行 1875-1883）

### 相关的关键文件

1. **前端状态管理**：
   - `webview/src/App.tsx` - loading 状态
   - `webview/src/hooks/useWindowCallbacks.ts` - 流式传输回调
   - `webview/src/components/WaitingIndicator.tsx` - 加载指示器

2. **消息路由**：
   - `src/services/MessageRouter.ts` - 消息路由
   - `src/services/BridgeManager.ts` - Bridge 管理
   - `webview/src/platform/VSCodeAdapter.ts` - VSCode 适配器

3. **AI Bridge**：
   - `ai-bridge/server.js` - 主服务器
   - `ai-bridge/services/claude/message-service.js` - Claude 消息服务

## 总结

这次修复主要解决了两个问题：

1. **消除 heartbeat 噪音**：添加了 heartbeat 消息的显式处理
2. **增强问题诊断能力**：添加了详细的日志追踪，可以快速定位阻塞点

如果问题仍然存在，通过新增的日志可以准确判断是哪个环节出了问题，为进一步修复提供依据。

---

**修复时间**：2026-01-28
**修复文件**：ai-bridge/server.js
**影响范围**：AI 响应流式传输机制
**风险等级**：低（仅添加日志和消息处理，不改变核心逻辑）
