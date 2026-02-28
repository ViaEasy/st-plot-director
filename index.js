/**
 * st-plot-director - SillyTavern Plot Director Extension
 *
 * Automatically generates plot directions after each AI response
 * and sends them as user messages to drive the narrative forward.
 */

import { generateViaProxy, generateDirect, testConnection } from './utils/api.js';
import {
    initPresets, getCurrentPreset, savePreset, deletePreset,
    exportPreset, importPreset, getPresetNames, getDefaultPromptManagerConfig,
} from './utils/preset-manager.js';

const MODULE_NAME = 'st-plot-director';
const EXTENSION_FOLDER = `third-party/${MODULE_NAME}`;

// API 模板数据
const API_TEMPLATES = {
    openai: {
        name: 'OpenAI',
        connectionMode: 'direct',
        apiType: 'openai',
        apiUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        temperature: 0.8,
        maxTokens: 300,
    },
    claude: {
        name: 'Claude (Direct)',
        connectionMode: 'direct',
        apiType: 'claude',
        apiUrl: 'https://api.anthropic.com/v1',
        model: 'claude-3-5-sonnet-20241022',
        temperature: 0.8,
        maxTokens: 300,
    },
    ollama: {
        name: 'Ollama (Local)',
        connectionMode: 'direct',
        apiType: 'openai',
        apiUrl: 'http://localhost:11434/v1',
        model: 'llama3.2',
        temperature: 0.8,
        maxTokens: 300,
    },
    proxy: {
        name: 'SillyTavern Proxy',
        connectionMode: 'proxy',
        apiType: 'openai',
        apiUrl: '',
        model: '',
        temperature: 0.8,
        maxTokens: 300,
    },
};

// 错误映射表
const ERROR_MESSAGES = {
    NO_MODEL: '请设置模型名称',
    NO_PRESET: '请选择包含 System Prompt 的预设',
    API_401: 'API Key 无效或已过期',
    API_403: 'API 访问被拒绝，请检查权限',
    API_429: 'API 请求频率超限，请稍后重试',
    API_500: 'API 服务器错误，请稍后重试',
    NETWORK_ERROR: '网络连接失败，请检查 API URL',
    TIMEOUT: '请求超时，请检查网络或增加超时时间',
};

// Regex 示例
const REGEX_EXAMPLES = [
    {
        label: '去除旁白（*号包裹）',
        pattern: '\\*[^*]+\\*',
        replacement: '',
        flags: 'g',
        enabled: true,
    },
    {
        label: '去除旁白（括号包裹）',
        pattern: '\\([^)]+\\)',
        replacement: '',
        flags: 'g',
        enabled: false,
    },
    {
        label: '统一引号为中文',
        pattern: '[""]',
        replacement: '"',
        flags: 'g',
        enabled: false,
    },
];

const defaultSettings = Object.freeze({
    enabled: false,
    mode: 'auto',
    rounds: 5,
    currentRound: 0,
    running: false,
    connectionMode: 'proxy',
    apiType: 'openai',
    apiUrl: '',
    apiKey: '',
    model: '',
    temperature: 0.8,
    maxTokens: 300,
    contextLength: 20,
    outlineEnabled: false,
    outline: '',
    outlineInjectRounds: 1,
    outlinePromptRounds: 999,
    waitForChatu8: true,
    chatu8StartTimeout: 15,
    chatu8Timeout: 300,
    presets: {},
    selectedPreset: '',
    apiConfigs: {},
    selectedApiConfig: '',
    regexRules: [],
    uiState: {
        activeTab: 'basic',
        collapsedSections: {
            'input-log': true,
            'llm-output': true,
            'log': true,
        },
    },
});

let isProcessing = false;
let currentAbortController = null;
let eventsBound = false;

// 配置变化检测
let savedPresetSnapshot = null;
let hasUnsavedChanges = false;

// 状态可视化
let statusUpdateInterval = null;

// ---- Logging ----

const MAX_LOG_ENTRIES = 500;
const logEntries = [];
let currentLogFilter = 'all'; // 'all', 'warn', 'error'

function log(message, level = 'INFO') {
    const time = new Date().toLocaleTimeString();
    const entry = { time, message, level };
    if (logEntries.length >= MAX_LOG_ENTRIES) {
        logEntries.shift();
    }
    logEntries.push(entry);
    updateLogDisplay();
    console.log(`[PlotDirector] [${level}] ${message}`);
}

function updateLogDisplay() {
    const el = document.getElementById('st_pd_log');
    if (!el) return;

    const filtered = logEntries.filter(entry => {
        if (currentLogFilter === 'all') return true;
        if (currentLogFilter === 'warn') return entry.level === 'WARN' || entry.level === 'ERROR';
        if (currentLogFilter === 'error') return entry.level === 'ERROR';
        return true;
    });

    const lines = filtered.map(entry => {
        const prefix = `[${entry.time}] [${entry.level}]`;
        return `${prefix} ${entry.message}`;
    });

    el.value = lines.join('\n');
    el.scrollTop = el.scrollHeight;
}

// 错误处理函数
function handleError(error, context = '') {
    let errorMsg = error.message || String(error);
    let friendlyMsg = errorMsg;

    // 优先检查 HTTP 状态码
    const status = error.status || error.response?.status;
    if (status) {
        if (status === 401) {
            friendlyMsg = ERROR_MESSAGES.API_401;
        } else if (status === 403) {
            friendlyMsg = ERROR_MESSAGES.API_403;
        } else if (status === 429) {
            friendlyMsg = ERROR_MESSAGES.API_429;
        } else if (status >= 500 && status < 600) {
            friendlyMsg = ERROR_MESSAGES.API_500;
        }
    } else {
        // 回退到字符串匹配
        if (errorMsg.includes('401')) {
            friendlyMsg = ERROR_MESSAGES.API_401;
        } else if (errorMsg.includes('403')) {
            friendlyMsg = ERROR_MESSAGES.API_403;
        } else if (errorMsg.includes('429')) {
            friendlyMsg = ERROR_MESSAGES.API_429;
        } else if (errorMsg.includes('500') || errorMsg.includes('502') || errorMsg.includes('503')) {
            friendlyMsg = ERROR_MESSAGES.API_500;
        } else if (errorMsg.includes('timeout') || errorMsg.includes('timed out')) {
            friendlyMsg = ERROR_MESSAGES.TIMEOUT;
        } else if (errorMsg.includes('network') || errorMsg.includes('ECONNREFUSED') || errorMsg.includes('fetch failed')) {
            friendlyMsg = ERROR_MESSAGES.NETWORK_ERROR;
        }
    }

    const fullMsg = context ? `${friendlyMsg} (${context})` : friendlyMsg;
    toastr.error(fullMsg);
    log(errorMsg, 'ERROR');
}

// 配置变化检测函数
function markConfigAsChanged() {
    hasUnsavedChanges = true;
    updateUnsavedIndicator();
}

function markConfigAsSaved() {
    hasUnsavedChanges = false;
    savedPresetSnapshot = getCurrentPresetSnapshot();
    updateUnsavedIndicator();
}

function updateUnsavedIndicator() {
    const indicator = document.getElementById('st_pd_unsaved_indicator');
    if (indicator) {
        indicator.style.display = hasUnsavedChanges ? 'inline' : 'none';
    }
}

function getCurrentPresetSnapshot() {
    const preset = getCurrentPreset(getSettings());
    return preset ? JSON.stringify(preset) : null;
}

function confirmSwitchPreset(newPresetName) {
    if (hasUnsavedChanges) {
        return confirm('当前配置未保存，是否继续切换？未保存的更改将丢失。');
    }
    return true;
}

// 状态可视化函数
function updateWaitingStatus(message, elapsedSeconds, totalSeconds) {
    const statusEl = document.getElementById('st_pd_status');
    if (!statusEl) return;

    const remaining = totalSeconds - elapsedSeconds;
    const isWarning = remaining <= 10 && remaining > 0;

    statusEl.textContent = `${message} (剩余 ${remaining}s)`;
    statusEl.className = 'st-pd-status generating';
    if (isWarning) {
        statusEl.style.color = '#ff9800';
    } else {
        statusEl.style.color = '';
    }
}

