// 只操作 acceptance-server 与手工启动的隔离 Songloft；不得指向用户日常实例。
// node songloft-plugin/test/host-acceptance.mjs <隔离目录>
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const root = resolve(process.argv[2] || '');
const host = 'http://127.0.0.1:58192';
const prefix = '/api/v1/jsplugin/hmusic-bridge';
const token = JSON.parse(readFileSync(join(root, 'host-auth.json'), 'utf8')).access_token;
const hmusicToken = JSON.parse(readFileSync(join(root, 'hmusic-auth.json'), 'utf8')).accessToken;
const results = [];
async function api(path, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(host + path, { method,
    headers: { Authorization: `Bearer ${token}`, ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  assert.ok(response.ok, `${method} ${path} failed: HTTP ${response.status}`);
  return data;
}
async function upload(file) {
  const form = new FormData();
  form.set('file', new Blob([readFileSync(file)], { type: 'application/zip' }), 'hmusic-bridge.jsplugin.zip');
  const result = await api('/api/v1/jsplugins/upload', form);
  assert.equal(result.success, 1, JSON.stringify(result));
  return result.results[0].plugin;
}
async function check(name, action) {
  const start = Date.now();
  await action();
  results.push({ name, passed: true, durationMs: Date.now() - start });
  console.log('PASS', name);
  writeFileSync(join(root, 'host-results.json'), JSON.stringify(results, null, 2));
}
const currentZip = new URL('../dist/hmusic-bridge.jsplugin.zip', import.meta.url);
const fixtureTrack = { id: 'acceptance:acceptance-audio', source: 'acceptance', sourceTrackId: 'acceptance-audio',
  title: '验收音频', artist: 'HMusic', durationMs: 3000, url: 'http://127.0.0.1:58194/expired.wav' };
const fixtureItem = { source_data: { schema_version: 1, provider: 'hmusic', track: fixtureTrack } };
let id;
await check('安装 0.1.0 并保存连接', async () => {
  await upload(join(root, 'hmusic-bridge-0.1.0.jsplugin.zip'));
  const c = await api(prefix + '/api/config', { baseUrl: 'http://127.0.0.1:58193', token: hmusicToken });
  assert.equal(c.hasToken, true);
});
await check('升级到 0.2.0 后配置和鉴权保持', async () => {
  await upload(currentZip);
  const c = await api(prefix + '/api/config');
  assert.equal(c.hasToken, true);
  assert.equal(c.baseUrl, 'http://127.0.0.1:58193');
  assert.equal((await api(prefix + '/api/status')).authenticated, true);
});
await check('真实宿主搜索和重复入库去重', async () => {
  const search = await api(prefix + '/api/search', { keyword: 'hmusic-test-tone', source: 'manual' });
  assert.ok(search.results.length);
  const one = await api(prefix + '/api/import', { items: search.results });
  const two = await api(prefix + '/api/import', { items: search.results });
  assert.deepEqual(one.songs.map(s => s.id), two.songs.map(s => s.id));
  assert.equal(typeof one.songs[0].id, 'number');
});
await check('原始 source_data 的旧链接被刷新，媒体 headers 返回宿主', async () => {
  const media = await api(prefix + '/api/music/url', fixtureItem);
  assert.equal(media.headers.Referer, 'https://hmusic-acceptance.test/');
  assert.ok(!media.url.endsWith('/expired.wav'));
  const created = await api(prefix + '/api/import', { items: [fixtureItem] });
  id = created.songs[0].id;
});
await check('宿主播放接口完成解析、带 headers 拉取媒体并返回 WAV 音频', async () => {
  const response = await fetch(host + `/api/v1/songs/${id}/play`, { headers: { Authorization: `Bearer ${token}`, Range: 'bytes=0-43' }, signal: AbortSignal.timeout(60000) });
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.ok(response.ok, `play HTTP ${response.status}: ${bytes.toString().slice(0, 200)}`);
  assert.equal(bytes.subarray(0, 4).toString(), 'RIFF');
  writeFileSync(join(root, 'played-audio.wav'), bytes);
});
await check('旧 URL 失效后重新解析得到新链接', async () => {
  const before = await api(prefix + '/api/music/url', fixtureItem);
  await fetch('http://127.0.0.1:58194/expire', { method: 'POST' });
  const after = await api(prefix + '/api/music/url', fixtureItem);
  assert.notEqual(before.url, after.url);
  assert.equal((await fetch(before.url, { headers: before.headers })).status, 403);
  assert.equal((await fetch(after.url, { headers: { ...after.headers, Range: 'bytes=0-1' } })).status, 206);
});
await check('完整 track 歌词接口', async () => {
  const lyrics = await api(prefix + '/api/lyrics', fixtureItem);
  assert.ok(lyrics.lyric.includes('验收歌词'));
  assert.ok(lyrics.tlyric.includes('Acceptance lyric'));
});
await check('禁用再启用后配置恢复', async () => {
  const list = await api('/api/v1/jsplugins');
  const plugins = Array.isArray(list) ? list : list.plugins;
  const plugin = plugins.find(p => p.entry_path === 'hmusic-bridge' || p.entryPath === 'hmusic-bridge');
  assert.ok(plugin);
  await api(`/api/v1/jsplugins/${plugin.id}/disable`, {});
  await api(`/api/v1/jsplugins/${plugin.id}/enable`, {});
  assert.equal((await api(prefix + '/api/status')).authenticated, true);
  await check('保留数据卸载并重装后配置恢复', async () => {
    await api(`/api/v1/jsplugins/${plugin.id}?keep_data=true`, undefined, 'DELETE');
    await upload(currentZip);
    assert.equal((await api(prefix + '/api/status')).authenticated, true);
  });
});
console.log(JSON.stringify({ passed: results.length, fixtureSongId: id }));
