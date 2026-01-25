import { getAdapter, isVSCode } from '../platform';
import { MessageTypes } from '../platform/types';

const BRIDGE_UNAVAILABLE_WARNED = new Set<string>();

/** Path traversal patterns to detect (including URL-encoded variants) */
const PATH_TRAVERSAL_PATTERNS = [
  '..',           // Direct traversal
  '~',            // Home directory reference
  '%2e%2e',       // URL-encoded ..
  '%2E%2E',       // URL-encoded .. (uppercase)
  '%252e%252e',   // Double URL-encoded ..
];

/**
 * Validate file path doesn't contain path traversal patterns
 * Defense-in-depth: backend also validates using canonical paths
 */
const isValidPath = (filePath: string): boolean => {
  if (!filePath) return false;
  // Check both original and decoded path for traversal patterns
  const decodedPath = decodeURIComponent(filePath);
  return !PATH_TRAVERSAL_PATTERNS.some(pattern =>
    filePath.toLowerCase().includes(pattern.toLowerCase()) ||
    decodedPath.toLowerCase().includes(pattern.toLowerCase())
  );
};

/**
 * Internal function to call the bridge
 * Uses platform adapter for VSCode, falls back to window.sendToJava for IDEA
 */
const callBridge = (payload: string) => {
  // Try VSCode adapter first
  if (isVSCode()) {
    const adapter = getAdapter();
    if (adapter.isReady()) {
      // Parse the payload and send through adapter
      const colonIndex = payload.indexOf(':');
      if (colonIndex === -1) {
        adapter.send(payload);
      } else {
        const type = payload.substring(0, colonIndex);
        const content = payload.substring(colonIndex + 1);
        try {
          adapter.send(type, JSON.parse(content));
        } catch {
          adapter.send(type, content);
        }
      }
      return true;
    }
  }

  // Fall back to legacy sendToJava (for IDEA or if adapter not ready)
  if (window.sendToJava) {
    window.sendToJava(payload);
    return true;
  }
  // Track warned payloads to avoid spam, but don't log to console
  BRIDGE_UNAVAILABLE_WARNED.add(payload);
  return false;
};

export const sendBridgeEvent = (event: string, content = '') => {
  return callBridge(`${event}:${content}`);
};

export const openFile = (filePath?: string, line?: number) => {
  if (!filePath) {
    return;
  }
  // Security: Validate file path
  if (!isValidPath(filePath)) {
    return;
  }
  if (isVSCode()) {
    getAdapter().openFile(filePath, line);
  } else {
    sendBridgeEvent('open_file', filePath);
  }
};

export const openBrowser = (url?: string) => {
  if (!url) {
    return;
  }

  if (isVSCode()) {
    getAdapter().openBrowser(url);
  } else {
    sendBridgeEvent('open_browser', url);
  }
};

export const sendToJava = (message: string, payload: any = {}) => {
  const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
  sendBridgeEvent(message, payloadStr);
};

export const refreshFile = (filePath: string) => {
  if (!filePath) return;

  if (isVSCode()) {
    getAdapter().refreshFile(filePath);
  } else {
    sendToJava('refresh_file', { filePath });
  }
};

export const showDiff = (filePath: string, oldContent: string, newContent: string, title?: string) => {
  if (isVSCode()) {
    getAdapter().showDiff(filePath, oldContent, newContent, title);
  } else {
    sendToJava('show_diff', { filePath, oldContent, newContent, title });
  }
};

export const showMultiEditDiff = (
  filePath: string,
  edits: Array<{ oldString: string; newString: string; replaceAll?: boolean }>,
  currentContent?: string
) => {
  // VSCode doesn't have multi-edit diff, use regular diff with combined content
  if (isVSCode()) {
    // For VSCode, we could potentially combine edits or show them sequentially
    // For now, just send to the extension which can handle it
    getAdapter().send('showMultiEditDiff', { filePath, edits, currentContent });
  } else {
    sendToJava('show_multi_edit_diff', { filePath, edits, currentContent });
  }
};

/**
 * Rewind files to a specific user message state
 * @param sessionId - Session ID
 * @param userMessageId - User message UUID to rewind to
 */
export const rewindFiles = (sessionId: string, userMessageId: string) => {
  if (isVSCode()) {
    getAdapter().send('rewindFiles', { sessionId, userMessageId });
  } else {
    sendToJava('rewind_files', { sessionId, userMessageId });
  }
};

/**
 * Send a message to the AI
 * @param text - Message text
 * @param sessionId - Optional session ID
 */
export const sendMessage = (text: string, sessionId?: string) => {
  if (isVSCode()) {
    getAdapter().send(MessageTypes.SEND_MESSAGE, { text, sessionId });
  } else {
    sendToJava('send_message', { text, sessionId });
  }
};

/**
 * Get history sessions
 */
export const getHistory = () => {
  if (isVSCode()) {
    getAdapter().send(MessageTypes.GET_HISTORY);
  } else {
    sendBridgeEvent('get_history');
  }
};

/**
 * Load a specific session
 * @param sessionId - Session ID to load
 */
export const loadSession = (sessionId: string) => {
  if (isVSCode()) {
    getAdapter().send(MessageTypes.LOAD_SESSION, { sessionId });
  } else {
    sendToJava('load_session', { sessionId });
  }
};

/**
 * Delete a session
 * @param sessionId - Session ID to delete
 */
export const deleteSession = (sessionId: string) => {
  if (isVSCode()) {
    getAdapter().send(MessageTypes.DELETE_SESSION, { sessionId });
  } else {
    sendToJava('delete_session', { sessionId });
  }
};

/**
 * Get current settings
 */
export const getSettings = () => {
  if (isVSCode()) {
    getAdapter().send(MessageTypes.GET_SETTINGS);
  } else {
    sendBridgeEvent('get_settings');
  }
};

/**
 * Update settings
 * @param settings - Partial settings to update
 */
export const updateSettings = (settings: Record<string, unknown>) => {
  if (isVSCode()) {
    getAdapter().send(MessageTypes.UPDATE_SETTINGS, { settings });
  } else {
    sendToJava('update_settings', settings);
  }
};

/**
 * Respond to a permission request
 * @param id - Permission request ID
 * @param allowed - Whether permission was granted
 * @param remember - Whether to remember this decision
 */
export const respondToPermission = (id: string, allowed: boolean, remember?: boolean) => {
  if (isVSCode()) {
    getAdapter().send(MessageTypes.PERMISSION_RESPONSE, { id, allowed, remember });
  } else {
    sendToJava('permission_response', { id, allowed, remember });
  }
};

/**
 * Undo changes for a single file
 * @param filePath - Absolute path to the file
 * @param status - File status: 'A' (added) or 'M' (modified)
 * @param operations - Array of edit operations to reverse
 */
export const undoFileChanges = (
  filePath: string,
  status: 'A' | 'M',
  operations: Array<{ oldString: string; newString: string; replaceAll?: boolean }>
) => {
  // Security: Validate file path (defense-in-depth, backend also validates)
  if (!isValidPath(filePath)) {
    return;
  }
  sendToJava('undo_file_changes', { filePath, status, operations });
};