function updateGeneratingStatus(message, elapsedSeconds) {
    const statusEl = document.getElementById('st_pd_status');
    if (!statusEl) return;

    statusEl.textContent = `${message} (已用时 ${elapsedSeconds}s)`;
    statusEl.className = 'st-pd-status generating';
    statusEl.style.color = '';
}

function clearStatusInterval() {
    if (statusUpdateInterval) {
        clearInterval(statusUpdateInterval);
        statusUpdateInterval = null;
    }
}

function showLLMOutput(text) {
    const el = document.getElementById('st_pd_llm_output');
    if (el) el.value = text;
}

function showInputLog(messages) {
    const el = document.getElementById('st_pd_input_log');
    if (!el) return;

    let logText = '=== Messages sent to Director LLM ===\n\n';

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        logText += `Message ${i + 1}:\n`;
        logText += `Role: ${msg.role}\n`;
        logText += `Content:\n${msg.content}\n`;
        logText += '\n' + '-'.repeat(50) + '\n\n';
    }

    el.value = logText;
    el.scrollTop = 0;
}

// ---- Settings ----

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForChatu8Complete(settings) {
    const fab = document.getElementById('st-chatu8-fab');
    if (!fab) {
        log('chatu8 FAB not found, skipping wait.');
        return;
    }

    const timeoutMs = (settings.chatu8Timeout || 300) * 1000;
    const startTime = Date.now();

    // Phase 1: Poll for up to chatu8StartTimeout waiting for chatu8 to START (loading class appears)
    log('Waiting for chatu8 to start...');
    const pollStartLimit = (settings.chatu8StartTimeout || 15) * 1000;
    let detected = false;
    while (Date.now() - startTime < pollStartLimit) {
        if (fab.classList.contains('st-chatu8-fab-loading')) {
            detected = true;
            break;
        }
        await delay(500);
    }

    if (!detected) {
        log(`chatu8 did not start within ${settings.chatu8StartTimeout || 15}s, continuing.`);
        return;
    }

    // Phase 2: Wait for chatu8 to FINISH (loading class removed)
    log('chatu8 is generating, waiting for it to finish...');

    // 启动状态更新
    const totalSeconds = Math.floor(timeoutMs / 1000);
    clearStatusInterval();
    statusUpdateInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        updateWaitingStatus('⏳ 等待 chatu8 完成...', elapsed, totalSeconds);
    }, 1000);

    return new Promise((resolve) => {
        let timeoutId = null;

        const cleanup = () => {
            observer.disconnect();
            clearStatusInterval();
            if (timeoutId) clearTimeout(timeoutId);
        };

        const observer = new MutationObserver(() => {
            if (!fab.classList.contains('st-chatu8-fab-loading')) {
                cleanup();
                log(`chatu8 finished (${((Date.now() - startTime) / 1000).toFixed(1)}s).`);
                resolve();
            }
        });
        observer.observe(fab, { attributes: true, attributeFilter: ['class'] });

        // Also check immediately in case it already finished during setup
        if (!fab.classList.contains('st-chatu8-fab-loading')) {
            cleanup();
            log(`chatu8 finished (${((Date.now() - startTime) / 1000).toFixed(1)}s).`);
            resolve();
            return;
        }

        timeoutId = setTimeout(() => {
            cleanup();
            log('chatu8 wait timed out, continuing anyway.', 'WARN');
            resolve();
        }, timeoutMs);
    });
}

function getSettings() {
    const context = SillyTavern.getContext();
    const ext = context.extensionSettings;
    if (!ext[MODULE_NAME]) {
        ext[MODULE_NAME] = structuredClone(defaultSettings);
    }
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(ext[MODULE_NAME], key)) {
            ext[MODULE_NAME][key] = defaultSettings[key];
        }
    }
    return ext[MODULE_NAME];
}

function saveSettings() {
    const context = SillyTavern.getContext();
    context.saveSettingsDebounced();
}

// ---- UI Helpers ----

function updateStatusUI(settings) {
    const statusEl = document.getElementById('st_pd_status');
    const progressEl = document.getElementById('st_pd_progress');
    if (!statusEl || !progressEl) return;

    if (isProcessing) {
        statusEl.textContent = 'Generating...';
        statusEl.className = 'st-pd-status generating';
        progressEl.textContent = `Round ${settings.currentRound} / ${settings.rounds}`;
    } else if (settings.running) {
        statusEl.textContent = 'Running';
        statusEl.className = 'st-pd-status running';
        progressEl.textContent = `Round ${settings.currentRound} / ${settings.rounds}`;
    } else {
        statusEl.textContent = 'Stopped';
        statusEl.className = 'st-pd-status stopped';
        progressEl.textContent = settings.currentRound > 0
            ? `Completed ${settings.currentRound} / ${settings.rounds}`
            : '';
    }
}

function populatePresetDropdown(settings) {
    const select = document.getElementById('st_pd_preset_select');
    if (!select) return;
    const names = getPresetNames(settings);
    select.innerHTML = '';
    for (const name of names) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        if (name === settings.selectedPreset) opt.selected = true;
        select.appendChild(opt);
    }
}

function loadPresetToEditor(settings) {
    const preset = getCurrentPreset(settings);
    const textarea = document.getElementById('st_pd_system_prompt');
    if (textarea && preset) {
        textarea.value = preset.system_prompt || '';
    } else if (textarea) {
        textarea.value = '';
    }
}

// ---- API Config Helpers ----

const API_CONFIG_FIELDS = ['connectionMode', 'apiType', 'apiUrl', 'apiKey', 'model', 'temperature', 'maxTokens', 'contextLength'];

function applyApiTemplate(settings, templateKey) {
    const template = API_TEMPLATES[templateKey];
    if (!template) return;

    settings.connectionMode = template.connectionMode;
    settings.apiType = template.apiType;
    settings.apiUrl = template.apiUrl;
    settings.model = template.model;
    settings.temperature = template.temperature;
    settings.maxTokens = template.maxTokens;

    // 清空 API Key（避免误用旧的 Key）
    settings.apiKey = '';

    // 更新 UI
    document.getElementById('st_pd_connection_mode').value = template.connectionMode;
    document.getElementById('st_pd_api_type').value = template.apiType;
    document.getElementById('st_pd_api_url').value = template.apiUrl;
    document.getElementById('st_pd_model').value = template.model;
    document.getElementById('st_pd_temperature').value = template.temperature;
    document.getElementById('st_pd_max_tokens').value = template.maxTokens;
    document.getElementById('st_pd_api_key').value = '';

    saveSettings();
    toastr.success(`已应用 ${template.name} 模板，请填写 API Key`);
}

function populateApiConfigDropdown(settings) {
    const select = document.getElementById('st_pd_api_config_select');
    if (!select) return;
    const names = Object.keys(settings.apiConfigs || {});
    select.innerHTML = '';
    const emptyOpt = document.createElement('option');
    emptyOpt.value = '';
    emptyOpt.textContent = '-- No saved config --';
    select.appendChild(emptyOpt);
    for (const name of names) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        if (name === settings.selectedApiConfig) opt.selected = true;
        select.appendChild(opt);
    }
}

function loadApiConfigToUI(settings) {
    const config = settings.apiConfigs[settings.selectedApiConfig];
    if (!config) return;
    for (const key of API_CONFIG_FIELDS) {
        if (config[key] !== undefined) {
            settings[key] = config[key];
        }
    }
    const fieldMap = {
        connectionMode: 'st_pd_connection_mode',
        apiType: 'st_pd_api_type',
        apiUrl: 'st_pd_api_url',
        apiKey: 'st_pd_api_key',
        model: 'st_pd_model',
        temperature: 'st_pd_temperature',
        maxTokens: 'st_pd_max_tokens',
        contextLength: 'st_pd_context_length',
    };
    for (const [key, id] of Object.entries(fieldMap)) {
        const el = document.getElementById(id);
        if (el) el.value = settings[key];
    }
}

function extractApiConfig(settings) {
    const config = {};
    for (const key of API_CONFIG_FIELDS) {
        config[key] = settings[key];
    }
    return config;
}

// ---- Core Logic ----

