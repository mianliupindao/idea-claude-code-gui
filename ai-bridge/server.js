#!/usr/bin/env node

/**
 * AI Bridge Server for VSCode Extension
 *
 * This is a long-running server that listens for JSON commands on stdin
 * and dispatches them to the appropriate handlers.
 *
 * Message Format (stdin):
 * { "type": "sendMessage", "content": {...}, "requestId": "xxx" }
 *
 * Response Format (stdout):
 * { "type": "streamChunk", "content": {...}, "requestId": "xxx" }
 */

import { handleClaudeCommand } from './channels/claude-channel.js';
import { handleCodexCommand } from './channels/codex-channel.js';
import { getSlashCommands as claudeGetSlashCommands } from './services/claude/message-service.js';
import { clearSdkCache, getClaudeSdkVersion, getCodexSdkVersion, getSdkStatus, isClaudeSdkAvailable, isCodexSdkAvailable } from './utils/sdk-loader.js';
import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { execFileSync, spawn } from 'child_process';
import { parseToml, generateToml } from './utils/toml-utils.js';

// Config paths
const CONFIG_DIR = path.join(os.homedir(), '.codemoss');
const SESSIONS_DIR = path.join(CONFIG_DIR, 'sessions');
const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');
const CODEMOSS_CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const PROVIDERS_FILE = path.join(CONFIG_DIR, 'providers.json');
const CODEX_PROVIDERS_FILE = path.join(CONFIG_DIR, 'codex-providers.json');
const CLAUDE_SETTINGS_FILE = path.join(os.homedir(), '.claude', 'settings.json');
const CLAUDE_JSON_FILE = path.join(os.homedir(), '.claude.json');
const CODEX_CONFIG_FILE = path.join(os.homedir(), '.codex', 'config.toml');
const AGENT_FILE = path.join(CONFIG_DIR, 'agent.json');
const LEGACY_AGENTS_FILE = path.join(CONFIG_DIR, 'agents.json');
const WORKSPACE_ROOT = (process.env.CODEMOSS_WORKSPACE_ROOT || '').trim();

function getWorkspaceRoot() {
  if (WORKSPACE_ROOT) {
    return WORKSPACE_ROOT;
  }
  return process.cwd();
}

const FILE_LIST_MAX_RESULTS = 200;
const FILE_LIST_MAX_DEPTH = 15;
const FILE_LIST_MAX_CHILDREN = 100;
const FILE_LIST_HIDDEN = new Set(['.DS_Store', '.git', 'node_modules', '.idea']);

function normalizeDisplayPath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function shouldHideListEntry(name) {
  return FILE_LIST_HIDDEN.has(name);
}

function buildFileItem(entry, entryPath, workspaceRoot) {
  const type = entry.isDirectory() ? 'directory' : 'file';
  let relativePath = entryPath;
  if (workspaceRoot && entryPath.startsWith(workspaceRoot)) {
    relativePath = path.relative(workspaceRoot, entryPath);
  }

  const item = {
    name: entry.name,
    path: normalizeDisplayPath(relativePath),
    absolutePath: entryPath,
    type,
  };

  if (!entry.isDirectory()) {
    const ext = path.extname(entry.name).replace('.', '');
    if (ext) {
      item.extension = ext;
    }
  }

  return item;
}

function resolveListBaseDir(workspaceRoot, currentPath) {
  const trimmed = (currentPath || '').trim();
  const root = workspaceRoot || process.cwd();

  if (!trimmed) {
    return { baseDir: root };
  }

  if (path.isAbsolute(trimmed)) {
    return { baseDir: trimmed };
  }

  return { baseDir: path.join(root, trimmed) };
}

function listDirectoryEntries(baseDir, workspaceRoot, query) {
  const results = [];
  if (!baseDir || !fs.existsSync(baseDir)) {
    return results;
  }

  let entries = [];
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch (error) {
    console.error('[server] Failed to read directory:', error?.message || error);
    return results;
  }

  const lowerQuery = query ? query.toLowerCase() : '';
  for (const entry of entries) {
    if (shouldHideListEntry(entry.name)) continue;
    if (lowerQuery && !entry.name.toLowerCase().includes(lowerQuery)) continue;

    const entryPath = path.join(baseDir, entry.name);
    results.push(buildFileItem(entry, entryPath, workspaceRoot));

    if (results.length >= FILE_LIST_MAX_CHILDREN) {
      break;
    }
  }

  return results;
}

function searchFilesRecursive(baseDir, workspaceRoot, query, results, depth) {
  if (!baseDir || depth > FILE_LIST_MAX_DEPTH || results.length >= FILE_LIST_MAX_RESULTS) {
    return;
  }

  let entries = [];
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return;
  }

  const lowerQuery = query.toLowerCase();
  for (const entry of entries) {
    if (shouldHideListEntry(entry.name)) continue;

    const entryPath = path.join(baseDir, entry.name);
    if (entry.name.toLowerCase().includes(lowerQuery)) {
      results.push(buildFileItem(entry, entryPath, workspaceRoot));
      if (results.length >= FILE_LIST_MAX_RESULTS) {
        return;
      }
    }

    if (entry.isDirectory()) {
      searchFilesRecursive(entryPath, workspaceRoot, query, results, depth + 1);
      if (results.length >= FILE_LIST_MAX_RESULTS) {
        return;
      }
    }
  }
}

// Current state
let currentProvider = 'claude';
let currentSessionId = null;

// Ensure directories exist
function ensureDirectories() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  }
}

ensureDirectories();
migrateLegacyProvidersToConfig();

/**
 * Send message to Extension Host via stdout
 */
function sendToHost(type, content, requestId) {
  const message = JSON.stringify({ type, content, requestId });
  console.log(message);
}

/**
 * Send error to Extension Host
 */
function sendError(error, requestId) {
  sendToHost('error', {
    code: 'BRIDGE_ERROR',
    message: error.message || String(error)
  }, requestId);
}

/**
 * Load JSON file
 */
function loadJsonFile(filePath, defaultValue = {}) {
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(content);
    }
  } catch (error) {
    console.error(`[server] Failed to load ${filePath}:`, error.message);
  }
  return defaultValue;
}

/**
 * Save JSON file
 */
function saveJsonFile(filePath, data) {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch (error) {
    console.error(`[server] Failed to save ${filePath}:`, error.message);
    return false;
  }
}

function normalizeAgentsConfig(raw) {
  const config = raw && typeof raw === 'object' ? raw : {};
  const agents = config.agents;
  if (agents && typeof agents === 'object' && !Array.isArray(agents)) {
    return { ...config, agents };
  }

  if (Array.isArray(agents)) {
    const agentMap = {};
    for (const agent of agents) {
      if (!agent || typeof agent !== 'object') continue;
      const id = typeof agent.id === 'string' && agent.id ? agent.id : `agent_${Date.now()}`;
      agentMap[id] = { ...agent, id };
    }
    return { ...config, agents: agentMap };
  }

  return { ...config, agents: {} };
}

function readAgentConfig() {
  if (fs.existsSync(AGENT_FILE)) {
    return normalizeAgentsConfig(loadJsonFile(AGENT_FILE, {}));
  }

  if (fs.existsSync(LEGACY_AGENTS_FILE)) {
    const legacy = normalizeAgentsConfig(loadJsonFile(LEGACY_AGENTS_FILE, {}));
    saveJsonFile(AGENT_FILE, legacy);
    return legacy;
  }

  return { agents: {} };
}

function writeAgentConfig(config) {
  return saveJsonFile(AGENT_FILE, normalizeAgentsConfig(config));
}

function getAgentsList() {
  const config = readAgentConfig();
  const agents = config.agents || {};
  const list = Object.keys(agents).map((id) => {
    const agent = agents[id] && typeof agents[id] === 'object' ? agents[id] : {};
    return { id, ...agent };
  });

  list.sort((a, b) => {
    const timeA = typeof a.createdAt === 'number' ? a.createdAt : 0;
    const timeB = typeof b.createdAt === 'number' ? b.createdAt : 0;
    return timeB - timeA;
  });

  return list;
}

function loadCodemossConfig() {
  const config = loadJsonFile(CODEMOSS_CONFIG_FILE, {});
  return config && typeof config === 'object' ? config : {};
}

function saveCodemossConfig(config) {
  return saveJsonFile(CODEMOSS_CONFIG_FILE, config && typeof config === 'object' ? config : {});
}

function ensureClaudeSection(config) {
  if (!config.claude || typeof config.claude !== 'object') {
    config.claude = {};
  }
  if (!config.claude.providers || typeof config.claude.providers !== 'object') {
    config.claude.providers = {};
  }
  if (typeof config.claude.current !== 'string' || !config.claude.current) {
    config.claude.current = '__local_settings_json__';
  }
  return config;
}

function ensureCodexSection(config) {
  if (!config.codex || typeof config.codex !== 'object') {
    config.codex = {};
  }
  if (!config.codex.providers || typeof config.codex.providers !== 'object') {
    config.codex.providers = {};
  }
  if (typeof config.codex.current !== 'string') {
    config.codex.current = '';
  }
  return config;
}

function normalizeClaudeProviderEntry(id, provider) {
  const base = provider && typeof provider === 'object' ? provider : {};
  const createdAt =
    typeof base.createdAt === 'number' && Number.isFinite(base.createdAt)
      ? base.createdAt
      : Date.now();
  return { ...base, id, createdAt };
}

function normalizeCodexProviderEntry(id, provider) {
  const base = provider && typeof provider === 'object' ? provider : {};
  const createdAt =
    typeof base.createdAt === 'number' && Number.isFinite(base.createdAt)
      ? base.createdAt
      : Date.now();
  return { ...base, id, createdAt };
}

function getClaudeProvidersFromConfig(config) {
  const cfg = ensureClaudeSection(config);
  const providersObj = cfg.claude.providers;
  const result = [];
  for (const [id, value] of Object.entries(providersObj)) {
    if (typeof id !== 'string' || !id) continue;
    result.push(normalizeClaudeProviderEntry(id, value));
  }
  return result;
}

function getCodexProvidersFromConfig(config) {
  const cfg = ensureCodexSection(config);
  const providersObj = cfg.codex.providers;
  const result = [];
  for (const [id, value] of Object.entries(providersObj)) {
    if (typeof id !== 'string' || !id) continue;
    result.push(normalizeCodexProviderEntry(id, value));
  }
  return result;
}

function syncLegacyProviderFilesFromConfig(config) {
  try {
    const cfg = ensureClaudeSection(config);
    const providers = getClaudeProvidersFromConfig(cfg).map(p => ({ ...p }));
    saveJsonFile(PROVIDERS_FILE, { providers });
  } catch {
  }

  try {
    const cfg = ensureCodexSection(config);
    const providers = getCodexProvidersFromConfig(cfg).map(p => ({ ...p }));
    saveJsonFile(CODEX_PROVIDERS_FILE, { providers });
  } catch {
  }
}

function migrateLegacyProvidersToConfig() {
  const config = loadCodemossConfig();
  ensureClaudeSection(config);
  ensureCodexSection(config);

  let changed = false;

  const legacyClaude = loadJsonFile(PROVIDERS_FILE, { providers: [] });
  const legacyClaudeList = Array.isArray(legacyClaude.providers) ? legacyClaude.providers : [];
  const configClaudeProviders = config.claude.providers;
  if (Object.keys(configClaudeProviders).length === 0 && legacyClaudeList.length > 0) {
    for (const p of legacyClaudeList) {
      if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !p.id) continue;
      configClaudeProviders[p.id] = { ...p };
    }
    changed = true;
  }

  const legacyCodex = loadJsonFile(CODEX_PROVIDERS_FILE, { providers: [] });
  const legacyCodexList = Array.isArray(legacyCodex.providers) ? legacyCodex.providers : [];
  const configCodexProviders = config.codex.providers;
  if (Object.keys(configCodexProviders).length === 0 && legacyCodexList.length > 0) {
    for (const p of legacyCodexList) {
      if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !p.id) continue;
      configCodexProviders[p.id] = { ...p };
    }
    changed = true;
  }

  const settings = loadJsonFile(SETTINGS_FILE, {});
  if ((typeof config.claude.current !== 'string' || !config.claude.current) && typeof settings.activeClaudeProviderId === 'string') {
    config.claude.current = settings.activeClaudeProviderId;
    changed = true;
  }
  if ((typeof config.codex.current !== 'string') && typeof settings.activeCodexProvider === 'string') {
    config.codex.current = settings.activeCodexProvider;
    changed = true;
  }

  if (changed) {
    saveCodemossConfig(config);
    syncLegacyProviderFilesFromConfig(config);
  }
}

function loadClaudeJson() {
  if (!fs.existsSync(CLAUDE_JSON_FILE)) {
    return null;
  }
  const data = loadJsonFile(CLAUDE_JSON_FILE, {});
  return data && typeof data === 'object' ? data : null;
}

function saveClaudeJson(data) {
  return saveJsonFile(CLAUDE_JSON_FILE, data && typeof data === 'object' ? data : {});
}

function syncClaudeMcpToSettings() {
  const claudeJson = loadClaudeJson();
  if (!claudeJson) {
    return;
  }
  const current = readClaudeSettings() || {};
  const next = { ...current };
  if (claudeJson.mcpServers && typeof claudeJson.mcpServers === 'object') {
    next.mcpServers = claudeJson.mcpServers;
  }
  if (Array.isArray(claudeJson.disabledMcpServers)) {
    next.disabledMcpServers = claudeJson.disabledMcpServers;
  }
  writeClaudeSettings(next);
}

function getClaudeDisabledServers(claudeJson, projectPath) {
  const disabled = new Set();
  if (claudeJson && Array.isArray(claudeJson.disabledMcpServers)) {
    for (const id of claudeJson.disabledMcpServers) {
      if (typeof id === 'string') {
        disabled.add(id);
      }
    }
  }
  if (projectPath && claudeJson && claudeJson.projects && typeof claudeJson.projects === 'object') {
    const projectConfig = claudeJson.projects[projectPath];
    if (projectConfig && Array.isArray(projectConfig.disabledMcpServers)) {
      for (const id of projectConfig.disabledMcpServers) {
        if (typeof id === 'string') {
          disabled.add(id);
        }
      }
    }
  }
  return disabled;
}

function buildClaudeServerEntry(id, serverSpec, disabledSet) {
  if (!serverSpec || typeof serverSpec !== 'object') {
    return null;
  }
  const spec = { ...serverSpec };
  if (!spec.type) {
    spec.type = spec.url ? 'http' : 'stdio';
  }
  return {
    id,
    name: id,
    server: spec,
    enabled: !disabledSet.has(id)
  };
}

function getClaudeMcpServers(projectPath) {
  const claudeJson = loadClaudeJson();
  if (claudeJson && claudeJson.mcpServers && typeof claudeJson.mcpServers === 'object') {
    const disabled = getClaudeDisabledServers(claudeJson, projectPath);
    const servers = [];
    for (const [id, spec] of Object.entries(claudeJson.mcpServers)) {
      const entry = buildClaudeServerEntry(id, spec, disabled);
      if (entry) {
        servers.push(entry);
      }
    }
    return servers;
  }

  const config = loadCodemossConfig();
  if (config && Array.isArray(config.mcpServers)) {
    return config.mcpServers;
  }

  const legacy = loadJsonFile(path.join(CONFIG_DIR, 'mcp-servers.json'), { servers: [] });
  return Array.isArray(legacy.servers) ? legacy.servers : [];
}

function updateClaudeDisabledServers(claudeJson, serverId, enabled, projectPath) {
  if (!claudeJson.disabledMcpServers || !Array.isArray(claudeJson.disabledMcpServers)) {
    claudeJson.disabledMcpServers = [];
  }

  if (!projectPath) {
    const filtered = claudeJson.disabledMcpServers.filter((id) => id !== serverId);
    if (!enabled) {
      filtered.push(serverId);
    }
    claudeJson.disabledMcpServers = filtered;
    return;
  }

  if (!claudeJson.projects || typeof claudeJson.projects !== 'object') {
    claudeJson.projects = {};
  }
  if (!claudeJson.projects[projectPath] || typeof claudeJson.projects[projectPath] !== 'object') {
    claudeJson.projects[projectPath] = {};
  }
  const projectConfig = claudeJson.projects[projectPath];
  if (!Array.isArray(projectConfig.disabledMcpServers)) {
    projectConfig.disabledMcpServers = [];
  }
  const filtered = projectConfig.disabledMcpServers.filter((id) => id !== serverId);
  if (!enabled) {
    filtered.push(serverId);
  }
  projectConfig.disabledMcpServers = filtered;
}

