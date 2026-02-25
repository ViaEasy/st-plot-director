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
 * Get the currently selected preset.
 * @param {object} settings - Extension settings
 * @returns {object|null} Current preset or null
 */
export function getCurrentPreset(settings) {
    if (!settings.selectedPreset || !settings.presets[settings.selectedPreset]) {
        return null;
    }
    return settings.presets[settings.selectedPreset];
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
    // Already in plugin format
    if (data.system_prompt !== undefined) {
        return {
            name: data.name || 'Imported Preset',
            system_prompt: data.system_prompt,
            temperature: data.temperature ?? 0.8,
            max_tokens: data.max_tokens ?? 300,
            model: data.model || '',
        };
    }

    // SillyTavern preset format: extract main prompt from prompts array
    if (Array.isArray(data.prompts)) {
        const mainPrompt = data.prompts.find(p => p.identifier === 'main');
        return {
            name: data.name || 'Imported ST Preset',
            system_prompt: mainPrompt?.content || '',
            temperature: data.temperature ?? 0.8,
            max_tokens: data.max_tokens ?? 300,
            model: '',
        };
    }

    // Fallback: treat any string content as system prompt
    if (typeof data.content === 'string') {
        return {
            name: data.name || 'Imported Preset',
            system_prompt: data.content,
            temperature: 0.8,
            max_tokens: 300,
            model: '',
        };
    }

    throw new Error('Unrecognized preset format');
}

/**
 * Get list of preset names.
 * @param {object} settings - Extension settings
 * @returns {string[]} Array of preset names
 */
export function getPresetNames(settings) {
    return Object.keys(settings.presets || {});
}