function buildChatHistory(chat, settings, mode) {
    const recentChat = chat.slice(-settings.contextLength);
    const filtered = recentChat.filter(msg => !(msg.is_system && !msg.is_user));

    if (mode === 'text') {
        // Text mode: simple concatenation
        let chatText = '';
        for (const msg of filtered) {
            const name = msg.name || (msg.is_user ? 'User' : 'Character');
            chatText += `${name}: ${msg.mes}\n\n`;
        }
        return chatText.trim();
    }

    // Role mode: show role information
    let chatText = '';
    for (const msg of filtered) {
        const role = msg.is_user ? 'user' : 'assistant';
        const name = msg.name || (msg.is_user ? 'User' : 'Character');
        chatText += `[${role}] ${name}: ${msg.mes}\n\n`;
    }
    return chatText.trim();
}

function shouldInjectOutlineToLLM(settings) {
    if (!settings.outlineEnabled) return false;
    if (!settings.outline?.trim()) return false;

    const currentRound = settings.currentRound || 0;
    const maxRounds = settings.outlinePromptRounds || 999;

    return currentRound < maxRounds;
}

function buildMessages(settings) {
    const context = SillyTavern.getContext();
    const chat = context.chat || [];
    const preset = getCurrentPreset(settings);
    const pmConfig = preset?.prompt_manager || getDefaultPromptManagerConfig();

    // Collect all enabled block contents
    const contentParts = [];

    for (const block of pmConfig.blocks) {
        if (!block.enabled) continue;

        let blockContent = '';

        // Get actual content for each block
        switch (block.id) {
            case 'system_prompt':
                blockContent = preset?.system_prompt || '';
                break;

            case 'plot_outline':
                if (shouldInjectOutlineToLLM(settings)) {
                    blockContent = settings.outline || '';
                }
                break;

            case 'chat_history':
                blockContent = buildChatHistory(chat, settings, pmConfig.chatHistoryMode);
                break;

            case 'instruction':
                blockContent = block.content || '';
                break;

            default:
                // Custom blocks
                if (block.type === 'custom') {
                    blockContent = block.content || '';
                }
                break;
        }

        // Skip empty content
        if (!blockContent.trim()) continue;

        // Wrap with tag if tagName exists
        if (block.tagName && block.tagName.trim()) {
            const tagName = block.tagName.trim();
            blockContent = `<${tagName}>\n${blockContent}\n</${tagName}>`;
        }

        contentParts.push(blockContent);
    }

    // Merge all content into a single message
    const mergedContent = contentParts.join('\n\n');

    // Return single user message
    return [
        {
            role: 'user',
            content: mergedContent
        }
    ];
}

function applyRegexRules(messages, rules) {
    if (!rules || rules.length === 0) return messages;

    const activeRules = rules.filter(r => r.enabled && r.pattern);
    if (activeRules.length === 0) return messages;

    const compiled = [];
    for (const rule of activeRules) {
        try {
            compiled.push({ regex: new RegExp(rule.pattern, rule.flags || 'g'), replacement: rule.replacement || '', label: rule.label || rule.pattern });
        } catch (e) {
            log(`Invalid regex "${rule.pattern}" (${rule.label || 'unnamed'}): ${e.message}. Skipping.`, 'WARN');
        }
    }

    if (compiled.length === 0) return messages;

    return messages.map(m => {
        let content = m.content;
        for (const { regex, replacement } of compiled) {
            content = content.replace(regex, replacement);
        }
        return content !== m.content ? { ...m, content } : m;
    });
}

async function callDirectorLLM(settings, signal) {
    const context = SillyTavern.getContext();
    let messages = buildMessages(settings);

    messages = applyRegexRules(messages, settings.regexRules);

    showInputLog(messages);

    // 启动生成状态更新
    const startTime = Date.now();
    clearStatusInterval();
    statusUpdateInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        updateGeneratingStatus('🤖 导演 LLM 生成中...', elapsed);
    }, 1000);

    try {
        const options = { signal };
        let result;
        if (settings.connectionMode === 'proxy') {
            result = await generateViaProxy(messages, settings, context.getRequestHeaders, options);
        } else {
            result = await generateDirect(messages, settings, options);
        }
        clearStatusInterval();
        return result;
    } catch (error) {
        clearStatusInterval();
        throw error;
    }
}

async function sendAsUserAndGenerate(text) {
    const context = SillyTavern.getContext();
    const message = {
        name: context.name1,
        is_user: true,
        is_system: false,
        send_date: new Date().toISOString(),
        mes: text,
    };

    context.chat.push(message);
    context.addOneMessage(message);
    await context.saveChat();
    await context.generate('normal', { automatic_trigger: true });
}

