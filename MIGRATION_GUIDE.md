# IDEA 到 VSCode 代码迁移指南

本文档描述如何将 `develop` 分支（IDEA 插件）的代码同步到 `feat/vscode` 分支（VSCode 扩展）。

## 分支结构

```
main
├── develop          ← IDEA 插件主开发分支（Java + 共享组件）
└── feat/vscode      ← VSCode 扩展分支（TypeScript + 共享组件）
```

## 代码映射关系

### 共享组件（可直接同步）

| 目录 | 用途 | 同步方式 |
|------|------|----------|
| `webview/` | React UI 界面 | 直接合并 |
| `ai-bridge/` | Node.js SDK 桥接层 | 直接合并 |

### 平台专用代码（需要手动迁移）

| develop 分支 (IDEA) | feat/vscode 分支 (VSCode) | 说明 |
|---------------------|---------------------------|------|
| `src/main/java/` | ❌ 不存在 | Java 专用，无需同步 |
| `src/main/resources/` | ❌ 不存在 | IDEA 资源，无需同步 |
| `build.gradle` | ❌ 不存在 | Gradle 构建，无需同步 |
| ❌ 不存在 | `src/*.ts` | VSCode TypeScript 源码 |
| ❌ 不存在 | `webpack.config.js` | VSCode 打包配置 |

### 功能对照表

| 功能 | IDEA (Java) | VSCode (TypeScript) |
|------|-------------|---------------------|
| 扩展入口 | `ClaudeSDKToolWindow.java` | `src/extension.ts` |
| Webview 提供者 | JCEF Browser | `src/providers/CodeMossViewProvider.ts` |
| 文件操作 | `handler/FileHandler.java` | `src/handlers/FileHandler.ts` |
| Diff 显示 | `handler/DiffHandler.java` | `src/handlers/DiffHandler.ts` |
| Bridge 管理 | `bridge/ProcessManager.java` | `src/services/BridgeManager.ts` |
| 配置服务 | `settings/*.java` | `src/services/ConfigService.ts` |
| 消息路由 | `handler/MessageDispatcher.java` | `src/services/MessageRouter.ts` |

## 同步步骤

### 方式一：同步共享组件（推荐）

仅同步 `webview/` 和 `ai-bridge/` 目录：

```bash
# 1. 确保在 feat/vscode 分支
git checkout feat/vscode

# 2. 获取 develop 分支最新代码
git fetch origin develop

# 3. 仅合并共享组件
git checkout origin/develop -- webview/ ai-bridge/

# 4. 检查冲突并解决
git status

# 5. 测试构建
npm run build

# 6. 提交
git add webview/ ai-bridge/
git commit -m "sync: 从 develop 同步共享组件"
```

### 方式二：Cherry-pick 特定提交

如果只需要同步特定功能：

```bash
# 1. 查看 develop 分支的提交历史
git log --oneline origin/develop -- webview/ ai-bridge/

# 2. Cherry-pick 需要的提交
git cherry-pick <commit-hash>

# 3. 解决可能的冲突
git status
# 编辑冲突文件...
git add .
git cherry-pick --continue
```

### 方式三：使用 diff + patch

精细控制同步内容：

```bash
# 1. 生成差异补丁
git diff HEAD origin/develop -- webview/ ai-bridge/ > sync.patch

# 2. 查看补丁内容
cat sync.patch

# 3. 应用补丁（可以选择性应用）
git apply sync.patch

# 4. 或者交互式应用
git apply --3way sync.patch
```

## 需要手动处理的情况

### 1. 平台适配层变更

当 `webview/` 中添加了平台特定代码时：

```typescript
// webview/src/platform/index.ts
// 需要确保 VSCode 适配器正确实现

export const platformAdapter = isVSCode
  ? new VSCodeAdapter()
  : new IDEAAdapter();  // IDEA 适配器在 VSCode 分支可移除
```

### 2. 新增 Handler 功能

当 develop 在 Java Handler 中添加新功能时，需要在 VSCode 对应的 TypeScript Handler 中实现：

```
develop: src/main/java/handler/NewHandler.java
   ↓ 手动迁移
feat/vscode: src/handlers/NewHandler.ts
```

**迁移模板：**

```typescript
// src/handlers/NewHandler.ts
import * as vscode from 'vscode';
import { Logger } from '../utils/logger';

export class NewHandler {
  constructor(private context: vscode.ExtensionContext) {}

  async handle(message: any): Promise<any> {
    // 参考 Java 实现逻辑
    Logger.info('NewHandler received:', message);

    // 实现对应功能...

    return { success: true };
  }
}
```

### 3. 新增配置项

当 develop 添加新的配置项时：

1. 更新 `package.json` 中的 `contributes.configuration`
2. 更新 `src/services/ConfigService.ts`

### 4. Bridge 协议变更

当 `ai-bridge/` 的 JSON 协议发生变化时，需要同步更新：
- `src/services/BridgeManager.ts` 中的消息处理
- `src/services/MessageRouter.ts` 中的路由逻辑

## 版本同步

版本号统一在 `package.json` 中管理：

```json
{
  "version": "0.1.16"
}
```

webview 构建时会自动从 `package.json` 读取版本号。

## 常见问题

### Q1: 合并后 webview 构建失败

```bash
# 清理并重新安装依赖
cd webview && rm -rf node_modules && npm install
npm run build
```

### Q2: TypeScript 类型错误

检查 `webview/src/global.d.ts` 是否需要更新类型定义。

### Q3: ai-bridge 行为不一致

确保 `ai-bridge/server.js` 中的协议格式与 VSCode 扩展预期一致。

### Q4: 如何回滚同步

```bash
# 查看同步前的提交
git log --oneline -10

# 回滚到指定提交
git reset --hard <commit-hash>
```

## 自动化脚本

创建同步脚本 `scripts/sync-from-develop.sh`：

```bash
#!/bin/bash
set -e

echo "🔄 开始从 develop 同步共享组件..."

# 获取最新代码
git fetch origin develop

# 保存当前分支
CURRENT_BRANCH=$(git branch --show-current)

# 检出共享组件
git checkout origin/develop -- webview/ ai-bridge/

# 检查是否有变更
if git diff --quiet HEAD; then
  echo "✅ 没有需要同步的变更"
  exit 0
fi

# 显示变更
echo "📝 变更文件："
git diff --stat HEAD

# 测试构建
echo "🔨 测试构建..."
npm run build

echo "✅ 同步完成，请检查变更后提交"
```

## 检查清单

同步后请确认：

- [ ] `npm run build` 构建成功
- [ ] webview 界面正常显示
- [ ] ai-bridge 通信正常
- [ ] 新增功能在 VSCode 中可用
- [ ] 无 TypeScript 类型错误
- [ ] 无 ESLint 警告

## 相关文件

| 文件 | 用途 |
|------|------|
| `package.json` | VSCode 扩展配置、版本号 |
| `tsconfig.json` | TypeScript 编译配置 |
| `webpack.config.js` | 扩展打包配置 |
| `.vscodeignore` | 发布排除规则 |
| `webview/package.json` | Webview 依赖配置 |
| `webview/vite.config.ts` | Webview 构建配置 |
