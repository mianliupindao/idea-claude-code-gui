import * as vscode from 'vscode';
import { BridgeManager, BridgeMessage } from './BridgeManager';
import { ConfigService } from './ConfigService';
import { FileHandler } from '../handlers/FileHandler';
import { DiffHandler } from '../handlers/DiffHandler';
import { Logger } from '../utils/logger';

export interface WebviewMessage {
  type: string;
  content: unknown;
  requestId?: string;
}

type MessageHandler = (message: WebviewMessage) => Promise<void> | void;

export class MessageRouter {
  private _webview?: vscode.Webview;
  private _handlers: Map<string, MessageHandler> = new Map();

  constructor(private readonly _bridgeManager: BridgeManager) {
    this._setupBridgeListeners();
    this._registerDefaultHandlers();
  }

  public setWebview(webview: vscode.Webview): void {
    this._webview = webview;
  }

  private _setupBridgeListeners(): void {
    this._bridgeManager.on('message', (message: BridgeMessage) => {
      if (message.type === 'fileOperation') return;
      this._sendToWebview({
        type: message.type,
        content: message.content,
        requestId: message.requestId
      });
    });

    // Handle file operations from bridge
    this._bridgeManager.on('fileOperation', async (message: BridgeMessage) => {
      const content = message.content as {
        operation: string;
        path?: string;
        filePath?: string;
        url?: string;
        oldContent?: string;
        newContent?: string;
        title?: string;
      };

      try {
        switch (content.operation) {
          case 'openFile':
            await FileHandler.openFile(content.path || content.filePath || '');
            break;
          case 'openBrowser':
            await FileHandler.openExternal(content.url || '');
            break;
          case 'refreshFile':
            await FileHandler.refreshFile(content.path || content.filePath || '');
            break;
          case 'showDiff':
            if (content.oldContent !== undefined && content.newContent !== undefined) {
              await DiffHandler.showContentDiff(
                content.oldContent,
                content.newContent,
                content.filePath || content.path || 'file',
                content.title
              );
            }
            break;
          default:
            Logger.warn('Unknown file operation:', content.operation);
        }
      } catch (error) {
        Logger.error('Error handling file operation:', error);
      }
    });
  }

