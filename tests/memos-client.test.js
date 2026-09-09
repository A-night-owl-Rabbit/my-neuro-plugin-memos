'use strict';

// 运行：cd live-2d && node --test plugins/built-in/memos/tests/memos-client.test.js
// 覆盖：提取成功提交缓冲；连续失败保留缓冲 + 退避 60/120/240s；成功后清零；缓冲上限丢最旧；
//       extraction_retry_enabled=false 时失败也提交；插件提醒只触发一次、恢复后重置；启动时读 /health 提醒。

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const axios = require('axios');
const { MemosClient, BACKOFF_BASE_MS, BACKOFF_MAX_MS } = require(path.join(__dirname, '..', 'memos-client.js'));
const MemosPlugin = require(path.join(__dirname, '..', 'index.js'));

function stubAxios(handlers) {
    const originalPost = axios.post;
    const originalGet = axios.get;
    const calls = [];
    axios.post = async (url, payload) => {
        calls.push({ method: 'post', url, payload });
        const handler = handlers.post || (() => ({ data: {} }));
        return handler(url, payload, calls.length);
    };
    axios.get = async (url) => {
        calls.push({ method: 'get', url });
        const handler = handlers.get || (() => ({ data: { status: 'healthy' } }));
        return handler(url);
    };
    return {
        calls,
        restore() {
            axios.post = originalPost;
            axios.get = originalGet;
        }
    };
}

function makeClient(overrides = {}) {
    const client = new MemosClient({
        enabled: true,
        api_url: 'http://stub',
        save_interval: 2,
        max_buffered_rounds: 4,
        ...overrides
    });
    let now = 1_000_000;
    client._now = () => now;
    client.__advance = (ms) => { now += ms; };
    return client;
}

async function pushRounds(client, count, prefix = 'r') {
    let last = null;
    for (let i = 0; i < count; i++) {
        last = await client.addWithBuffer([
            { role: 'user', content: `${prefix}${i} 用户` },
            { role: 'assistant', content: `${prefix}${i} 回复` }
        ]);
    }
    return last;
}

test('1. 提取成功：达到保存间隔即提交，缓冲清空，streak 为 0', async () => {
    const stub = stubAxios({ post: () => ({ data: { status: 'success', added: 1, extraction_status: 'ok' } }) });
    try {
        const client = makeClient();
        const first = await pushRounds(client, 1);
        assert.equal(first.status, 'buffered');
        const second = await pushRounds(client, 1, 's');
        assert.equal(second.status, 'saved');
        assert.equal(client.roundCount, 0);
        assert.equal(client.conversationBuffer.length, 0);
        assert.equal(client.getExtractionHealth().failStreak, 0);
        assert.equal(stub.calls.filter(c => c.method === 'post').length, 1);
    } finally {
        stub.restore();
    }
});

test('2. 连续三次提取失败：缓冲保留、streak 递增、退避 60/120/240 秒', async () => {
    const stub = stubAxios({ post: () => ({ data: { status: 'success', added: 0, extraction_status: 'failed', extraction_error: 'timeout' } }) });
    try {
        const client = makeClient({ max_buffered_rounds: 20 });
        const expectedBackoffs = [BACKOFF_BASE_MS, BACKOFF_BASE_MS * 2, BACKOFF_BASE_MS * 4];
        for (let attempt = 0; attempt < 3; attempt++) {
            // 首次要凑够保存间隔（2 轮）；之后缓冲里已经 ≥ 间隔，退避一结束第 1 条新对话就触发重试
            client.__advance(BACKOFF_MAX_MS);
            const result = await pushRounds(client, attempt === 0 ? 2 : 1, `a${attempt}_`);
            assert.equal(result.status, 'extraction_failed', `attempt ${attempt} status`);
            assert.equal(result.retained, true, `attempt ${attempt} retained`);
            assert.equal(result.failStreak, attempt + 1, `attempt ${attempt} streak`);
            assert.equal(client._backoffMs, expectedBackoffs[attempt], `attempt ${attempt} backoff`);
            assert.equal(result.nextRetryInMs, expectedBackoffs[attempt], `attempt ${attempt} nextRetryInMs`);
        }
        // 三次都没提交：2 + 1 + 1 = 4 轮全部还在缓冲里
        assert.equal(client.roundCount, 4);
        assert.equal(client.conversationBuffer.length, 8);
        assert.equal(client.getExtractionHealth().lastError, 'timeout');
        assert.equal(stub.calls.filter(c => c.method === 'post').length, 3);
    } finally {
        stub.restore();
    }
});

