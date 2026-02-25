/**
 * LLM API call wrapper for st-plot-director.
 * Supports OpenAI-compatible and Claude APIs, via proxy or direct.
 */

/**
 * Generate via SillyTavern's proxy endpoint.
 * @param {Array} messages - Chat messages array
 * @param {object} settings - Plugin settings
 * @param {Function} getRequestHeaders - Header getter from ST context
 * @returns {Promise<string>} Generated text
 */
export async function generateViaProxy(messages, settings, getRequestHeaders) {
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
 * @returns {Promise<string>} Generated text
 */
export async function generateDirect(messages, settings) {
    if (settings.apiType === 'openai') {
        return generateDirectOpenAI(messages, settings);
    }
    if (settings.apiType === 'claude') {
        return generateDirectClaude(messages, settings);
    }
    throw new Error(`Unsupported API type: ${settings.apiType}`);
}

async function generateDirectOpenAI(messages, settings) {
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
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`OpenAI request failed (${response.status}): ${text}`);
    }

    const data = await response.json();
    return data.choices[0].message.content;
}

async function generateDirectClaude(messages, settings) {
    const systemMsg = messages.find(m => m.role === 'system');
    const chatMsgs = messages.filter(m => m.role !== 'system');
    const url = settings.apiUrl.replace(/\/+$/, '');

    const response = await fetch(`${url}/messages`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': settings.apiKey,
            'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
            model: settings.model,
            max_tokens: settings.maxTokens,
            system: systemMsg?.content || '',
            messages: chatMsgs,
            temperature: settings.temperature,
        }),
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Claude request failed (${response.status}): ${text}`);
    }

    const data = await response.json();
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
