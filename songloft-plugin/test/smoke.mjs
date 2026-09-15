// HMusic Bridge 冒烟测试
// 用法: node test/smoke.mjs <HMusicBaseUrl> <JWT>
// 离线: node test/smoke.mjs --offline（只运行 Phase B/C，不访问真实服务）
// Phase A(live):Node vm 加载 build/main.js + 模拟宿主 songloft 全局,对真实 HMusic-Server
//   跑配置(token 沿用/清空) → 状态 → 搜索 → source_data 契约 → 解析可播性 → fallback 换源 → 入库。
// Phase B(mock):拦截 fetch 伪造 HMusic 响应,覆盖候选遍历:
//   已证死的目标曲被排除;候选失败后继续尝试下一个,不重复解析死链。

import { call, jsonRes, loadPlugin, makeSongloft } from './helpers.mjs';

const offline = process.argv.includes('--offline');
const baseUrl = process.argv[2] ?? 'http://127.0.0.1:6650';
const token = process.argv[3] ?? '';
if (!offline && !token) {
  console.error('在线冒烟需要服务地址和 JWT；离线验证请运行 npm test 或 npm run smoke -- --offline。');
  process.exit(2);
}

let failures = 0;
let checks = 0;
function check(name, cond, extra) {
  checks++;
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.log(`  ✗ ${name}${extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 300) : ''}`); }
}

