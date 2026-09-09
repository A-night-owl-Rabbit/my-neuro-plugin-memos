const { Plugin } = require('../../../js/core/plugin-base.js');
const { MemosClient } = require('./memos-client.js');
const { MemosTools } = require('./tools.js');
const fs = require('fs');
const path = require('path');

const BACKEND_CONFIG_PATH = path.join(__dirname, '..', '..', '..', '..', 'memos_system', 'config', 'memos_config.json');

const SHORT_QUERY_FILLERS = new Set([
    '嗯', '嗯嗯', '嗯哼', '嗯嗯嗯',
    '啊', '哦', '噢', '唔', '额',
    '哈', '哈哈', '哈哈哈', '呵呵',
    '好', '好的', '好哒',
    '行', '行了', '收到', '知道了', '明白',
    '对', '是的', '没事', '可以', '哦哦'
]);
const SHORT_QUERY_FILLER_CHARS = new Set(['嗯', '啊', '哦', '噢', '唔', '额', '哈', '呵']);

function isShortMemoryQuery(text) {
    const normalized = String(text || '')
        .trim()
        .replace(/[\s\u3000，。、！？：；“”‘’（）【】,.!?;:"'()\[\]…—～~\-]+/g, '');
    if (!normalized || normalized.length <= 1) return true;
    if (SHORT_QUERY_FILLERS.has(normalized)) return true;
    if (normalized.length <= 2 && [...normalized].every(ch => SHORT_QUERY_FILLER_CHARS.has(ch))) {
        return true;
    }
    return false;
}

function buildBackendEmbeddingConfig(cfg, backendCfg) {
    const be = cfg && cfg.backend_embedding;
    if (!be) return backendCfg;
    const provider = be.provider === 'api' ? 'api' : 'local';
    const baseUrl = String(be.api_base_url || 'https://api.siliconflow.cn/v1').trim();
    const apiKey = String(be.api_key || '').trim();
    backendCfg.embedding = backendCfg.embedding || {};
    backendCfg.embedding.provider = provider;
    backendCfg.embedding.api = {
        ...(backendCfg.embedding.api || {}),
        base_url: baseUrl,
        model: String(be.embedding_model || 'BAAI/bge-m3').trim(),
        api_key: apiKey
    };
    backendCfg.search = backendCfg.search || {};
    backendCfg.search.reranker_provider = provider;
    backendCfg.search.reranker_api = {
        ...(backendCfg.search.reranker_api || {}),
        base_url: baseUrl,
        model: String(be.rerank_model || 'BAAI/bge-reranker-v2-m3').trim(),
        api_key: apiKey
    };
    return backendCfg;
}

function describeEmbeddingModeMismatch(health, expectedProvider) {
    const emb = health && health.embedding;
    if (!emb) return null;
    if (emb.warning) {
        return { level: 'warn', text: `MemOS：${emb.warning}`, onceKey: `warning:${emb.warning}` };
    }
    if (emb.provider !== expectedProvider) {
        const wantedName = expectedProvider === 'api' ? 'API 调用' : '本地模型';
        const envNames = Array.isArray(emb.env_overrides) ? emb.env_overrides.filter(Boolean) : [];
        const text = envNames.length
            ? `后端由环境变量 ${envNames.join(', ')} 指定为 ${emb.provider}，WebUI 设置未生效`
            : `MemOS 向量模式已改为「${wantedName}」，请在 WebUI 把记忆系统停止再启动后生效`;
        return { level: 'warn', text, onceKey: `mismatch:${expectedProvider}:${emb.provider}:${envNames.join('|')}` };
    }
    return { level: 'info', text: `MemOS 向量模式: ${emb.provider}`, onceKey: null };
}

class MemosPlugin extends Plugin {

    async onInit() {
        const cfg = this.context.getPluginFileConfig();
        this.client = new MemosClient(cfg);
        this.tools = new MemosTools(this.client.apiUrl, {
            similarityThreshold: this.client.similarityThreshold
        });
        this._cfg = cfg;
        // 连续多少次提取失败后提醒一次；同一段连续失败只提醒一次，成功后重置
        const threshold = Number(cfg.extraction_failure_notice_threshold);
        this._noticeThreshold = Number.isFinite(threshold) && threshold >= 1 ? Math.floor(threshold) : 3;
        this._noticeShownForStreak = false;
        this._embeddingMismatchOnceKey = null;
    }

    async onStart() {
        if (!this.client.enabled) {
            this.context.log('warn', 'MemOS 已禁用');
            return;
        }

        this._syncBackendConfig();

        const ok = await this.client.isAvailable();
        this.context.log('info', `MemOS 服务: ${ok ? '已连接' : '不可用（请确认 memos_system 是否启动）'}`);
        if (ok) {
            await this._checkBackendExtractionHealth();
            await this._checkEmbeddingModeMismatch();
        }
    }

    async onConfigChanged(newConfig) {
        this._cfg = newConfig;
        this._syncBackendConfig();
        await this._checkEmbeddingModeMismatch();
    }

    async _checkEmbeddingModeMismatch() {
        try {
            const expected = (this._cfg && this._cfg.backend_embedding && this._cfg.backend_embedding.provider === 'api')
                ? 'api'
                : 'local';
            const health = this.client && typeof this.client.fetchHealth === 'function'
                ? await this.client.fetchHealth()
                : null;
            const result = describeEmbeddingModeMismatch(health, expected);
            if (!result) return;
            if (result.level === 'info') {
                this.context.log('info', result.text);
                return;
            }
            if (result.onceKey && this._embeddingMismatchOnceKey === result.onceKey) {
                return;
            }
            this._embeddingMismatchOnceKey = result.onceKey;
            this.context.log('warn', result.text);
            this._notify(result.text);
        } catch (err) {
            this.context.log('warn', `核对 MemOS 向量模式失败（不影响运行）: ${err.message}`);
        }
    }

    /** 启动时读取一次后端健康信息：提取链路处于 failing/disabled 或有告警时立刻提醒 */
    async _checkBackendExtractionHealth() {
        try {
            const health = await this.client.fetchHealth();
            if (!health) return;
            const extraction = health.extraction || null;
            const warnings = Array.isArray(health.warnings) ? health.warnings : [];
            const status = extraction?.status;
            if (status === 'failing' || status === 'disabled' || warnings.length > 0) {
                const detail = warnings.length > 0 ? warnings.join('；') : `记忆提取状态 ${status}`;
                this.context.log('warn', `MemOS 后端提示: ${detail}`);
                this._notify(`MemOS 记忆提取异常：${detail}`);
            } else if (status) {
                this.context.log('info', `MemOS 记忆提取状态: ${status}${extraction?.last_ok_at ? `（上次成功 ${extraction.last_ok_at}）` : ''}`);
            }
        } catch (err) {
            this.context.log('warn', `读取 MemOS 健康信息失败（不影响运行）: ${err.message}`);
        }
    }

    _notify(text, durationMs = 6000) {
        try {
            if (typeof this.context.showSubtitle === 'function') {
                this.context.showSubtitle(text, durationMs);
            }
        } catch (_) {
            // 字幕只是提醒手段，失败不影响记忆功能
        }
    }

    /** 处理一次缓冲保存的结果：连续失败达到阈值时提醒一次，成功后重置 */
    _handleSaveResult(result) {
        if (!result || typeof result !== 'object') return;
        if (result.status === 'saved' || result.status === 'flushed') {
            if (this._noticeShownForStreak) {
                this.context.log('info', 'MemOS 记忆提取已恢复正常');
            }
            this._noticeShownForStreak = false;
            return;
        }
        if (result.status === 'extraction_failed' || result.status === 'extraction_disabled') {
            const streak = Number(result.failStreak) || 0;
            const reason = result.extraction_error ? `，原因: ${result.extraction_error}` : '';
            const retainInfo = result.retained
                ? `，已保留 ${result.bufferedRounds} 轮对话等待重试`
                : '，本批对话已放弃';
            this.context.log('warn', `MemOS 记忆提取${result.status === 'extraction_disabled' ? '模型未配置' : '失败'}（连续 ${streak} 次${reason}${retainInfo}）`);
            if (streak >= this._noticeThreshold && !this._noticeShownForStreak) {
                this._noticeShownForStreak = true;
                const hint = result.status === 'extraction_disabled'
                    ? 'MemOS 记忆提取模型未配置，肥牛记不住最近的对话，请到插件配置里检查后端 LLM'
                    : `MemOS 记忆提取已连续失败 ${streak} 次，肥牛可能记不住最近的对话，请检查后端模型配置或网络`;
                this.context.log('warn', hint);
                this._notify(hint);
            }
        }
    }

    async onStop() {
        if (this.client?.enabled) {
            const result = await this.client.flushBuffer();
            this._handleSaveResult(result);
        }
    }

    async onUserInput(event) {
        if (!this.client?.enabled || !this._cfg.auto_inject) return;
        if (!['voice', 'text'].includes(event.source)) return;

        try {
            if (isShortMemoryQuery(event.text)) {
                this.context.log('info', `短查询跳过记忆检索: ${String(event.text || '').slice(0, 20)}`);
                this.context.removeSystemPromptPatch('memos-recall');
                return;
            }

            const memories = await this.client.search(event.text);
            if (memories.length > 0) {
                const text = this.client.formatMemoriesForPrompt(memories);
                this.context.addSystemPromptPatch('memos-recall', `\n【你对主人的已知记忆，回答时必须自然融入，不要说"根据记忆"】:\n${text}`);
            } else {
                this.context.removeSystemPromptPatch('memos-recall');
            }
        } catch (err) {
            this.context.log('error', `记忆注入失败: ${err.message}`);
        }
    }

    async onLLMResponse(response) {
        if (!this.client?.enabled || !this._cfg.auto_save) return;
        if (response.proactive_internal) return;

        const messages = this.context.getMessages();
        const lastUser = [...messages].reverse().find(m => m.role === 'user');
        if (!lastUser) return;

        const contextSummary = this._getCompressedContextSummary(messages);
        this.client.addWithBuffer([
            { role: 'user', content: lastUser.content },
            { role: 'assistant', content: response.text }
        ], { contextSummary }).then(result => {
            this._handleSaveResult(result);
        }).catch(err => {
            this.context.log('error', `MemOS 保存对话失败: ${err.message}`);
        });
    }

    _getCompressedContextSummary(messages = null) {
        const sourceMessages = Array.isArray(messages) ? messages : this.context.getMessages();
        for (let i = sourceMessages.length - 1; i >= 0; i--) {
            const msg = sourceMessages[i];
            if (!msg || msg.role !== 'assistant') continue;

            const content = this._extractTextContent(msg.content).trim();
            if (!this._isCompressedSummaryMessage(content)) continue;

            return this._stripSummaryTitle(content);
        }
        return null;
    }

    _isCompressedSummaryMessage(content) {
        if (!content) return false;
        return (
            content.startsWith('[历史折叠索引]') ||
            content.startsWith('[历史对话总结]') ||
            content.includes('历史对话总结') ||
            /^\d{4}-\d{1,2}-\d{1,2}.*?总结[：:]/.test(content)
        );
    }

    _stripSummaryTitle(content) {
        return content
            .replace(/^\d{4}-\d{1,2}-\d{1,2}.*?总结[：:]/, '')
            .replace(/^\[历史折叠索引\]\s*/, '')
            .replace(/^\[历史对话总结\]\s*/, '')
            .trim();
    }

    _extractTextContent(content) {
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
            return content
                .filter(part => part && part.type === 'text')
                .map(part => part.text || '')
                .join(' ');
        }
        if (content === null || content === undefined) return '';
        return String(content);
    }

    getTools() {
        if (!this.client?.enabled) return [];
        return this.tools.getDefinitions();
    }

    async executeTool(name, params) {
        return this.tools.execute(name, params);
    }

    /**
     * 将插件中的后端配置同步写入 memos_system/config/memos_config.json
     * 只覆盖插件管理的字段，保留后端独有字段（storage、embedding 等）
     */
    _syncBackendConfig() {
        try {
            let backendCfg = {};
            if (fs.existsSync(BACKEND_CONFIG_PATH)) {
                backendCfg = JSON.parse(fs.readFileSync(BACKEND_CONFIG_PATH, 'utf-8'));
            }

            const cfg = this._cfg;

            // LLM
            if (cfg.backend_llm) {
                backendCfg.llm = backendCfg.llm || {};
                const existingConfig = backendCfg.llm.config || {};
                const resolvedConfig = this._resolveBackendLLMConfig(cfg.backend_llm, existingConfig);
                backendCfg.llm.config = {
                    ...existingConfig,
                    ...resolvedConfig,
                    max_tokens: cfg.backend_llm.max_tokens ?? existingConfig.max_tokens ?? 8000
                };
            }

            // LLM fallback
            if (cfg.backend_llm_fallback) {
                const existingFallback = backendCfg.llm_fallback?.config || {};
                const resolvedFallback = this._resolveBackendLLMConfig(
                    cfg.backend_llm_fallback,
                    existingFallback
                );
                backendCfg.llm_fallback = {
                    ...(backendCfg.llm_fallback || {}),
                    enabled: cfg.backend_llm_fallback.enabled !== false,
                    config: {
                        ...existingFallback,
                        ...resolvedFallback
                    }
                };
            }

            // Search
            if (cfg.backend_search) {
                backendCfg.search = backendCfg.search || {};
                if (cfg.backend_search.enable_bm25 !== undefined) backendCfg.search.enable_bm25 = cfg.backend_search.enable_bm25;
                if (cfg.backend_search.bm25_weight !== undefined) backendCfg.search.bm25_weight = cfg.backend_search.bm25_weight;
                if (cfg.backend_search.enable_graph_query !== undefined) backendCfg.search.enable_graph_query = cfg.backend_search.enable_graph_query;
            }
            backendCfg.search = backendCfg.search || {};
            backendCfg.search.similarity_threshold = cfg.similarity_threshold ?? backendCfg.search.similarity_threshold ?? 0.5;
            buildBackendEmbeddingConfig(cfg, backendCfg);

            // Features
            if (cfg.backend_features) {
                if (cfg.backend_features.entity_extraction !== undefined) {
                    backendCfg.entity_extraction = backendCfg.entity_extraction || {};
                    backendCfg.entity_extraction.enabled = cfg.backend_features.entity_extraction;
                    backendCfg.entity_extraction.auto_extract_on_add = cfg.backend_features.entity_extraction;
                }
                if (cfg.backend_features.image_memory !== undefined) {
                    backendCfg.image = backendCfg.image || {};
                    backendCfg.image.enabled = cfg.backend_features.image_memory;
                }
                if (cfg.backend_features.image_auto_describe !== undefined) {
                    backendCfg.image = backendCfg.image || {};
                    backendCfg.image.auto_describe = cfg.backend_features.image_auto_describe;
                }
            }

            const dir = path.dirname(BACKEND_CONFIG_PATH);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(BACKEND_CONFIG_PATH, JSON.stringify(backendCfg, null, 2), 'utf-8');
            this.context.log('info', '已同步后端配置到 memos_config.json');
        } catch (err) {
            this.context.log('warn', `同步后端配置失败（不影响运行）: ${err.message}`);
        }
    }

    _resolveBackendLLMConfig(config = {}, existing = {}) {
        const providerId = String(config.provider_id || '').trim();
        const providerModelId = providerId ? String(config.model_id || '').trim() : '';
        let resolved = null;

        if (providerId) {
            resolved = this.context.resolveLLM(providerId, providerModelId || null);
        } else if (config.base_url && config.api_key && config.model) {
            resolved = {
                api_url: config.base_url,
                api_key: config.api_key,
                model: config.model
            };
        } else {
            resolved = this.context.resolveLLM(null, null);
            if (!resolved?.api_url && global.voiceChat?.API_URL) {
                resolved = {
                    api_url: global.voiceChat.API_URL,
                    api_key: global.voiceChat.API_KEY || '',
                    model: global.voiceChat.MODEL || ''
                };
            }
        }

        if (!resolved?.api_url || !resolved?.model) {
            return {
                model: existing.model || '',
                api_key: existing.api_key || '',
                base_url: existing.base_url || ''
            };
        }

        return {
            model: resolved.model,
            api_key: resolved.api_key || '',
            base_url: resolved.api_url
        };
    }
}

module.exports = MemosPlugin;
// 挂成不可枚举：插件加载器会按自有可枚举属性推断插件类，可枚举会让它误选到这个函数
Object.defineProperty(module.exports, 'isShortMemoryQuery', {
    value: isShortMemoryQuery,
    enumerable: false
});
Object.defineProperty(module.exports, 'buildBackendEmbeddingConfig', {
    value: buildBackendEmbeddingConfig,
    enumerable: false
});
Object.defineProperty(module.exports, 'describeEmbeddingModeMismatch', {
    value: describeEmbeddingModeMismatch,
    enumerable: false
});
