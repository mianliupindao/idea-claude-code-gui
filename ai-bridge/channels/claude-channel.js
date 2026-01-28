/**
 * Claude channel command handler – isolates all Claude specific command logic
 * away from the shared channel-manager entry point.
 */
import {
  sendMessage as claudeSendMessage,
  sendMessageWithAttachments as claudeSendMessageWithAttachments,
  getSlashCommands as claudeGetSlashCommands,
  rewindFiles as claudeRewindFiles,
  getMcpServerStatus as claudeGetMcpServerStatus,
  getMcpServerTools as claudeGetMcpServerTools
} from '../services/claude/message-service.js';
import { getSessionMessages as claudeGetSessionMessages } from '../services/claude/session-service.js';

/**
 * Execute a Claude specific command.
 * @param {string} command
 * @param {string[]} args
 * @param {object|null} stdinData
 */
export async function handleClaudeCommand(command, args, stdinData) {
  switch (command) {
    case 'send': {
      if (stdinData && stdinData.message !== undefined) {
        // 🔧 解构时包含 streaming 参数
        const { message, sessionId, cwd, permissionMode, model, openedFiles, agentPrompt, streaming, thinkingEnabled } = stdinData;
        await claudeSendMessage(
          message,
          sessionId || '',
          cwd || '',
          permissionMode || '',
          model || '',
          openedFiles || null,
          agentPrompt || null,
          streaming,  // 🔧 传递 streaming 参数
          thinkingEnabled
        );
      } else {
        await claudeSendMessage(args[0], args[1], args[2], args[3], args[4]);
      }
      break;
    }

    case 'sendWithAttachments': {
      if (stdinData && stdinData.message !== undefined) {
        // 🔧 解构时包含 streaming 参数
        const { message, sessionId, cwd, permissionMode, model, attachments, openedFiles, agentPrompt, streaming, thinkingEnabled } = stdinData;
        await claudeSendMessageWithAttachments(
          message,
          sessionId || '',
          cwd || '',
          permissionMode || '',
          model || '',
          attachments
            ? { attachments, openedFiles, agentPrompt, streaming, thinkingEnabled }
            : { openedFiles, agentPrompt, streaming, thinkingEnabled }
        );
      } else {
        await claudeSendMessageWithAttachments(args[0], args[1], args[2], args[3], args[4], stdinData);
      }
      break;
    }

    case 'getSession':
      await claudeGetSessionMessages(args[0], args[1]);
      break;

    case 'getSlashCommands': {
      const cwd = stdinData?.cwd || args[0] || null;
      await claudeGetSlashCommands(cwd);
      break;
    }

    case 'rewindFiles': {
      const sessionId = stdinData?.sessionId || args[0];
      const userMessageId = stdinData?.userMessageId || args[1];
      const cwd = stdinData?.cwd || args[2] || null;
      if (!sessionId || !userMessageId) {
        console.log(JSON.stringify({
          success: false,
          error: 'Missing required parameters: sessionId and userMessageId'
        }));
        return;
      }
      await claudeRewindFiles(sessionId, userMessageId, cwd);
      break;
    }

    case 'getMcpServerStatus': {
      const cwd = stdinData?.cwd || args[0] || null;
      await claudeGetMcpServerStatus(cwd);
      break;
    }

    case 'getMcpServerTools': {
      const serverId = stdinData?.serverId || args[0] || null;
      await claudeGetMcpServerTools(serverId);
      break;
    }

    default:
      throw new Error(`Unknown Claude command: ${command}`);
  }
}

export function getClaudeCommandList() {
  return ['send', 'sendWithAttachments', 'getSession', 'getSlashCommands', 'rewindFiles', 'getMcpServerStatus', 'getMcpServerTools'];
}