async function showPreviewPopup(text) {
    const context = SillyTavern.getContext();
    const container = document.createElement('div');
    const label = document.createElement('p');
    label.innerHTML = '<b>Plot Director</b> generated the following direction:';
    const textarea = document.createElement('textarea');
    textarea.className = 'st-pd-preview-content text_pole';
    textarea.value = text;
    container.appendChild(label);
    container.appendChild(textarea);

    const popup = new context.Popup(container, context.POPUP_TYPE.CONFIRM, '', {
        okButton: 'Send',
        cancelButton: 'Skip',
        wide: true,
    });

    const result = await popup.show();

    if (result === context.Popup.RESULT?.AFFIRMATIVE || result === 1) {
        const ta = popup.dlg?.querySelector('.st-pd-preview-content');
        return ta ? ta.value : text;
    }

    return null;
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

async function onGenerationEnded() {
    const settings = getSettings();

    if (!settings.enabled || !settings.running) {
        return;
    }

    if (isProcessing) {
        log('Skipped: already processing a direction.');
        return;
    }

    if (settings.currentRound >= settings.rounds) {
        return;
    }

    await runDirectorRound();
}

async function runDirectorRound() {
    const settings = getSettings();

    if (!settings.running || isProcessing) return;
    if (settings.currentRound >= settings.rounds) {
        stopDirector(settings);
        return;
    }

    if (currentAbortController) {
        currentAbortController.abort();
    }
    currentAbortController = new AbortController();

    isProcessing = true;

    try {
        settings.currentRound++;
        log(`Round ${settings.currentRound}/${settings.rounds} - Starting...`);
        updateStatusUI(settings);
        saveSettings();

        // Wait for chatu8 to finish image tag generation
        if (settings.waitForChatu8) {
            await waitForChatu8Complete(settings);
        }

        if (!settings.running) {
            log('Director stopped before LLM call, skipping this round.');
            return;
        }

        log('Calling director LLM...');
        const direction = await callDirectorLLM(settings, currentAbortController.signal);

        if (!direction || !direction.trim()) {
            log('Director LLM returned empty response. Skipping this round.', 'WARN');
            toastr.warning('Director LLM returned empty response.');
            isProcessing = false;
            updateStatusUI(settings);
            return;
        }

        let finalText = direction.trim();
        log(`Director LLM responded (${finalText.length} chars).`);
        showLLMOutput(finalText);

        // Inject outline into direction if configured
        const shouldInjectOutline = settings.outlineEnabled
            && settings.outline?.trim()
            && settings.outlineInjectRounds > 0
            && settings.currentRound <= settings.outlineInjectRounds;

        if (shouldInjectOutline) {
            finalText = `[Plot Outline]\n${settings.outline.trim()}\n\n[Direction]\n${finalText}`;
            log(`Outline injected (round ${settings.currentRound} <= ${settings.outlineInjectRounds}).`);
        }

        if (settings.mode === 'preview') {
            log('Preview mode: waiting for user confirmation...');
            const edited = await showPreviewPopup(finalText);
            if (edited === null) {
                log('User skipped this round.');
                isProcessing = false;
                updateStatusUI(settings);
                if (settings.currentRound >= settings.rounds) {
                    stopDirector(settings);
                }
                return;
            }
            finalText = edited;
        }

        if (!settings.running) {
            log('Director stopped before sending user message, skipping send.');
            return;
        }

        log('Sending direction as user message...');
        const isLastRound = settings.currentRound >= settings.rounds;
        if (isLastRound) {
            log(`All ${settings.rounds} rounds completed.`);
        }

        isProcessing = false;
        updateStatusUI(settings);

        if (isLastRound) {
            stopDirector(settings);
        }

        await sendAsUserAndGenerate(finalText);
    } catch (err) {
        if (err.name === 'AbortError') {
            log('Director LLM request aborted.');
        } else {
            handleError(err, 'Plot Director');
        }
        isProcessing = false;
        stopDirector(settings);
    } finally {
        if (currentAbortController?.signal?.aborted) {
            currentAbortController = null;
        }
    }
}

async function startDirector(settings) {
    if (!settings.enabled) {
        toastr.warning('Please enable Plot Director first.');
        return;
    }

    const preset = getCurrentPreset(settings);
    if (!preset || !preset.system_prompt) {
        toastr.warning(ERROR_MESSAGES.NO_PRESET);
        return;
    }

    if (settings.connectionMode === 'direct') {
        if (!settings.apiUrl?.trim()) {
            toastr.warning('Please set an API URL for direct connection mode.');
            return;
        }
        if (!settings.model?.trim()) {
            toastr.warning(ERROR_MESSAGES.NO_MODEL);
            return;
        }
    } else if (!settings.model?.trim()) {
        toastr.warning('Please set a model name.');
        return;
    }

    settings.running = true;
    settings.currentRound = 0;
    isProcessing = false;
    updateStatusUI(settings);
    saveSettings();

    log(`Director started. Will run for ${settings.rounds} rounds.`);
    toastr.info('Plot Director started.');

    // Immediately kick off the first round
    await runDirectorRound();
}

function stopDirector(settings) {
    const wasRunning = settings.running;
    settings.running = false;
    isProcessing = false;
    if (currentAbortController) {
        currentAbortController.abort();
        currentAbortController = null;
    }
    updateStatusUI(settings);
    saveSettings();
    if (wasRunning) {
        log(`Director stopped. Completed ${settings.currentRound}/${settings.rounds} rounds.`);
        toastr.info('Plot Director stopped.');
    }
}

// ---- Prompt Manager UI ----

function getBlockContentPreview(block, settings) {
    const preset = getCurrentPreset(settings);
    switch (block.id) {
        case 'system_prompt':
            return preset?.system_prompt || '(empty)';
        case 'plot_outline':
            return settings.outline?.trim() || '(empty)';
        case 'chat_history':
            return '(recent chat messages)';
        case 'instruction':
            return block.content || '(empty)';
        default:
            return block.content || '(empty)';
    }
}

function isBlockContentEditable(block) {
    return block.id === 'instruction' || block.type === 'custom';
}

function renderPromptManager(settings) {
    const container = document.getElementById('st_pd_pm_block_list');
    if (!container) return;

    const preset = getCurrentPreset(settings);
    if (!preset) {
        container.innerHTML = '<div style="opacity:0.5;padding:8px;">No preset selected.</div>';
        return;
    }

    const pmConfig = preset.prompt_manager;
    container.innerHTML = '';

    // Update chatHistoryMode dropdown
    const modeSelect = document.getElementById('st_pd_chat_history_mode');
    if (modeSelect) {
        modeSelect.value = pmConfig.chatHistoryMode || 'role';
    }

    for (let i = 0; i < pmConfig.blocks.length; i++) {
        const block = pmConfig.blocks[i];
        const blockEl = document.createElement('div');
        blockEl.className = 'st-pd-pm-block' + (block.enabled ? '' : ' disabled');
        blockEl.draggable = true;
        blockEl.dataset.blockIndex = i;

        const roleClass = 'role-' + (block.role || 'user');
        const preview = getBlockContentPreview(block, settings);
        const previewText = preview.length > 50 ? preview.substring(0, 50) + '...' : preview;

        // Tag name display in header
        const tagDisplay = block.tagName
            ? `<span class="st-pd-pm-block-tag-display">&lt;${escapeHtml(block.tagName)}&gt;</span>`
            : '';

        let actionsHtml = '';
        if (block.type === 'fixed') {
            actionsHtml += '<i class="fa-solid fa-lock st-pd-pm-block-fixed-icon" title="Fixed block"></i>';
        }
        actionsHtml += `<input type="checkbox" class="st-pd-pm-block-toggle" ${block.enabled ? 'checked' : ''} title="Enable/Disable" />`;
        actionsHtml += '<i class="fa-solid fa-chevron-down st-pd-pm-block-expand" title="Expand/Collapse"></i>';
        if (block.type === 'custom') {
            actionsHtml += '<i class="fa-solid fa-trash st-pd-pm-block-delete" title="Delete block"></i>';
        }

        blockEl.innerHTML = `
            <div class="st-pd-pm-block-header">
                <i class="fa-solid fa-grip-vertical st-pd-pm-drag-handle"></i>
                <span class="st-pd-pm-block-role ${roleClass}">${block.role || 'user'}</span>
                <span class="st-pd-pm-block-label">${escapeHtml(block.label)}</span>
                ${tagDisplay}
                <span class="st-pd-pm-block-preview">${escapeHtml(previewText)}</span>
                <div class="st-pd-pm-block-actions">${actionsHtml}</div>
            </div>
            <div class="st-pd-pm-block-body st-pd-hidden"></div>
        `;

        // Build body content
        const body = blockEl.querySelector('.st-pd-pm-block-body');
        if (isBlockContentEditable(block)) {
            const textarea = document.createElement('textarea');
            textarea.className = 'text_pole';
            textarea.value = block.content || '';
            textarea.addEventListener('input', () => {
                block.content = textarea.value;
                saveSettings();
                // Update preview
                const previewEl = blockEl.querySelector('.st-pd-pm-block-preview');
                if (previewEl) {
                    const t = textarea.value || '(empty)';
                    previewEl.textContent = t.length > 50 ? t.substring(0, 50) + '...' : t;
                }
            });
            body.appendChild(textarea);
        } else {
            const previewDiv = document.createElement('div');
            previewDiv.className = 'st-pd-pm-block-content-preview';
            previewDiv.textContent = getBlockContentPreview(block, settings);
            body.appendChild(previewDiv);
        }

        // Add Tag Name input row
        const tagNameRow = document.createElement('div');
        tagNameRow.className = 'st-pd-pm-block-tag-row';

        const tagLabel = document.createElement('label');
        tagLabel.className = 'st-pd-pm-block-tag-label';
        tagLabel.textContent = 'Tag Name (optional):';
        tagNameRow.appendChild(tagLabel);

        const tagInput = document.createElement('input');
        tagInput.type = 'text';
        tagInput.className = 'st-pd-pm-block-tag-input text_pole';
        tagInput.value = block.tagName || '';
        tagInput.placeholder = 'e.g., history log, plot outline';
        tagInput.maxLength = 50;
        tagNameRow.appendChild(tagInput);

        tagInput.addEventListener('input', () => {
            block.tagName = tagInput.value;
            saveSettings();
            // Update tag display in header
            const tagDisplayEl = blockEl.querySelector('.st-pd-pm-block-tag-display');
            if (block.tagName && block.tagName.trim()) {
                if (tagDisplayEl) {
                    tagDisplayEl.textContent = `<${block.tagName.trim()}>`;
                } else {
                    const labelEl = blockEl.querySelector('.st-pd-pm-block-label');
                    const newTagDisplay = document.createElement('span');
                    newTagDisplay.className = 'st-pd-pm-block-tag-display';
                    newTagDisplay.textContent = `<${block.tagName.trim()}>`;
                    labelEl.insertAdjacentElement('afterend', newTagDisplay);
                }
            } else if (tagDisplayEl) {
                tagDisplayEl.remove();
            }
        });

        body.appendChild(tagNameRow);

        if (block.type === 'custom') {
            const roleSelect = document.createElement('select');
            roleSelect.className = 'st-pd-pm-block-role-select';
            for (const r of ['system', 'user', 'assistant']) {
                const opt = document.createElement('option');
                opt.value = r;
                opt.textContent = r;
                if (r === block.role) opt.selected = true;
                roleSelect.appendChild(opt);
            }
            roleSelect.addEventListener('change', () => {
                block.role = roleSelect.value;
                saveSettings();
                renderPromptManager(settings);
            });
            body.appendChild(roleSelect);
        }

        // Toggle enable/disable
        blockEl.querySelector('.st-pd-pm-block-toggle')?.addEventListener('change', (e) => {
            block.enabled = e.target.checked;
            blockEl.classList.toggle('disabled', !block.enabled);
            saveSettings();
            // Sync outline enabled state
            if (block.id === 'plot_outline') {
                settings.outlineEnabled = block.enabled;
                const outlineCheckbox = document.getElementById('st_pd_outline_enabled');
                if (outlineCheckbox) outlineCheckbox.checked = block.enabled;
            }
        });

        // Expand/collapse
        blockEl.querySelector('.st-pd-pm-block-expand')?.addEventListener('click', (e) => {
            body.classList.toggle('st-pd-hidden');
            e.target.classList.toggle('fa-chevron-down');
            e.target.classList.toggle('fa-chevron-up');
        });

        // Delete custom block
        blockEl.querySelector('.st-pd-pm-block-delete')?.addEventListener('click', () => {
            pmConfig.blocks.splice(i, 1);
            saveSettings();
            renderPromptManager(settings);
        });

        // Drag-and-drop events
        blockEl.addEventListener('dragstart', (e) => {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', String(i));
            blockEl.classList.add('dragging');
        });

        blockEl.addEventListener('dragend', () => {
            blockEl.classList.remove('dragging');
            container.querySelectorAll('.st-pd-pm-block').forEach(el => {
                el.classList.remove('drag-over-top', 'drag-over-bottom');
            });
        });

        blockEl.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            const rect = blockEl.getBoundingClientRect();
            const midY = rect.top + rect.height / 2;
            blockEl.classList.remove('drag-over-top', 'drag-over-bottom');
            if (e.clientY < midY) {
                blockEl.classList.add('drag-over-top');
            } else {
                blockEl.classList.add('drag-over-bottom');
            }
        });

        blockEl.addEventListener('dragleave', () => {
            blockEl.classList.remove('drag-over-top', 'drag-over-bottom');
        });

        blockEl.addEventListener('drop', (e) => {
            e.preventDefault();
            blockEl.classList.remove('drag-over-top', 'drag-over-bottom');
            const fromIndex = parseInt(e.dataTransfer.getData('text/plain'));
            if (isNaN(fromIndex) || fromIndex === i) return;

            const rect = blockEl.getBoundingClientRect();
            const midY = rect.top + rect.height / 2;
            let toIndex = e.clientY < midY ? i : i + 1;

            // Adjust index if dragging from before the drop target
            if (fromIndex < toIndex) toIndex--;

            const [moved] = pmConfig.blocks.splice(fromIndex, 1);
            pmConfig.blocks.splice(toIndex, 0, moved);
            saveSettings();
            renderPromptManager(settings);
        });

        container.appendChild(blockEl);
    }
}

