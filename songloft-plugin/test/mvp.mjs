import assert from 'node:assert/strict';
import test from 'node:test';
import { call, jsonRes, loadPlugin, makeSongloft } from './helpers.mjs';

const original = { id: 'tx:old', source: 'tx', sourceTrackId: 'old', title: '测试歌曲', artist: '测试歌手', durationMs: 180000 };
const alternate = { ...original, id: 'kw:new', source: 'kw', sourceTrackId: 'new' };
const sourceData = (track = original) => ({ schema_version: 1, provider: 'hmusic', track });

async function backend(upstream, commResult = { success: true, data: { ok: true } }) {
  const host = makeSongloft();
  const requests = [];
  const messages = [];
  let lyricRegistered = false;
  host.songloft.lyrics = {
    registerProvider() { lyricRegistered = true; },
    unregisterProvider() { lyricRegistered = false; },
  };
  host.songloft.comm = { async call(...args) {
    messages.push(args);
    if (commResult instanceof Error) throw commResult;
    return typeof commResult === 'function' ? commResult(...args) : commResult;
  } };
  host.songloft.plugin = {
    getHostUrl: async () => 'http://songloft.test/',
    getToken: async () => 'fixture-host-token',
  };
  const sandbox = { songloft: host.songloft, console, URL, TextDecoder, Response, setTimeout, clearTimeout,
    fetch: async (url, init) => {
      requests.push({ url, ...init });
      return upstream(url, init);
    } };
  loadPlugin(sandbox);
  await call(sandbox, 'POST', '/api/config', { baseUrl: 'http://hmusic.test', token: 'fixture-token' });
  return { ...host, sandbox, requests, messages, lyricRegistered: () => lyricRegistered };
}

test('解析要求刷新和严格探测，临时 headers 返回宿主且不写入 source_data', async () => {
  const b = await backend(() => jsonRes({ url: 'https://cdn.test/fresh', headers: { Referer: 'https://music.test/' }, verified: true }));
  const response = await call(b.sandbox, 'POST', '/api/music/url', { source_data: sourceData({ ...original, url: 'https://cdn.test/expired' }) });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { url: 'https://cdn.test/fresh', headers: { Referer: 'https://music.test/' } });
  const request = JSON.parse(b.requests[0].body);
  assert.equal(request.refresh, true);
  assert.equal(request.strict, true);
  assert.ok(request.timeoutMs < Number(b.requests[0].headers['X-Fetch-Timeout-Ms']));
  assert.ok(!('X-Fetch-Control' in b.requests[0].headers));
});

test('旧 Server 未返回探测凭据时拒绝宣告解析成功', async () => {
  const b = await backend(() => jsonRes({ url: 'https://cdn.test/expired' }));
  const response = await call(b.sandbox, 'POST', '/api/music/url', { source_data: sourceData() });
  assert.equal(response.status, 404);
});

test('Server 严格探测失败后换源，并传回新来源和媒体 headers', async () => {
  const b = await backend((url, init) => {
    if (url.includes('/search?')) return jsonRes({ tracks: [original, alternate] });
    if (JSON.parse(init.body).track.source === 'tx') return jsonRes({ error: 'dead media' }, 501);
    return jsonRes({ url: 'https://cdn.test/fresh', headers: { Referer: 'https://music.test/' }, verified: true });
  });
  const response = await call(b.sandbox, 'POST', '/api/music/url', { source_data: sourceData(), fallback: {
    enabled: true, title: original.title, artist: original.artist, duration: 180,
  } });
  assert.equal(response.body.used_fallback, true);
  assert.equal(response.body.source_data.track.source, 'kw');
  assert.equal(response.body.headers.Referer, 'https://music.test/');
  assert.ok(!JSON.stringify(response.body.source_data).includes('fixture-token'));
});

test('来源筛选传递给 Server，非法来源和小数页码不会出站', async () => {
  const b = await backend(() => jsonRes({ tracks: [alternate] }));
  assert.equal((await call(b.sandbox, 'POST', '/api/search', { keyword: '测试', source: 'kw' })).status, 200);
  assert.equal(new URL(b.requests[0].url).searchParams.get('source'), 'kw');
  for (const options of [{ source: 'bad' }, { page: 1.5 }, { page_size: -1 }]) {
    assert.equal((await call(b.sandbox, 'POST', '/api/search', { keyword: '测试', ...options })).status, 400);
  }
  assert.equal(b.requests.length, 1);
});