  private _registerDefaultHandlers(): void {
    // Test message handler
    this.register('test', async (message) => {
      Logger.info('Test message received:', message.content);
      this._sendToWebview({
        type: 'testResponse',
        content: { received: true, echo: message.content },
        requestId: message.requestId
      });
    });

    // Send message to AI
    this.register('sendMessage', async (message) => {
      const content = message.content as { text: string; sessionId?: string };
      Logger.info('Sending message to AI:', content.text?.substring(0, 50) + '...');

      this._bridgeManager.send({
        type: 'sendMessage',
        content,
        requestId: message.requestId
      });
    });

    // Get history
    this.register('getHistory', async (message) => {
      this._bridgeManager.send({
        type: 'getHistory',
        content: {},
        requestId: message.requestId
      });
    });

    // Load session
    this.register('loadSession', async (message) => {
      this._bridgeManager.send({
        type: 'loadSession',
        content: message.content,
        requestId: message.requestId
      });
    });

    // Delete session
    this.register('deleteSession', async (message) => {
      this._bridgeManager.send({
        type: 'deleteSession',
        content: message.content,
        requestId: message.requestId
      });
    });

    // Get settings
    this.register('getSettings', async (message) => {
      this._bridgeManager.send({
        type: 'getSettings',
        content: {},
        requestId: message.requestId
      });
    });

    // Update settings
    this.register('updateSettings', async (message) => {
      this._bridgeManager.send({
        type: 'updateSettings',
        content: message.content,
        requestId: message.requestId
      });
    });

    // Get provider config
    this.register('getProviderConfig', async (message) => {
      this._bridgeManager.send({
        type: 'getProviderConfig',
        content: message.content,
        requestId: message.requestId
      });
    });

    // Update provider config
    this.register('updateProviderConfig', async (message) => {
      this._bridgeManager.send({
        type: 'updateProviderConfig',
        content: message.content,
        requestId: message.requestId
      });
    });

    // Legacy provider update (used by webview)
    this.register('update_provider', async (message) => {
      this._bridgeManager.send({
        type: 'update_provider',
        content: message.content,
        requestId: message.requestId
      });
    });

    // Thinking toggle
    this.register('get_thinking_enabled', async (message) => {
      this._bridgeManager.send({
        type: 'get_thinking_enabled',
        content: message.content ?? {},
        requestId: message.requestId
      });
    });

    this.register('set_thinking_enabled', async (message) => {
      this._bridgeManager.send({
        type: 'set_thinking_enabled',
        content: message.content,
        requestId: message.requestId
      });
    });

    // Permission response
    this.register('permissionResponse', async (message) => {
      this._bridgeManager.send({
        type: 'permissionResponse',
        content: message.content,
        requestId: message.requestId
      });
    });

    // MCP servers
    this.register('getMcpServers', async (message) => {
      this._bridgeManager.send({
        type: 'getMcpServers',
        content: {},
        requestId: message.requestId
      });
    });

    this.register('addMcpServer', async (message) => {
      this._bridgeManager.send({
        type: 'addMcpServer',
        content: message.content,
        requestId: message.requestId
      });
    });

    this.register('updateMcpServer', async (message) => {
      this._bridgeManager.send({
        type: 'updateMcpServer',
        content: message.content,
        requestId: message.requestId
      });
    });

    this.register('deleteMcpServer', async (message) => {
      this._bridgeManager.send({
        type: 'deleteMcpServer',
        content: message.content,
        requestId: message.requestId
      });
    });

    // Skills
    this.register('getSkills', async (message) => {
      this._bridgeManager.send({
        type: 'getSkills',
        content: {},
        requestId: message.requestId
      });
    });

    const handleListFiles = async (message: WebviewMessage) => {
      try {
        const content = message.content as { query?: string; currentPath?: string } | undefined;
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        const files = await FileHandler.listFiles(content || {}, workspaceRoot);
        this._sendToWebview({
          type: 'fileListResult',
          content: { files },
          requestId: message.requestId
        });
      } catch (error) {
        Logger.error('Failed to list files:', error);
        this._sendToWebview({
          type: 'fileListResult',
          content: { files: [] },
          requestId: message.requestId
        });
      }
    };

    this.register('list_files', handleListFiles);
    this.register('listFiles', handleListFiles);

    const openSkillFileChooser = async (message: WebviewMessage) => {
      const content = message.content as { scope?: string; paths?: string[]; path?: string; files?: string[] } | undefined;
      const scope = content?.scope === 'local' ? 'local' : 'global';

      const hasPaths =
        (Array.isArray(content?.paths) && content?.paths.length > 0) ||
        (Array.isArray(content?.files) && content?.files.length > 0) ||
        typeof content?.path === 'string';

      if (hasPaths) {
        this._bridgeManager.send({
          type: 'import_skill',
          content,
          requestId: message.requestId
        });
        return;
      }

      const selection = await vscode.window.showOpenDialog({
        canSelectMany: true,
        canSelectFiles: true,
        canSelectFolders: true,
        openLabel: 'Select',
        title: 'Select Skill File or Folder',
      });

      if (!selection || selection.length === 0) {
        this._sendToWebview({
          type: 'backend_notification',
          content: { type: 'info', message: '已取消选择文件' },
          requestId: message.requestId
        });
        return;
      }

      const paths = selection.map((item) => item.fsPath);
      this._bridgeManager.send({
        type: 'import_skill',
        content: { scope, paths },
        requestId: message.requestId
      });
    };

    this.register('import_skill', openSkillFileChooser);
    this.register('importSkill', openSkillFileChooser);

    // Agents
    this.register('getAgents', async (message) => {
      this._bridgeManager.send({
        type: 'getAgents',
        content: {},
        requestId: message.requestId
      });
    });

    // Dependencies
    this.register('getDependencies', async (message) => {
      this._bridgeManager.send({
        type: 'getDependencies',
        content: {},
        requestId: message.requestId
      });
    });

    this.register('installDependency', async (message) => {
      this._bridgeManager.send({
        type: 'installDependency',
        content: message.content,
        requestId: message.requestId
      });
    });

    // Open file in editor
    this.register('openFile', async (message) => {
      const content = message.content as { path: string; line?: number; column?: number };
      const success = await FileHandler.openFile(content.path, content.line, content.column);
      if (!success) {
        this._sendError(message.requestId, 'FILE_NOT_FOUND', `Failed to open file: ${content.path}`);
      }
    });

    // Open browser/external URL
    this.register('openBrowser', async (message) => {
      const content = message.content as { url: string };
      await FileHandler.openExternal(content.url);
    });

    // Refresh file
    this.register('refreshFile', async (message) => {
      const content = message.content as { path: string };
      await FileHandler.refreshFile(content.path);
    });

    // Show diff
    this.register('showDiff', async (message) => {
      const content = message.content as {
        filePath?: string;
        originalPath?: string;
        modifiedPath?: string;
        originalContent?: string;
        newContent?: string;
        title?: string;
      };

      let success = false;

      if (content.originalPath && content.modifiedPath) {
        // File-based diff
        success = await DiffHandler.showFileDiff(
          content.originalPath,
          content.modifiedPath,
          content.title
        );
      } else if (content.filePath && content.newContent !== undefined) {
        // Proposed changes diff
        success = await DiffHandler.showProposedChanges(
          content.filePath,
          content.newContent,
          content.title
        );
      } else if (content.originalContent !== undefined && content.newContent !== undefined) {
        // Content-based diff
        success = await DiffHandler.showContentDiff(
          content.originalContent,
          content.newContent,
          content.filePath || 'file',
          content.title
        );
      }

      if (!success) {
        this._sendError(message.requestId, 'DIFF_ERROR', 'Failed to show diff');
      }
    });

    // Get working directory
    this.register('getWorkingDirectory', async (message) => {
      const configService = ConfigService.getInstance();
      const workingDir = configService.getWorkingDirectory();
      this._sendToWebview({
        type: 'workingDirectory',
        content: { path: workingDir || '' },
        requestId: message.requestId
      });
    });

    const openCcSwitchFileChooser = async (message: WebviewMessage) => {
      const selection = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: 'Select',
        filters: {
          'cc-switch': ['db', 'sqlite', 'sqlite3'],
          'All Files': ['*']
        }
      });