function bindPromptManagerUI(settings) {
    // Chat history mode
    const modeSelect = document.getElementById('st_pd_chat_history_mode');
    modeSelect?.addEventListener('change', () => {
        const preset = getCurrentPreset(settings);
        if (preset?.prompt_manager) {
            preset.prompt_manager.chatHistoryMode = modeSelect.value;
            saveSettings();
        }
    });

    // Add custom block
    document.getElementById('st_pd_pm_add_block')?.addEventListener('click', async () => {
        const context = SillyTavern.getContext();
        const result = await context.callGenericPopup('Enter block label:', context.POPUP_TYPE.INPUT);
        if (!result || typeof result !== 'string' || !result.trim()) return;

        const preset = getCurrentPreset(settings);
        if (!preset?.prompt_manager) return;

        const newBlock = {
            id: `custom_${Date.now()}`,
            type: 'custom',
            role: 'user',
            label: result.trim(),
            enabled: true,
            content: '',
            tagName: '',
        };

        preset.prompt_manager.blocks.push(newBlock);
        saveSettings();
        renderPromptManager(settings);
        toastr.success(`Block "${result.trim()}" added.`);
    });

    // 添加基础模板按钮
    document.getElementById('st_pd_pm_add_template')?.addEventListener('click', async () => {
        const preset = getCurrentPreset(settings);
        if (!preset?.prompt_manager) return;

        // 检查是否已有基础块
        const hasSystemPrompt = preset.prompt_manager.blocks.some(b => b.id === 'system_prompt');
        const hasChatHistory = preset.prompt_manager.blocks.some(b => b.id === 'chat_history');
        const hasPlotOutline = preset.prompt_manager.blocks.some(b => b.id === 'plot_outline');

        if (hasSystemPrompt && hasChatHistory && hasPlotOutline) {
            toastr.info('基础模板块已存在');
            return;
        }

        // 如果有自定义块，警告用户
        const hasCustomBlocks = preset.prompt_manager.blocks.some(b => b.type === 'custom');
        if (hasCustomBlocks) {
            const context = SillyTavern.getContext();
            const confirmed = await context.callGenericPopup(
                '应用基础模板将清空所有现有块（包括自定义块）。是否继续？',
                context.POPUP_TYPE.CONFIRM
            );
            if (confirmed !== 1 && confirmed !== true) {
                return;
            }
        }

        // 清空现有块并添加基础模板
        preset.prompt_manager.blocks = [
            {
                id: 'system_prompt',
                type: 'fixed',
                role: 'system',
                label: 'System Prompt',
                enabled: true,
                content: null,
                tagName: '',
            },
            {
                id: 'chat_history',
                type: 'fixed',
                role: 'special',
                label: 'Chat History',
                enabled: true,
                content: null,
                tagName: 'history log',
            },
            {
                id: 'plot_outline',
                type: 'fixed',
                role: 'system',
                label: 'Plot Outline',
                enabled: false,
                content: null,
                tagName: 'plot outline',
            },
        ];

        saveSettings();
        renderPromptManager(settings);
        toastr.success('已应用基础 Prompt 模板');
    });

    // Sync outline checkbox -> prompt manager block
    const outlineCheckbox = document.getElementById('st_pd_outline_enabled');
    if (outlineCheckbox) {
        outlineCheckbox.addEventListener('change', () => {
            settings.outlineEnabled = outlineCheckbox.checked;
            const preset = getCurrentPreset(settings);
            if (preset?.prompt_manager) {
                const outlineBlock = preset.prompt_manager.blocks.find(b => b.id === 'plot_outline');
                if (outlineBlock) {
                    outlineBlock.enabled = outlineCheckbox.checked;
                }
            }
            saveSettings();
            renderPromptManager(settings);
        });
    }

    renderPromptManager(settings);
}

// ---- Regex Filters UI ----

