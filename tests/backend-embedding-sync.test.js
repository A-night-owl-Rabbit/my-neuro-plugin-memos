'use strict';

const assert = require('node:assert/strict');
const path = require('path');
const test = require('node:test');

const MemosPlugin = require(path.join(__dirname, '..', 'index.js'));
const { buildBackendEmbeddingConfig, describeEmbeddingModeMismatch } = MemosPlugin;

function makePlugin() {
    const logs = [];
    const subtitles = [];
    const plugin = new MemosPlugin();
    plugin.context = {
        log(level, text) { logs.push({ level, text }); },
        showSubtitle(text) { subtitles.push(text); }
    };
    plugin._cfg = { backend_embedding: { provider: 'api' } };
    plugin._embeddingMismatchOnceKey = null;
    plugin.client = {
        async fetchHealth() {
            return plugin._fakeHealth || null;
        }
    };
    plugin._logs = logs;
    plugin._subtitles = subtitles;
    return plugin;
}

test('no backend_embedding keeps backend config untouched', () => {
    const backend = {
        embedding: { model_path: '../full-hub/rag-hub', vector_size: 1024, api: { timeout_sec: 10 } },
        search: { enable_reranker: true, rerank_top_n: 20, reranker_api: { max_retries: 1 } }
    };
    const before = JSON.stringify(backend);
    const after = buildBackendEmbeddingConfig({}, backend);
    assert.equal(after, backend);
    assert.equal(JSON.stringify(after), before);
});

test('api provider writes 8 keys and keeps tuning fields', () => {
    const backend = {
        embedding: {
            model_path: '../full-hub/rag-hub',
            vector_size: 1024,
            api: { timeout_sec: 10, batch_size: 32 }
        },
        search: {
            enable_reranker: true,
            rerank_top_n: 20,
            similarity_threshold: 0.5,
            reranker_api: { max_retries: 1, circuit_break_failures: 3 }
        }
    };
    const result = buildBackendEmbeddingConfig({
        backend_embedding: {
            provider: 'api',
            api_base_url: 'https://api.siliconflow.cn/v1',
            api_key: 'sk-test',
            embedding_model: 'BAAI/bge-m3',
            rerank_model: 'BAAI/bge-reranker-v2-m3'
        }
    }, backend);
    assert.equal(result.embedding.provider, 'api');
    assert.equal(result.embedding.api.base_url, 'https://api.siliconflow.cn/v1');
    assert.equal(result.embedding.api.model, 'BAAI/bge-m3');
    assert.equal(result.embedding.api.api_key, 'sk-test');
    assert.equal(result.search.reranker_provider, 'api');
    assert.equal(result.search.reranker_api.base_url, 'https://api.siliconflow.cn/v1');
    assert.equal(result.search.reranker_api.model, 'BAAI/bge-reranker-v2-m3');
    assert.equal(result.search.reranker_api.api_key, 'sk-test');
    assert.equal(result.embedding.model_path, '../full-hub/rag-hub');
    assert.equal(result.embedding.vector_size, 1024);
    assert.equal(result.embedding.api.timeout_sec, 10);
    assert.equal(result.search.enable_reranker, true);
    assert.equal(result.search.rerank_top_n, 20);
    assert.equal(result.search.reranker_api.max_retries, 1);
});

test('illegal provider falls back to local', () => {
    const result = buildBackendEmbeddingConfig({
        backend_embedding: { provider: 'weird', api_base_url: 'https://api.siliconflow.cn/v1' }
    }, {});
    assert.equal(result.embedding.provider, 'local');
    assert.equal(result.search.reranker_provider, 'local');
});

test('empty api_key still writes provider api', () => {
    const result = buildBackendEmbeddingConfig({
        backend_embedding: { provider: 'api', api_key: '   ' }
    }, {});
    assert.equal(result.embedding.provider, 'api');
    assert.equal(result.embedding.api.api_key, '');
});

test('mismatch helper covers warning, provider gap, env override, and match', () => {
    const warning = describeEmbeddingModeMismatch({
        embedding: { warning: 'API 密钥未配置，已按本地模型运行', provider: 'local' }
    }, 'api');
    assert.equal(warning.level, 'warn');
    assert.match(warning.text, /API 密钥未配置/);

    const mismatch = describeEmbeddingModeMismatch({
        embedding: { provider: 'local', warning: null, env_overrides: [] }
    }, 'api');
    assert.equal(mismatch.level, 'warn');
    assert.match(mismatch.text, /API 调用/);

    const env = describeEmbeddingModeMismatch({
        embedding: { provider: 'api', warning: null, env_overrides: ['MEMOS_EMBEDDING_PROVIDER'] }
    }, 'local');
    assert.equal(env.level, 'warn');
    assert.match(env.text, /MEMOS_EMBEDDING_PROVIDER/);

    const ok = describeEmbeddingModeMismatch({
        embedding: { provider: 'api', warning: null, env_overrides: [] }
    }, 'api');
    assert.equal(ok.level, 'info');
    assert.equal(ok.onceKey, null);
});

test('mismatch reminder fires once for the same warning', async () => {
    const plugin = makePlugin();
    plugin._fakeHealth = {
        embedding: { warning: 'API 密钥未配置，已按本地模型运行', provider: 'local' }
    };
    await plugin._checkEmbeddingModeMismatch();
    await plugin._checkEmbeddingModeMismatch();
    assert.equal(plugin._subtitles.length, 1);
    assert.equal(plugin._logs.filter(item => item.level === 'warn').length, 1);
});

test('matching provider does not subtitle', async () => {
    const plugin = makePlugin();
    plugin._cfg.backend_embedding.provider = 'local';
    plugin._fakeHealth = { embedding: { provider: 'local', warning: null, env_overrides: [] } };
    await plugin._checkEmbeddingModeMismatch();
    assert.equal(plugin._subtitles.length, 0);
    assert.equal(plugin._logs.some(item => item.level === 'info' && /向量模式: local/.test(item.text)), true);
});