// ===== Phase A:live =====
async function runLive() {
  console.log('Phase A — live HMusic-Server');

  const { songloft, storageMap, importCalls } = makeSongloft();
  const sandbox = {
    console,
    fetch: (url, init) => fetch(url, init),
    setTimeout,
    clearTimeout,
    URL,
    TextDecoder,
    Response,
    songloft,
    globalThis: {},
  };
  loadPlugin(sandbox);

  // 1. 配置
  {
    const r = await call(sandbox, 'POST', '/api/config', { baseUrl, token });
    check('保存配置', r.status === 200 && r.body.ok && r.body.baseUrl === baseUrl && r.body.hasToken === Boolean(token), r);

    const p80 = await call(sandbox, 'POST', '/api/config', { baseUrl: 'http://example.test:80', token });
    check('显式默认端口(:80)+token → 保存', p80.status === 200 && p80.body.hasToken === Boolean(token), p80);
    const bare = await call(sandbox, 'POST', '/api/config', { baseUrl: 'http://example.test' });
    check('默认端口省略 → 与显式 :80 同 origin 沿用', bare.status === 200 && bare.body.hasToken === Boolean(token), bare);
    const upper = await call(sandbox, 'POST', '/api/config', { baseUrl: 'http://EXAMPLE.test:80' });
    check('主机名大小写不敏感 → 同 origin 沿用', upper.status === 200 && upper.body.hasToken === Boolean(token), upper);
    const tls = await call(sandbox, 'POST', '/api/config', { baseUrl: 'https://example.test' });
    check('协议不同(http vs https) → 不同源清空', tls.status === 200 && tls.body.hasToken === false, tls);
    const port8080 = await call(sandbox, 'POST', '/api/config', { baseUrl: 'http://example.test:8080' });
    check('端口不同(:8080) → 不同源清空', port8080.status === 200 && port8080.body.hasToken === false, port8080);

    const cross = await call(sandbox, 'POST', '/api/config', { baseUrl: 'http://127.0.0.1:9999' });
    check('跨 origin 留空 → 不把旧 JWT 发给新服务器', cross.status === 200 && cross.body.hasToken === false, cross);

    const back = await call(sandbox, 'POST', '/api/config', { baseUrl });
    check('换回旧地址留空 → 仍不沿用(需重填)', back.status === 200 && back.body.hasToken === false, back);

    const refilled = await call(sandbox, 'POST', '/api/config', { baseUrl, token });
    check('重填 token 恢复', refilled.status === 200 && refilled.body.hasToken === Boolean(token), refilled);

    const slash = await call(sandbox, 'POST', '/api/config', { baseUrl: baseUrl + '/' });
    check('同 origin(仅尾斜杠差异)留空 → 沿用', slash.status === 200 && slash.body.hasToken === Boolean(token), slash);

    const keep = await call(sandbox, 'POST', '/api/config', { baseUrl });
    check('不带 token 字段 → 沿用已存凭证', keep.status === 200 && keep.body.hasToken === Boolean(token), keep);

    const cleared = await call(sandbox, 'POST', '/api/config', { baseUrl, token: '' });
    check('显式 token:"" → 清空', cleared.status === 200 && cleared.body.hasToken === false, cleared);

    const restored = await call(sandbox, 'POST', '/api/config', { baseUrl, token });
    check('恢复 token', restored.status === 200 && restored.body.hasToken === Boolean(token), restored);

    const g = await call(sandbox, 'GET', '/api/config');
    check('读取配置(hasToken 不回传明文)', g.status === 200 && g.body.baseUrl === baseUrl && g.body.tokenMasked && !('token' in g.body), g);
  }

  // 2. 状态
  {
    const r = await call(sandbox, 'GET', '/api/status');
    check('连通状态', r.status === 200 && r.body.reachable === true, r);
    console.log('    status:', JSON.stringify(r.body));
  }

  // 3. 搜索
  let first = null;
  {
    const r = await call(sandbox, 'POST', '/api/search', { keyword: '周杰伦 晴天', page: 1, page_size: 5 });
    check('搜索返回 200', r.status === 200, r);
    const results = r.body.results ?? [];
    check('搜索有结果', results.length > 0, results.length);
    if (results.length === 0) { console.log('  ✗ 搜索无结果，中止 live 阶段后续断言'); process.exit(1); }
    first = results[0];
    const sd = first && first.source_data;
    check('结果带 source_data(schema/provider/track)',
      sd && sd.schema_version === 1 && sd.provider === 'hmusic' && sd.track && sd.track.sourceTrackId, first);
    check('结果字段完整(title/artist/duration 秒)',
      first.title && first.artist && Number.isInteger(first.duration) && first.duration > 60, first);
    check('token 不在 source_data 中', JSON.stringify(sd ?? {}).includes(token) === false);
  }

  // 4. 解析(主路径)
  {
    const t0 = Date.now();
    const r = await call(sandbox, 'POST', '/api/music/url', { source_data: first.source_data });
    const ms = Date.now() - t0;
    const url = (r.body && r.body.url) || '';
    check(`解析返回 URL(${ms}ms)`, r.status === 200 && url.startsWith('http'), r);
    check('无 used_fallback', r.body.used_fallback === undefined, r.body);
    const probe = await fetch(url, { headers: { Range: 'bytes=0-1' }, signal: AbortSignal.timeout(15000) });
    check('URL 实测可播(200/206)', probe.status === 200 || probe.status === 206, probe.status);
    await probe.body?.cancel?.().catch(() => {});
  }

  // 5. fallback 换源(破坏 source_data,主路径必败,应自搜换源)
  {
    const broken = { ...first.source_data, track: { ...first.source_data.track, sourceTrackId: 'nonexistent-id-000' } };
    const r = await call(sandbox, 'POST', '/api/music/url', {
      source_data: broken,
      fallback: { enabled: true, title: first.title, artist: first.artist, duration: first.duration },
    });
    check('fallback 换源成功', r.status === 200 && r.body.used_fallback === true && r.body.url, r);
    if (r.body.source_data) check('fallback 返回新 source_data', r.body.source_data.track.sourceTrackId !== 'nonexistent-id-000');
  }

  // 6. 入库(模拟宿主 songs.create)
  {
    importCalls.length = 0;
    const second = (await call(sandbox, 'POST', '/api/search', { keyword: '林俊杰 江南', page: 1, page_size: 3 })).body.results?.[0];
    check('第二首搜索有结果', Boolean(second));
    const r = await call(sandbox, 'POST', '/api/import', { items: [first, second] });
    check('入库返回 200 且 2 首', r.status === 200 && (r.body.songs ?? []).length === 2, r);
    check('入库走 songs.create(自动关联)', importCalls.length === 2, importCalls.length);
    check('dedupKey 形如 hmusic:<source>:<id>', importCalls.every((i) => /^hmusic:[a-z]+:[^:]+$/.test(i.dedupKey)), importCalls.map((i) => i.dedupKey));
    check('sourceData 为 JSON 字符串且含 track', importCalls.every((i) => { const p = JSON.parse(i.sourceData); return p.provider === 'hmusic' && p.track; }));
    check('入库不携带 token', importCalls.every((i) => !i.sourceData.includes(token)));
  }

  // 7. 非法输入
  {
    const r = await call(sandbox, 'POST', '/api/music/url', { source_data: { provider: 'hmusic' } });
    check('非法 source_data → 404 source_not_available', r.status === 404 && r.body.error === 'source_not_available', r);
    const r2 = await call(sandbox, 'POST', '/api/search', { keyword: '' });
    check('空关键词 → 400', r2.status === 400, r2);
    const r3 = await call(sandbox, 'GET', '/api/nothing');
    check('未知路由 → 404', r3.status === 404, r3);
  }

  // 8. JSON null 请求体(合法 JSON 但非对象,须 400 而非未捕获 TypeError)
  {
    const nc = await call(sandbox, 'POST', '/api/config', 'null');
    check('config 收到 JSON null → 400', nc.status === 400, nc);
    const nm = await call(sandbox, 'POST', '/api/music/url', 'null');
    check('music/url 收到 JSON null → 400', nm.status === 400, nm);
    const ni = await call(sandbox, 'POST', '/api/import', 'null');
    check('import 收到 JSON null → 400', ni.status === 400, ni);
    const ns = await call(sandbox, 'POST', '/api/search', 'null');
    check('search 收到 JSON null → 400', ns.status === 400, ns);
  }
}

