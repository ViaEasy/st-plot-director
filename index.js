/**
 * st-plot-director - SillyTavern Plot Director Extension
 *
 * Automatically generates plot directions after each AI response
 * and sends them as user messages to drive the narrative forward.
 */

import { generateViaProxy, generateDirect, testConnection } from './utils/api.js';
import {
    initPresets, getCurrentPreset, savePreset, deletePreset,
    exportPreset, importPreset, getPresetNames,
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
    waitForChatu8: true,
    chatu8Timeout: 300,
    presets: {},
    selectedPreset: '',
    apiConfigs: {},
    selectedApiConfig: '',
});

let isProcessing = false;

// ---- Logging ----

const logEntries = [];

function log(message) {
    const time = new Date().toLocaleTimeString();
    const entry = `[${time}] ${message}`;
    logEntries.push(entry);
    const el = document.getElementById('st_pd_log');
    if (el) {
        el.value = logEntries.join('\n');
        el.scrollTop = el.scrollHeight;
    }
    console.log(`[PlotDirector] ${message}`);
}

function showLLMOutput(text) {
    const el = document.getElementById('st_pd_llm_output');
    if (el) el.value = text;
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

    // Phase 1: Poll for up to 15s waiting for chatu8 to START (loading class appears)
    log('Waiting for chatu8 to start...');
    const pollStartLimit = 15000;
    let detected = false;
    while (Date.now() - startTime < pollStartLimit) {
        if (fab.classList.contains('st-chatu8-fab-loading')) {
            detected = true;
            break;
        }
        await delay(500);
    }

    if (!detected) {
        log('chatu8 did not start within 15s, continuing.');
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

function buildMessages(settings) {
    const context = SillyTavern.getContext();
    const chat = context.chat || [];
    const preset = getCurrentPreset(settings);

    const messages = [];

    if (preset && preset.system_prompt) {
        messages.push({ role: 'system', content: preset.system_prompt });
    }

    if (settings.outlineEnabled && settings.outline.trim()) {
        messages.push({
            role: 'system',
            content: `[Plot Outline]\n${settings.outline.trim()}`,
        });
    }

    const recentChat = chat.slice(-settings.contextLength);
    let chatText = '';
    for (const msg of recentChat) {
        if (msg.is_system && !msg.is_user) continue;
        const name = msg.name || (msg.is_user ? 'User' : 'Character');
        chatText += `${name}: ${msg.mes}\n\n`;
    }

    if (chatText) {
        messages.push({ role: 'user', content: chatText.trim() });
    }

    messages.push({
        role: 'user',
        content: 'Based on the conversation above, generate the next plot direction.',
    });

    return messages;
}

async function callDirectorLLM(settings) {
    const context = SillyTavern.getContext();
    const messages = buildMessages(settings);

    if (settings.connectionMode === 'proxy') {
        return await generateViaProxy(messages, settings, context.getRequestHeaders);
    } else {
        return await generateDirect(messages, settings);
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
    const html = `
        <div>
            <p><b>Plot Director</b> generated the following direction:</p>
            <textarea class="st-pd-preview-content text_pole">${escapeHtml(text)}</textarea>
        </div>
    `;

    const popup = new context.Popup(html, context.POPUP_TYPE.CONFIRM, '', {
        okButton: 'Send',
        cancelButton: 'Skip',
        wide: true,
    });

    const result = await popup.show();

    if (result === context.Popup.RESULT?.AFFIRMATIVE || result === 1) {
        const textarea = popup.dlg?.querySelector('.st-pd-preview-content');
        return textarea ? textarea.value : text;
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

        log('Calling director LLM...');
        const direction = await callDirectorLLM(settings);

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
        log(`ERROR: ${err.message}`);
        toastr.error(`Plot Director error: ${err.message}`);
        isProcessing = false;
        stopDirector(settings);
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
    updateStatusUI(settings);
    saveSettings();
    if (wasRunning) {
        log(`Director stopped. Completed ${settings.currentRound}/${settings.rounds} rounds.`);
        toastr.info('Plot Director stopped.');
    }
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

    document.getElementById('st_pd_api_config_save')?.addEventListener('click', () => {
        const name = prompt('Enter a name for this API configuration:');
        if (!name || !name.trim()) return;
        const trimmed = name.trim();
        if (!settings.apiConfigs) settings.apiConfigs = {};
        settings.apiConfigs[trimmed] = extractApiConfig(settings);
        settings.selectedApiConfig = trimmed;
        populateApiConfigDropdown(settings);
        saveSettings();
        toastr.success(`API config "${trimmed}" saved.`);
    });

    document.getElementById('st_pd_api_config_delete')?.addEventListener('click', () => {
        const name = settings.selectedApiConfig;
        if (!name) {
            toastr.warning('No API config selected.');
            return;
        }
        if (!confirm(`Delete API config "${name}"?`)) return;
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
        outlineEnabledEl.addEventListener('change', () => {
            settings.outlineEnabled = outlineEnabledEl.checked;
            saveSettings();
        });
    }

    const outlineEl = document.getElementById('st_pd_outline');
    if (outlineEl) {
        outlineEl.value = settings.outline;
        outlineEl.addEventListener('input', () => {
            settings.outline = outlineEl.value;
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
}

function bindPresetUI(settings) {
    const selectEl = document.getElementById('st_pd_preset_select');
    const promptEl = document.getElementById('st_pd_system_prompt');

    populatePresetDropdown(settings);
    loadPresetToEditor(settings);

    selectEl?.addEventListener('change', () => {
        settings.selectedPreset = selectEl.value;
        loadPresetToEditor(settings);
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
            });
            settings.selectedPreset = name;
            populatePresetDropdown(settings);
            loadPresetToEditor(settings);
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
            saveSettings();
            toastr.success('Preset deleted.');
        }
    });

    document.getElementById('st_pd_preset_import')?.addEventListener('click', async () => {
        try {
            const preset = await importPreset();
            const name = preset.name || 'Imported Preset';
            savePreset(settings, name, preset);
            settings.selectedPreset = name;
            populatePresetDropdown(settings);
            loadPresetToEditor(settings);
            saveSettings();
            toastr.success(`Preset "${name}" imported.`);
        } catch (err) {
            toastr.error(err.message);
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
            toastr.success(`Preset "${settings.selectedPreset}" saved.`);
        } else {
            toastr.warning('No preset selected.');
        }
    });
}

// ---- Initialization ----

jQuery(async function () {
    const context = SillyTavern.getContext();
    const settings = getSettings();

    const extensionUrl = `scripts/extensions/${EXTENSION_FOLDER}`;

    await initPresets(settings, extensionUrl);
    saveSettings();

    const response = await fetch(`${extensionUrl}/settings.html`);
    if (!response.ok) {
        console.error('[PlotDirector] Failed to load settings HTML');
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

    context.eventSource.on(context.eventTypes.GENERATION_ENDED, onGenerationEnded);

    log('Extension loaded.');
});
