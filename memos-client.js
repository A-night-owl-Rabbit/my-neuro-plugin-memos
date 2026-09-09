const axios = require('axios');

// 提取失败后的重试退避：60s 起步，每次失败翻倍，最长 10 分钟；成功后归零
const BACKOFF_BASE_MS = 60 * 1000;
const BACKOFF_MAX_MS = 10 * 60 * 1000;
const MESSAGES_PER_ROUND = 2;
// /add 是后台异步调用，不阻塞对话。后端一次"大模型提取 + 实体提取"常需 15~30 秒，
// 旧值 10 秒会在后端仍在处理时就判定网络错误并重发同一批对话，造成重复提取。
const ADD_TIMEOUT_MS = 180 * 1000;

class MemosClient {
    constructor(pluginConfig) {
        this.enabled = pluginConfig.enabled !== false;
        this.apiUrl = pluginConfig.api_url || 'http://127.0.0.1:8003';
        this.autoInject = pluginConfig.auto_inject !== false;
        this.injectTopK = pluginConfig.inject_top_k ?? 3;
        this.similarityThreshold = pluginConfig.similarity_threshold ?? 0.6;
        this.autoSave = pluginConfig.auto_save !== false;
        this.saveInterval = pluginConfig.save_interval ?? 5;
        // 提取失败时是否保留对话等待重试（默认开）；缓冲最多保留多少轮（默认 3 倍保存间隔）
        this.extractionRetryEnabled = pluginConfig.extraction_retry_enabled !== false;
        const defaultMaxRounds = Math.max(this.saveInterval * 3, this.saveInterval);
        const configuredMaxRounds = Number(pluginConfig.max_buffered_rounds);
        this.maxBufferedRounds = Number.isFinite(configuredMaxRounds) && configuredMaxRounds >= this.saveInterval
            ? Math.floor(configuredMaxRounds)
            : defaultMaxRounds;

        this.conversationBuffer = [];
        this.bufferContextSummary = null;
        this.roundCount = 0;
        this._saving = false;
        this._bufferSummaryVersion = 0;
        this._savePromise = null;

        // 提取链路健康（前端视角）
        this._extractionFailStreak = 0;
        this._extractionLastStatus = null;
        this._extractionLastError = null;
        this._extractionLastFailedAt = null;
        this._extractionLastOkAt = null;
        this._backoffMs = 0;
        this._nextSaveAllowedAt = 0;
        this._droppedRounds = 0;
        this._now = () => Date.now();
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
            }, { timeout: 6000 });

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

            const response = await axios.post(`${this.apiUrl}/add`, payload, { timeout: ADD_TIMEOUT_MS });

            return response.data;
        } catch (error) {
            console.error('MemOS 添加记忆失败:', error.message);
            return { status: 'error', message: error.message };
        }
    }

    /** 读取后端健康信息（含 extraction / write_gate / warnings），失败返回 null */
    async fetchHealth() {
        if (!this.enabled) return null;
        try {
            const response = await axios.get(`${this.apiUrl}/health`, { timeout: 3000 });
            return response.data || null;
        } catch (_) {
            return null;
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

    /** 缓冲超过上限时丢掉最旧的整轮，返回丢弃的轮数 */
    _enforceBufferCap() {
        let dropped = 0;
        while (this.roundCount > this.maxBufferedRounds && this.conversationBuffer.length >= MESSAGES_PER_ROUND) {
            this.conversationBuffer.splice(0, MESSAGES_PER_ROUND);
            this.roundCount -= 1;
            dropped += 1;
        }
        if (dropped > 0) {
            this._droppedRounds += dropped;
            console.warn(`[MemOS] 缓冲超过 ${this.maxBufferedRounds} 轮上限，已丢弃最旧的 ${dropped} 轮对话（累计 ${this._droppedRounds} 轮）`);
        }
        return dropped;
    }

    _isExtractionFailure(result) {
        const status = result?.extraction_status;
        return status === 'failed' || status === 'disabled';
    }

    _onExtractionSuccess(result) {
        this._extractionFailStreak = 0;
        this._extractionLastStatus = result?.extraction_status || 'ok';
        this._extractionLastError = null;
        this._extractionLastOkAt = this._now();
        this._backoffMs = 0;
        this._nextSaveAllowedAt = 0;
    }

    _onExtractionFailure(result) {
        this._extractionFailStreak += 1;
        this._extractionLastStatus = result?.extraction_status || 'failed';
        this._extractionLastError = result?.extraction_error || null;
        this._extractionLastFailedAt = this._now();
        if (this.extractionRetryEnabled) {
            this._backoffMs = this._backoffMs > 0
                ? Math.min(this._backoffMs * 2, BACKOFF_MAX_MS)
                : BACKOFF_BASE_MS;
            this._nextSaveAllowedAt = this._now() + this._backoffMs;
        }
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

            if (this._isExtractionFailure(result)) {
                this._onExtractionFailure(result);
                let retained = false;
                if (this.extractionRetryEnabled) {
                    // 后端收到了对话但没提取出来：留在缓冲里等下一次，防止对话白白丢掉
                    retained = true;
                    this._enforceBufferCap();
                } else {
                    this._commitBufferSnapshot(snapshot);
                }
                const nextRetryInMs = Math.max(0, this._nextSaveAllowedAt - this._now());
                console.warn(
                    `[MemOS] 记忆提取${result.extraction_status === 'disabled' ? '模型未配置' : '失败'}` +
                    `（连续 ${this._extractionFailStreak} 次${result.extraction_error ? `，原因: ${result.extraction_error}` : ''}）` +
                    (retained ? `，已保留 ${this.roundCount} 轮对话，${Math.round(nextRetryInMs / 1000)} 秒后重试` : '，本批对话已放弃')
                );
                return {
                    status: result.extraction_status === 'disabled' ? 'extraction_disabled' : 'extraction_failed',
                    extraction_status: result.extraction_status,
                    extraction_error: result.extraction_error || null,
                    failStreak: this._extractionFailStreak,
                    retained,
                    nextRetryInMs,
                    bufferedRounds: this.roundCount,
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
            this._onExtractionSuccess(result);

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
        this._enforceBufferCap();

        console.log(`[MemOS] 对话已缓存 (${this.roundCount}/${this.saveInterval} 轮)`);

        const dueByRounds = this.roundCount >= this.saveInterval;
        const backoffActive = this._now() < this._nextSaveAllowedAt;
        if (dueByRounds && !this._saving && !backoffActive) {
            console.log(`[MemOS] 达到 ${this.saveInterval} 轮，开始保存记忆...`);
            return await this._startBufferSave('saved');
        }

        if (dueByRounds && backoffActive) {
            const waitSec = Math.round((this._nextSaveAllowedAt - this._now()) / 1000);
            return {
                status: 'buffered',
                bufferedRounds: this.roundCount,
                remaining: 0,
                backoff: true,
                nextRetryInMs: this._nextSaveAllowedAt - this._now(),
                message: `提取失败退避中，${waitSec} 秒后重试`
            };
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

        // 退出前的最后一次保存不受退避限制
        console.log(`[MemOS] 强制保存缓存的 ${this.roundCount} 轮对话...`);
        return await this._startBufferSave('flushed');
    }

    /** 前端视角的提取健康信息，供插件提醒与日志使用 */
    getExtractionHealth() {
        return {
            failStreak: this._extractionFailStreak,
            lastStatus: this._extractionLastStatus,
            lastError: this._extractionLastError,
            lastFailedAt: this._extractionLastFailedAt,
            lastOkAt: this._extractionLastOkAt,
            backoffMs: this._backoffMs,
            nextRetryAt: this._nextSaveAllowedAt || null,
            bufferedRounds: this.roundCount,
            droppedRounds: this._droppedRounds,
            retryEnabled: this.extractionRetryEnabled,
            maxBufferedRounds: this.maxBufferedRounds
        };
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

module.exports = { MemosClient, BACKOFF_BASE_MS, BACKOFF_MAX_MS };
