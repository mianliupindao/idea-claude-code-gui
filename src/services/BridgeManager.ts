import * as vscode from 'vscode';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { Logger } from '../utils/logger';
import { EventEmitter } from 'events';

export interface BridgeMessage {
  type: string;
  content: unknown;
  requestId?: string;
}

type MessageHandler = (message: BridgeMessage) => void;

export class BridgeManager extends EventEmitter {
  private _process: ChildProcess | null = null;
  private _isRunning = false;
  private _restartCount = 0;
  private _maxRestarts = 3;
  private _messageBuffer = '';
  private _messageHandlers: Map<string, MessageHandler[]> = new Map();

  constructor(private readonly _context: vscode.ExtensionContext) {
    super();
  }

  public get isRunning(): boolean {
    return this._isRunning;
  }

  public async start(): Promise<void> {
    if (this._isRunning) {
      Logger.warn('Bridge process is already running');
      return;
    }

    // Use server.js for VSCode (persistent server mode)
    const bridgePath = path.join(this._context.extensionPath, 'ai-bridge', 'server.js');
    const nodePath = process.execPath || 'node';
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';

    try {
      Logger.info('Starting ai-bridge server:', bridgePath, 'using Node:', nodePath);

      this._process = spawn(nodePath, [bridgePath], {
        cwd: path.join(this._context.extensionPath, 'ai-bridge'),
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NODE_ENV: 'production',
          CODEMOSS_EXTENSION_PATH: this._context.extensionPath,
          CODEMOSS_WORKSPACE_ROOT: workspaceRoot
        }
      });

      this._setupProcessListeners();
      this._isRunning = true;
      this._restartCount = 0;

      Logger.info('ai-bridge server started successfully');
    } catch (error) {
      Logger.error('Failed to start ai-bridge server:', error);
      throw error;
    }
  }

  private _setupProcessListeners(): void {
    if (!this._process) return;

    // Handle stdout (messages from bridge)
    this._process.stdout?.on('data', (data: Buffer) => {
      this._handleData(data.toString());
    });

    // Handle stderr (logs from bridge)
    this._process.stderr?.on('data', (data: Buffer) => {
      const logLine = data.toString().trim();
      // Upgrade diagnostic logs to INFO level for visibility
      if (logLine.includes('[DIAG]') || logLine.includes('[DEBUG]') || logLine.includes('[INTERCEPT]')) {
        Logger.info('[ai-bridge]', logLine);
      } else if (logLine.includes('[ERROR]') || logLine.includes('Error:')) {
        Logger.error('[ai-bridge]', logLine);
      } else {
        Logger.debug('[ai-bridge]', logLine);
      }
    });

    // Handle process exit
    this._process.on('exit', (code, signal) => {
      this._isRunning = false;
      Logger.warn(`ai-bridge process exited with code ${code}, signal ${signal}`);

      // Attempt restart if not intentionally stopped
      if (code !== 0 && this._restartCount < this._maxRestarts) {
        this._restartCount++;
        Logger.info(`Attempting to restart ai-bridge (attempt ${this._restartCount}/${this._maxRestarts})`);
        setTimeout(() => this.start(), 1000 * this._restartCount);
      } else if (this._restartCount >= this._maxRestarts) {
        Logger.error('Max restart attempts reached for ai-bridge');
        vscode.window.showErrorMessage(
          'CodeMoss: AI bridge process failed to start. Please check your Node.js installation.',
          'Show Logs'
        ).then(action => {
          if (action === 'Show Logs') {
            Logger.show();
          }
        });
      }
    });

    // Handle process error
    this._process.on('error', (error) => {
      Logger.error('ai-bridge process error:', error);
      this._isRunning = false;
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        vscode.window.showErrorMessage(
          'CodeMoss: Failed to start AI bridge. Node.js runtime was not found.',
          'Show Logs'
        ).then(action => {
          if (action === 'Show Logs') {
            Logger.show();
          }
        });
      }
    });
  }

  private _handleData(data: string): void {
    this._messageBuffer += data;

    // Process complete messages (newline-delimited JSON)
    const lines = this._messageBuffer.split('\n');
    this._messageBuffer = lines.pop() || '';

    for (const line of lines) {
      if (line.trim()) {
        // Only try to parse lines that look like JSON
        if (line.trim().startsWith('{')) {
          try {
            const message = JSON.parse(line) as BridgeMessage;
            this._handleMessage(message);
          } catch (_error) {
            // Silently ignore malformed JSON - could be debug output
            Logger.debug('[ai-bridge] Non-JSON output:', line.substring(0, 100));
          }
        } else {
          // Non-JSON output (debug logs from ai-bridge)
          Logger.debug('[ai-bridge]', line);
        }
      }
    }
  }

  private _handleMessage(message: BridgeMessage): void {
    Logger.debug('Received message from bridge:', message.type);

    // Emit event for this message type
    this.emit(message.type, message);
    this.emit('message', message);

    // Call registered handlers
    const handlers = this._messageHandlers.get(message.type);
    if (handlers) {
      handlers.forEach(handler => handler(message));
    }
  }

  public send(message: BridgeMessage): boolean {
    if (!this._process || !this._isRunning) {
      Logger.warn('Cannot send message: bridge process not running');
      return false;
    }

    try {
      const data = JSON.stringify(message) + '\n';
      this._process.stdin?.write(data);
      Logger.debug('Sent message to bridge:', message.type);
      return true;
    } catch (error) {
      Logger.error('Failed to send message to bridge:', error);
      return false;
    }
  }

  public onMessage(type: string, handler: MessageHandler): void {
    if (!this._messageHandlers.has(type)) {
      this._messageHandlers.set(type, []);
    }
    this._messageHandlers.get(type)!.push(handler);
  }

  public offMessage(type: string, handler: MessageHandler): void {
    const handlers = this._messageHandlers.get(type);
    if (handlers) {
      const index = handlers.indexOf(handler);
      if (index > -1) {
        handlers.splice(index, 1);
      }
    }
  }

  public stop(): void {
    if (this._process) {
      Logger.info('Stopping ai-bridge process');
      this._restartCount = this._maxRestarts; // Prevent auto-restart
      this._process.kill();
      this._process = null;
      this._isRunning = false;
    }
  }

  public restart(): Promise<void> {
    this.stop();
    this._restartCount = 0;
    return this.start();
  }
}