function upsertClaudeMcpServer(server, projectPath) {
  if (!server || typeof server.id !== 'string') {
    throw new Error('Server must have an id');
  }

  const claudeJson = loadClaudeJson() || {};
  if (!claudeJson.mcpServers || typeof claudeJson.mcpServers !== 'object') {
    claudeJson.mcpServers = {};
  }

  const serverSpec = server.server && typeof server.server === 'object' ? server.server : {};
  claudeJson.mcpServers[server.id] = { ...serverSpec };
  const enabled = server.enabled !== false;
  updateClaudeDisabledServers(claudeJson, server.id, enabled, projectPath);
  saveClaudeJson(claudeJson);
  syncClaudeMcpToSettings();
}

function deleteClaudeMcpServer(serverId) {
  const claudeJson = loadClaudeJson();
  if (claudeJson && claudeJson.mcpServers && typeof claudeJson.mcpServers === 'object') {
    delete claudeJson.mcpServers[serverId];
    if (Array.isArray(claudeJson.disabledMcpServers)) {
      claudeJson.disabledMcpServers = claudeJson.disabledMcpServers.filter((id) => id !== serverId);
    }
    if (claudeJson.projects && typeof claudeJson.projects === 'object') {
      for (const key of Object.keys(claudeJson.projects)) {
        const projectConfig = claudeJson.projects[key];
        if (projectConfig && Array.isArray(projectConfig.disabledMcpServers)) {
          projectConfig.disabledMcpServers = projectConfig.disabledMcpServers.filter((id) => id !== serverId);
        }
      }
    }
    saveClaudeJson(claudeJson);
    syncClaudeMcpToSettings();
    return true;
  }

  const config = loadCodemossConfig();
  if (config && Array.isArray(config.mcpServers)) {
    config.mcpServers = config.mcpServers.filter((s) => s && s.id !== serverId);
    saveCodemossConfig(config);
    return true;
  }

  return false;
}

function readCodexConfigToml() {
  if (!fs.existsSync(CODEX_CONFIG_FILE)) {
    return null;
  }
  const content = fs.readFileSync(CODEX_CONFIG_FILE, 'utf-8');
  return parseToml(content);
}

function writeCodexConfigToml(config) {
  const dir = path.dirname(CODEX_CONFIG_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(CODEX_CONFIG_FILE, generateToml(config || {}), 'utf-8');
}

function toCodexMcpServer(id, config) {
  const server = {
    id,
    name: id,
    server: {},
    enabled: true,
    apps: { claude: false, codex: true, gemini: false }
  };

  if (!config || typeof config !== 'object') {
    return server;
  }

  if (config.url) {
    server.server.type = 'http';
    server.server.url = String(config.url);
  } else {
    server.server.type = 'stdio';
  }

  if (config.command) server.server.command = String(config.command);
  if (config.args) server.server.args = Array.isArray(config.args) ? config.args : [config.args];
  if (config.env && typeof config.env === 'object') server.server.env = config.env;
  if (config.cwd) server.server.cwd = String(config.cwd);
  if (config.env_vars) server.server.env_vars = Array.isArray(config.env_vars) ? config.env_vars : [config.env_vars];
  if (config.bearer_token_env_var) server.server.bearer_token_env_var = String(config.bearer_token_env_var);
  if (config.http_headers && typeof config.http_headers === 'object') server.server.http_headers = config.http_headers;
  if (config.env_http_headers && typeof config.env_http_headers === 'object') server.server.env_http_headers = config.env_http_headers;
  if (typeof config.enabled === 'boolean') server.enabled = config.enabled;
  if (config.startup_timeout_sec !== undefined) server.startup_timeout_sec = Number(config.startup_timeout_sec);
  if (config.tool_timeout_sec !== undefined) server.tool_timeout_sec = Number(config.tool_timeout_sec);
  if (config.enabled_tools) server.enabled_tools = Array.isArray(config.enabled_tools) ? config.enabled_tools : [config.enabled_tools];
  if (config.disabled_tools) server.disabled_tools = Array.isArray(config.disabled_tools) ? config.disabled_tools : [config.disabled_tools];

  return server;
}

function getCodexMcpServers() {
  const config = readCodexConfigToml();
  if (!config || !config.mcp_servers || typeof config.mcp_servers !== 'object') {
    return [];
  }
  const servers = [];
  for (const [id, value] of Object.entries(config.mcp_servers)) {
    servers.push(toCodexMcpServer(id, value));
  }
  return servers;
}

function buildCodexMcpConfig(server) {
  const result = {};
  const spec = server.server && typeof server.server === 'object' ? server.server : {};

  if (spec.command) result.command = spec.command;
  if (spec.args) result.args = spec.args;
  if (spec.env) result.env = spec.env;
  if (spec.cwd) result.cwd = spec.cwd;
  if (spec.env_vars) result.env_vars = spec.env_vars;
  if (spec.url) result.url = spec.url;
  if (spec.bearer_token_env_var) result.bearer_token_env_var = spec.bearer_token_env_var;
  if (spec.http_headers) result.http_headers = spec.http_headers;
  if (spec.env_http_headers) result.env_http_headers = spec.env_http_headers;

  if (server.enabled !== undefined) result.enabled = !!server.enabled;
  if (server.startup_timeout_sec !== undefined) result.startup_timeout_sec = Number(server.startup_timeout_sec);
  if (server.tool_timeout_sec !== undefined) result.tool_timeout_sec = Number(server.tool_timeout_sec);
  if (server.enabled_tools) result.enabled_tools = server.enabled_tools;
  if (server.disabled_tools) result.disabled_tools = server.disabled_tools;

  return result;
}

function upsertCodexMcpServer(server) {
  if (!server || typeof server.id !== 'string') {
    throw new Error('Server must have an id');
  }
  const config = readCodexConfigToml() || {};
  if (!config.mcp_servers || typeof config.mcp_servers !== 'object') {
    config.mcp_servers = {};
  }
  config.mcp_servers[server.id] = buildCodexMcpConfig(server);
  writeCodexConfigToml(config);
}

function deleteCodexMcpServer(serverId) {
  const config = readCodexConfigToml();
  if (!config || !config.mcp_servers || typeof config.mcp_servers !== 'object') {
    return false;
  }
  if (config.mcp_servers[serverId]) {
    delete config.mcp_servers[serverId];
    writeCodexConfigToml(config);
    return true;
  }
  return false;
}

const SKILL_FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---/;
const SKILL_DESCRIPTION_RE = /description:\s*(.+?)(?:\n[a-z-]+:|$)/s;

function javaStringHash(value) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return hash;
}

function javaHashHex(value) {
  return (javaStringHash(value) >>> 0).toString(16);
}

function getGlobalSkillsDir() {
  return path.join(os.homedir(), '.claude', 'skills');
}

function getLocalSkillsDir(workspaceRoot) {
  if (!workspaceRoot) return null;
  return path.join(workspaceRoot, '.claude', 'skills');
}

function getSkillsManagementRootDir() {
  return path.join(CONFIG_DIR, 'skills');
}

function getGlobalManagementDir() {
  return path.join(getSkillsManagementRootDir(), 'global');
}

function getLocalManagementDir(workspaceRoot) {
  if (!workspaceRoot) return null;
  const projectName = path.basename(workspaceRoot) || 'Root';
  const safeDirName = `${projectName}_${javaHashHex(workspaceRoot)}`;
  return path.join(getSkillsManagementRootDir(), safeDirName);
}

function ensureDirectoryExists(dirPath) {
  if (!dirPath) return false;
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  return true;
}

function getSkillFileTimes(stats) {
  const createdAt = stats.birthtimeMs && Number.isFinite(stats.birthtimeMs)
    ? new Date(stats.birthtimeMs).toISOString()
    : new Date(stats.ctimeMs).toISOString();
  const modifiedAt = stats.mtimeMs && Number.isFinite(stats.mtimeMs)
    ? new Date(stats.mtimeMs).toISOString()
    : new Date(stats.mtime).toISOString();
  return { createdAt, modifiedAt };
}

function extractSkillDescription(skillPath, isDirectory) {
  try {
    let mdPath = null;
    if (isDirectory) {
      const lower = path.join(skillPath, 'skill.md');
      const upper = path.join(skillPath, 'SKILL.md');
      if (fs.existsSync(lower)) {
        mdPath = lower;
      } else if (fs.existsSync(upper)) {
        mdPath = upper;
      }
    } else if (skillPath.toLowerCase().endsWith('.md')) {
      mdPath = skillPath;
    }

    if (!mdPath || !fs.existsSync(mdPath)) {
      return null;
    }

    const content = fs.readFileSync(mdPath, 'utf-8');
    const frontmatterMatch = content.match(SKILL_FRONTMATTER_RE);
    if (!frontmatterMatch) {
      return null;
    }
    const frontmatter = frontmatterMatch[1];
    const descriptionMatch = frontmatter.match(SKILL_DESCRIPTION_RE);
    if (!descriptionMatch) {
      return null;
    }
    return String(descriptionMatch[1]).trim();
  } catch (error) {
    console.error('[server] Failed to extract skill description:', error?.message || error);
    return null;
  }
}

function scanSkillsDirectory(dirPath, scope, enabled) {
  const skills = {};
  if (!dirPath || !fs.existsSync(dirPath)) {
    return skills;
  }

  let entries = [];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (error) {
    console.error('[server] Failed to read skills directory:', error?.message || error);
    return skills;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) {
      continue;
    }

    const skillPath = path.join(dirPath, entry.name);
    const isDir = entry.isDirectory();
    const type = isDir ? 'directory' : 'file';
    const id = `${scope}-${entry.name}${enabled ? '' : '-disabled'}`;
    const description = extractSkillDescription(skillPath, isDir);

    const skill = {
      id,
      name: entry.name,
      type,
      scope,
      path: skillPath,
      enabled,
    };

    if (description) {
      skill.description = description;
    }

    try {
      const stats = fs.statSync(skillPath);
      const times = getSkillFileTimes(stats);
      skill.createdAt = times.createdAt;
      skill.modifiedAt = times.modifiedAt;
    } catch (error) {
      console.error('[server] Failed to read skill stats:', error?.message || error);
    }

    skills[id] = skill;
  }

  return skills;
}

function getAllSkillsByScope(scope, workspaceRoot) {
  const activeDir = scope === 'global' ? getGlobalSkillsDir() : getLocalSkillsDir(workspaceRoot);
  const managementDir = scope === 'global' ? getGlobalManagementDir() : getLocalManagementDir(workspaceRoot);
  const activeSkills = scanSkillsDirectory(activeDir, scope, true);
  const disabledSkills = scanSkillsDirectory(managementDir, scope, false);
  return { ...activeSkills, ...disabledSkills };
}

function getAllSkills(workspaceRoot) {
  return {
    global: getAllSkillsByScope('global', workspaceRoot),
    local: getAllSkillsByScope('local', workspaceRoot),
  };
}