test('3. 退避期内达到保存间隔不再请求后端；退避结束后才重试', async () => {
    let mode = 'failed';
    const stub = stubAxios({
        post: () => (mode === 'failed'
            ? { data: { status: 'success', extraction_status: 'failed', extraction_error: 'http_500' } }
            : { data: { status: 'success', added: 2, extraction_status: 'ok' } })
    });
    try {
        const client = makeClient({ max_buffered_rounds: 20 });
        const failed = await pushRounds(client, 2);
        assert.equal(failed.status, 'extraction_failed');
        const postsAfterFail = stub.calls.filter(c => c.method === 'post').length;

        // 退避中：再来 2 轮，达到间隔但不该请求
        const during = await pushRounds(client, 2, 'b');
        assert.equal(during.status, 'buffered');
        assert.equal(during.backoff, true);
        assert.equal(stub.calls.filter(c => c.method === 'post').length, postsAfterFail);

        // 退避结束且后端恢复：第 1 条新对话就触发重试，一次请求带走全部 5 轮，缓冲清空、streak 归零、退避归零
        mode = 'ok';
        client.__advance(BACKOFF_BASE_MS + 1);
        const recovered = await pushRounds(client, 1, 'c');
        assert.equal(recovered.status, 'saved');
        assert.equal(recovered.savedRounds, 5);
        assert.equal(client.roundCount, 0);
        assert.equal(client._backoffMs, 0);
        assert.equal(client._nextSaveAllowedAt, 0);
        assert.equal(client.getExtractionHealth().failStreak, 0);
        const lastPost = stub.calls.filter(c => c.method === 'post').pop();
        assert.equal(lastPost.payload.messages.length, 10);
    } finally {
        stub.restore();
    }
});

test('4. 缓冲达到上限：丢最旧一轮，保留最新，累计丢弃计数', async () => {
    const stub = stubAxios({ post: () => ({ data: { status: 'success', extraction_status: 'failed', extraction_error: 'connection' } }) });
    try {
        const client = makeClient({ save_interval: 2, max_buffered_rounds: 3 });
        await pushRounds(client, 2, 'x');          // 失败，保留 2 轮
        client.__advance(BACKOFF_MAX_MS);
        await pushRounds(client, 2, 'y');          // 累计 4 轮 > 3 → 丢 1 轮（x0）
        assert.equal(client.roundCount, 3);
        assert.equal(client.conversationBuffer.length, 6);
        assert.equal(client.conversationBuffer[0].content, 'x1 用户');
        assert.equal(client.getExtractionHealth().droppedRounds, 1);
        client.__advance(BACKOFF_MAX_MS);
        await pushRounds(client, 3, 'z');          // 累计 6 轮 → 丢到 3 轮
        assert.equal(client.roundCount, 3);
        assert.equal(client.conversationBuffer[0].content, 'z0 用户');
        assert.equal(client.getExtractionHealth().droppedRounds, 4);
    } finally {
        stub.restore();
    }
});

test('5. extraction_retry_enabled=false：失败也提交快照（旧行为），仍计 streak', async () => {
    const stub = stubAxios({ post: () => ({ data: { status: 'success', extraction_status: 'failed', extraction_error: 'timeout' } }) });
    try {
        const client = makeClient({ extraction_retry_enabled: false });
        const result = await pushRounds(client, 2);
        assert.equal(result.status, 'extraction_failed');
        assert.equal(result.retained, false);
        assert.equal(client.roundCount, 0);
        assert.equal(client.getExtractionHealth().failStreak, 1);
        assert.equal(client._nextSaveAllowedAt, 0, '关闭重试时不设退避');
    } finally {
        stub.restore();
    }
});

test('6. 网络层错误（status=error）保持旧行为：保留缓冲、不计入提取失败', async () => {
    const stub = stubAxios({ post: () => { throw new Error('ECONNREFUSED'); } });
    try {
        const client = makeClient();
        const result = await pushRounds(client, 2);
        assert.equal(result.status, 'error');
        assert.equal(client.roundCount, 2);
        assert.equal(client.getExtractionHealth().failStreak, 0);
    } finally {
        stub.restore();
    }
});

test('7. 旧后端没有 extraction_status 字段：按成功处理', async () => {
    const stub = stubAxios({ post: () => ({ data: { status: 'success', added: 1 } }) });
    try {
        const client = makeClient();
        const result = await pushRounds(client, 2);
        assert.equal(result.status, 'saved');
        assert.equal(client.roundCount, 0);
    } finally {
        stub.restore();
    }
});

test('8. extraction_status=empty（确实没可记内容）按成功处理，不计失败', async () => {
    const stub = stubAxios({ post: () => ({ data: { status: 'success', added: 0, extraction_status: 'empty' } }) });
    try {
        const client = makeClient();
        const result = await pushRounds(client, 2);
        assert.equal(result.status, 'saved');
        assert.equal(client.getExtractionHealth().failStreak, 0);
    } finally {
        stub.restore();
    }
});

