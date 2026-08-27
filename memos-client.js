const axios = require('axios');

class MemosClient {
    constructor(pluginConfig) {
        this.enabled = pluginConfig.enabled !== false;
        this.apiUrl = pluginConfig.api_url || 'http://127.0.0.1:8003';
        this.autoInject = pluginConfig.auto_inject !== false;
        this.injectTopK = pluginConfig.inject_top_k ?? 3;
        this.similarityThreshold = pluginConfig.similarity_threshold ?? 0.6;
        this.autoSave = pluginConfig.auto_save !== false;
        this.saveInterval = pluginConfig.save_interval ?? 5;
        this.conversationBuffer = [];
        this.bufferContextSummary = null;
        this.roundCount = 0;
        this._saving = false;
        this._bufferSummaryVersion = 0;
        this._savePromise = null;
    }

    _normalizeContextSummary(summary) {
        if (typeof summary !== 'string') return null;
        const text = summary.trim();
        if (!text) return null;

        const maxChars = 6000;
        if (text.length <= maxChars) return text;

        const half = Math.floor(maxChars / 2);
        return `${text.slice(0, half).trimEnd()}\n...[历史摘要过长，已保留开头和结尾]...\n${text.slice(-half).trimStart()}`;
    }

    async search(query, topK = null) {
        if (!this.enabled) return [];

        try {
            const response = await axios.post(`${this.apiUrl}/search`, {
                query,
                top_k: topK || this.injectTopK,
                user_id: 'feiniu_default',
                similarity_threshold: this.similarityThreshold
            }, { timeout: 3000 });

            return response.data.memories || [];
        } catch (error) {
            console.error('MemOS 搜索失败:', error.message);
            return [];
        }
    }

    async add(messages, options = {}) {
        if (!this.enabled) return { status: 'disabled' };

        try {
            const contextSummary = this._normalizeContextSummary(
                options.contextSummary ||
                options.context_summary ||
                options.historySummary ||
                options.history_summary ||
                options.compressedContext ||
                options.compressed_context
            );
            const payload = {
                messages,
                user_id: 'feiniu_default'
            };
            if (contextSummary) {
                payload.context_summary = contextSummary;
            }

            const response = await axios.post(`${this.apiUrl}/add`, payload, { timeout: 10000 });

            return response.data;
        } catch (error) {
            console.error('MemOS 添加记忆失败:', error.message);
            return { status: 'error', message: error.message };
        }
    }

    _snapshotBuffer() {
        return {
            messages: [...this.conversationBuffer],
            rounds: this.roundCount,
            contextSummary: this.bufferContextSummary,
            summaryVersion: this._bufferSummaryVersion
        };
    }

    _commitBufferSnapshot(snapshot) {
        const prefixMatches = snapshot.messages.every((message, index) =>
            this.conversationBuffer[index] === message
        );
        if (!prefixMatches) return false;

        this.conversationBuffer.splice(0, snapshot.messages.length);
        this.roundCount = Math.max(0, this.roundCount - snapshot.rounds);

        // Keep a summary when newer messages arrived while the request was in
        // flight; those messages still belong to the same buffered context.
        if (this._bufferSummaryVersion === snapshot.summaryVersion &&
            this.conversationBuffer.length === 0) {
            this.bufferContextSummary = null;
        }
        return true;
    }

    async _saveBufferSnapshot(status) {
        const snapshot = this._snapshotBuffer();
        if (snapshot.messages.length === 0) return { status: 'empty' };

        try {
            const result = await this.add(snapshot.messages, {
                contextSummary: snapshot.contextSummary
            });
            if (result?.status === 'error') {
                return {
                    status: 'error',
                    message: result.message || 'MemOS 写入失败',
                    result
                };
            }

            if (!this._commitBufferSnapshot(snapshot)) {
                return {
                    status: 'error',
                    message: 'MemOS 保存期间缓冲区发生变化，已保留本地缓冲以便重试',
                    result
                };
            }

            if (status === 'saved') {
                return {
                    status: 'saved',
                    result,
                    savedRounds: snapshot.rounds,
                    bufferedRounds: this.roundCount
                };
            }

            return {
                status: 'flushed',
                message: `已保存 ${snapshot.rounds} 轮对话`,
                result,
                bufferedRounds: this.roundCount
            };
        } catch (error) {
            console.error('MemOS 保存失败:', error.message);
            return { status: 'error', message: error.message, result: null };
        }
    }