function copyDirectory(source, target) {
  fs.mkdirSync(target, { recursive: true });
  const entries = fs.readdirSync(source, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(source, entry.name);
    const destPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function deleteDirectory(target) {
  if (!fs.existsSync(target)) return;
  const entries = fs.readdirSync(target, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      deleteDirectory(entryPath);
    } else {
      fs.unlinkSync(entryPath);
    }
  }
  fs.rmdirSync(target);
}

function importSkills(sourcePaths, scope, workspaceRoot) {
  const result = {
    success: false,
    count: 0,
    total: Array.isArray(sourcePaths) ? sourcePaths.length : 0,
    imported: [],
  };

  const targetDir = scope === 'global' ? getGlobalSkillsDir() : getLocalSkillsDir(workspaceRoot);
  if (!targetDir) {
    return { success: false, error: `无法获取 ${scope} Skills 目录` };
  }

  if (!ensureDirectoryExists(targetDir)) {
    return { success: false, error: `无法创建 Skills 目录: ${targetDir}` };
  }

  const errors = [];
  const sources = Array.isArray(sourcePaths) ? sourcePaths : [];
  for (const sourcePath of sources) {
    const source = sourcePath ? path.resolve(sourcePath) : null;
    if (!source || !fs.existsSync(source)) {
      errors.push({ path: sourcePath, error: '源路径不存在' });
      continue;
    }

    const name = path.basename(source);
    const targetPath = path.join(targetDir, name);
    if (fs.existsSync(targetPath)) {
      errors.push({ path: sourcePath, error: `已存在同名 Skill: ${name}` });
      continue;
    }

    try {
      const stats = fs.statSync(source);
      if (stats.isDirectory()) {
        copyDirectory(source, targetPath);
      } else {
        fs.copyFileSync(source, targetPath);
      }

      const description = extractSkillDescription(targetPath, stats.isDirectory());
      const skill = {
        id: `${scope}-${name}`,
        name,
        type: stats.isDirectory() ? 'directory' : 'file',
        scope,
        path: targetPath,
      };
      if (description) {
        skill.description = description;
      }

      result.imported.push(skill);
      result.count += 1;
    } catch (error) {
      errors.push({ path: sourcePath, error: `复制失败: ${error?.message || error}` });
    }
  }

  result.success = errors.length === 0 || result.count > 0;
  if (errors.length > 0) {
    result.errors = errors;
  }
  return result;
}

function deleteSkillByName(name, scope, enabled, workspaceRoot) {
  const result = { success: false };
  const activeDir = scope === 'global' ? getGlobalSkillsDir() : getLocalSkillsDir(workspaceRoot);
  const managementDir = scope === 'global' ? getGlobalManagementDir() : getLocalManagementDir(workspaceRoot);
  const baseDir = enabled ? activeDir : managementDir;

  if (!baseDir) {
    return { success: false, error: `无法获取 ${scope} Skills 目录` };
  }

  const targetPath = path.join(baseDir, name);
  if (!fs.existsSync(targetPath)) {
    return { success: false, error: `Skill 不存在: ${name}` };
  }

  try {
    const stats = fs.statSync(targetPath);
    if (stats.isDirectory()) {
      deleteDirectory(targetPath);
    } else {
      fs.unlinkSync(targetPath);
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: `删除失败: ${error?.message || error}` };
  }
}

function enableSkill(name, scope, workspaceRoot) {
  const sourceDir = scope === 'global' ? getGlobalManagementDir() : getLocalManagementDir(workspaceRoot);
  const targetDir = scope === 'global' ? getGlobalSkillsDir() : getLocalSkillsDir(workspaceRoot);

  if (!sourceDir || !targetDir) {
    return { success: false, error: `无法获取 ${scope} Skills 目录` };
  }

  const sourcePath = path.join(sourceDir, name);
  const targetPath = path.join(targetDir, name);

  if (!fs.existsSync(sourcePath)) {
    return { success: false, error: `Skill 不存在于管理目录: ${name}` };
  }

  if (fs.existsSync(targetPath)) {
    return { success: false, error: `使用中目录已存在同名 Skill: ${name}`, conflict: true };
  }

  if (!ensureDirectoryExists(targetDir)) {
    return { success: false, error: `无法创建目标目录: ${targetDir}` };
  }

  try {
    fs.renameSync(sourcePath, targetPath);
  } catch (error) {
    try {
      const stats = fs.statSync(sourcePath);
      if (stats.isDirectory()) {
        copyDirectory(sourcePath, targetPath);
        deleteDirectory(sourcePath);
      } else {
        fs.copyFileSync(sourcePath, targetPath);
        fs.unlinkSync(sourcePath);
      }
    } catch (copyError) {
      return { success: false, error: `移动失败: ${copyError?.message || copyError}` };
    }
  }

  return {
    success: true,
    name,
    scope,
    enabled: true,
    path: targetPath,
  };
}

function disableSkill(name, scope, workspaceRoot) {
  const sourceDir = scope === 'global' ? getGlobalSkillsDir() : getLocalSkillsDir(workspaceRoot);
  const targetDir = scope === 'global' ? getGlobalManagementDir() : getLocalManagementDir(workspaceRoot);

  if (!sourceDir || !targetDir) {
    return { success: false, error: `无法获取 ${scope} Skills 目录` };
  }

  const sourcePath = path.join(sourceDir, name);
  const targetPath = path.join(targetDir, name);

  if (!fs.existsSync(sourcePath)) {
    return { success: false, error: `Skill 不存在于使用中目录: ${name}` };
  }

  if (fs.existsSync(targetPath)) {
    return { success: false, error: `管理目录已存在同名 Skill: ${name}`, conflict: true };
  }

  if (!ensureDirectoryExists(targetDir)) {
    return { success: false, error: `无法创建目标目录: ${targetDir}` };
  }

  try {
    fs.renameSync(sourcePath, targetPath);
  } catch (error) {
    try {
      const stats = fs.statSync(sourcePath);
      if (stats.isDirectory()) {
        copyDirectory(sourcePath, targetPath);
        deleteDirectory(sourcePath);
      } else {
        fs.copyFileSync(sourcePath, targetPath);
        fs.unlinkSync(sourcePath);
      }
    } catch (copyError) {
      return { success: false, error: `移动失败: ${copyError?.message || copyError}` };
    }
  }

  return {
    success: true,
    name,
    scope,
    enabled: false,
    path: targetPath,
  };
}

function toggleSkill(name, scope, currentEnabled, workspaceRoot) {
  return currentEnabled
    ? disableSkill(name, scope, workspaceRoot)
    : enableSkill(name, scope, workspaceRoot);
}

function resolveSkillOpenPath(skillPath) {
  if (!skillPath) return null;
  try {
    const stats = fs.statSync(skillPath);
    if (stats.isDirectory()) {
      const lower = path.join(skillPath, 'skill.md');
      const upper = path.join(skillPath, 'SKILL.md');
      if (fs.existsSync(lower)) {
        return lower;
      }
      if (fs.existsSync(upper)) {
        return upper;
      }
    }
  } catch (error) {
    console.error('[server] Failed to resolve skill path:', error?.message || error);
  }
  return skillPath;
}

function readClaudeSettings() {
  try {
    if (!fs.existsSync(CLAUDE_SETTINGS_FILE)) return null;
    const raw = fs.readFileSync(CLAUDE_SETTINGS_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeClaudeSettings(settings) {
  const dir = path.dirname(CLAUDE_SETTINGS_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(CLAUDE_SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
}

function mergeProviderSettingsIntoClaudeSettings(baseSettings, providerSettings) {
  const base = (baseSettings && typeof baseSettings === 'object') ? baseSettings : {};
  const incoming = (providerSettings && typeof providerSettings === 'object') ? providerSettings : {};

  const next = { ...base };
  for (const [key, value] of Object.entries(incoming)) {
    if (key === 'env' && value && typeof value === 'object' && !Array.isArray(value)) {
      const baseEnv = (next.env && typeof next.env === 'object') ? next.env : {};
      next.env = { ...baseEnv, ...value };
      continue;
    }
    next[key] = value;
  }
  return next;
}

function extractClaudeEnvConfig(settings) {
  const env = settings?.env && typeof settings.env === 'object' ? settings.env : {};
  const apiKey = typeof env.ANTHROPIC_AUTH_TOKEN === 'string' && env.ANTHROPIC_AUTH_TOKEN
    ? env.ANTHROPIC_AUTH_TOKEN
    : (typeof env.ANTHROPIC_API_KEY === 'string' ? env.ANTHROPIC_API_KEY : '');
  const baseUrl = typeof env.ANTHROPIC_BASE_URL === 'string' ? env.ANTHROPIC_BASE_URL : '';
  return { apiKey, baseUrl };
}

/**
 * Normalize message type (convert snake_case to camelCase)
 */
function normalizeMessageType(type) {
  // Map of snake_case to camelCase
  const typeMap = {
    // Session & Message
    'send_message': 'sendMessage',
    'send_message_with_attachments': 'sendMessageWithAttachments',
    'get_history': 'getHistory',
    'load_history_data': 'getHistory',
    'load_session': 'loadSession',
    'delete_session': 'deleteSession',
    'create_new_session': 'createNewSession',
    'interrupt_session': 'interruptSession',
    'export_session': 'exportSession',
    'toggle_favorite': 'toggleFavorite',
    'update_title': 'updateTitle',
    'create_new_tab': 'createNewTab',

    // Settings
    'get_settings': 'getSettings',
    'update_settings': 'updateSettings',
    'get_streaming_enabled': 'getStreamingEnabled',
    'set_streaming_enabled': 'setStreamingEnabled',
    'get_send_shortcut': 'getSendShortcut',
    'set_send_shortcut': 'setSendShortcut',
    'get_thinking_enabled': 'getThinkingEnabled',
    'set_thinking_enabled': 'setThinkingEnabled',

    // Provider Config
    'get_provider_config': 'getProviderConfig',
    'update_provider_config': 'updateProviderConfig',
    'get_current_claude_config': 'getCurrentClaudeConfig',
    'update_current_claude_config': 'updateCurrentClaudeConfig',
    'get_active_provider': 'getActiveProvider',
    'set_active_provider': 'setActiveProvider',
    'set_provider': 'setProvider',
    'get_providers': 'getProviders',
    'add_provider': 'addProvider',
    'update_provider': 'updateProvider',
    'switch_provider': 'switchProvider',
    'delete_provider': 'deleteProvider',
    'get_codex_providers': 'getCodexProviders',
    'add_codex_provider': 'addCodexProvider',
    'update_codex_provider': 'updateCodexProvider',
    'switch_codex_provider': 'switchCodexProvider',
    'delete_codex_provider': 'deleteCodexProvider',

    // Model & Mode
    'set_model': 'setModel',
    'set_mode': 'setMode',
    'set_reasoning_effort': 'setReasoningEffort',

    // Permission
    'permission_response': 'permissionResponse',
    'permission_decision': 'permissionDecision',
    'ask_user_question_response': 'askUserQuestionResponse',
    'plan_approval_response': 'planApprovalResponse',

    // MCP Servers
    'get_mcp_servers': 'getMcpServers',
    'add_mcp_server': 'addMcpServer',
    'update_mcp_server': 'updateMcpServer',
    'delete_mcp_server': 'deleteMcpServer',
    'toggle_mcp_server': 'toggleMcpServer',
    'get_mcp_server_status': 'getMcpServerStatus',
    'get_codex_mcp_servers': 'getCodexMcpServers',
    'add_codex_mcp_server': 'addCodexMcpServer',
    'update_codex_mcp_server': 'updateCodexMcpServer',
    'delete_codex_mcp_server': 'deleteCodexMcpServer',
    'toggle_codex_mcp_server': 'toggleCodexMcpServer',
    'get_global_mcp_servers': 'getMcpServers',
    'add_global_mcp_server': 'addMcpServer',
    'update_global_mcp_server': 'updateMcpServer',
    'delete_global_mcp_server': 'deleteMcpServer',
    'toggle_global_mcp_server': 'toggleMcpServer',

    // Skills
    'get_skills': 'getSkills',
    'get_all_skills': 'getSkills',
    'import_skill': 'importSkill',
    'open_skill': 'openSkill',
    'delete_skill': 'deleteSkill',
    'toggle_skill': 'toggleSkill',

    // Agents
    'get_agents': 'getAgents',
    'get_selected_agent': 'getSelectedAgent',
    'set_selected_agent': 'setSelectedAgent',
    'add_agent': 'addAgent',
    'update_agent': 'updateAgent',
    'delete_agent': 'deleteAgent',

    // Dependencies
    'get_dependencies': 'getDependencies',
    'get_dependency_status': 'getDependencies',
    'get_sdk_status': 'getSdkStatus',
    'install_dependency': 'installDependency',
    'uninstall_dependency': 'uninstallDependency',
    'check_node_environment': 'checkNodeEnvironment',

    // Usage Statistics
    'get_usage_statistics': 'getUsageStatistics',

    // File Operations
    'open_file': 'openFile',
    'open_browser': 'openBrowser',
    'refresh_file': 'refreshFile',
    'show_diff': 'showDiff',
    'show_multi_edit_diff': 'showMultiEditDiff',
    'rewind_files': 'rewindFiles',
    'list_files': 'listFiles',
    'save_json': 'saveJson',

    // System
    'frontend_ready': 'frontendReady',
    'refresh_slash_commands': 'refreshSlashCommands',
    'get_node_path': 'getNodePath',
    'set_node_path': 'setNodePath',
    'get_working_directory': 'getWorkingDirectory',
    'set_working_directory': 'setWorkingDirectory',
    'get_editor_font_config': 'getEditorFontConfig',

    // Provider Import
    'open_file_chooser_for_cc_switch': 'openFileChooserForCcSwitch',
    'save_imported_providers': 'saveImportedProviders',
    'preview_cc_switch_import': 'previewCcSwitchImport',
  };
  return typeMap[type] || type;
}

const AGENT_PROMPT_CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function normalizeSendMessageContent(raw) {
  if (!raw) return {};
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return { text: '' };
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        return JSON.parse(trimmed);
      } catch (error) {
        console.error('[server] Failed to parse send_message payload JSON:', error?.message || error);
      }
    }
    return { text: raw };
  }
  if (typeof raw === 'object') return raw;
  return {};
}

function sanitizeAgentPrompt(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(AGENT_PROMPT_CONTROL_CHARS, '');
  const trimmed = cleaned.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function extractAgentPrompt(content) {
  if (!content || typeof content !== 'object') return null;
  const direct = typeof content.agentPrompt === 'string' ? content.agentPrompt : null;
  const agentObj = content.agent && typeof content.agent === 'object' ? content.agent : null;
  const fromAgent = agentObj && typeof agentObj.prompt === 'string' ? agentObj.prompt : null;
  return sanitizeAgentPrompt(direct ?? fromAgent);
}

/**
 * Handle incoming message from Extension Host
 */
async function handleMessage(message) {
  const { type: rawType, content, requestId } = message;
  const type = normalizeMessageType(rawType);

  console.error(`[server] Handling message: ${rawType} -> ${type}`);

  try {
    switch (type) {
      // === Session & Message ===
      case 'sendMessage':
      case 'sendMessageWithAttachments':
        await handleSendMessage(content, requestId);
        break;

      case 'getHistory':
        handleGetHistory(requestId);
        break;

      case 'loadSession':
        handleLoadSession(content, requestId);
        break;

      case 'deleteSession':
        handleDeleteSession(content, requestId);
        break;

      case 'createNewSession':
        handleCreateNewSession(requestId);
        break;

      case 'interruptSession':
        handleInterruptSession(requestId);
        break;

      case 'exportSession':
        handleExportSession(content, requestId);
        break;

      case 'toggleFavorite':
        handleToggleFavorite(content, requestId);
        break;

      case 'updateTitle':
        handleUpdateTitle(content, requestId);
        break;

      case 'createNewTab':
        handleCreateNewTab(requestId);
        break;

      // === Settings ===
      case 'getSettings':
        handleGetSettings(requestId);
        break;

      case 'updateSettings':
        handleUpdateSettings(content, requestId);
        break;

      case 'getStreamingEnabled':
        handleGetStreamingEnabled(requestId);
        break;

      case 'setStreamingEnabled':
        handleSetStreamingEnabled(content, requestId);
        break;

      case 'getSendShortcut':
        handleGetSendShortcut(requestId);
        break;

      case 'setSendShortcut':
        handleSetSendShortcut(content, requestId);
        break;

      case 'getThinkingEnabled':
        handleGetThinkingEnabled(requestId);
        break;

      case 'setThinkingEnabled':
        handleSetThinkingEnabled(content, requestId);
        break;

      // === Provider Config ===
      case 'getProviderConfig':
        handleGetProviderConfig(content, requestId);
        break;

      case 'updateProviderConfig':
        handleUpdateProviderConfig(content, requestId);
        break;

      case 'getCurrentClaudeConfig':
        handleGetCurrentClaudeConfig(requestId);
        break;

      case 'updateCurrentClaudeConfig':
        handleUpdateCurrentClaudeConfig(content, requestId);
        break;

      case 'getActiveProvider':
        handleGetActiveClaudeProvider(requestId);
        break;

      case 'setActiveProvider':
      case 'setProvider':
        handleSetChatProvider(content, requestId);
        break;

      case 'switchProvider':
        await handleSwitchClaudeProvider(content, requestId);
        break;

      case 'getProviders':
        handleGetProviders(requestId);
        break;

      case 'addProvider':
        handleAddProvider(content, requestId);
        break;

      case 'updateProvider':
        handleUpdateProvider(content, requestId);
        break;

      case 'deleteProvider':
        handleDeleteProvider(content, requestId);
        break;

      case 'getCodexProviders':
        handleGetCodexProviders(requestId);
        break;

      case 'addCodexProvider':
        handleAddCodexProvider(content, requestId);
        break;

      case 'updateCodexProvider':
        handleUpdateCodexProvider(content, requestId);
        break;

      case 'switchCodexProvider':
        handleSwitchCodexProvider(content, requestId);
        break;

      case 'deleteCodexProvider':
        handleDeleteCodexProvider(content, requestId);
        break;

      // === Model & Mode ===
      case 'setModel':
        handleSetModel(content, requestId);
        break;

      case 'setMode':
        handleSetMode(content, requestId);
        break;

      case 'setReasoningEffort':
        handleSetReasoningEffort(content, requestId);
        break;

      // === Permission ===
      case 'permissionResponse':
      case 'permissionDecision':
        handlePermissionResponse(content, requestId);
        break;

      case 'askUserQuestionResponse':
        handleAskUserQuestionResponse(content, requestId);
        break;

      case 'planApprovalResponse':
        handlePlanApprovalResponse(content, requestId);
        break;

      // === MCP Servers ===
      case 'getMcpServers':
        handleGetMcpServers(requestId);
        break;

      case 'getCodexMcpServers':
        handleGetCodexMcpServers(requestId);
        break;

      case 'addMcpServer':
        handleAddMcpServer(content, requestId);
        break;

      case 'addCodexMcpServer':
        handleAddCodexMcpServer(content, requestId);
        break;

      case 'updateMcpServer':
        handleUpdateMcpServer(content, requestId);
        break;

      case 'updateCodexMcpServer':
        handleUpdateCodexMcpServer(content, requestId);
        break;

      case 'deleteMcpServer':
        handleDeleteMcpServer(content, requestId);
        break;

      case 'deleteCodexMcpServer':
        handleDeleteCodexMcpServer(content, requestId);
        break;

      case 'toggleMcpServer':
        handleToggleMcpServer(content, requestId);
        break;

      case 'toggleCodexMcpServer':
        handleToggleCodexMcpServer(content, requestId);
        break;

      case 'getMcpServerStatus':
        handleGetMcpServerStatus(requestId);
        break;

      // === Skills ===
      case 'getSkills':
        handleGetSkills(requestId);
        break;

      case 'importSkill':
        handleImportSkill(content, requestId);
        break;

      case 'openSkill':
        handleOpenSkill(content, requestId);
        break;

      case 'deleteSkill':
        handleDeleteSkill(content, requestId);
        break;

      case 'toggleSkill':
        handleToggleSkill(content, requestId);
        break;

      // === Agents ===
      case 'getAgents':
        handleGetAgents(requestId);
        break;

      case 'getSelectedAgent':
        handleGetSelectedAgent(requestId);
        break;

      case 'setSelectedAgent':
        handleSetSelectedAgent(content, requestId);
        break;

      case 'addAgent':
        handleAddAgent(content, requestId);
        break;

      case 'updateAgent':
        handleUpdateAgent(content, requestId);
        break;

      case 'deleteAgent':
        handleDeleteAgent(content, requestId);
        break;

      // === Dependencies ===
      case 'getDependencies':
        handleGetDependencies(requestId);
        break;

      case 'getSdkStatus':
        handleGetSdkStatus(requestId);
        break;

      case 'installDependency':
        handleInstallDependency(content, requestId);
        break;

      case 'uninstallDependency':
        handleUninstallDependency(content, requestId);
        break;

      case 'checkNodeEnvironment':
        handleCheckNodeEnvironment(requestId);
        break;

      // === Usage Statistics ===
      case 'getUsageStatistics':
        handleGetUsageStatistics(content, requestId);
        break;

      case 'listFiles':
        handleListFiles(content, requestId);
        break;

      // === File Operations (forwarded to extension) ===
      case 'openFile':
      case 'openBrowser':
      case 'refreshFile':
      case 'showDiff':
      case 'showMultiEditDiff':
      case 'rewindFiles':
      case 'saveJson':
        // These are handled by the extension, forward them back
        sendToHost('fileOperation', { operation: type, ...content }, requestId);
        break;

      // === System ===
      case 'frontendReady':
        handleFrontendReady(requestId);
        break;

      case 'refreshSlashCommands':
        await handleRefreshSlashCommands(requestId);
        break;

      case 'getNodePath':
        handleGetNodePath(requestId);
        break;

      case 'setNodePath':
        handleSetNodePath(content, requestId);
        break;

      case 'getWorkingDirectory':
        handleGetWorkingDirectory(requestId);
        break;

      case 'setWorkingDirectory':
        handleSetWorkingDirectory(content, requestId);
        break;

      case 'getEditorFontConfig':
        handleGetEditorFontConfig(requestId);
        break;

      // === Provider Import ===
      case 'openFileChooserForCcSwitch':
        sendToHost('backend_notification', {
          type: 'error',
          message:
            'VSCode 版暂时无法由 ai-bridge 直接弹出文件选择器。\n' +
            '请升级 CodeMoss 扩展到最新版后，再使用“选择 cc-switch.db 文件导入”。\n' +
            '或者先使用“从 cc-switch 更新”导入默认路径 ~/.cc-switch/cc-switch.db（如果存在）。'
        }, requestId);
        break;

      case 'previewCcSwitchImport':
        await handlePreviewCcSwitchImport(content, requestId);
        break;

      case 'saveImportedProviders':
        await handleSaveImportedProviders(content, requestId);
        break;

      default:
        console.error(`[server] Unknown message type: ${type}`);
        // Send empty response instead of error to avoid breaking the UI
        sendToHost(type + 'Response', {}, requestId);
    }
  } catch (error) {
    console.error(`[server] Error handling ${type}:`, error);
    sendError(error, requestId);
  }
}

// ============================================
// Message Handlers
// ============================================

async function handleSendMessage(content, requestId) {
  const normalizedContent = normalizeSendMessageContent(content);
  const { text, sessionId, provider = currentProvider } = normalizedContent;
  const messageText = typeof text === 'string' ? text : '';
  const isCodexProvider = provider === 'codex' || provider === 'openai';
  const isClaudeProvider = !isCodexProvider;
  const allowedPermissionModes = new Set(['acceptEdits', 'bypassPermissions', 'default', 'delegate', 'dontAsk', 'plan']);
  const requestedPermissionModeRaw = normalizedContent?.permissionMode ?? currentMode;
  const effectivePermissionMode =
    requestedPermissionModeRaw === 'ask'
      ? 'default'
      : (typeof requestedPermissionModeRaw === 'string' && allowedPermissionModes.has(requestedPermissionModeRaw))
        ? requestedPermissionModeRaw
        : 'default';
  const requestedModel = typeof normalizedContent?.model === 'string' && normalizedContent.model
    ? normalizedContent.model
    : currentModel;
  const requestedReasoningEffort = typeof normalizedContent?.reasoningEffort === 'string' && normalizedContent.reasoningEffort
    ? normalizedContent.reasoningEffort
    : currentReasoningEffort;
  const agentPrompt = extractAgentPrompt(normalizedContent);
  const openedFiles = normalizedContent?.openedFiles;
  const attachments = Array.isArray(normalizedContent?.attachments) ? normalizedContent.attachments : [];

  const settings = loadJsonFile(SETTINGS_FILE, {});
  const streamingEnabled = settings.streamingEnabled !== false;
  const thinkingEnabled = settings.thinkingEnabled !== false;

  sendToHost('streamStart', { sessionId }, requestId);

  // Intercept console.log to capture Claude SDK streaming output
  const originalConsoleLog = console.log;
  const interceptConsoleLog = (interceptor) => {
    console.log = (...args) => {
      const output = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
      interceptor(output);
    };
  };
  const restoreConsoleLog = () => {
    console.log = originalConsoleLog;
  };

  try {
    if (isClaudeProvider && isClaudeSdkAvailable()) {
      let bufferedContent = '';
      let capturedStructuredError = null;
      let structuredErrorEmitted = false;
      const stdinData = {
        sessionId: sessionId || currentSessionId,
        message: messageText,
        cwd: normalizedContent?.workingDirectory || getWorkspaceRoot(),
        permissionMode: effectivePermissionMode,
        model: requestedModel,
        streaming: streamingEnabled,
        thinkingEnabled
      };
      if (agentPrompt) {
        stdinData.agentPrompt = agentPrompt;
      }
      if (openedFiles && typeof openedFiles === 'object') {
        stdinData.openedFiles = openedFiles;
      }
      if (attachments.length > 0) {
        stdinData.attachments = attachments;
      }

      // Intercept Claude SDK output and convert to streamChunk messages
      interceptConsoleLog((output) => {
        // Log all intercepted output for debugging
        process.stderr.write('[ai-bridge][INTERCEPT] ' + output.substring(0, 100) + '\n');

        // Check for streaming markers from message-service.js
        if (output.startsWith('[CONTENT_DELTA]')) {
          const deltaJson = output.substring('[CONTENT_DELTA]'.length).trim();
          process.stderr.write('[ai-bridge][CONTENT_DELTA] deltaJson: ' + deltaJson + '\n');
          try {
            // message-service.js uses JSON.stringify for delta, so parse it
            const delta = JSON.parse(deltaJson);
            process.stderr.write('[ai-bridge][CONTENT_DELTA] parsed delta: ' + delta + '\n');
            sendToHost('streamChunk', { delta, sessionId }, requestId);
          } catch (e) {
            // If not JSON, use as-is
            process.stderr.write('[ai-bridge][CONTENT_DELTA] parse failed, using as-is: ' + e.message + '\n');
            sendToHost('streamChunk', { delta: deltaJson, sessionId }, requestId);
          }
        } else if (output.startsWith('[CONTENT]')) {
          let textChunk = output.substring('[CONTENT]'.length);
          if (textChunk.startsWith(' ')) textChunk = textChunk.slice(1);
          if (streamingEnabled) {
            sendToHost('streamChunk', { delta: textChunk, sessionId }, requestId);
          } else {
            bufferedContent += textChunk;
          }
        } else if (output.startsWith('[THINKING_DELTA]')) {
          if (!thinkingEnabled) return;
          const deltaJson = output.substring('[THINKING_DELTA]'.length).trim();
          try {
            const delta = JSON.parse(deltaJson);
            sendToHost('thinkingChunk', { delta, sessionId }, requestId);
          } catch {
            sendToHost('thinkingChunk', { delta: deltaJson, sessionId }, requestId);
          }
        } else if (output.startsWith('[THINKING]')) {
          if (!thinkingEnabled) return;
          let thinkingChunk = output.substring('[THINKING]'.length);
          if (thinkingChunk.startsWith(' ')) thinkingChunk = thinkingChunk.slice(1);
          if (thinkingChunk) {
            sendToHost('thinkingChunk', { delta: thinkingChunk, sessionId }, requestId);
          }
        } else if (output.startsWith('[MESSAGE]')) {
          // Full message - could be used for tool calls etc
          const msgJson = output.substring('[MESSAGE]'.length).trim();
          try {
            const msg = JSON.parse(msgJson);
            sendToHost('messageUpdate', { message: msg, sessionId }, requestId);
            // In non-streaming mode, also accumulate plain text for final delivery
            if (!streamingEnabled && msg && msg.type === 'assistant') {
              const blocks = msg.message?.content ?? msg.content;
              if (Array.isArray(blocks)) {
                for (const b of blocks) {
                  if (b && typeof b === 'object') {
                    if (b.type === 'text' && typeof b.text === 'string') {
                      bufferedContent += b.text;
                    } else if (b.type === 'thinking' && typeof b.thinking === 'string') {
                      // Optionally include thinking in final text; keep minimal to avoid clutter
                      // bufferedContent += b.thinking;
                    }
                  }
                }
              } else if (typeof blocks === 'string') {
                bufferedContent += blocks;
              }
            }
          } catch {
            // Ignore parse errors
          }
        } else if (output.startsWith('[STREAM_START]')) {
          process.stderr.write('[ai-bridge] SDK stream started\n');
        } else if (output.startsWith('[STREAM_END]')) {
          process.stderr.write('[ai-bridge] SDK stream ended\n');
        } else if (output.startsWith('{')) {
          try {
            const maybeJson = JSON.parse(output);
            if (maybeJson && typeof maybeJson === 'object') {
              if (maybeJson.success === false && typeof maybeJson.error === 'string') {
                capturedStructuredError = maybeJson.error;
                if (!structuredErrorEmitted) {
                  structuredErrorEmitted = true;
                  sendToHost('streamChunk', {
                    delta: `\n\nError: ${maybeJson.error}`,
                    sessionId
                  }, requestId);
                }
                return;
              }
              if (typeof maybeJson.type === 'string') {
                originalConsoleLog(output);
                return;
              }
            }
          } catch {}

          process.stderr.write('[ai-bridge] ' + output + '\n');
        } else {
          // Debug/other logs - send to stderr to avoid protocol pollution
          process.stderr.write('[ai-bridge] ' + output + '\n');
        }
      });

      const claudeCommand = attachments.length > 0 ? 'sendWithAttachments' : 'send';
      await handleClaudeCommand(claudeCommand, [], stdinData);
      restoreConsoleLog();

      if (!streamingEnabled && bufferedContent) {
        sendToHost('streamChunk', { delta: bufferedContent, sessionId }, requestId);
      } else if (!streamingEnabled && capturedStructuredError && !structuredErrorEmitted) {
        sendToHost('streamChunk', { delta: `\n\nError: ${capturedStructuredError}`, sessionId }, requestId);
      }
    } else if (isCodexProvider && isCodexSdkAvailable()) {
      const stdinData = {
        sessionId: sessionId || currentSessionId,
        message: messageText,
        threadId: sessionId || currentSessionId,
        cwd: normalizedContent?.workingDirectory || process.cwd(),
        permissionMode: effectivePermissionMode,
        model: requestedModel,
        reasoningEffort: requestedReasoningEffort,
        baseUrl: normalizedContent?.baseUrl,
        apiKey: normalizedContent?.apiKey
      };
      await handleCodexCommand('send', [], stdinData);
    } else {
      const claudeManual = [
        `mkdir -p ~/.codemoss/dependencies/claude-sdk`,
        `cd ~/.codemoss/dependencies/claude-sdk`,
        `npm init -y`,
        `npm install @anthropic-ai/claude-agent-sdk @anthropic-ai/sdk @anthropic-ai/bedrock-sdk`,
      ].join('\n');

      const codexManual = [
        `mkdir -p ~/.codemoss/dependencies/codex-sdk`,
        `cd ~/.codemoss/dependencies/codex-sdk`,
        `npm init -y`,
        `npm install @openai/codex-sdk`,
      ].join('\n');

      const sdkName = isCodexProvider ? 'Codex SDK' : 'Claude Code SDK';
      const manual = isCodexProvider ? codexManual : claudeManual;
      const status = getSdkStatus();
      const depsDir = path.join(os.homedir(), '.codemoss', 'dependencies');
      const depsDirExists = fs.existsSync(depsDir);
      const depsDirEntries = (() => {
        try {
          if (!depsDirExists) return [];
          return fs.readdirSync(depsDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
        } catch {
          return [];
        }
      })();
      const expectedPath = isCodexProvider ? status.codex?.path : status.claude?.path;
      const expectedExists = expectedPath ? fs.existsSync(expectedPath) : false;

      sendToHost('streamChunk', {
        delta:
          `⚠️ ${sdkName} 未安装（或未被检测到），当前无法提问/获取回复。\n\n` +
          `你可以在插件设置里打开「SDK 依赖」并点击安装；或者手动执行：\n` +
          `\`\`\`bash\n${manual}\n\`\`\`\n` +
          `诊断信息：\n` +
          `- provider: ${String(provider)}\n` +
          `- homedir: ${os.homedir()}\n` +
          `- depsDir: ${depsDir} (exists: ${depsDirExists})\n` +
          `- depsDir children: ${depsDirEntries.join(', ') || '(empty)'}\n` +
          `- expectedPath: ${expectedPath || '(unknown)'} (exists: ${expectedExists})\n\n` +
          `安装完成后回到面板重试即可。`,
        sessionId
      }, requestId);
    }
  } catch (error) {
    restoreConsoleLog();
    sendToHost('streamChunk', {
      delta: `\n\nError: ${error.message}`,
      sessionId
    }, requestId);
  }

  sendToHost('streamEnd', { sessionId }, requestId);
}

function handleGetHistory(requestId) {
  const sessions = [];

  const favoritesFile = path.join(CONFIG_DIR, 'favorites.json');
  const titlesFile = path.join(CONFIG_DIR, 'session-titles.json');
  const favorites = loadJsonFile(favoritesFile, {});
  const titles = loadJsonFile(titlesFile, {});

  const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');

  const extractText = (raw) => {
    const blocks = raw?.message?.content ?? raw?.content;
    if (typeof blocks === 'string') return blocks;
    if (!Array.isArray(blocks)) return '';
    const parts = [];
    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
      if (b.type === 'thinking' && typeof b.thinking === 'string') parts.push(b.thinking);
    }
    return parts.join('');
  };

  try {
    if (fs.existsSync(claudeProjectsDir)) {
      const projectDirs = fs.readdirSync(claudeProjectsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => path.join(claudeProjectsDir, d.name));

      for (const projectDir of projectDirs) {
        const files = fs.readdirSync(projectDir);
        for (const file of files) {
          if (!file.endsWith('.jsonl')) continue;
          const sessionId = file.replace(/\.jsonl$/, '');
          const filePath = path.join(projectDir, file);

          let messageCount = 0;
          let inferredTitle = '';
          try {
            const text = fs.readFileSync(filePath, 'utf-8');
            const lines = text.split('\n').filter((l) => l.trim());
            for (const line of lines) {
              try {
                const obj = JSON.parse(line);
                if (obj?.type === 'user' || obj?.type === 'assistant') {
                  messageCount += 1;
                }
                if (!inferredTitle && obj?.type === 'user') {
                  const t = extractText(obj).trim();
                  if (t) inferredTitle = t;
                }
              } catch {}
            }
          } catch {}

          const stat = fs.statSync(filePath);
          const titleFromStore = titles?.[sessionId]?.customTitle;
          const title = (typeof titleFromStore === 'string' && titleFromStore.trim())
            ? titleFromStore.trim()
            : (inferredTitle ? inferredTitle.substring(0, 50) : 'Untitled Session');

          const fav = favorites?.[sessionId];
          sessions.push({
            sessionId,
            title,
            messageCount,
            lastTimestamp: stat.mtime.toISOString(),
            isFavorited: !!fav,
            favoritedAt: fav?.favoritedAt,
            provider: 'claude'
          });
        }
      }
    }
  } catch (error) {
    console.error('[server] Failed to read Claude project sessions:', error);
  }

  sessions.sort((a, b) => new Date(b.lastTimestamp || 0) - new Date(a.lastTimestamp || 0));

  sendToHost('historyLoaded', {
    success: true,
    sessions,
    total: sessions.length,
    favorites
  }, requestId);
}

function handleLoadSession(content, requestId) {
  const sessionId =
    (typeof content === 'string' ? content : content?.sessionId) ||
    null;

  if (!sessionId) {
    sendError(new Error('Session not found'), requestId);
    return;
  }

  const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');
  let sessionFile = null;
  try {
    if (fs.existsSync(claudeProjectsDir)) {
      const projectDirs = fs.readdirSync(claudeProjectsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => path.join(claudeProjectsDir, d.name));
      for (const dir of projectDirs) {
        const candidate = path.join(dir, `${sessionId}.jsonl`);
        if (fs.existsSync(candidate)) {
          sessionFile = candidate;
          break;
        }
      }
    }
  } catch {
    // ignore
  }

  if (!sessionFile) {
    sendError(new Error('Session not found'), requestId);
    return;
  }

  const extractText = (raw) => {
    const blocks = raw?.message?.content ?? raw?.content;
    if (typeof blocks === 'string') return blocks;
    if (!Array.isArray(blocks)) return '';
    const parts = [];
    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
      if (b.type === 'thinking' && typeof b.thinking === 'string') parts.push(b.thinking);
    }
    return parts.join('');
  };

  try {
    const text = fs.readFileSync(sessionFile, 'utf-8');
    const lines = text.split('\n').filter((l) => l.trim());
    const messages = [];
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj?.type === 'user' || obj?.type === 'assistant' || obj?.type === 'error') {
          messages.push({
            type: obj.type,
            content: extractText(obj) || '',
            raw: obj,
            timestamp: obj.timestamp || undefined
          });
        }
      } catch {
        // ignore
      }
    }
    currentSessionId = sessionId;
    sendToHost('updateMessages', JSON.stringify(messages), requestId);
  } catch (error) {
    sendError(error, requestId);
  }
}