      if (!selection || selection.length === 0) {
        this._sendToWebview({
          type: 'backend_notification',
          content: { type: 'info', message: '已取消选择文件' },
          requestId: message.requestId
        });
        return;
      }

      const dbPath = selection[0].fsPath;
      this._bridgeManager.send({
        type: 'preview_cc_switch_import',
        content: { dbPath },
        requestId: message.requestId
      });
    };

    this.register('open_file_chooser_for_cc_switch', openCcSwitchFileChooser);
    this.register('openFileChooserForCcSwitch', openCcSwitchFileChooser);
  }

  public register(type: string, handler: MessageHandler): void {
    this._handlers.set(type, handler);
  }

  public async route(message: WebviewMessage): Promise<void> {
    const handler = this._handlers.get(message.type);

    if (handler) {
      await handler(message);
    } else {
      Logger.debug('Forwarding unhandled message type to bridge:', message.type);
      // Forward unknown messages to bridge
      this._bridgeManager.send({
        type: message.type,
        content: message.content,
        requestId: message.requestId
      });
    }
  }

  private _sendToWebview(message: { type: string; content: unknown; requestId?: string }): void {
    if (this._webview) {
      this._webview.postMessage(message);
    }
  }

  private _sendError(requestId: string | undefined, code: string, errorMessage: string): void {
    this._sendToWebview({
      type: 'error',
      content: { code, message: errorMessage },
      requestId
    });
  }
}
