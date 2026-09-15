// 仅用于隔离验收：真实 HMusic App + 本地媒体夹具；数据与凭据落入指定临时目录。
// 从仓库根运行 node --import tsx songloft-plugin/test/acceptance-server.mjs <临时目录> [真实 LX 文件]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

if (!process.argv[2]) throw new Error('acceptance data directory is required');
const root = resolve(process.argv[2]);
// 用户 LX 脚本可能自行打印订阅凭据，验收日志不转发脚本的 console.log。
const printReady = console.log;
console.log = () => {};
mkdirSync(join(root, 'hmusic-data'), { recursive: true });
Object.assign(process.env, {
  HMUSIC_HOST: '127.0.0.1', HMUSIC_PORT: '58193',
  HMUSIC_DATA_DIR: join(root, 'hmusic-data'), HMUSIC_DATABASE_URL: join(root, 'hmusic-data/test.db'),
  HMUSIC_JWT_SECRET: randomBytes(32).toString('hex'), HMUSIC_LOG_LEVEL: 'silent',
  HMUSIC_PUBLIC_BASE_URL: 'http://127.0.0.1:58193',
});
const { buildApp } = await import('../../src/app.ts');
const { createTestToneWav } = await import('../../src/shared/test-tone.ts');
const wav = createTestToneWav();
let generation = 1;
const media = createServer((req, res) => {
  if (req.url === '/generation') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ generation }));
    return;
  }
  if (req.url === '/expire' && req.method === 'POST') {
    generation++;
    res.end('{}');
    return;
  }
  if (req.url !== `/audio-${generation}.wav` || req.headers.referer !== 'https://hmusic-acceptance.test/') {
    res.writeHead(403); res.end(); return;
  }
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
  const start = range ? Number(range[1]) : 0;
  const end = range && range[2] ? Math.min(Number(range[2]), wav.length - 1) : wav.length - 1;
  res.writeHead(range ? 206 : 200, { 'Content-Type': 'audio/wav', 'Content-Length': end - start + 1,
    'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${wav.length}` } : {}) });
  res.end(wav.subarray(start, end + 1));
});
await new Promise((done) => media.listen(58194, '127.0.0.1', done));
const app = await buildApp();
await app.listen({ host: '127.0.0.1', port: 58193 });
const setup = await app.inject({ method: 'POST', url: '/api/v1/auth/setup',
  payload: { username: 'acceptance', password: randomBytes(24).toString('hex') } });
if (setup.statusCode !== 200) throw new Error('Use a fresh acceptance directory');
const token = setup.json().accessToken;
writeFileSync(join(root, 'hmusic-auth.json'), JSON.stringify({ accessToken: token }), { mode: 0o600 });
async function api(path, payload) {
  const result = await app.inject({ method: 'POST', url: path, headers: { authorization: `Bearer ${token}` }, payload });
  if (result.statusCode >= 400) throw new Error(`${path}: ${result.statusCode}`);
}
await api('/api/v1/sources/lx-plugins', { id: 'acceptance', name: 'Acceptance media', enabled: true,
  code: `module.exports.search = (q) => q.keyword && q.keyword.includes('验收') ? [{ id: 'acceptance-audio', title: '验收音频', artist: 'HMusic', duration: '00:03' }] : [];
  module.exports.getUrl = async (track) => {
    if (track.id !== 'acceptance-audio') return undefined;
    const state = await (await fetch('http://127.0.0.1:58194/generation')).json();
    return {url: 'http://127.0.0.1:58194/audio-' + state.generation + '.wav', headers: {Referer: 'https://hmusic-acceptance.test/'}};
  };
  module.exports.getLyric = (track) => track.id === 'acceptance-audio' ? {lrc: '[00:00.00]验收歌词', tlyric: '[00:00.00]Acceptance lyric'} : undefined;`,
});
if (process.argv[3]) {
  await api('/api/v1/sources/lx-plugins', { id: 'acceptance-online', name: 'Online source', enabled: true,
    code: readFileSync(resolve(process.argv[3]), 'utf8') });
}
printReady('HMusic acceptance ready at 127.0.0.1:58193; media fixture at 58194');
async function stop() { await app.close(); media.closeAllConnections(); media.close(); }
process.once('SIGTERM', () => stop().then(() => process.exit(0)));
process.once('SIGINT', () => stop().then(() => process.exit(0)));