function makePluginWithFakeContext(cfg = {}) {
    const logs = [];
    const subtitles = [];
    const context = {
        getPluginFileConfig: () => ({ enabled: true, api_url: 'http://stub', save_interval: 2, extraction_failure_notice_threshold: 3, ...cfg }),
        log: (level, message) => logs.push({ level, message }),
        showSubtitle: (text, duration) => subtitles.push({ text, duration }),
        getMessages: () => [],
        addSystemPromptPatch() {},
        removeSystemPromptPatch() {},
        resolveLLM: () => null
    };
    const plugin = new MemosPlugin({ name: 'memos' }, context);
    return { plugin, context, logs, subtitles };
}

test('9. 插件提醒：连续 3 次失败只弹一次字幕，成功后重置，再次累计到阈值才再弹', async () => {
    const { plugin, subtitles, logs } = makePluginWithFakeContext();
    await plugin.onInit();
    assert.equal(plugin._noticeThreshold, 3);

    const failed = (streak) => ({ status: 'extraction_failed', extraction_status: 'failed', extraction_error: 'timeout', failStreak: streak, retained: true, bufferedRounds: streak * 2 });
    plugin._handleSaveResult(failed(1));
    plugin._handleSaveResult(failed(2));
    assert.equal(subtitles.length, 0, '未到阈值不提醒');
    plugin._handleSaveResult(failed(3));
    assert.equal(subtitles.length, 1, '到阈值提醒一次');
    assert.match(subtitles[0].text, /连续失败 3 次/);
    plugin._handleSaveResult(failed(4));
    plugin._handleSaveResult(failed(5));
    assert.equal(subtitles.length, 1, '同一段连续失败不重复提醒');

    plugin._handleSaveResult({ status: 'saved', savedRounds: 2, bufferedRounds: 0 });
    assert.ok(logs.some(l => l.message.includes('已恢复正常')), '恢复时写日志');
    plugin._handleSaveResult(failed(1));
    plugin._handleSaveResult(failed(2));
    assert.equal(subtitles.length, 1);
    plugin._handleSaveResult(failed(3));
    assert.equal(subtitles.length, 2, '恢复后再次累计到阈值才再提醒');

    plugin._handleSaveResult({ status: 'extraction_disabled', extraction_status: 'disabled', failStreak: 3, retained: true, bufferedRounds: 6 });
    assert.equal(subtitles.length, 2, 'disabled 与 failed 共用同一段提醒状态');
    assert.ok(logs.filter(l => l.level === 'warn').length >= 6, '每次失败都有 warn 日志');
});

test('10. 插件启动：后端 /health 报 failing 或 warnings 时提醒一次；ok 时只记 info', async () => {
    const stub = stubAxios({
        get: () => ({ data: { status: 'healthy', extraction: { status: 'failing', consecutive_failures: 4, last_error: 'timeout' }, warnings: ['记忆提取已连续失败 4 次，最后错误：timeout'] } })
    });
    try {
        const { plugin, subtitles, logs } = makePluginWithFakeContext();
        await plugin.onInit();
        plugin._syncBackendConfig = () => {};
        await plugin.onStart();
        assert.equal(subtitles.length, 1);
        assert.match(subtitles[0].text, /连续失败 4 次/);
        assert.ok(logs.some(l => l.level === 'warn' && l.message.includes('MemOS 后端提示')));
    } finally {
        stub.restore();
    }

    const stubOk = stubAxios({
        get: () => ({ data: { status: 'healthy', extraction: { status: 'ok', last_ok_at: '2026-09-03T22:00:00' }, warnings: [] } })
    });
    try {
        const { plugin, subtitles, logs } = makePluginWithFakeContext();
        await plugin.onInit();
        plugin._syncBackendConfig = () => {};
        await plugin.onStart();
        assert.equal(subtitles.length, 0);
        assert.ok(logs.some(l => l.level === 'info' && l.message.includes('记忆提取状态: ok')));
    } finally {
        stubOk.restore();
    }
});

test('11. 配置解析：阈值非法回落 3；缓冲上限不能小于保存间隔', async () => {
    const { plugin } = makePluginWithFakeContext({ extraction_failure_notice_threshold: 'abc' });
    await plugin.onInit();
    assert.equal(plugin._noticeThreshold, 3);
    const client = new MemosClient({ enabled: true, save_interval: 5, max_buffered_rounds: 2 });
    assert.equal(client.maxBufferedRounds, 15, '小于保存间隔时回落默认 3 倍');
    const client2 = new MemosClient({ enabled: true, save_interval: 5 });
    assert.equal(client2.maxBufferedRounds, 15);
    const client3 = new MemosClient({ enabled: true, save_interval: 5, max_buffered_rounds: 8 });
    assert.equal(client3.maxBufferedRounds, 8);
});