test('MIoT 返回最佳同曲、解析型身份和去重键，不写库或返回临时 URL', async () => {
  const b = await backend(() => jsonRes({ tracks: [
    { ...original, artist: '其他歌手' }, { ...alternate, durationMs: 200000 }, original,
  ] }));
  const response = await call(b.sandbox, 'POST', '/api/search/topone', {
    keyword: '测试', hint: { title: original.title, artist: original.artist, duration: 180 },
  });
  assert.equal(response.body.code, 0);
  assert.equal(response.body.data.dedup_key, 'hmusic:tx:old');
  assert.equal(response.body.data.plugin_entry_path, 'hmusic-bridge');
  assert.ok(!response.body.data.url);
  assert.equal(b.importCalls.length, 0);
});

test('MIoT 无匹配返回 null，不把翻唱错认成目标歌手', async () => {
  const b = await backend(() => jsonRes({ tracks: [{ ...original, artist: '其他歌手' }] }));
  const response = await call(b.sandbox, 'POST', '/api/search/topone', {
    keyword: '测试', hint: { title: original.title, artist: original.artist },
  });
  assert.equal(response.body.data, null);
});

test('歌词用 POST 传完整 track，可处理尚未进入 HMusic 队列的歌曲', async () => {
  const b = await backend(() => jsonRes({ lrc: '[00:01.00]原文', translatedLines: [{ timeMs: 1234, text: '译文' }] }));
  const response = await call(b.sandbox, 'POST', '/api/lyrics', { source_data: sourceData() });
  assert.deepEqual(response.body, { lyric: '[00:01.00]原文', tlyric: '[00:01.234]译文' });
  assert.equal(b.requests[0].method, 'POST');
  assert.equal(new URL(b.requests[0].url).pathname, '/api/v1/tracks/lyrics');
  assert.deepEqual(JSON.parse(b.requests[0].body).track, original);
});

test('宿主歌词 provider 搜索同曲后取词', async () => {
  const b = await backend((url) => url.includes('/search?')
    ? jsonRes({ tracks: [original] }) : jsonRes({ lrc: '[00:01.00]原文' }));
  const response = await b.sandbox.onHTTPRequest({ method: 'GET', path: '/lyric-search', headers: {}, body: '',
    query: new URLSearchParams({ title: original.title, artist: original.artist }).toString() });
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).lyric, '[00:01.00]原文');
});

test('休眠保留歌词与 MIoT 注册，缺少 MIoT 不阻塞插件启动', async () => {
  const b = await backend(() => jsonRes({}));
  await b.sandbox.onInit();
  assert.equal(b.lyricRegistered(), true);
  assert.equal(b.messages[0][1], 'register-search-provider');
  assert.equal((await call(b.sandbox, 'POST', '/api/miot/register', {})).body.registered, true);
  await b.sandbox.onDeinit();
  assert.equal(b.lyricRegistered(), true);
  assert.ok(b.messages.every(message => message[1] === 'register-search-provider'));
  const missing = await backend(() => jsonRes({}), new Error('not installed'));
  await missing.sandbox.onInit();
  assert.equal(missing.lyricRegistered(), true);
  assert.equal((await call(missing.sandbox, 'POST', '/api/miot/register', {})).body.registered, false);
});

test('手动注册先用宿主凭据唤醒 MIoT，初始化不发起递归宿主请求', async () => {
  let sleeping = true;
  const b = await backend((url, init) => {
    assert.equal(url, 'http://songloft.test/api/v1/jsplugin/miot/search-providers');
    assert.equal(init.headers.Authorization, 'Bearer fixture-host-token');
    assert.equal(init.headers['X-Fetch-Timeout-Ms'], '3000');
    sleeping = false;
    return jsonRes({ providers: [] });
  }, () => {
    if (sleeping) throw new Error('service not found');
    return { success: true, data: { ok: true } };
  });
  await b.sandbox.onInit();
  assert.equal(b.requests.length, 0);
  assert.equal((await call(b.sandbox, 'POST', '/api/miot/register', {})).body.registered, true);
  assert.equal(b.requests.length, 1);
});

test('MIoT 缺失或返回失败时，不把通信成功当作注册成功', async () => {
  const missing = await backend(() => jsonRes({ error: 'not installed' }, 404));
  assert.equal((await call(missing.sandbox, 'POST', '/api/miot/register', {})).body.registered, false);
  assert.equal(missing.messages.length, 0);
  for (const result of [null, { ok: true }, { success: true },
    { success: false, data: { ok: true } }, { success: true, data: { ok: false } }]) {
    const b = await backend(() => jsonRes({ providers: [] }), result);
    assert.equal((await call(b.sandbox, 'POST', '/api/miot/register', {})).body.registered, false);
  }
});