function handleDeleteSession(content, requestId) {
  const sessionId =
    (typeof content === 'string' ? content : content?.sessionId) ||
    null;

  if (!sessionId) {
    sendError(new Error('Session not found'), requestId);
    return;
  }

  const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');
  try {
    if (fs.existsSync(claudeProjectsDir)) {
      const projectDirs = fs.readdirSync(claudeProjectsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => path.join(claudeProjectsDir, d.name));
      for (const dir of projectDirs) {
        const candidate = path.join(dir, `${sessionId}.jsonl`);
        if (fs.existsSync(candidate)) {
          fs.unlinkSync(candidate);
          break;
        }
      }
    }
    const favoritesFile = path.join(CONFIG_DIR, 'favorites.json');
    const favorites = loadJsonFile(favoritesFile, {});
    if (favorites && typeof favorites === 'object' && favorites[sessionId]) {
      delete favorites[sessionId];
      saveJsonFile(favoritesFile, favorites);
    }
    const titlesFile = path.join(CONFIG_DIR, 'session-titles.json');
    const titles = loadJsonFile(titlesFile, {});
    if (titles && typeof titles === 'object' && titles[sessionId]) {
      delete titles[sessionId];
      saveJsonFile(titlesFile, titles);
    }
    sendToHost('sessionDeleted', { sessionId }, requestId);
  } catch (error) {
    sendError(error, requestId);
  }
}

