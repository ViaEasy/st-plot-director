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
    waitForChatu8: true,
    chatu8StartTimeout: 15,
    chatu8Timeout: 300,
    presets: {},
    selectedPreset: '',
    apiConfigs: {},
    selectedApiConfig: '',
});

let isProcessing = false;
let currentAbortController = null;
let eventsBound = false;

// ---- Logging ----

const MAX_LOG_ENTRIES = 500;
const logEntries = [];

function log(message) {
    const time = new Date().toLocaleTimeString();
    const entry = `[${time}] ${message}`;
    if (logEntries.length >= MAX_LOG_ENTRIES) {
        logEntries.shift();
    }
    logEntries.push(entry);
    const el = document.getElementById('st_pd_log');
    if (el) {
        // Append new entry instead of re-joining entire array
        if (el.value) {
            el.value += '\n' + entry;
        } else {
            el.value = entry;
        }
        el.scrollTop = el.scrollHeight;
    }
    console.log(`[PlotDirector] ${message}`);
}

function showLLMOutput(text) {
    const el = document.getElementById('st_pd_llm_output');
    if (el) el.value = text;
}

function showInputLog(messages) {
    const el = document.getElementById('st_pd_input_log');
    if (!el) return;
    const text = messages.map(m => `[${m.role}]\n${m.content}`).join('\n\n---\n\n');
    el.value = text;
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

    return new Promise((resolve) => {
        const observer = new MutationObserver(() => {
            if (!fab.classList.contains('st-chatu8-fab-loading')) {
                observer.disconnect();
                log(`chatu8 finished (${((Date.now() - startTime) / 1000).toFixed(1)}s).`);
                resolve();
            }
        });
        observer.observe(fab, { attributes: true, attributeFilter: ['class'] });

        // Also check immediately in case it already finished during setup
        if (!fab.classList.contains('st-chatu8-fab-loading')) {
            observer.disconnect();
            log(`chatu8 finished (${((Date.now() - startTime) / 1000).toFixed(1)}s).`);
            resolve();
            return;
        }

        setTimeout(() => {
            observer.disconnect();
            log('WARNING: chatu8 wait timed out, continuing anyway.');
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
        let chatText = '';
        for (const msg of filtered) {
            const name = msg.name || (msg.is_user ? 'User' : 'Character');
            chatText += `${name}: ${msg.mes}\n\n`;
        }
        return chatText.trim() ? [{ role: 'user', content: chatText.trim() }] : [];
    }

    // Role mode: preserve user/assistant roles, merge adjacent same-role
    const rawMessages = filtered.map(msg => ({
        role: msg.is_user ? 'user' : 'assistant',
        content: msg.mes,
    }));

    const merged = [];
    for (const msg of rawMessages) {
        if (merged.length > 0 && merged[merged.length - 1].role === msg.role) {
            merged[merged.length - 1].content += '\n\n' + msg.content;
        } else {
            merged.push({ ...msg });
        }
    }

    return merged;
}

function buildMessages(settings) {
    const context = SillyTavern.getContext();
    const chat = context.chat || [];
    const preset = getCurrentPreset(settings);
    const pmConfig = preset?.prompt_manager || getDefaultPromptManagerConfig();

    const messages = [];

    for (const block of pmConfig.blocks) {
        if (!block.enabled) continue;

        switch (block.id) {
            case 'system_prompt':
                if (preset?.system_prompt) {
                    messages.push({ role: 'system', content: preset.system_prompt });
                }
                break;

            case 'plot_outline':
                if (settings.outlineEnabled && settings.outline?.trim()) {
                    messages.push({
                        role: 'system',
                        content: `[Plot Outline]\n${settings.outline.trim()}`,
                    });
                }
                break;

            case 'chat_history': {
                const historyMessages = buildChatHistory(chat, settings, pmConfig.chatHistoryMode);
                messages.push(...historyMessages);
                break;
            }

            case 'instruction':
                if (block.content?.trim()) {
                    messages.push({ role: block.role || 'user', content: block.content.trim() });
                }
                break;

            default:
                // Custom blocks
                if (block.type === 'custom' && block.content?.trim()) {
                    messages.push({ role: block.role || 'user', content: block.content.trim() });
                }
                break;
        }
    }

    return messages;
}

async function callDirectorLLM(settings, signal) {
    const context = SillyTavern.getContext();
    const messages = buildMessages(settings);

    showInputLog(messages);

    const options = { signal };
    if (settings.connectionMode === 'proxy') {
        return await generateViaProxy(messages, settings, context.getRequestHeaders, options);
    } else {
        return await generateDirect(messages, settings, options);
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
            log('WARNING: Director LLM returned empty response. Skipping this round.');
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
            log(`ERROR: ${err.message}`);
            toastr.error(`Plot Director error: ${err.message}`);
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
        toastr.warning('Please select a preset with a system prompt.');
        return;
    }

    if (settings.connectionMode === 'direct') {
        if (!settings.apiUrl?.trim()) {
            toastr.warning('Please set an API URL for direct connection mode.');
            return;
        }
        if (!settings.model?.trim()) {
            toastr.warning('Please set a model name.');
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
            previewDiv.style.cssText = 'font-size:0.85em;opacity:0.7;white-space:pre-wrap;max-height:120px;overflow-y:auto;';
            previewDiv.textContent = getBlockContentPreview(block, settings);
            body.appendChild(previewDiv);
        }

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
        };

        preset.prompt_manager.blocks.push(newBlock);
        saveSettings();
        renderPromptManager(settings);
        toastr.success(`Block "${result.trim()}" added.`);
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
        log('Testing API connection...');
        toastr.info('Testing connection...');
        const result = await testConnection(settings, context.getRequestHeaders);
        if (result.success) {
            log(`Connection test OK: ${result.message}`);
            toastr.success(result.message);
        } else {
            log(`Connection test FAILED: ${result.message}`);
            toastr.error(result.message);
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
        const el = document.getElementById('st_pd_log');
        if (el) el.value = '';
        toastr.info('Log cleared.');
    });

    // Preset management
    bindPresetUI(settings);

    // Prompt Manager
    bindPromptManagerUI(settings);
}

function bindPresetUI(settings) {
    const selectEl = document.getElementById('st_pd_preset_select');
    const promptEl = document.getElementById('st_pd_system_prompt');

    populatePresetDropdown(settings);
    loadPresetToEditor(settings);

    selectEl?.addEventListener('change', () => {
        settings.selectedPreset = selectEl.value;
        loadPresetToEditor(settings);
        renderPromptManager(settings);
        saveSettings();
    });

    promptEl?.addEventListener('input', () => {
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
            toastr.success(`Preset "${settings.selectedPreset}" saved.`);
        } else {
            toastr.warning('No preset selected.');
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
