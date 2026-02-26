/**
 * LLM API call wrapper for st-plot-director.
 * Supports OpenAI-compatible and Claude APIs, via proxy or direct.
 */

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Combine an optional AbortController signal with a timeout signal.
 * @param {AbortSignal} [signal] - External abort signal
 * @param {number} [timeoutMs] - Timeout in milliseconds
 * @returns {AbortSignal} Combined signal
 */
function combinedSignal(signal, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (signal) signals.push(signal);
    return AbortSignal.any(signals);
}

/**
 * Generate via SillyTavern's proxy endpoint.
 * @param {Array} messages - Chat messages array
 * @param {object} settings - Plugin settings
 * @param {Function} getRequestHeaders - Header getter from ST context
 * @param {object} [options] - Optional parameters
 * @param {AbortSignal} [options.signal] - Abort signal
 * @returns {Promise<string>} Generated text
 */
export async function generateViaProxy(messages, settings, getRequestHeaders, options = {}) {
    const body = {
        chat_completion_source: settings.apiType,
        messages: messages,
        model: settings.model,
        temperature: settings.temperature,
        max_tokens: settings.maxTokens,
        stream: false,
    };

    if (settings.apiUrl) {
        body.reverse_proxy = settings.apiUrl;
        body.proxy_password = settings.apiKey;
    }

    const response = await fetch('/api/backends/chat-completions/generate', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(body),
        signal: combinedSignal(options.signal),
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Proxy request failed (${response.status}): ${text}`);
    }

    const data = await response.json();

    // ST proxy returns different formats depending on source
    if (typeof data === 'string') {
        return data;
    }
    if (data.choices && data.choices[0]) {
        return data.choices[0].message?.content || data.choices[0].text || '';
    }
    if (data.content && data.content[0]) {
        return data.content[0].text || '';
    }

    throw new Error('Unexpected proxy response format');
}

/**
 * Generate via direct API request.
 * @param {Array} messages - Chat messages array
 * @param {object} settings - Plugin settings
 * @param {object} [options] - Optional parameters
 * @param {AbortSignal} [options.signal] - Abort signal
 * @returns {Promise<string>} Generated text
 */
export async function generateDirect(messages, settings, options = {}) {
    if (settings.apiType === 'openai') {
        return generateDirectOpenAI(messages, settings, options);
    }
    if (settings.apiType === 'claude') {
        return generateDirectClaude(messages, settings, options);
    }
    throw new Error(`Unsupported API type: ${settings.apiType}`);
}

async function generateDirectOpenAI(messages, settings, options = {}) {
    const url = settings.apiUrl.replace(/\/+$/, '');
    const response = await fetch(`${url}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${settings.apiKey}`,
        },
        body: JSON.stringify({
            model: settings.model,
            messages: messages,
            temperature: settings.temperature,
            max_tokens: settings.maxTokens,
        }),
        signal: combinedSignal(options.signal),
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`OpenAI request failed (${response.status}): ${text}`);
    }

    const data = await response.json();
    if (!data.choices?.[0]?.message?.content) {
        throw new Error('OpenAI response missing choices[0].message.content');
    }
    return data.choices[0].message.content;
}

async function generateDirectClaude(messages, settings, options = {}) {
    const systemParts = messages.filter(m => m.role === 'system').map(m => m.content);
    const systemText = systemParts.join('\n\n');
    const chatMsgs = messages.filter(m => m.role !== 'system');
    const url = settings.apiUrl.replace(/\/+$/, '');

    // Merge consecutive same-role messages (Claude API rejects them)
    const mergedMsgs = [];
    for (const msg of chatMsgs) {
        if (mergedMsgs.length > 0 && mergedMsgs[mergedMsgs.length - 1].role === msg.role) {
            mergedMsgs[mergedMsgs.length - 1].content += '\n\n' + msg.content;
        } else {
            mergedMsgs.push({ ...msg });
        }
    }

    // Claude requires first message to be user role
    if (mergedMsgs.length > 0 && mergedMsgs[0].role === 'assistant') {
        mergedMsgs.unshift({ role: 'user', content: '[Conversation start]' });
    }

    const body = {
        model: settings.model,
        max_tokens: settings.maxTokens,
        messages: mergedMsgs,
        temperature: settings.temperature,
    };

    if (systemText) {
        body.system = systemText;
    }

    const response = await fetch(`${url}/messages`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': settings.apiKey,
            'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: combinedSignal(options.signal),
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Claude request failed (${response.status}): ${text}`);
    }

    const data = await response.json();
    if (!data.content?.[0]?.text) {
        throw new Error('Claude response missing content[0].text');
    }
    return data.content[0].text;
}

/**
 * Test API connection by sending a minimal request.
 * @param {object} settings - Plugin settings
 * @param {Function} getRequestHeaders - Header getter from ST context
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function testConnection(settings, getRequestHeaders) {
    const testMessages = [
        { role: 'user', content: 'Reply with "OK" and nothing else.' },
    ];

    try {
        let result;
        if (settings.connectionMode === 'proxy') {
            result = await generateViaProxy(testMessages, settings, getRequestHeaders);
        } else {
            result = await generateDirect(testMessages, settings);
        }
        return { success: true, message: `Connection OK. Response: ${result.substring(0, 50)}` };
    } catch (err) {
        return { success: false, message: `Connection failed: ${err.message}` };
    }
}