function handleGetSettings(requestId) {
  const settings = loadJsonFile(SETTINGS_FILE, {
    theme: 'auto',
    fontSize: 14,
    streamingEnabled: true,
    activeProvider: 'claude'
  });
  sendToHost('settingsLoaded', settings, requestId);
}

function handleUpdateSettings(content, requestId) {
  const currentSettings = loadJsonFile(SETTINGS_FILE, {});
  const newSettings = { ...currentSettings, ...content };
  saveJsonFile(SETTINGS_FILE, newSettings);
  sendToHost('settingsUpdated', newSettings, requestId);
}

function handleGetStreamingEnabled(requestId) {
  const settings = loadJsonFile(SETTINGS_FILE, {});
  sendToHost('streamingEnabledLoaded', { streamingEnabled: settings.streamingEnabled !== false }, requestId);
}

function handleSetStreamingEnabled(content, requestId) {
  const settings = loadJsonFile(SETTINGS_FILE, {});
  const desired =
    typeof content === 'object' && content !== null
      ? (
        typeof content.streamingEnabled === 'boolean'
          ? content.streamingEnabled
          : (content.enabled !== false)
      )
      : true;
  settings.streamingEnabled = desired;
  saveJsonFile(SETTINGS_FILE, settings);
  sendToHost('streamingEnabledUpdated', { streamingEnabled: settings.streamingEnabled }, requestId);
}

function handleGetProviderConfig(content, requestId) {
  const { provider } = content || {};
  const configFile = path.join(CONFIG_DIR, `${provider}-config.json`);
  const config = loadJsonFile(configFile, {});
  sendToHost('providerConfigLoaded', { provider, config }, requestId);
}

function handleUpdateProviderConfig(content, requestId) {
  const { provider, config } = content || {};
  const configFile = path.join(CONFIG_DIR, `${provider}-config.json`);
  saveJsonFile(configFile, config);
  sendToHost('providerConfigUpdated', { provider, config }, requestId);
}

function handleGetCurrentClaudeConfig(requestId) {
  const settings = readClaudeSettings() || {};
  const { apiKey, baseUrl } = extractClaudeEnvConfig(settings);

  const localProviderId = '__local_settings_json__';
  const codemossSettings = loadJsonFile(SETTINGS_FILE, {});
  const activeId = typeof codemossSettings.activeClaudeProviderId === 'string'
    ? codemossSettings.activeClaudeProviderId
    : localProviderId;

  const providersData = loadJsonFile(PROVIDERS_FILE, { providers: [] });
  const activeProvider = Array.isArray(providersData.providers)
    ? providersData.providers.find(p => p && typeof p === 'object' && p.id === activeId)
    : null;

  sendToHost('currentClaudeConfigLoaded', {
    apiKey,
    baseUrl,
    providerId: activeId,
    providerName: activeId === localProviderId ? '本地 settings.json' : (activeProvider?.name || '')
  }, requestId);
}

function handleUpdateCurrentClaudeConfig(content, requestId) {
  const current = readClaudeSettings() || {};
  const next = mergeProviderSettingsIntoClaudeSettings(current, content || {});
  writeClaudeSettings(next);
  const { apiKey, baseUrl } = extractClaudeEnvConfig(next);
  sendToHost('currentClaudeConfigUpdated', { apiKey, baseUrl }, requestId);
}

function handleSetChatProvider(content, requestId) {
  const provider =
    typeof content === 'string'
      ? content
      : (content && typeof content === 'object' ? content.provider : null);

  if (!provider) {
    sendError(new Error('Missing provider'), requestId);
    return;
  }

  const settings = loadJsonFile(SETTINGS_FILE, {});
  settings.activeProvider = provider;
  currentProvider = provider;
  saveJsonFile(SETTINGS_FILE, settings);
  sendToHost('activeProviderUpdated', { provider }, requestId);
}

function buildLocalProvider(settings) {
  const { apiKey, baseUrl } = extractClaudeEnvConfig(settings || {});
  return {
    id: '__local_settings_json__',
    name: '本地 settings.json',
    isActive: true,
    isLocalProvider: true,
    settingsConfig: settings || {},
    apiKey,
    baseUrl
  };
}

function getClaudeProvidersWithActiveFlag() {
  const config = loadCodemossConfig();
  ensureClaudeSection(config);

  const codemossSettings = loadJsonFile(SETTINGS_FILE, {});
  const activeFromConfig =
    typeof config.claude?.current === 'string' && config.claude.current
      ? config.claude.current
      : null;
  const activeFromLegacy =
    typeof codemossSettings.activeClaudeProviderId === 'string' && codemossSettings.activeClaudeProviderId
      ? codemossSettings.activeClaudeProviderId
      : null;
  const activeId = activeFromConfig || activeFromLegacy || '__local_settings_json__';

  if (!activeFromConfig && activeFromLegacy) {
    config.claude.current = activeFromLegacy;
    saveCodemossConfig(config);
    syncLegacyProviderFilesFromConfig(config);
  }

  const rawProviders = getClaudeProvidersFromConfig(config);
  const providers = rawProviders.map(p => ({ ...p, isActive: p.id === activeId }));

  const localEntry = {
    id: '__local_settings_json__',
    name: '本地 settings.json',
    isActive: activeId === '__local_settings_json__',
    isLocalProvider: true
  };
  return { activeId, providers: [localEntry, ...providers] };
}

function handleGetActiveClaudeProvider(requestId) {
  const { activeId, providers } = getClaudeProvidersWithActiveFlag();
  if (activeId === '__local_settings_json__') {
    const settings = readClaudeSettings() || {};
    sendToHost('activeProviderLoaded', buildLocalProvider(settings), requestId);
    return;
  }
  const provider = providers.find(p => p.id === activeId) || null;
  sendToHost('activeProviderLoaded', provider, requestId);
}

async function handleSwitchClaudeProvider(content, requestId) {
  const id =
    typeof content === 'string'
      ? content
      : (content && typeof content === 'object' ? content.id : null);

  if (!id) {
    sendError(new Error('Missing provider id'), requestId);
    return;
  }

  const config = loadCodemossConfig();
  ensureClaudeSection(config);
  config.claude.current = id;
  saveCodemossConfig(config);
  syncLegacyProviderFilesFromConfig(config);

  const codemossSettings = loadJsonFile(SETTINGS_FILE, {});
  codemossSettings.activeClaudeProviderId = id;
  saveJsonFile(SETTINGS_FILE, codemossSettings);

  if (id !== '__local_settings_json__') {
    const provider = config.claude.providers && typeof config.claude.providers === 'object'
      ? config.claude.providers[id]
      : null;
    if (!provider) {
      sendToHost('backend_notification', { type: 'error', message: `未找到供应商: ${id}` }, requestId);
    } else {
      const current = readClaudeSettings() || {};
      const next = mergeProviderSettingsIntoClaudeSettings(current, provider.settingsConfig || {});
      writeClaudeSettings(next);
      sendToHost('showSwitchSuccess', { message: '切换成功：已同步到 ~/.claude/settings.json' }, requestId);
    }
  } else {
    sendToHost('showSwitchSuccess', { message: '已切换到本地 ~/.claude/settings.json 配置' }, requestId);
  }

  const { providers: refreshed } = getClaudeProvidersWithActiveFlag();
  sendToHost('providersLoaded', refreshed, requestId);
  handleGetCurrentClaudeConfig(requestId);
  handleGetActiveClaudeProvider(requestId);
}

function handlePermissionResponse(content, requestId) {
  console.error('[server] Permission response:', JSON.stringify(content));
  sendToHost('permissionProcessed', { success: true }, requestId);
}

function handleGetMcpServers(requestId) {
  const servers = getClaudeMcpServers(getWorkspaceRoot());
  sendToHost('mcpServersLoaded', servers, requestId);
}

function handleGetCodexMcpServers(requestId) {
  const servers = getCodexMcpServers();
  sendToHost('mcpServersLoaded', servers, requestId);
}

function handleAddMcpServer(content, requestId) {
  try {
    upsertClaudeMcpServer(content, getWorkspaceRoot());
    sendToHost('mcpServerAdded', content, requestId);
    handleGetMcpServers(requestId);
  } catch (error) {
    sendError(error, requestId);
  }
}

function handleAddCodexMcpServer(content, requestId) {
  try {
    upsertCodexMcpServer(content);
    sendToHost('mcpServerAdded', content, requestId);
    handleGetCodexMcpServers(requestId);
  } catch (error) {
    sendError(error, requestId);
  }
}

function handleUpdateMcpServer(content, requestId) {
  try {
    upsertClaudeMcpServer(content, getWorkspaceRoot());
    sendToHost('mcpServerUpdated', content, requestId);
    handleGetMcpServers(requestId);
  } catch (error) {
    sendError(error, requestId);
  }
}

function handleUpdateCodexMcpServer(content, requestId) {
  try {
    upsertCodexMcpServer(content);
    sendToHost('mcpServerUpdated', content, requestId);
    handleGetCodexMcpServers(requestId);
  } catch (error) {
    sendError(error, requestId);
  }
}

function handleDeleteMcpServer(content, requestId) {
  try {
    if (!deleteClaudeMcpServer(content?.id)) {
      throw new Error('MCP server not found');
    }
    sendToHost('mcpServerDeleted', { id: content?.id }, requestId);
    handleGetMcpServers(requestId);
  } catch (error) {
    sendError(error, requestId);
  }
}

function handleDeleteCodexMcpServer(content, requestId) {
  try {
    if (!deleteCodexMcpServer(content?.id)) {
      throw new Error('MCP server not found');
    }
    sendToHost('mcpServerDeleted', { id: content?.id }, requestId);
    handleGetCodexMcpServers(requestId);
  } catch (error) {
    sendError(error, requestId);
  }
}

function handleGetSkills(requestId) {
  const data = getAllSkills(getWorkspaceRoot());
  sendToHost('skillsLoaded', data, requestId);
}

function handleGetAgents(requestId) {
  const agents = getAgentsList();
  // Return array directly, not wrapped object
  sendToHost('agentsLoaded', agents, requestId);
}

function handleGetDependencies(requestId) {
  const status = getSdkStatus();
  // Return format expected by DependencySection: Record<SdkId, SdkStatus>
  // SdkId = 'claude-sdk' | 'codex-sdk'
  // SdkStatus = { status: 'installed' | 'not_installed', installedVersion?, installPath?, hasUpdate? }
  sendToHost('dependenciesLoaded', {
    'claude-sdk': {
      status: status.claude?.installed ? 'installed' : 'not_installed',
      installedVersion: status.claude?.version || null,
      installPath: status.claude?.path || null,
      hasUpdate: false
    },
    'codex-sdk': {
      status: status.codex?.installed ? 'installed' : 'not_installed',
      installedVersion: status.codex?.version || null,
      installPath: status.codex?.path || null,
      hasUpdate: false
    }
  }, requestId);
}

function handleGetSdkStatus(requestId) {
  const status = getSdkStatus();
  sendToHost('sdkStatus', status, requestId);
}

function getNodeEnvironmentStatus() {
  const nodeVersion = process.version;
  const isWin = process.platform === 'win32';
  const candidates = isWin ? ['npm.cmd', 'npm.exe', 'npm'] : ['npm'];
  let lastError = 'npm_not_available';

  for (const npmCommand of candidates) {
    try {
      const npmVersion = execFileSync(npmCommand, ['--version'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      if (npmVersion) {
        return { available: true, nodeVersion, npmVersion, npmCommand };
      }
    } catch (error) {
      lastError = error?.message ? String(error.message) : 'npm_not_available';
    }
  }

  return { available: false, nodeVersion, npmVersion: undefined, npmCommand: isWin ? 'npm.cmd' : 'npm', error: lastError };
}

function handleInstallDependency(content, requestId) {
  const sdkId = content?.id || content?.sdkId;
  const packagesBySdk = {
    'claude-sdk': ['@anthropic-ai/claude-agent-sdk', '@anthropic-ai/sdk', '@anthropic-ai/bedrock-sdk'],
    'codex-sdk': ['@openai/codex-sdk'],
  };

  const pkgs = packagesBySdk[sdkId];
  if (!sdkId || !pkgs) {
    sendToHost('dependencyInstallResult', { success: false, sdkId: sdkId || 'unknown', error: 'invalid_sdk_id' }, requestId);
    return;
  }

  const envStatus = getNodeEnvironmentStatus();
  if (!envStatus.available) {
    sendToHost('dependencyInstallResult', { success: false, sdkId, error: 'node_not_configured', logs: envStatus.error }, requestId);
    return;
  }

  const depsRoot = path.join(CONFIG_DIR, 'dependencies');
  const sdkRootDir = path.join(depsRoot, sdkId);
  fs.mkdirSync(sdkRootDir, { recursive: true });

  const pkgJsonPath = path.join(sdkRootDir, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) {
    fs.writeFileSync(pkgJsonPath, JSON.stringify({ name: `codemoss-${sdkId}`, private: true }, null, 2), 'utf-8');
  }

  const npmCmd = envStatus.npmCommand;
  const args = ['install', '--no-audit', '--no-fund', ...pkgs];
  const child = spawn(npmCmd, args, { cwd: sdkRootDir, env: { ...process.env } });

  let combinedLogs = '';
  const onChunk = (chunk) => {
    const text = chunk.toString();
    combinedLogs += text;
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trimEnd();
      if (trimmed) {
        sendToHost('dependencyInstallProgress', { sdkId, log: trimmed }, requestId);
      }
    }
  };

  child.stdout?.on('data', onChunk);
  child.stderr?.on('data', onChunk);

  child.on('error', (err) => {
    sendToHost('dependencyInstallResult', { success: false, sdkId, error: err?.message || 'install_failed', logs: combinedLogs }, requestId);
  });

  child.on('close', (code) => {
    if (code === 0) {
      clearSdkCache();
      const installedVersion = sdkId === 'claude-sdk' ? getClaudeSdkVersion() : getCodexSdkVersion();
      sendToHost('dependencyInstallResult', { success: true, sdkId, installedVersion: installedVersion || undefined, logs: combinedLogs }, requestId);
      handleGetDependencies(requestId);
      return;
    }
    sendToHost('dependencyInstallResult', { success: false, sdkId, error: `install_failed_exit_${code}`, logs: combinedLogs }, requestId);
  });
}

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const CODEX_SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');

const CLAUDE_MODEL_PRICING = {
  opus: { input: 15.0, output: 75.0, cacheWrite: 18.75, cacheRead: 1.5 },
  sonnet: { input: 3.0, output: 15.0, cacheWrite: 3.75, cacheRead: 0.3 },
  haiku: { input: 0.8, output: 4.0, cacheWrite: 1.0, cacheRead: 0.08 },
};

function getClaudeModelPricing(model) {
  const lower = String(model || '').toLowerCase();
  if (lower.includes('opus-4') || lower.includes('claude-opus-4')) {
    return CLAUDE_MODEL_PRICING.opus;
  }
  if (lower.includes('haiku-4') || lower.includes('claude-haiku-4')) {
    return CLAUDE_MODEL_PRICING.haiku;
  }
  return CLAUDE_MODEL_PRICING.sonnet;
}

function createUsageData() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
  };
}