    _startBufferSave(status) {
        if (this._savePromise) return this._savePromise;

        this._saving = true;
        const promise = this._saveBufferSnapshot(status).finally(() => {
            if (this._savePromise === promise) {
                this._savePromise = null;
                this._saving = false;
            }
        });
        this._savePromise = promise;
        return promise;
    }

    async addWithBuffer(messages, options = {}) {
        if (!this.enabled) return { status: 'disabled' };

        this.conversationBuffer.push(...messages);
        this.roundCount++;
        const contextSummary = this._normalizeContextSummary(
            options.contextSummary ||
            options.context_summary ||
            options.historySummary ||
            options.history_summary ||
            options.compressedContext ||
            options.compressed_context
        );
        if (contextSummary) {
            this.bufferContextSummary = contextSummary;
            this._bufferSummaryVersion++;
        }

        console.log(`[MemOS] 对话已缓存 (${this.roundCount}/${this.saveInterval} 轮)`);

        if (this.roundCount >= this.saveInterval && !this._saving) {
            console.log(`[MemOS] 达到 ${this.saveInterval} 轮，开始保存记忆...`);
            return await this._startBufferSave('saved');
        }

        return { status: 'buffered', bufferedRounds: this.roundCount, remaining: this.saveInterval - this.roundCount };
    }

    async flushBuffer() {
        if (!this.enabled) return { status: 'empty' };

        if (this._savePromise) {
            const inFlightResult = await this._savePromise;
            if (inFlightResult?.status === 'error') return inFlightResult;
        }
        if (this.conversationBuffer.length === 0) return { status: 'empty' };

        console.log(`[MemOS] 强制保存缓存的 ${this.roundCount} 轮对话...`);
        return await this._startBufferSave('flushed');
    }

    /** 将 ISO/时间戳格式化为中文本地日期时间，供 AI 理解「记忆发生时间」 */
    _formatMemoryTimeForPrompt(timestamp) {
        if (!timestamp) return '';
        try {
            const d = new Date(timestamp);
            if (isNaN(d.getTime())) {
                return typeof timestamp === 'string' ? timestamp : String(timestamp);
            }
            return d.toLocaleString('zh-CN', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false
            });
        } catch (_) {
            return typeof timestamp === 'string' ? timestamp : String(timestamp);
        }
    }

    formatMemoriesForPrompt(memories) {
        if (!memories || memories.length === 0) return '';

        return memories.map(mem => {
            const content = typeof mem === 'string' ? mem : mem.content;
            const pl = mem && typeof mem.payload === 'object' && mem.payload ? mem.payload : null;
            const timestamp = mem.created_at || mem.timestamp || (pl && (pl.created_at || pl.timestamp));
            const updatedAt = mem.updated_at || (pl && pl.updated_at);

            const timeStr = this._formatMemoryTimeForPrompt(timestamp);
            const updateMark = (updatedAt && updatedAt !== timestamp) ? '（已更新）' : '';
            return timeStr ? `- ${content} 【${timeStr}】${updateMark}` : `- ${content}`;
        }).join('\n');
    }

    async isAvailable() {
        if (!this.enabled) return false;
        try {
            const response = await axios.get(`${this.apiUrl}/health`, { timeout: 2000 });
            return response.data.status === 'healthy';
        } catch (_) {
            return false;
        }
    }
}

module.exports = { MemosClient };