function renderRegexRules(settings) {
    const container = document.getElementById('st_pd_regex_rule_list');
    if (!container) return;

    if (!settings.regexRules) settings.regexRules = [];
    const rules = settings.regexRules;

    container.innerHTML = '';

    for (let i = 0; i < rules.length; i++) {
        const rule = rules[i];
        const ruleEl = document.createElement('div');
        ruleEl.className = 'st-pd-regex-rule' + (rule.enabled ? '' : ' disabled');
        ruleEl.draggable = true;
        ruleEl.dataset.ruleIndex = i;

        const displayLabel = rule.label || (rule.pattern ? `/${rule.pattern}/${rule.flags || ''}` : '(empty rule)');

        ruleEl.innerHTML = `
            <div class="st-pd-regex-rule-header">
                <i class="fa-solid fa-grip-vertical st-pd-regex-drag-handle"></i>
                <span class="st-pd-regex-rule-label">${escapeHtml(displayLabel)}</span>
                <div class="st-pd-regex-rule-actions">
                    <input type="checkbox" class="st-pd-regex-rule-toggle" ${rule.enabled ? 'checked' : ''} title="Enable/Disable" />
                    <i class="fa-solid fa-chevron-down st-pd-regex-rule-expand" title="Expand/Collapse"></i>
                    <i class="fa-solid fa-trash st-pd-regex-rule-delete" title="Delete rule"></i>
                </div>
            </div>
            <div class="st-pd-regex-rule-body st-pd-hidden">
                <div class="st-pd-row">
                    <label>Label</label>
                    <input type="text" class="st-pd-regex-input-label" value="${escapeHtml(rule.label || '')}" placeholder="Optional name" />
                </div>
                <div class="st-pd-row">
                    <label>Pattern</label>
                    <input type="text" class="st-pd-regex-input-pattern" value="${escapeHtml(rule.pattern || '')}" placeholder="Regular expression" />
                </div>
                <div class="st-pd-row">
                    <label>Flags</label>
                    <input type="text" class="st-pd-regex-input-flags" value="${escapeHtml(rule.flags || 'g')}" placeholder="g" style="max-width:80px;" />
                </div>
                <div class="st-pd-row">
                    <label>Replace</label>
                    <input type="text" class="st-pd-regex-input-replacement" value="${escapeHtml(rule.replacement || '')}" placeholder="(empty = delete)" />
                </div>
            </div>
        `;

        // Toggle enable/disable
        ruleEl.querySelector('.st-pd-regex-rule-toggle')?.addEventListener('change', (e) => {
            rule.enabled = e.target.checked;
            ruleEl.classList.toggle('disabled', !rule.enabled);
            saveSettings();
        });

        // Expand/collapse
        ruleEl.querySelector('.st-pd-regex-rule-expand')?.addEventListener('click', (e) => {
            const body = ruleEl.querySelector('.st-pd-regex-rule-body');
            body.classList.toggle('st-pd-hidden');
            e.target.classList.toggle('fa-chevron-down');
            e.target.classList.toggle('fa-chevron-up');
        });

        // Delete
        ruleEl.querySelector('.st-pd-regex-rule-delete')?.addEventListener('click', () => {
            rules.splice(i, 1);
            saveSettings();
            renderRegexRules(settings);
        });

        // Input bindings
        const labelInput = ruleEl.querySelector('.st-pd-regex-input-label');
        labelInput?.addEventListener('input', () => {
            rule.label = labelInput.value;
            const labelEl = ruleEl.querySelector('.st-pd-regex-rule-label');
            if (labelEl) {
                labelEl.textContent = rule.label || (rule.pattern ? `/${rule.pattern}/${rule.flags || ''}` : '(empty rule)');
            }
            saveSettings();
        });

        const patternInput = ruleEl.querySelector('.st-pd-regex-input-pattern');
        patternInput?.addEventListener('input', () => {
            rule.pattern = patternInput.value;
            if (!rule.label) {
                const labelEl = ruleEl.querySelector('.st-pd-regex-rule-label');
                if (labelEl) {
                    labelEl.textContent = rule.pattern ? `/${rule.pattern}/${rule.flags || ''}` : '(empty rule)';
                }
            }
            saveSettings();
        });
        patternInput?.addEventListener('blur', () => {
            if (!patternInput.value) {
                patternInput.classList.remove('st-pd-regex-invalid');
                return;
            }
            try {
                new RegExp(patternInput.value, rule.flags || 'g');
                patternInput.classList.remove('st-pd-regex-invalid');
            } catch {
                patternInput.classList.add('st-pd-regex-invalid');
            }
        });

        const flagsInput = ruleEl.querySelector('.st-pd-regex-input-flags');
        flagsInput?.addEventListener('input', () => {
            rule.flags = flagsInput.value;
            if (!rule.label) {
                const labelEl = ruleEl.querySelector('.st-pd-regex-rule-label');
                if (labelEl) {
                    labelEl.textContent = rule.pattern ? `/${rule.pattern}/${rule.flags || ''}` : '(empty rule)';
                }
            }
            saveSettings();
        });

        const replacementInput = ruleEl.querySelector('.st-pd-regex-input-replacement');
        replacementInput?.addEventListener('input', () => {
            rule.replacement = replacementInput.value;
            saveSettings();
        });

        // Drag-and-drop events
        ruleEl.addEventListener('dragstart', (e) => {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', String(i));
            ruleEl.classList.add('dragging');
        });

        ruleEl.addEventListener('dragend', () => {
            ruleEl.classList.remove('dragging');
            container.querySelectorAll('.st-pd-regex-rule').forEach(el => {
                el.classList.remove('drag-over-top', 'drag-over-bottom');
            });
        });

        ruleEl.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            const rect = ruleEl.getBoundingClientRect();
            const midY = rect.top + rect.height / 2;
            ruleEl.classList.remove('drag-over-top', 'drag-over-bottom');
            if (e.clientY < midY) {
                ruleEl.classList.add('drag-over-top');
            } else {
                ruleEl.classList.add('drag-over-bottom');
            }
        });

        ruleEl.addEventListener('dragleave', () => {
            ruleEl.classList.remove('drag-over-top', 'drag-over-bottom');
        });

        ruleEl.addEventListener('drop', (e) => {
            e.preventDefault();
            const fromIdx = parseInt(e.dataTransfer.getData('text/plain'), 10);
            const rect = ruleEl.getBoundingClientRect();
            const midY = rect.top + rect.height / 2;
            let toIdx = e.clientY < midY ? i : i + 1;
            if (fromIdx < toIdx) toIdx--;
            if (fromIdx !== toIdx && fromIdx >= 0 && fromIdx < rules.length) {
                const [moved] = rules.splice(fromIdx, 1);
                rules.splice(toIdx, 0, moved);
                saveSettings();
                renderRegexRules(settings);
            }
            ruleEl.classList.remove('drag-over-top', 'drag-over-bottom');
        });

        container.appendChild(ruleEl);
    }
}

function bindRegexUI(settings) {
    document.getElementById('st_pd_regex_add_rule')?.addEventListener('click', () => {
        if (!settings.regexRules) settings.regexRules = [];
        settings.regexRules.push({
            id: 'regex_' + Date.now(),
            enabled: true,
            label: '',
            pattern: '',
            flags: 'g',
            replacement: '',
        });
        saveSettings();
        renderRegexRules(settings);
    });

    // 添加示例按钮
    document.getElementById('st_pd_regex_add_examples')?.addEventListener('click', () => {
        if (!settings.regexRules) settings.regexRules = [];

        // 检查是否已存在相同 pattern 的规则
        const existingPatterns = new Set(settings.regexRules.map(r => r.pattern));
        const newExamples = REGEX_EXAMPLES.filter(ex => !existingPatterns.has(ex.pattern));

        if (newExamples.length === 0) {
            toastr.info('所有示例规则已存在');
            return;
        }

        // 添加新示例规则
        for (const example of newExamples) {
            settings.regexRules.push({
                id: 'regex_' + Date.now() + '_' + Math.random(),
                ...example,
            });
        }

        saveSettings();
        renderRegexRules(settings);
        toastr.success(`已添加 ${newExamples.length} 个新示例`);
    });

    renderRegexRules(settings);
}

// ---- Settings Panel Binding ----