function parseTimestamp(value) {
  if (!value) return 0;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : 0;
}

function sanitizeProjectPath(value) {
  return String(value || '').replace(/[^a-zA-Z0-9]/g, '-');
}

function buildEmptyStats(projectPath) {
  const projectName = projectPath === 'all'
    ? 'All Projects'
    : (path.basename(projectPath || '') || 'Root');
  return {
    projectPath,
    projectName,
    totalSessions: 0,
    totalUsage: createUsageData(),
    estimatedCost: 0,
    sessions: [],
    dailyUsage: [],
    weeklyComparison: {
      currentWeek: { sessions: 0, cost: 0, tokens: 0 },
      lastWeek: { sessions: 0, cost: 0, tokens: 0 },
      trends: { sessions: 0, cost: 0, tokens: 0 },
    },
    byModel: [],
    lastUpdated: Date.now(),
  };
}

function parseClaudeSessionFile(filePath) {
  let usage = createUsageData();
  let totalCost = 0;
  let model = 'unknown';
  let firstTimestamp = 0;
  let summary = null;

  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (error) {
    return null;
  }

  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    let raw = null;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    if (!raw || typeof raw !== 'object') continue;

    if (!firstTimestamp && raw.timestamp) {
      firstTimestamp = parseTimestamp(raw.timestamp);
    }

    if (raw.type === 'summary') {
      if (typeof raw.summary === 'string') {
        summary = raw.summary;
      } else if (typeof raw.message?.content === 'string') {
        summary = raw.message.content;
      }
    }

    if (raw.type === 'assistant' && raw.message && raw.message.usage) {
      const u = raw.message.usage;
      const inputTokens = Number(u.input_tokens) || 0;
      const outputTokens = Number(u.output_tokens) || 0;
      const cacheWrite = Number(u.cache_creation_input_tokens) || 0;
      const cacheRead = Number(u.cache_read_input_tokens) || 0;

      if (inputTokens || outputTokens || cacheWrite || cacheRead) {
        usage.inputTokens += inputTokens;
        usage.outputTokens += outputTokens;
        usage.cacheWriteTokens += cacheWrite;
        usage.cacheReadTokens += cacheRead;

        if (model === 'unknown' && raw.message?.model) {
          model = String(raw.message.model);
        }

        const pricing = getClaudeModelPricing(model);
        totalCost += (inputTokens * pricing.input +
          outputTokens * pricing.output +
          cacheWrite * pricing.cacheWrite +
          cacheRead * pricing.cacheRead) / 1_000_000.0;
      }
    }
  }

  usage.totalTokens = usage.inputTokens + usage.outputTokens + usage.cacheWriteTokens + usage.cacheReadTokens;
  if (usage.totalTokens === 0) {
    return null;
  }

  return {
    sessionId: path.basename(filePath, '.jsonl'),
    timestamp: firstTimestamp || Date.now(),
    model,
    usage,
    cost: totalCost,
    summary,
  };
}

function readClaudeSessionsFromDir(projectDir) {
  const sessions = [];
  if (!projectDir || !fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
    return sessions;
  }

  let entries = [];
  try {
    entries = fs.readdirSync(projectDir, { withFileTypes: true });
  } catch (error) {
    return sessions;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const filePath = path.join(projectDir, entry.name);
    try {
      const stats = fs.statSync(filePath);
      if (!stats.size) continue;
    } catch {
      continue;
    }
    const session = parseClaudeSessionFile(filePath);
    if (session) {
      sessions.push(session);
    }
  }

  return sessions;
}

function processClaudeSessions(sessions, stats) {
  const dailyMap = new Map();
  const modelMap = new Map();

  const now = Date.now();
  const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;
  const twoWeeksAgo = now - 14 * 24 * 60 * 60 * 1000;

  const currentWeek = { sessions: 0, cost: 0, tokens: 0 };
  const lastWeek = { sessions: 0, cost: 0, tokens: 0 };

  for (const session of sessions) {
    stats.totalUsage.inputTokens += session.usage.inputTokens;
    stats.totalUsage.outputTokens += session.usage.outputTokens;
    stats.totalUsage.cacheWriteTokens += session.usage.cacheWriteTokens;
    stats.totalUsage.cacheReadTokens += session.usage.cacheReadTokens;
    stats.totalUsage.totalTokens += session.usage.totalTokens;
    stats.estimatedCost += session.cost;

    const dateKey = new Date(session.timestamp).toISOString().slice(0, 10);
    let daily = dailyMap.get(dateKey);
    if (!daily) {
      daily = {
        date: dateKey,
        sessions: 0,
        usage: createUsageData(),
        cost: 0,
        modelsUsed: [],
      };
      dailyMap.set(dateKey, daily);
    }
    daily.sessions += 1;
    daily.cost += session.cost;
    daily.usage.inputTokens += session.usage.inputTokens;
    daily.usage.outputTokens += session.usage.outputTokens;
    if (!daily.modelsUsed.includes(session.model)) {
      daily.modelsUsed.push(session.model);
    }

    let modelStat = modelMap.get(session.model);
    if (!modelStat) {
      modelStat = {
        model: session.model,
        totalCost: 0,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        sessionCount: 0,
      };
      modelMap.set(session.model, modelStat);
    }
    modelStat.sessionCount += 1;
    modelStat.totalCost += session.cost;
    modelStat.totalTokens += session.usage.totalTokens;
    modelStat.inputTokens += session.usage.inputTokens;
    modelStat.outputTokens += session.usage.outputTokens;
    modelStat.cacheCreationTokens += session.usage.cacheWriteTokens;
    modelStat.cacheReadTokens += session.usage.cacheReadTokens;

    if (session.timestamp > oneWeekAgo) {
      currentWeek.sessions += 1;
      currentWeek.cost += session.cost;
      currentWeek.tokens += session.usage.totalTokens;
    } else if (session.timestamp > twoWeeksAgo) {
      lastWeek.sessions += 1;
      lastWeek.cost += session.cost;
      lastWeek.tokens += session.usage.totalTokens;
    }
  }

  stats.dailyUsage = Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));
  stats.byModel = Array.from(modelMap.values()).sort((a, b) => b.totalCost - a.totalCost);
  stats.sessions = sessions.slice().sort((a, b) => b.timestamp - a.timestamp);
  if (stats.sessions.length > 200) {
    stats.sessions = stats.sessions.slice(0, 200);
  }

  const trends = {
    sessions: lastWeek.sessions === 0 ? 0 : ((currentWeek.sessions - lastWeek.sessions) / lastWeek.sessions) * 100,
    cost: lastWeek.cost === 0 ? 0 : ((currentWeek.cost - lastWeek.cost) / lastWeek.cost) * 100,
    tokens: lastWeek.tokens === 0 ? 0 : ((currentWeek.tokens - lastWeek.tokens) / lastWeek.tokens) * 100,
  };

  stats.weeklyComparison = {
    currentWeek,
    lastWeek,
    trends,
  };
}

function getClaudeProjectStatistics(projectPath) {
  const stats = buildEmptyStats(projectPath);
  const sessions = [];

  try {
    if (projectPath === 'all') {
      if (fs.existsSync(CLAUDE_PROJECTS_DIR)) {
        const dirs = fs.readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => path.join(CLAUDE_PROJECTS_DIR, entry.name));
        for (const dir of dirs) {
          sessions.push(...readClaudeSessionsFromDir(dir));
        }
      }
    } else if (projectPath) {
      const folderName1 = sanitizeProjectPath(projectPath);
      const folderName2 = sanitizeProjectPath(projectPath);
      const dir1 = folderName1 ? path.join(CLAUDE_PROJECTS_DIR, folderName1) : null;
      const dir2 = folderName2 ? path.join(CLAUDE_PROJECTS_DIR, folderName2) : null;

      if (dir1 && fs.existsSync(dir1)) {
        sessions.push(...readClaudeSessionsFromDir(dir1));
      } else if (dir2 && fs.existsSync(dir2)) {
        sessions.push(...readClaudeSessionsFromDir(dir2));
      }
    }
  } catch (error) {
    return stats;
  }

  stats.totalSessions = sessions.length;
  processClaudeSessions(sessions, stats);
  return stats;
}

function calculateCodexCost(usage) {
  const inputCost = (usage.inputTokens / 1_000_000.0) * 3.0;
  const outputCost = (usage.outputTokens / 1_000_000.0) * 15.0;
  const cacheReadCost = (usage.cacheReadTokens / 1_000_000.0) * 0.30;
  return inputCost + outputCost + cacheReadCost;
}

function parseCodexSessionSummary(filePath) {
  const usage = createUsageData();
  let firstTimestamp = 0;
  let summary = null;
  let actualModel = null;

  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (error) {
    return null;
  }

  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    let raw = null;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    if (!raw || typeof raw !== 'object') continue;

    if (!firstTimestamp && raw.timestamp) {
      firstTimestamp = parseTimestamp(raw.timestamp);
    }

    if (!actualModel && raw.type === 'turn_context' && raw.payload && raw.payload.model) {
      actualModel = String(raw.payload.model);
    }

    if (!summary && raw.type === 'event_msg' && raw.payload?.type === 'user_message') {
      const text = typeof raw.payload.message === 'string' ? raw.payload.message : '';
      if (text) {
        const trimmed = text.replace(/\n/g, ' ').trim();
        summary = trimmed.length > 45 ? `${trimmed.slice(0, 45)}...` : trimmed;
      }
    }

    if (raw.type === 'event_msg' && raw.payload?.type === 'token_count') {
      const info = raw.payload.info;
      const totalUsage = info && info.total_token_usage ? info.total_token_usage : null;
      if (totalUsage) {
        usage.inputTokens = Number(totalUsage.input_tokens) || 0;
        usage.outputTokens = Number(totalUsage.output_tokens) || 0;
        usage.cacheReadTokens = Number(totalUsage.cached_input_tokens) || 0;
        usage.cacheWriteTokens = 0;
      }
    }
  }

  usage.totalTokens = usage.inputTokens + usage.outputTokens + usage.cacheWriteTokens + usage.cacheReadTokens;
  const model = actualModel || 'gpt-5.1';
  const cost = calculateCodexCost(usage);

  if (!summary && usage.totalTokens === 0) {
    return null;
  }

  return {
    sessionId: path.basename(filePath, '.jsonl'),
    timestamp: firstTimestamp || Date.now(),
    model,
    usage,
    cost,
    summary,
  };
}

function walkCodexSessions(dirPath, depthLimit, currentDepth, results) {
  if (!fs.existsSync(dirPath)) return;
  let entries = [];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (error) {
    return;
  }

  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (currentDepth < depthLimit) {
        walkCodexSessions(entryPath, depthLimit, currentDepth + 1, results);
      }
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      try {
        const stats = fs.statSync(entryPath);
        if (!stats.size) continue;
      } catch {
        continue;
      }
      results.push(entryPath);
    }
  }
}

function readCodexSessionSummaries() {
  const sessions = [];
  if (!fs.existsSync(CODEX_SESSIONS_DIR)) {
    return sessions;
  }

  const files = [];
  walkCodexSessions(CODEX_SESSIONS_DIR, 10, 0, files);
  for (const filePath of files) {
    const summary = parseCodexSessionSummary(filePath);
    if (summary) {
      sessions.push(summary);
    }
  }

  sessions.sort((a, b) => b.timestamp - a.timestamp);
  return sessions;
}

function processCodexSessions(sessions, stats) {
  const dailyMap = new Map();
  const modelMap = new Map();

  for (const session of sessions) {
    stats.totalUsage.inputTokens += session.usage.inputTokens;
    stats.totalUsage.outputTokens += session.usage.outputTokens;
    stats.totalUsage.cacheWriteTokens += session.usage.cacheWriteTokens;
    stats.totalUsage.cacheReadTokens += session.usage.cacheReadTokens;
    stats.totalUsage.totalTokens += session.usage.totalTokens;
    stats.estimatedCost += session.cost;
  }

  for (const session of sessions) {
    const dateKey = new Date(session.timestamp).toISOString().slice(0, 10);
    let daily = dailyMap.get(dateKey);
    if (!daily) {
      daily = {
        date: dateKey,
        sessions: 0,
        usage: createUsageData(),
        cost: 0,
        modelsUsed: [],
      };
      dailyMap.set(dateKey, daily);
    }

    daily.sessions += 1;
    daily.cost += session.cost;
    daily.usage.inputTokens += session.usage.inputTokens;
    daily.usage.outputTokens += session.usage.outputTokens;
    daily.usage.cacheWriteTokens += session.usage.cacheWriteTokens;
    daily.usage.cacheReadTokens += session.usage.cacheReadTokens;
    daily.usage.totalTokens += session.usage.totalTokens;
    if (!daily.modelsUsed.includes(session.model)) {
      daily.modelsUsed.push(session.model);
    }

    let modelStat = modelMap.get(session.model);
    if (!modelStat) {
      modelStat = {
        model: session.model,
        totalCost: 0,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        sessionCount: 0,
      };
      modelMap.set(session.model, modelStat);
    }
    modelStat.sessionCount += 1;
    modelStat.totalCost += session.cost;
    modelStat.totalTokens += session.usage.totalTokens;
    modelStat.inputTokens += session.usage.inputTokens;
    modelStat.outputTokens += session.usage.outputTokens;
    modelStat.cacheCreationTokens += session.usage.cacheWriteTokens;
    modelStat.cacheReadTokens += session.usage.cacheReadTokens;
  }

  stats.sessions = sessions;
  stats.dailyUsage = Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));
  stats.byModel = Array.from(modelMap.values()).sort((a, b) => b.totalCost - a.totalCost);

  const now = Date.now();
  const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;
  const twoWeeksAgo = now - 14 * 24 * 60 * 60 * 1000;

  for (const session of sessions) {
    if (session.timestamp >= oneWeekAgo) {
      stats.weeklyComparison.currentWeek.sessions += 1;
      stats.weeklyComparison.currentWeek.cost += session.cost;
      stats.weeklyComparison.currentWeek.tokens += session.usage.totalTokens;
    } else if (session.timestamp >= twoWeeksAgo) {
      stats.weeklyComparison.lastWeek.sessions += 1;
      stats.weeklyComparison.lastWeek.cost += session.cost;
      stats.weeklyComparison.lastWeek.tokens += session.usage.totalTokens;
    }
  }

  if (stats.weeklyComparison.lastWeek.sessions > 0) {
    stats.weeklyComparison.trends.sessions =
      ((stats.weeklyComparison.currentWeek.sessions - stats.weeklyComparison.lastWeek.sessions) / stats.weeklyComparison.lastWeek.sessions) * 100;
  }
  if (stats.weeklyComparison.lastWeek.cost > 0) {
    stats.weeklyComparison.trends.cost =
      ((stats.weeklyComparison.currentWeek.cost - stats.weeklyComparison.lastWeek.cost) / stats.weeklyComparison.lastWeek.cost) * 100;
  }
  if (stats.weeklyComparison.lastWeek.tokens > 0) {
    stats.weeklyComparison.trends.tokens =
      ((stats.weeklyComparison.currentWeek.tokens - stats.weeklyComparison.lastWeek.tokens) / stats.weeklyComparison.lastWeek.tokens) * 100;
  }
}