if (offline) console.log('Phase A — 已跳过（离线模式）');
else await runLive();

// ===== Phase B:mock(候选遍历) =====
console.log('Phase B — mock 候选遍历');

const track = (source, id, title = '晴天', artist = '周杰伦') => ({
  id: `${source}:${id}`,
  source,
  sourceTrackId: id,
  title,
  artist,
  album: '叶惠美',
  durationMs: 269000,
  qualities: ['128k', '320k', 'flac'],
});

const deadTrack = track('tx', 'dead-1');
const candATrack = track('kw', 'cand-a'); // 解析失败
const candBTrack = track('wy', 'cand-b'); // 解析成功

const resolveCalls = [];
const mockFetch = async (url, init) => {
  const u = new URL(url);
  if (u.pathname === '/api/v1/search') {
    return jsonRes({ tracks: [deadTrack, candATrack, candBTrack] });
  }
  if (u.pathname === '/api/v1/tracks/resolve') {
    const reqTrack = JSON.parse(init.body).track;
    resolveCalls.push(reqTrack.sourceTrackId);
    if (reqTrack.sourceTrackId === 'dead-1' || reqTrack.sourceTrackId === 'cand-a') {
      return jsonRes({ code: 501, message: 'no playable url' }, 501);
    }
    return jsonRes({ url: 'https://cdn.example.com/ok.mp3', quality: '320k', verified: true });
  }
  if (u.pathname === '/api/v1/auth/status') {
    return jsonRes({ initialized: true, authenticated: true });
  }
  throw new Error('mock fetch: no route for ' + url);
};

const mock = makeSongloft();
const mockSandbox = {
  console,
  fetch: mockFetch,
  setTimeout,
  clearTimeout,
  URL,
  TextDecoder,
  Response,
  songloft: mock.songloft,
  globalThis: {},
};
loadPlugin(mockSandbox);

{
  await call(mockSandbox, 'POST', '/api/config', { baseUrl: 'http://mock-hmusic', token: 'mock-token' });

  const r = await call(mockSandbox, 'POST', '/api/music/url', {
    source_data: {
      schema_version: 1,
      provider: 'hmusic',
      track: deadTrack,
    },
    fallback: { enabled: true, title: deadTrack.title, artist: deadTrack.artist, duration: 269 },
  });

  check('死源候选被排除,换到可用候选', r.status === 200 && r.body.used_fallback === true
    && r.body.source_data?.track?.sourceTrackId === 'cand-b', r);
  check('返回可用 URL', r.body.url === 'https://cdn.example.com/ok.mp3', r.body);
  check('解析顺序:原曲 → cand-a → cand-b(无重复,失败后继续)',
    JSON.stringify(resolveCalls) === JSON.stringify(['dead-1', 'cand-a', 'cand-b']), resolveCalls);
}