function bindSettingsUI(settings) {
    const enabledEl = document.getElementById('st_pd_enabled');
    if (enabledEl) {
        enabledEl.checked = settings.enabled;
        enabledEl.addEventListener('change', () => {
            settings.enabled = enabledEl.checked;
            saveSettings();
        });
    }

    const modeEl = document.getElementById('st_pd_mode');
    if (modeEl) {
        modeEl.value = settings.mode;
        modeEl.addEventListener('change', () => {
            settings.mode = modeEl.value;
            saveSettings();
        });
    }

    const roundsEl = document.getElementById('st_pd_rounds');
    if (roundsEl) {
        roundsEl.value = settings.rounds;
        roundsEl.addEventListener('change', () => {
            settings.rounds = parseInt(roundsEl.value) || 5;
            saveSettings();
        });
    }

    document.getElementById('st_pd_start')?.addEventListener('click', () => startDirector(settings));
    document.getElementById('st_pd_stop')?.addEventListener('click', () => stopDirector(settings));

    // chatu8 wait
    const waitChatu8El = document.getElementById('st_pd_wait_chatu8');
    if (waitChatu8El) {
        waitChatu8El.checked = settings.waitForChatu8;
        waitChatu8El.addEventListener('change', () => {
            settings.waitForChatu8 = waitChatu8El.checked;
            saveSettings();
        });
    }

    const chatu8TimeoutEl = document.getElementById('st_pd_chatu8_timeout');
    if (chatu8TimeoutEl) {
        chatu8TimeoutEl.value = settings.chatu8Timeout;
        chatu8TimeoutEl.addEventListener('change', () => {
            settings.chatu8Timeout = parseInt(chatu8TimeoutEl.value) || 300;
            saveSettings();
        });
    }

    const chatu8StartEl = document.getElementById('st_pd_chatu8_start_timeout');
    if (chatu8StartEl) {
        chatu8StartEl.value = settings.chatu8StartTimeout;
        chatu8StartEl.addEventListener('change', () => {
            settings.chatu8StartTimeout = parseInt(chatu8StartEl.value) || 15;
            saveSettings();
        });
    }

    const connEl = document.getElementById('st_pd_connection_mode');
    if (connEl) {
        connEl.value = settings.connectionMode;
        connEl.addEventListener('change', () => {
            settings.connectionMode = connEl.value;
            saveSettings();
        });
    }

    const apiTypeEl = document.getElementById('st_pd_api_type');
    if (apiTypeEl) {
        apiTypeEl.value = settings.apiType;
        apiTypeEl.addEventListener('change', () => {
            settings.apiType = apiTypeEl.value;
            saveSettings();
        });
    }

    const apiUrlEl = document.getElementById('st_pd_api_url');
    if (apiUrlEl) {
        apiUrlEl.value = settings.apiUrl;
        apiUrlEl.addEventListener('input', () => {
            settings.apiUrl = apiUrlEl.value;
            saveSettings();
        });
    }

    const apiKeyEl = document.getElementById('st_pd_api_key');
    if (apiKeyEl) {
        apiKeyEl.value = settings.apiKey;
        apiKeyEl.addEventListener('input', () => {
            settings.apiKey = apiKeyEl.value;
            saveSettings();
        });
    }

    document.getElementById('st_pd_toggle_key')?.addEventListener('click', () => {
        if (apiKeyEl) {
            apiKeyEl.type = apiKeyEl.type === 'password' ? 'text' : 'password';
        }
    });

    const modelEl = document.getElementById('st_pd_model');
    if (modelEl) {
        modelEl.value = settings.model;
        modelEl.addEventListener('input', () => {
            settings.model = modelEl.value;
            saveSettings();
        });
    }

    const tempEl = document.getElementById('st_pd_temperature');
    if (tempEl) {
        tempEl.value = settings.temperature;
        tempEl.addEventListener('change', () => {
            settings.temperature = parseFloat(tempEl.value) || 0.8;
            saveSettings();
        });
    }

    const maxTokEl = document.getElementById('st_pd_max_tokens');
    if (maxTokEl) {
        maxTokEl.value = settings.maxTokens;
        maxTokEl.addEventListener('change', () => {
            settings.maxTokens = parseInt(maxTokEl.value) || 300;
            saveSettings();
        });
    }

    const ctxLenEl = document.getElementById('st_pd_context_length');
    if (ctxLenEl) {
        ctxLenEl.value = settings.contextLength;
        ctxLenEl.addEventListener('change', () => {
            settings.contextLength = parseInt(ctxLenEl.value) || 20;
            saveSettings();
        });
    }

    // API Config management
    populateApiConfigDropdown(settings);

    // API 模板选择
    document.getElementById('st_pd_api_template')?.addEventListener('change', (e) => {
        const templateKey = e.target.value;
        if (templateKey) {
            applyApiTemplate(settings, templateKey);
            e.target.value = ''; // 重置选择
        }
    });

    document.getElementById('st_pd_api_config_select')?.addEventListener('change', (e) => {
        settings.selectedApiConfig = e.target.value;
        if (settings.selectedApiConfig) {
            loadApiConfigToUI(settings);
        }
        saveSettings();
    });

    document.getElementById('st_pd_api_config_save')?.addEventListener('click', async () => {
        const context = SillyTavern.getContext();
        const result = await context.callGenericPopup('Enter a name for this API configuration:', context.POPUP_TYPE.INPUT);
        if (!result || typeof result !== 'string' || !result.trim()) return;
        const trimmed = result.trim();
        if (!settings.apiConfigs) settings.apiConfigs = {};
        settings.apiConfigs[trimmed] = extractApiConfig(settings);
        settings.selectedApiConfig = trimmed;
        populateApiConfigDropdown(settings);
        saveSettings();
        toastr.success(`API config "${trimmed}" saved.`);
    });

    document.getElementById('st_pd_api_config_delete')?.addEventListener('click', async () => {
        const context = SillyTavern.getContext();
        const name = settings.selectedApiConfig;
        if (!name) {
            toastr.warning('No API config selected.');
            return;
        }
        const confirmResult = await context.callGenericPopup(
            `Delete API config "${name}"?`,
            context.POPUP_TYPE.CONFIRM,
        );
        if (confirmResult !== 1 && confirmResult !== true) return;
        delete settings.apiConfigs[name];
        const remaining = Object.keys(settings.apiConfigs);
        settings.selectedApiConfig = remaining.length > 0 ? remaining[0] : '';
        populateApiConfigDropdown(settings);
        if (settings.selectedApiConfig) {
            loadApiConfigToUI(settings);
        }
        saveSettings();
        toastr.success(`API config "${name}" deleted.`);
    });

    document.getElementById('st_pd_test_connection')?.addEventListener('click', async () => {
        const context = SillyTavern.getContext();
        const btn = document.getElementById('st_pd_test_connection');

        log('测试 API 连接...');
        toastr.info('测试连接中...');

        // 禁用按钮
        if (btn) {
            btn.disabled = true;
            btn.style.opacity = '0.5';
        }

        const startTime = Date.now();
        const result = await testConnection(settings, context.getRequestHeaders);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

        // 恢复按钮
        if (btn) {
            btn.disabled = false;
            btn.style.opacity = '1';
        }

        if (result.success) {
            log(`连接测试成功 (${elapsed}s): ${result.message}`);
            toastr.success(`连接成功！延迟: ${elapsed}s`);
        } else {
            handleError(new Error(result.message), '连接测试');
        }
    });

    const outlineEnabledEl = document.getElementById('st_pd_outline_enabled');
    if (outlineEnabledEl) {
        outlineEnabledEl.checked = settings.outlineEnabled;
        // Change listener is handled by bindPromptManagerUI for bidirectional sync
    }

    const outlineEl = document.getElementById('st_pd_outline');
    if (outlineEl) {
        outlineEl.value = settings.outline;
        outlineEl.addEventListener('input', () => {
            settings.outline = outlineEl.value;
            saveSettings();
        });
    }

    // Outline prompt rounds (inject to LLM)
    const outlinePromptRoundsEl = document.getElementById('st_pd_outline_prompt_rounds');
    if (outlinePromptRoundsEl) {
        outlinePromptRoundsEl.value = settings.outlinePromptRounds ?? 999; // 向后兼容
        outlinePromptRoundsEl.addEventListener('change', () => {
            settings.outlinePromptRounds = parseInt(outlinePromptRoundsEl.value) || 0;
            saveSettings();
        });
    }

    const outlineInjectEl = document.getElementById('st_pd_outline_inject_rounds');
    if (outlineInjectEl) {
        outlineInjectEl.value = settings.outlineInjectRounds;
        outlineInjectEl.addEventListener('change', () => {
            settings.outlineInjectRounds = parseInt(outlineInjectEl.value) || 0;
            saveSettings();
        });
    }

    // Log buttons
    document.getElementById('st_pd_log_export')?.addEventListener('click', () => {
        if (logEntries.length === 0) {
            toastr.info('No log entries to export.');
            return;
        }
        const blob = new Blob([logEntries.join('\n')], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `plot-director-log-${new Date().toISOString().replace(/:/g, '-')}.txt`;
        a.click();
        URL.revokeObjectURL(url);
        log('Log exported.');
    });

    document.getElementById('st_pd_log_clear')?.addEventListener('click', () => {
        logEntries.length = 0;
        updateLogDisplay();
        toastr.info('Log cleared.');
    });

    // 日志过滤按钮
    document.getElementById('st_pd_log_filter_all')?.addEventListener('click', () => {
        currentLogFilter = 'all';
        updateLogDisplay();
        updateLogFilterButtons();
    });

    document.getElementById('st_pd_log_filter_warn')?.addEventListener('click', () => {
        currentLogFilter = 'warn';
        updateLogDisplay();
        updateLogFilterButtons();
    });

    document.getElementById('st_pd_log_filter_error')?.addEventListener('click', () => {
        currentLogFilter = 'error';
        updateLogDisplay();
        updateLogFilterButtons();
    });

    function updateLogFilterButtons() {
        const allBtn = document.getElementById('st_pd_log_filter_all');
        const warnBtn = document.getElementById('st_pd_log_filter_warn');
        const errorBtn = document.getElementById('st_pd_log_filter_error');

        if (allBtn) allBtn.style.opacity = currentLogFilter === 'all' ? '1' : '0.6';
        if (warnBtn) warnBtn.style.opacity = currentLogFilter === 'warn' ? '1' : '0.6';
        if (errorBtn) errorBtn.style.opacity = currentLogFilter === 'error' ? '1' : '0.6';
    }

    updateLogFilterButtons();

    // Preset management
    bindPresetUI(settings);

    // Prompt Manager
    bindPromptManagerUI(settings);

    // Regex Filters
    bindRegexUI(settings);
}

function bindPresetUI(settings) {
    const selectEl = document.getElementById('st_pd_preset_select');
    const promptEl = document.getElementById('st_pd_system_prompt');

    populatePresetDropdown(settings);
    loadPresetToEditor(settings);

    selectEl?.addEventListener('change', () => {
        const newPreset = selectEl.value;
        if (!confirmSwitchPreset(newPreset)) {
            selectEl.value = settings.selectedPreset; // 恢复原选择
            return;
        }
        settings.selectedPreset = newPreset;
        loadPresetToEditor(settings);
        renderPromptManager(settings);
        saveSettings();
        markConfigAsSaved();
    });

    promptEl?.addEventListener('input', () => {
        markConfigAsChanged();
        const preset = getCurrentPreset(settings);
        if (preset) {
            preset.system_prompt = promptEl.value;
            saveSettings();
        }
    });

    document.getElementById('st_pd_preset_new')?.addEventListener('click', async () => {
        const context = SillyTavern.getContext();
        const result = await context.callGenericPopup('Enter preset name:', context.POPUP_TYPE.INPUT);
        if (result && typeof result === 'string' && result.trim()) {
            const name = result.trim();
            savePreset(settings, name, {
                system_prompt: '',
                temperature: settings.temperature,
                max_tokens: settings.maxTokens,
                model: '',
                prompt_manager: getDefaultPromptManagerConfig(),
            });
            settings.selectedPreset = name;
            populatePresetDropdown(settings);
            loadPresetToEditor(settings);
            renderPromptManager(settings);
            saveSettings();
            toastr.success(`Preset "${name}" created.`);
        }
    });

    document.getElementById('st_pd_preset_delete')?.addEventListener('click', async () => {
        const context = SillyTavern.getContext();
        if (!settings.selectedPreset) return;
        const confirm = await context.callGenericPopup(
            `Delete preset "${settings.selectedPreset}"?`,
            context.POPUP_TYPE.CONFIRM,
        );
        if (confirm === 1 || confirm === true) {
            deletePreset(settings, settings.selectedPreset);
            populatePresetDropdown(settings);
            loadPresetToEditor(settings);
            renderPromptManager(settings);
            saveSettings();
            toastr.success('Preset deleted.');
        }
    });

    document.getElementById('st_pd_preset_import')?.addEventListener('click', async () => {
        try {
            const context = SillyTavern.getContext();
            const preset = await importPreset();
            const name = preset.name || 'Imported Preset';
            if (settings.presets[name]) {
                const confirmResult = await context.callGenericPopup(
                    `Preset "${name}" already exists. Overwrite?`,
                    context.POPUP_TYPE.CONFIRM,
                );
                if (confirmResult !== 1 && confirmResult !== true) return;
            }
            savePreset(settings, name, preset);
            settings.selectedPreset = name;
            populatePresetDropdown(settings);
            loadPresetToEditor(settings);
            renderPromptManager(settings);
            saveSettings();
            toastr.success(`Preset "${name}" imported.`);
        } catch (err) {
            if (err.message !== 'File selection cancelled') {
                toastr.error(err.message);
            }
        }
    });

    document.getElementById('st_pd_preset_export')?.addEventListener('click', () => {
        const preset = getCurrentPreset(settings);
        if (preset) {
            exportPreset(preset);
        } else {
            toastr.warning('No preset selected.');
        }
    });

    // Save preset
    document.getElementById('st_pd_preset_save')?.addEventListener('click', () => {
        const preset = getCurrentPreset(settings);
        if (preset && promptEl) {
            preset.system_prompt = promptEl.value;
            saveSettings();
            renderPromptManager(settings);
            markConfigAsSaved();
            toastr.success(`Preset "${settings.selectedPreset}" saved.`);
        } else {
            toastr.warning('No preset selected.');
        }
    });
}

// ---- Tab System ----

function initTabSystem() {
    const tabs = document.querySelectorAll('.st-pd-tab');
    const tabContents = document.querySelectorAll('.st-pd-tab-content');

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const tabName = tab.dataset.tab;

            // 移除所有 active 类
            tabs.forEach(t => t.classList.remove('active'));
            tabContents.forEach(tc => tc.classList.remove('active'));

            // 添加 active 类到当前标签
            tab.classList.add('active');
            const targetContent = document.querySelector(`[data-tab-content="${tabName}"]`);
            if (targetContent) {
                targetContent.classList.add('active');
            }

            // 保存状态
            const settings = getSettings();
            if (!settings.uiState) {
                settings.uiState = { activeTab: 'basic', collapsedSections: {} };
            }
            settings.uiState.activeTab = tabName;
            saveSettings();
        });
    });

    // 恢复上次的标签页
    const settings = getSettings();
    const activeTab = settings.uiState?.activeTab || 'basic';
    const activeTabEl = document.querySelector(`[data-tab="${activeTab}"]`);
    if (activeTabEl) {
        activeTabEl.click();
    }
}