function getCodexProjectStatistics(projectPath) {
  const stats = buildEmptyStats(projectPath);
  stats.weeklyComparison.currentWeek = { sessions: 0, cost: 0, tokens: 0 };
  stats.weeklyComparison.lastWeek = { sessions: 0, cost: 0, tokens: 0 };
  stats.weeklyComparison.trends = { sessions: 0, cost: 0, tokens: 0 };

  try {
    const sessions = readCodexSessionSummaries();
    stats.totalSessions = sessions.length;
    processCodexSessions(sessions, stats);
    return stats;
  } catch (error) {
    return stats;
  }
}

function handleGetUsageStatistics(content, requestId) {
  const scope = content?.scope === 'all' ? 'all' : 'current';
  const provider = content?.provider || currentProvider || 'claude';
  const workspaceRoot = getWorkspaceRoot();
  const projectPath = scope === 'all' ? 'all' : workspaceRoot;

  let stats = null;
  try {
    if (provider === 'codex') {
      stats = getCodexProjectStatistics(projectPath);
    } else {
      stats = getClaudeProjectStatistics(projectPath);
    }
  } catch (error) {
    stats = buildEmptyStats(projectPath);
  }

  sendToHost('usageStatisticsLoaded', stats, requestId);
}

function handleListFiles(content, requestId) {
  const query = typeof content?.query === 'string' ? content.query.trim() : '';
  const currentPath = typeof content?.currentPath === 'string' ? content.currentPath.trim() : '';
  const workspaceRoot = getWorkspaceRoot();
  let { baseDir } = resolveListBaseDir(workspaceRoot, currentPath);

  try {
    if (!baseDir || !fs.existsSync(baseDir) || !fs.statSync(baseDir).isDirectory()) {
      baseDir = workspaceRoot || process.cwd();
    }
  } catch {
    baseDir = workspaceRoot || process.cwd();
  }

  let files = [];
  if (query) {
    searchFilesRecursive(baseDir, workspaceRoot || baseDir, query, files, 0);
  } else {
    files = listDirectoryEntries(baseDir, workspaceRoot || baseDir, '');
  }

  files.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'directory' ? -1 : 1;
    }
    return a.path.localeCompare(b.path);
  });

  sendToHost('fileListResult', { files }, requestId);
}

// ============================================
// Additional Session Handlers
// ============================================

function handleCreateNewSession(requestId) {
  const sessionId = crypto.randomUUID();
  currentSessionId = sessionId;
  sendToHost('sessionCreated', { sessionId }, requestId);
}

function handleInterruptSession(requestId) {
  // TODO: Actually interrupt the SDK session
  sendToHost('sessionInterrupted', { success: true }, requestId);
}

function handleExportSession(content, requestId) {
  const sessionId =
    (typeof content === 'string' ? content : content?.sessionId) ||
    null;

  if (!sessionId) {
    sendError(new Error('Session not found'), requestId);
    return;
  }

  const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');
  let sessionFile = null;
  try {
    if (fs.existsSync(claudeProjectsDir)) {
      const projectDirs = fs.readdirSync(claudeProjectsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => path.join(claudeProjectsDir, d.name));
      for (const dir of projectDirs) {
        const candidate = path.join(dir, `${sessionId}.jsonl`);
        if (fs.existsSync(candidate)) {
          sessionFile = candidate;
          break;
        }
      }
    }
  } catch {
    // ignore
  }

  if (!sessionFile) {
    sendError(new Error('Session not found'), requestId);
    return;
  }

  const titlesFile = path.join(CONFIG_DIR, 'session-titles.json');
  const titles = loadJsonFile(titlesFile, {});
  const titleFromStore = titles?.[sessionId]?.customTitle;
  const title =
    (typeof titleFromStore === 'string' && titleFromStore.trim())
      ? titleFromStore.trim()
      : (typeof content === 'object' && content && typeof content.title === 'string' ? content.title : 'Untitled Session');

  try {
    const text = fs.readFileSync(sessionFile, 'utf-8');
    const lines = text.split('\n').filter((l) => l.trim());
    const messages = [];
    for (const line of lines) {
      try {
        messages.push(JSON.parse(line));
      } catch {
        // ignore
      }
    }
    sendToHost('sessionExported', { sessionId, title, messages }, requestId);
  } catch (error) {
    sendError(error, requestId);
  }
}

function handleToggleFavorite(content, requestId) {
  const sessionId =
    (typeof content === 'string' ? content : content?.sessionId) ||
    null;

  if (!sessionId) {
    sendError(new Error('Session not found'), requestId);
    return;
  }

  const favoritesFile = path.join(CONFIG_DIR, 'favorites.json');
  const favorites = loadJsonFile(favoritesFile, {});

  const currentlyFavorited = !!favorites?.[sessionId];
  if (currentlyFavorited) {
    delete favorites[sessionId];
  } else {
    favorites[sessionId] = { favoritedAt: Date.now() };
  }
  saveJsonFile(favoritesFile, favorites);
  sendToHost('favoriteToggled', { sessionId, favorite: !currentlyFavorited }, requestId);
}

function handleUpdateTitle(content, requestId) {
  const sessionId = (typeof content === 'string' ? content : content?.sessionId) || null;
  const title =
    (typeof content === 'object' && content && typeof content.customTitle === 'string')
      ? content.customTitle
      : (typeof content === 'object' && content && typeof content.title === 'string' ? content.title : '');

  if (!sessionId) {
    sendError(new Error('Session not found'), requestId);
    return;
  }

  const titlesFile = path.join(CONFIG_DIR, 'session-titles.json');
  const titles = loadJsonFile(titlesFile, {});

  const trimmed = title.trim();
  if (!trimmed) {
    if (titles?.[sessionId]) delete titles[sessionId];
  } else {
    titles[sessionId] = { customTitle: trimmed, updatedAt: Date.now() };
  }
  saveJsonFile(titlesFile, titles);
  sendToHost('titleUpdated', { sessionId, title: trimmed }, requestId);
}

function handleCreateNewTab(requestId) {
  // VSCode doesn't support multiple tabs in the same way
  sendToHost('tabCreated', { success: true }, requestId);
}

// ============================================
// Additional Settings Handlers
// ============================================

function handleGetSendShortcut(requestId) {
  const settings = loadJsonFile(SETTINGS_FILE, {});
  sendToHost('sendShortcutLoaded', { shortcut: settings.sendShortcut || 'Enter' }, requestId);
}

function handleSetSendShortcut(content, requestId) {
  const settings = loadJsonFile(SETTINGS_FILE, {});
  settings.sendShortcut = content?.shortcut || 'Enter';
  saveJsonFile(SETTINGS_FILE, settings);
  sendToHost('sendShortcutUpdated', { shortcut: settings.sendShortcut }, requestId);
}

function handleGetThinkingEnabled(requestId) {
  const claudeSettings = readClaudeSettings() || {};
  const enabled = claudeSettings.alwaysThinkingEnabled !== false;
  sendToHost('thinkingEnabledLoaded', { enabled }, requestId);
}

function handleSetThinkingEnabled(content, requestId) {
  const enabled = content?.enabled !== false;
  const current = readClaudeSettings() || {};
  const next = { ...current, alwaysThinkingEnabled: enabled };
  writeClaudeSettings(next);

  const codemossSettings = loadJsonFile(SETTINGS_FILE, {});
  codemossSettings.thinkingEnabled = enabled;
  saveJsonFile(SETTINGS_FILE, codemossSettings);

  try {
    const config = loadCodemossConfig();
    ensureClaudeSection(config);
    const activeId =
      typeof config.claude?.current === 'string' && config.claude.current
        ? config.claude.current
        : (typeof codemossSettings.activeClaudeProviderId === 'string' ? codemossSettings.activeClaudeProviderId : '__local_settings_json__');
    if (activeId !== '__local_settings_json__' && config.claude.providers && typeof config.claude.providers === 'object') {
      const existing = config.claude.providers[activeId];
      if (existing && typeof existing === 'object') {
        const settingsConfig = existing.settingsConfig && typeof existing.settingsConfig === 'object' ? existing.settingsConfig : {};
        config.claude.providers[activeId] = { ...existing, settingsConfig: { ...settingsConfig, alwaysThinkingEnabled: enabled } };
        saveCodemossConfig(config);
        syncLegacyProviderFilesFromConfig(config);
      }
    }
  } catch {
    // ignore
  }

  sendToHost('thinkingEnabledUpdated', { enabled }, requestId);
}

// ============================================
// Additional Provider Handlers
// ============================================

function handleGetProviders(requestId) {
  const { providers } = getClaudeProvidersWithActiveFlag();
  sendToHost('providersLoaded', providers, requestId);
}

function handleAddProvider(content, requestId) {
  const provider = (content && typeof content === 'object') ? content : null;
  if (!provider || typeof provider.id !== 'string') {
    sendError(new Error('Invalid provider payload'), requestId);
    return;
  }

  const config = loadCodemossConfig();
  ensureClaudeSection(config);

  if (!config.claude.providers[provider.id]) {
    const createdAt = typeof provider.createdAt === 'number' ? provider.createdAt : Date.now();
    config.claude.providers[provider.id] = { ...provider, createdAt };
    saveCodemossConfig(config);
    syncLegacyProviderFilesFromConfig(config);
  }

  const { providers } = getClaudeProvidersWithActiveFlag();
  sendToHost('providersLoaded', providers, requestId);
}

function handleUpdateProvider(content, requestId) {
  const id = content?.id;
  const updates = content?.updates;
  if (typeof id !== 'string' || !updates || typeof updates !== 'object') {
    sendError(new Error('Invalid update_provider payload'), requestId);
    return;
  }

  const config = loadCodemossConfig();
  ensureClaudeSection(config);
  const existing = config.claude.providers[id];
  if (existing && typeof existing === 'object') {
    const createdAt = typeof existing.createdAt === 'number'
      ? existing.createdAt
      : (typeof updates.createdAt === 'number' ? updates.createdAt : Date.now());
    config.claude.providers[id] = { ...existing, ...updates, createdAt, id };
    saveCodemossConfig(config);
    syncLegacyProviderFilesFromConfig(config);
  }

  const codemossSettings = loadJsonFile(SETTINGS_FILE, {});
  const activeId =
    typeof config.claude.current === 'string' && config.claude.current
      ? config.claude.current
      : (typeof codemossSettings.activeClaudeProviderId === 'string' ? codemossSettings.activeClaudeProviderId : '__local_settings_json__');
  if (activeId === id) {
    const current = readClaudeSettings() || {};
    const updated = config.claude.providers[id];
    const next = mergeProviderSettingsIntoClaudeSettings(current, updated?.settingsConfig || {});
    writeClaudeSettings(next);
    handleGetCurrentClaudeConfig(requestId);
    handleGetActiveClaudeProvider(requestId);
  }
  const nextAlwaysThinkingEnabled = updates?.settingsConfig?.alwaysThinkingEnabled;
  if (activeId === id && typeof nextAlwaysThinkingEnabled === 'boolean') {
    if (codemossSettings.thinkingEnabled !== nextAlwaysThinkingEnabled) {
      codemossSettings.thinkingEnabled = nextAlwaysThinkingEnabled;
      saveJsonFile(SETTINGS_FILE, codemossSettings);
    }
    sendToHost('thinkingEnabledUpdated', { enabled: nextAlwaysThinkingEnabled }, requestId);
  }

  const { providers } = getClaudeProvidersWithActiveFlag();
  sendToHost('providersLoaded', providers, requestId);
}

function handleDeleteProvider(content, requestId) {
  const id = content?.id;
  if (typeof id !== 'string') {
    sendError(new Error('Invalid delete_provider payload'), requestId);
    return;
  }

  const config = loadCodemossConfig();
  ensureClaudeSection(config);
  if (config.claude.providers && typeof config.claude.providers === 'object') {
    delete config.claude.providers[id];
  }

  const codemossSettings = loadJsonFile(SETTINGS_FILE, {});
  const activeId =
    typeof config.claude.current === 'string' && config.claude.current
      ? config.claude.current
      : (typeof codemossSettings.activeClaudeProviderId === 'string' ? codemossSettings.activeClaudeProviderId : '__local_settings_json__');
  if (activeId === id) {
    config.claude.current = '__local_settings_json__';
    codemossSettings.activeClaudeProviderId = '__local_settings_json__';
    saveJsonFile(SETTINGS_FILE, codemossSettings);
    saveCodemossConfig(config);
    syncLegacyProviderFilesFromConfig(config);
    sendToHost('showSwitchSuccess', { message: '已回退到本地 settings.json 配置' }, requestId);
    handleGetCurrentClaudeConfig(requestId);
    handleGetActiveClaudeProvider(requestId);
  } else {
    saveCodemossConfig(config);
    syncLegacyProviderFilesFromConfig(config);
  }

  const { providers } = getClaudeProvidersWithActiveFlag();
  sendToHost('providersLoaded', providers, requestId);
}

async function handlePreviewCcSwitchImport(content, requestId) {
  const defaultDbPath = path.join(os.homedir(), '.cc-switch', 'cc-switch.db');
  const dbPath =
    typeof content === 'string'
      ? content
      : (content && typeof content === 'object' && typeof content.dbPath === 'string' ? content.dbPath : defaultDbPath);

  if (!fs.existsSync(dbPath)) {
    sendToHost('backend_notification', {
      type: 'error',
      message:
        `未找到 cc-switch 数据库文件。\n` +
        `路径: ${dbPath}\n` +
        `你可以选择“选择 cc-switch.db 文件导入”，或者确认已安装并配置过 cc-switch。`
    }, requestId);
    return;
  }

  const scriptPath = path.join(process.cwd(), 'read-cc-switch-db.js');
  try {
    const output = execFileSync(process.execPath, [scriptPath, dbPath], { encoding: 'utf-8' }).trim();
    const parsed = JSON.parse(output || '{}');
    if (!parsed || parsed.success === false) {
      sendToHost('backend_notification', { type: 'error', message: parsed?.error || '读取 cc-switch 数据库失败' }, requestId);
      return;
    }
    sendToHost('import_preview_result', { providers: parsed.providers || [] }, requestId);
  } catch (error) {
    const stderr = (error && typeof error === 'object' && 'stderr' in error) ? String(error.stderr || '') : '';
    const message = stderr.trim() ? stderr.trim() : (error?.message || '读取 cc-switch 数据库失败');
    sendToHost('backend_notification', { type: 'error', message }, requestId);
  }
}

async function handleSaveImportedProviders(content, requestId) {
  const imported = content?.providers;
  if (!Array.isArray(imported)) {
    sendError(new Error('Invalid save_imported_providers payload'), requestId);
    return;
  }

  const config = loadCodemossConfig();
  ensureClaudeSection(config);

  for (const p of imported) {
    if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !p.id) continue;
    const createdAt = typeof p.createdAt === 'number' ? p.createdAt : Date.now();
    config.claude.providers[p.id] = { ...p, source: 'cc-switch', createdAt, id: p.id };
  }

  saveCodemossConfig(config);
  syncLegacyProviderFilesFromConfig(config);

  const { providers } = getClaudeProvidersWithActiveFlag();
  sendToHost('providersLoaded', providers, requestId);
  sendToHost('backend_notification', { type: 'success', message: `已导入 ${imported.length} 个供应商配置` }, requestId);
}

function handleGetCodexProviders(requestId) {
  const config = loadCodemossConfig();
  ensureCodexSection(config);

  const codemossSettings = loadJsonFile(SETTINGS_FILE, {});
  const activeFromConfig =
    typeof config.codex?.current === 'string' && config.codex.current
      ? config.codex.current
      : null;
  const activeFromLegacy =
    typeof codemossSettings.activeCodexProvider === 'string' && codemossSettings.activeCodexProvider
      ? codemossSettings.activeCodexProvider
      : null;
  const activeId = activeFromConfig || activeFromLegacy || '';

  if (!activeFromConfig && activeFromLegacy) {
    config.codex.current = activeFromLegacy;
    saveCodemossConfig(config);
    syncLegacyProviderFilesFromConfig(config);
  }

  const providers = getCodexProvidersFromConfig(config).map(p => ({ ...p, isActive: p.id === activeId }));
  sendToHost('codexProvidersLoaded', providers, requestId);
}