{
  // 无可用候选 → 404
  resolveCalls.length = 0;
  const r = await call(mockSandbox, 'POST', '/api/music/url', {
    source_data: { schema_version: 1, provider: 'hmusic', track: { ...candATrack, sourceTrackId: 'dead-1', id: 'tx:dead-1' } },
    fallback: { enabled: true, title: '不存在的歌', artist: '无人', duration: 1 },
  });
  check('全候选失败 → 404 source_not_available', r.status === 404 && r.body.error === 'source_not_available', r);
}

// ===== Phase C:mock(超时预算) =====
console.log('Phase C — mock 超时预算');

const slowA = track('tx', 'slow-a');
const slowB = track('kw', 'slow-b');

let budgetResolveCalls = [];
const budgetMockFetch = async (url, init) => {
  const u = new URL(url);
  if (u.pathname === '/api/v1/search') {
    return jsonRes({ tracks: [deadTrack, slowA, slowB, candBTrack] });
  }
  if (u.pathname === '/api/v1/tracks/resolve') {
    const reqTrack = JSON.parse(init.body).track;
    budgetResolveCalls.push(reqTrack.sourceTrackId);
    if (reqTrack.sourceTrackId === 'dead-1') {
      return jsonRes({ code: 501, message: 'no playable url' }, 501);
    }
    if (reqTrack.sourceTrackId.startsWith('slow-')) {
      // 模拟宿主：按 X-Fetch-Timeout-Ms 到点后拒绝（慢源）。
      const ms = Math.min(parseInt(init.headers['X-Fetch-Timeout-Ms'] ?? '15000', 10), 25000);
      await new Promise((_, reject) => setTimeout(() => reject(new Error('mock upstream timeout')), ms));
    }
    return jsonRes({ url: 'https://cdn.example.com/ok.mp3', quality: '320k', verified: true });
  }
  if (u.pathname === '/api/v1/auth/status') {
    return jsonRes({ initialized: true, authenticated: true });
  }
  throw new Error('mock fetch: no route for ' + url);
};

const budget = makeSongloft();
const budgetSandbox = {
  console,
  fetch: budgetMockFetch,
  setTimeout,
  clearTimeout,
  URL,
  TextDecoder,
  Response,
  songloft: budget.songloft,
  globalThis: {},
};
loadPlugin(budgetSandbox);

{
  const t0 = Date.now();
  await call(budgetSandbox, 'POST', '/api/config', { baseUrl: 'http://mock-hmusic', token: 'mock-token' });
  const r = await call(budgetSandbox, 'POST', '/api/music/url', {
    source_data: {
      schema_version: 1,
      provider: 'hmusic',
      track: deadTrack,
    },
    fallback: { enabled: true, title: deadTrack.title, artist: deadTrack.artist, duration: 269 },
  });
  const elapsed = Date.now() - t0;
  // slow-a 吃掉 ~20s、slow-b 吃掉剩余 ~6s 后预算耗尽；cand-b 不再尝试（约 4s 最小尝试余量）。
  check('预算耗尽 → 404 而非被宿主整体掐断', r.status === 404 && r.body.error === 'source_not_available', r);
  check('总耗时 ≈ 总预算内(<30s 宿主上限)', elapsed < 30000, elapsed);
  check('尝试序列:原曲 → slow-a → slow-b → 止损(不试 cand-b)',
    JSON.stringify(budgetResolveCalls) === JSON.stringify(['dead-1', 'slow-a', 'slow-b']), budgetResolveCalls);
}

console.log(`\n冒烟断言：${checks} 项，${checks - failures} 通过，${failures} 失败。`);
process.exit(failures === 0 ? 0 : 1);
