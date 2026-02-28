/**
 * Preset manager for st-plot-director.
 * Handles CRUD, import/export of system prompt presets.
 */

const BUILTIN_PRESETS_PATH = 'presets';

/**
 * Load built-in default preset from the extension directory.
 * @param {string} extensionUrl - Base URL of the extension
 * @returns {Promise<object>} Default preset object
 */
async function loadBuiltinPreset(extensionUrl) {
    const response = await fetch(`${extensionUrl}/${BUILTIN_PRESETS_PATH}/default.json`);
    if (!response.ok) {
        throw new Error('Failed to load built-in default preset');
    }
    return await response.json();
}

/**
 * Initialize presets in settings, loading default if empty.
 * @param {object} settings - Extension settings reference
 * @param {string} extensionUrl - Base URL of the extension
 */
export async function initPresets(settings, extensionUrl) {
    if (!settings.presets) {
        settings.presets = {};
    }
    if (!settings.selectedPreset) {
        settings.selectedPreset = '';
    }

    // Load built-in default if no presets exist
    if (Object.keys(settings.presets).length === 0) {
        try {
            const defaultPreset = await loadBuiltinPreset(extensionUrl);
            const name = defaultPreset.name || 'Default Plot Director';
            settings.presets[name] = defaultPreset;
            settings.selectedPreset = name;
        } catch (err) {
            console.warn('[PlotDirector] Failed to load default preset:', err);
        }
    }
}

/**
 * Default prompt manager config for migration of old presets.
 * Uses "text" mode to preserve existing behavior.
 */
const DEFAULT_PM_BLOCKS = [
    { id: 'system_prompt', type: 'fixed', role: 'system', label: 'System Prompt', enabled: true, content: null, tagName: '' },
    { id: 'plot_outline', type: 'fixed', role: 'system', label: 'Plot Outline', enabled: true, content: null, tagName: 'plot outline' },
    { id: 'chat_history', type: 'fixed', role: 'special', label: 'Chat History', enabled: true, content: null, tagName: 'history log' },
    { id: 'instruction', type: 'fixed', role: 'user', label: 'Instruction', enabled: true, content: 'Based on the conversation above, generate the next plot direction.', tagName: '' },
];

/**
 * Default prompt manager config.
 * Shared single source of truth for index.js and preset migration.
 * @param {string} [chatHistoryMode='role'] - Chat history mode
 * @returns {object} Default prompt manager config
 */
export function getDefaultPromptManagerConfig(chatHistoryMode = 'role') {
    return {
        chatHistoryMode,
        blocks: structuredClone(DEFAULT_PM_BLOCKS),
    };
}

/**
 * Ensure a preset has a valid prompt_manager config.
 * Creates default config if missing (lazy migration).
 * @param {object} preset - Preset to check
 */
export function ensurePromptManagerConfig(preset) {
    if (!preset) return;
    if (!preset.prompt_manager) {
        preset.prompt_manager = getDefaultPromptManagerConfig('text');
        return;
    }

    // Migrate old blocks without tagName field
    if (preset.prompt_manager.blocks) {
        for (const block of preset.prompt_manager.blocks) {
            if (block.tagName === undefined) {
                // Set default tagName based on block id
                if (block.id === 'chat_history') {
                    block.tagName = 'history log';
                } else if (block.id === 'plot_outline') {
                    block.tagName = 'plot outline';
                } else {
                    block.tagName = '';
                }
            }
        }
    }
}

/**
 * Get the currently selected preset.
 * @param {object} settings - Extension settings
 * @returns {object|null} Current preset or null
 */
export function getCurrentPreset(settings) {
    if (!settings.selectedPreset || !settings.presets[settings.selectedPreset]) {
        return null;
    }
    const preset = settings.presets[settings.selectedPreset];
    ensurePromptManagerConfig(preset);
    return preset;
}

/**
 * Save/update a preset.
 * @param {object} settings - Extension settings
 * @param {string} name - Preset name
 * @param {object} preset - Preset data
 */
export function savePreset(settings, name, preset) {
    settings.presets[name] = { ...preset, name };
}

/**
 * Delete a preset by name.
 * @param {object} settings - Extension settings
 * @param {string} name - Preset name to delete
 */
export function deletePreset(settings, name) {
    delete settings.presets[name];
    if (settings.selectedPreset === name) {
        const remaining = Object.keys(settings.presets);
        settings.selectedPreset = remaining.length > 0 ? remaining[0] : '';
    }
}

/**
 * Export a preset as a downloadable JSON file.
 * @param {object} preset - Preset to export
 */
export function exportPreset(preset) {
    const blob = new Blob([JSON.stringify(preset, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${preset.name || 'preset'}.json`;
    a.click();
    URL.revokeObjectURL(url);
}

/**
 * Import a preset from a JSON file.
 * Returns a promise that resolves with the parsed preset.
 * @returns {Promise<object>} Imported preset
 */
export function importPreset() {
    return new Promise((resolve, reject) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) {
                reject(new Error('No file selected'));
                return;
            }
            try {
                const text = await file.text();
                const data = JSON.parse(text);
                const preset = convertToPreset(data);
                resolve(preset);
            } catch (err) {
                reject(new Error(`Failed to parse preset: ${err.message}`));
            }
        };
        input.addEventListener('cancel', () => {
            reject(new Error('File selection cancelled'));
        });
        input.click();
    });
}

/**
 * Convert imported data to the plugin's preset format.
 * Supports both native plugin format and SillyTavern instruct presets.
 * @param {object} data - Raw imported JSON
 * @returns {object} Normalized preset
 */
function convertToPreset(data) {
    let preset;

    // Already in plugin format
    if (data.system_prompt !== undefined) {
        preset = {
            name: data.name || 'Imported Preset',
            system_prompt: data.system_prompt,
            temperature: data.temperature ?? 0.8,
            max_tokens: data.max_tokens ?? 300,
            model: data.model || '',
        };
        // Preserve prompt_manager if present in imported data
        if (data.prompt_manager) {
            preset.prompt_manager = data.prompt_manager;
        }
    } else if (Array.isArray(data.prompts)) {
        // SillyTavern preset format: extract main prompt from prompts array
        const mainPrompt = data.prompts.find(p => p.identifier === 'main');
        preset = {
            name: data.name || 'Imported ST Preset',
            system_prompt: mainPrompt?.content || '',
            temperature: data.temperature ?? 0.8,
            max_tokens: data.max_tokens ?? 300,
            model: '',
        };
    } else if (typeof data.content === 'string') {
        // Fallback: treat any string content as system prompt
        preset = {
            name: data.name || 'Imported Preset',
            system_prompt: data.content,
            temperature: 0.8,
            max_tokens: 300,
            model: '',
        };
    } else {
        throw new Error('Unrecognized preset format');
    }

    ensurePromptManagerConfig(preset);
    return preset;
}

/**
 * Get list of preset names.
 * @param {object} settings - Extension settings
 * @returns {string[]} Array of preset names
 */
export function getPresetNames(settings) {
    return Object.keys(settings.presets || {});
}
