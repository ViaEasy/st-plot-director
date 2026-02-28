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
 * Read an SSE stream and accumulate text tokens.
 * @param {Response} response - Fetch response with streaming body
 * @param {Function} parseChunk - Extracts token text from a JSON data string, returns string or null
 * @param {Function} [onToken] - Called with each incremental token
 * @returns {Promise<string>} Full accumulated text
 */
async function readSSEStream(response, parseChunk, onToken) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (data === '[DONE]') return fullText;
            try {
                const token = parseChunk(data);
                if (token) {
                    fullText += token;
                    if (onToken) onToken(token);
                }
            } catch {
                // Skip malformed JSON chunks
            }
        }
    }
    return fullText;
}

/**
 * Generate via SillyTavern's proxy endpoint.
 * @param {Array} messages - Chat messages array
 * @param {object} settings - Plugin settings
 * @param {Function} getRequestHeaders - Header getter from ST context
 * @param {object} [options] - Optional parameters
 * @param {AbortSignal} [options.signal] - Abort signal
 * @param {boolean} [options.streaming] - Enable streaming
 * @param {Function} [options.onToken] - Streaming token callback
 * @returns {Promise<string>} Generated text
 */
export async function generateViaProxy(messages, settings, getRequestHeaders, options = {}) {
    const streaming = options.streaming && typeof options.onToken === 'function';

    const body = {
        chat_completion_source: settings.apiType,
        messages: messages,
        model: settings.model,
        temperature: settings.temperature,
        max_tokens: settings.maxTokens,
        stream: streaming,
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

    if (streaming) {
        return readSSEStream(response, (data) => {
            const json = JSON.parse(data);
            return json.choices?.[0]?.delta?.content || null;
        }, options.onToken);
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
 * @param {boolean} [options.streaming] - Enable streaming
 * @param {Function} [options.onToken] - Streaming token callback
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
    const streaming = options.streaming && typeof options.onToken === 'function';
    const url = settings.apiUrl.replace(/\/+$/, '');

    const requestBody = {
        model: settings.model,
        messages: messages,
        temperature: settings.temperature,
        max_tokens: settings.maxTokens,
    };
    if (streaming) requestBody.stream = true;

    const response = await fetch(`${url}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${settings.apiKey}`,
        },
        body: JSON.stringify(requestBody),
        signal: combinedSignal(options.signal),
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`OpenAI request failed (${response.status}): ${text}`);
    }

    if (streaming) {
        return readSSEStream(response, (data) => {
            const json = JSON.parse(data);
            return json.choices?.[0]?.delta?.content || null;
        }, options.onToken);
    }

    const data = await response.json();
    if (!data.choices?.[0]?.message?.content) {
        throw new Error('OpenAI response missing choices[0].message.content');
    }
    return data.choices[0].message.content;
}

async function generateDirectClaude(messages, settings, options = {}) {
    const streaming = options.streaming && typeof options.onToken === 'function';
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
    if (streaming) body.stream = true;

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

    if (streaming) {
        return readSSEStream(response, (data) => {
            const json = JSON.parse(data);
            if (json.type === 'content_block_delta' && json.delta?.type === 'text_delta') {
                return json.delta.text;
            }
            return null;
        }, options.onToken);
    }

    const data = await response.json();
    if (!data.content?.[0]?.text) {
        throw new Error('Claude response missing content[0].text');
    }
    return data.content[0].text;
}

/**
 * Fetch available models from the API.
 * @param {object} settings - Plugin settings (needs apiUrl, apiKey, apiType)
 * @returns {Promise<string[]>} Sorted array of model IDs
 */
export async function fetchModels(settings) {
    const url = settings.apiUrl?.replace(/\/+$/, '');
    if (!url) throw new Error('API URL is required');

    if (settings.apiType === 'openai') {
        const response = await fetch(`${url}/models`, {
            headers: { 'Authorization': `Bearer ${settings.apiKey}` },
            signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) throw new Error(`Failed (${response.status})`);
        const data = await response.json();
        return (data.data || []).map(m => m.id).sort();
    }

    if (settings.apiType === 'claude') {
        const response = await fetch(`${url}/models?limit=1000`, {
            headers: {
                'x-api-key': settings.apiKey,
                'anthropic-version': '2023-06-01',
            },
            signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) throw new Error(`Failed (${response.status})`);
        const data = await response.json();
        return (data.data || []).map(m => m.id).sort();
    }

    throw new Error(`Unsupported API type: ${settings.apiType}`);
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