// ---- Collapsible Sections ----

function initCollapsibleSections() {
    const headers = document.querySelectorAll('.st-pd-section-header[data-collapsible="true"]');

    headers.forEach(header => {
        header.addEventListener('click', () => {
            const section = header.closest('.st-pd-section');
            const sectionId = section.dataset.sectionId;

            // 切换折叠状态
            section.classList.toggle('collapsed');

            // 保存状态
            const settings = getSettings();
            if (!settings.uiState) {
                settings.uiState = { activeTab: 'basic', collapsedSections: {} };
            }
            if (!settings.uiState.collapsedSections) {
                settings.uiState.collapsedSections = {};
            }
            settings.uiState.collapsedSections[sectionId] =
                section.classList.contains('collapsed');
            saveSettings();
        });
    });

    // 恢复折叠状态
    const settings = getSettings();
    const collapsed = settings.uiState?.collapsedSections || {};
    Object.entries(collapsed).forEach(([sectionId, isCollapsed]) => {
        if (isCollapsed) {
            const section = document.querySelector(`[data-section-id="${sectionId}"]`);
            if (section) {
                section.classList.add('collapsed');
            }
        }
    });
}

// ---- Initialization ----

jQuery(async function () {
    try {
        const context = SillyTavern.getContext();
        const settings = getSettings();

        const extensionUrl = `scripts/extensions/${EXTENSION_FOLDER}`;

        await initPresets(settings, extensionUrl);
        saveSettings();

        const response = await fetch(`${extensionUrl}/settings.html`);
        if (!response.ok) {
            console.error('[PlotDirector] Failed to load settings HTML');
            toastr.error('Plot Director: Failed to load settings UI');
            return;
        }
        const html = await response.text();
        const container = document.getElementById('extensions_settings2');
        if (container) {
            const wrapper = document.createElement('div');
            wrapper.id = 'st_pd_container';
            wrapper.innerHTML = html;
            container.appendChild(wrapper);
        }

        bindSettingsUI(settings);
        updateStatusUI(settings);

        // 初始化标签页系统
        initTabSystem();

        // 初始化可折叠区域
        initCollapsibleSections();

        if (settings.running) {
            settings.running = false;
            settings.currentRound = 0;
            saveSettings();
            updateStatusUI(settings);
        }

        if (!eventsBound) {
            context.eventSource.on(context.eventTypes.GENERATION_ENDED, onGenerationEnded);
            eventsBound = true;
        }

        log('Extension loaded.');
    } catch (err) {
        console.error('[PlotDirector] Initialization failed:', err);
        toastr.error(`Plot Director initialization failed: ${err.message}`);
    }
});