function handleAddCodexProvider(content, requestId) {
  const provider = (content && typeof content === 'object') ? content : null;
  if (!provider) {
    sendError(new Error('Invalid add_codex_provider payload'), requestId);
    return;
  }

  const id = typeof provider.id === 'string' && provider.id ? provider.id : `codex_provider_${Date.now()}`;
  const config = loadCodemossConfig();
  ensureCodexSection(config);
  const createdAt = typeof provider.createdAt === 'number' ? provider.createdAt : Date.now();
  config.codex.providers[id] = { ...provider, id, createdAt };
  saveCodemossConfig(config);
  syncLegacyProviderFilesFromConfig(config);

  handleGetCodexProviders(requestId);
}

function handleUpdateCodexProvider(content, requestId) {
  const id = content?.id;
  const updates = content?.updates;
  if (typeof id !== 'string' || !updates || typeof updates !== 'object') {
    sendError(new Error('Invalid update_codex_provider payload'), requestId);
    return;
  }

  const config = loadCodemossConfig();
  ensureCodexSection(config);
  const existing = config.codex.providers[id];
  if (existing && typeof existing === 'object') {
    const createdAt = typeof existing.createdAt === 'number'
      ? existing.createdAt
      : (typeof updates.createdAt === 'number' ? updates.createdAt : Date.now());
    config.codex.providers[id] = { ...existing, ...updates, id, createdAt };
    saveCodemossConfig(config);
    syncLegacyProviderFilesFromConfig(config);
  }

  handleGetCodexProviders(requestId);
}

function handleSwitchCodexProvider(content, requestId) {
  const id = typeof content?.id === 'string' ? content.id : null;
  if (!id) {
    sendError(new Error('Invalid switch_codex_provider payload'), requestId);
    return;
  }

  const config = loadCodemossConfig();
  ensureCodexSection(config);
  config.codex.current = id;
  saveCodemossConfig(config);
  syncLegacyProviderFilesFromConfig(config);

  const settings = loadJsonFile(SETTINGS_FILE, {});
  settings.activeCodexProvider = id;
  saveJsonFile(SETTINGS_FILE, settings);

  handleGetCodexProviders(requestId);
}

function handleDeleteCodexProvider(content, requestId) {
  const id = typeof content?.id === 'string' ? content.id : null;
  if (!id) {
    sendError(new Error('Invalid delete_codex_provider payload'), requestId);
    return;
  }

  const config = loadCodemossConfig();
  ensureCodexSection(config);
  if (config.codex.providers && typeof config.codex.providers === 'object') {
    delete config.codex.providers[id];
  }

  const settings = loadJsonFile(SETTINGS_FILE, {});
  const activeId =
    typeof config.codex.current === 'string' && config.codex.current
      ? config.codex.current
      : (typeof settings.activeCodexProvider === 'string' ? settings.activeCodexProvider : '');
  if (activeId === id) {
    config.codex.current = '';
    settings.activeCodexProvider = '';
    saveJsonFile(SETTINGS_FILE, settings);
  }

  saveCodemossConfig(config);
  syncLegacyProviderFilesFromConfig(config);

  handleGetCodexProviders(requestId);
}

// ============================================
// Model & Mode Handlers
// ============================================

let currentModel = 'claude-sonnet-4-20250514';
let currentMode = 'ask';
let currentReasoningEffort = 'medium';

function handleSetModel(content, requestId) {
  currentModel = content?.model || content || 'claude-sonnet-4-20250514';
  sendToHost('modelSet', { model: currentModel }, requestId);
}

function handleSetMode(content, requestId) {
  currentMode = content?.mode || content || 'ask';
  sendToHost('modeSet', { mode: currentMode }, requestId);
}

function handleSetReasoningEffort(content, requestId) {
  currentReasoningEffort = content?.effort || content || 'medium';
  sendToHost('reasoningEffortSet', { effort: currentReasoningEffort }, requestId);
}

// ============================================
// Permission Handlers
// ============================================

function handleAskUserQuestionResponse(content, requestId) {
  console.error('[server] Ask user question response:', JSON.stringify(content));
  sendToHost('askUserQuestionProcessed', { success: true }, requestId);
}

function handlePlanApprovalResponse(content, requestId) {
  console.error('[server] Plan approval response:', JSON.stringify(content));
  sendToHost('planApprovalProcessed', { success: true }, requestId);
}

// ============================================
// Additional MCP Handlers
// ============================================

function handleToggleMcpServer(content, requestId) {
  try {
    const servers = getClaudeMcpServers(getWorkspaceRoot());
    const target = servers.find((s) => s.id === content?.id);
    if (!target) {
      throw new Error('MCP server not found');
    }
    const next = { ...target, enabled: !target.enabled };
    upsertClaudeMcpServer(next, getWorkspaceRoot());
    sendToHost('mcpServerToggled', next, requestId);
    handleGetMcpServers(requestId);
  } catch (error) {
    sendError(error, requestId);
  }
}

function handleToggleCodexMcpServer(content, requestId) {
  try {
    const servers = getCodexMcpServers();
    const target = servers.find((s) => s.id === content?.id);
    if (!target) {
      throw new Error('MCP server not found');
    }
    const next = { ...target, enabled: !target.enabled };
    upsertCodexMcpServer(next);
    sendToHost('mcpServerToggled', next, requestId);
    handleGetCodexMcpServers(requestId);
  } catch (error) {
    sendError(error, requestId);
  }
}

function handleGetMcpServerStatus(requestId) {
  const servers = getClaudeMcpServers(getWorkspaceRoot());
  // Map status to frontend expected values: 'connected' | 'failed' | 'needs-auth' | 'pending'
  const statuses = servers.map((s) => ({
    id: s.id,
    name: s.name || s.id,
    status: s.enabled ? 'connected' : 'failed'
  }));
  sendToHost('mcpServerStatusLoaded', { statuses }, requestId);
}

// ============================================
// Additional Skills Handlers
// ============================================

function handleImportSkill(content, requestId) {
  const scope = content?.scope === 'local' ? 'local' : 'global';
  let paths = [];

  if (Array.isArray(content?.paths)) {
    paths = content.paths.filter((p) => typeof p === 'string');
  } else if (Array.isArray(content?.files)) {
    paths = content.files.filter((p) => typeof p === 'string');
  } else if (typeof content?.path === 'string') {
    paths = [content.path];
  }

  if (paths.length === 0) {
    sendToHost('skillImported', { success: false, error: '未选择文件' }, requestId);
    return;
  }

  const result = importSkills(paths, scope, getWorkspaceRoot());
  sendToHost('skillImported', result, requestId);
}

function handleOpenSkill(content, requestId) {
  const resolvedPath = resolveSkillOpenPath(content?.path);
  if (!resolvedPath) {
    sendError(new Error('Skill path not provided'), requestId);
    return;
  }
  sendToHost('fileOperation', { operation: 'openFile', path: resolvedPath }, requestId);
}

function handleDeleteSkill(content, requestId) {
  const scope = content?.scope === 'local' ? 'local' : 'global';
  let name = content?.name;
  let enabled = typeof content?.enabled === 'boolean' ? content.enabled : true;

  if (!name && typeof content?.id === 'string') {
    const prefix = `${scope}-`;
    let parsed = content.id.startsWith(prefix) ? content.id.slice(prefix.length) : content.id;
    if (parsed.endsWith('-disabled')) {
      parsed = parsed.slice(0, -'-disabled'.length);
      enabled = false;
    }
    name = parsed;
  }

  if (!name) {
    sendToHost('skillDeleted', { success: false, error: 'Skill 名称缺失' }, requestId);
    return;
  }

  const result = deleteSkillByName(name, scope, enabled, getWorkspaceRoot());
  sendToHost('skillDeleted', result, requestId);
}

function handleToggleSkill(content, requestId) {
  const scope = content?.scope === 'local' ? 'local' : 'global';
  let name = content?.name;
  let enabled = typeof content?.enabled === 'boolean' ? content.enabled : true;

  if (!name && typeof content?.id === 'string') {
    const prefix = `${scope}-`;
    let parsed = content.id.startsWith(prefix) ? content.id.slice(prefix.length) : content.id;
    if (parsed.endsWith('-disabled')) {
      parsed = parsed.slice(0, -'-disabled'.length);
      enabled = false;
    }
    name = parsed;
  }

  if (!name) {
    sendError(new Error('Skill name missing'), requestId);
    return;
  }

  const result = toggleSkill(name, scope, enabled, getWorkspaceRoot());
  sendToHost('skillToggled', result, requestId);
}

// ============================================
// Additional Agent Handlers
// ============================================

function handleGetSelectedAgent(requestId) {
  const config = readAgentConfig();
  const selectedId = typeof config.selectedAgentId === 'string' ? config.selectedAgentId : null;
  const agent =
    selectedId && config.agents && config.agents[selectedId]
      ? { id: selectedId, ...config.agents[selectedId] }
      : null;
  sendToHost('selectedAgentLoaded', { selectedAgentId: selectedId, agent }, requestId);
}

function handleSetSelectedAgent(content, requestId) {
  const config = readAgentConfig();
  const agent = content?.agent || content || null;
  if (agent && typeof agent.id === 'string' && agent.id) {
    config.selectedAgentId = agent.id;
    if (!config.agents) {
      config.agents = {};
    }
    if (config.agents[agent.id]) {
      config.agents[agent.id] = { ...config.agents[agent.id], ...agent };
    }
    writeAgentConfig(config);
    sendToHost('selectedAgentChanged', { agent }, requestId);
    return;
  }

  config.selectedAgentId = null;
  writeAgentConfig(config);
  sendToHost('selectedAgentChanged', { agent: null }, requestId);
}

function handleAddAgent(content, requestId) {
  try {
    const config = readAgentConfig();
    const agent = content && typeof content === 'object' ? content : {};
    const id = typeof agent.id === 'string' && agent.id ? agent.id : `agent_${Date.now()}`;
    const existing = config.agents || {};
    if (existing[id]) {
      throw new Error(`Agent with id '${id}' already exists`);
    }
    if (!agent.createdAt) {
      agent.createdAt = Date.now();
    }
    existing[id] = { ...agent, id };
    config.agents = existing;
    writeAgentConfig(config);
    sendToHost('agentsLoaded', getAgentsList(), requestId);
    sendToHost('agentOperationResult', { success: true, operation: 'add' }, requestId);
  } catch (error) {
    sendToHost('agentOperationResult', {
      success: false,
      operation: 'add',
      error: error?.message || 'add_failed'
    }, requestId);
  }
}

function handleUpdateAgent(content, requestId) {
  try {
    const id = content?.id;
    const updates = content?.updates;
    if (!id || !updates || typeof updates !== 'object') {
      throw new Error('Invalid update_agent payload');
    }
    const config = readAgentConfig();
    const existing = config.agents || {};
    if (!existing[id]) {
      throw new Error(`Agent with id '${id}' not found`);
    }
    const current = existing[id];
    existing[id] = { ...current, ...updates, id, createdAt: current.createdAt || updates.createdAt || Date.now() };
    config.agents = existing;
    writeAgentConfig(config);
    sendToHost('agentsLoaded', getAgentsList(), requestId);
    sendToHost('agentOperationResult', { success: true, operation: 'update' }, requestId);
  } catch (error) {
    sendToHost('agentOperationResult', {
      success: false,
      operation: 'update',
      error: error?.message || 'update_failed'
    }, requestId);
  }
}

function handleDeleteAgent(content, requestId) {
  try {
    const id = content?.id;
    if (!id) {
      throw new Error('Missing agent id');
    }
    const config = readAgentConfig();
    const existing = config.agents || {};
    if (!existing[id]) {
      throw new Error('Agent not found');
    }
    delete existing[id];
    config.agents = existing;
    if (config.selectedAgentId === id) {
      config.selectedAgentId = null;
      sendToHost('selectedAgentChanged', { agent: null }, requestId);
    }
    writeAgentConfig(config);
    sendToHost('agentsLoaded', getAgentsList(), requestId);
    sendToHost('agentOperationResult', { success: true, operation: 'delete' }, requestId);
  } catch (error) {
    sendToHost('agentOperationResult', {
      success: false,
      operation: 'delete',
      error: error?.message || 'delete_failed'
    }, requestId);
  }
}

// ============================================
// Additional Dependency Handlers
// ============================================

function handleUninstallDependency(content, requestId) {
  const sdkId = content?.id || content?.sdkId;
  if (!sdkId || (sdkId !== 'claude-sdk' && sdkId !== 'codex-sdk')) {
    sendToHost('dependencyUninstallResult', { success: false, sdkId: sdkId || 'unknown', error: 'invalid_sdk_id' }, requestId);
    return;
  }

  const sdkRootDir = path.join(CONFIG_DIR, 'dependencies', sdkId);
  try {
    fs.rmSync(sdkRootDir, { recursive: true, force: true });
    clearSdkCache();
    sendToHost('dependencyUninstallResult', { success: true, sdkId }, requestId);
    handleGetDependencies(requestId);
  } catch (error) {
    sendToHost('dependencyUninstallResult', { success: false, sdkId, error: error?.message || 'uninstall_failed' }, requestId);
  }
}

function handleCheckNodeEnvironment(requestId) {
  const envStatus = getNodeEnvironmentStatus();
  sendToHost('nodeEnvironmentStatus', {
    available: envStatus.available,
    nodeVersion: envStatus.nodeVersion,
    npmVersion: envStatus.npmVersion,
    error: envStatus.error
  }, requestId);
}

// ============================================
// System Handlers
// ============================================

function handleFrontendReady(requestId) {
  console.error('[server] Frontend ready signal received');
  // Send initial data to frontend
  sendToHost('frontendReadyAck', {
    sdkStatus: getSdkStatus(),
    version: '0.1.0'
  }, requestId);
}

async function handleRefreshSlashCommands(requestId) {
  try {
    const commands = await claudeGetSlashCommands(getWorkspaceRoot(), { emitLogs: false });
    const list = Array.isArray(commands) ? commands : [];
    sendToHost('slashCommandsUpdated', list, requestId);
  } catch (error) {
    sendToHost('slashCommandsUpdated', [], requestId);
  }
}

function handleGetNodePath(requestId) {
  sendToHost('nodePathLoaded', { path: process.execPath }, requestId);
}

function handleSetNodePath(content, requestId) {
  // VSCode doesn't need to set node path
  sendToHost('nodePathSet', { success: true }, requestId);
}

function handleGetWorkingDirectory(requestId) {
  sendToHost('workingDirectoryLoaded', { path: getWorkspaceRoot() }, requestId);
}

function handleSetWorkingDirectory(content, requestId) {
  const { path: dirPath } = content || {};
  if (dirPath && fs.existsSync(dirPath)) {
    process.chdir(dirPath);
    sendToHost('workingDirectorySet', { path: dirPath, success: true }, requestId);
  } else {
    sendError(new Error('Invalid directory path'), requestId);
  }
}

function handleGetEditorFontConfig(requestId) {
  // VSCode handles its own font config
  sendToHost('editorFontConfigLoaded', {
    fontFamily: 'Consolas',
    fontSize: 14,
    lineSpacing: 1.5
  }, requestId);
}

// ============================================
// Server Setup
// ============================================

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

rl.on('line', (line) => {
  if (line.trim()) {
    try {
      const message = JSON.parse(line);
      handleMessage(message);
    } catch (error) {
      console.error('[server] Failed to parse message:', line.substring(0, 100));
    }
  }
});

rl.on('close', () => {
  console.error('[server] stdin closed, exiting');
  process.exit(0);
});

// Log startup
console.error('[server] AI Bridge Server started');
console.error('[server] Config directory:', CONFIG_DIR);
console.error('[server] SDK Status:', JSON.stringify(getSdkStatus()));

// Send ready message
sendToHost('ready', {
  version: '0.1.0',
  sdkStatus: getSdkStatus()
});
