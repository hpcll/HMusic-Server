// 配置安全回归：真实插件 handler + 真实页面代码，网络与最小 DOM 隔离。
// 这些测试覆盖交互顺序，不替代真实 Songloft WebView/客户端验收。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { call, jsonRes, loadPlugin, makeSongloft } from './helpers.mjs';

const hostURLContext = vm.createContext({ URLSearchParams });
vm.runInContext(readFileSync(new URL('./fixtures/songloft-url.js', import.meta.url), 'utf8'), hostURLContext);
const HostURL = hostURLContext.URL;
const pageCode = readFileSync(new URL('../static/app.js', import.meta.url), 'utf8');
const pageHTML = readFileSync(new URL('../static/index.html', import.meta.url), 'utf8');
const TOKEN_A = 'dummy-token-for-server-a';
const TOKEN_B = 'dummy-token-for-server-b';
const A = 'http://server-a.test:6650';
const B = 'http://server-b.test:6650';
const sampleTrack = {
  id: 'tx:sample', source: 'tx', sourceTrackId: 'sample',
  title: '晴天', artist: '周杰伦', durationMs: 269000,
};

function makeBackend({ url = HostURL, fetch: upstream } = {}) {
  const host = makeSongloft();
  const requests = [];
  const sandbox = {
    ...host, URL: url, Response, TextDecoder, console, setTimeout, clearTimeout,
    fetch: async (address, init) => {
      requests.push({ address, ...init });
      if (upstream) return upstream(address, init);
      if (address.includes('/api/v1/search?')) return jsonRes({ tracks: [sampleTrack] });
      return jsonRes({ authenticated: Boolean(init.headers.Authorization) });
    },
  };
  loadPlugin(sandbox);
  return { sandbox, requests, ...host };
}

const originCases = [
  ['IPv6 地址变化', 'http://[2001:db8::1]:6650', 'http://[2001:db8::2]:6650', false],
  ['IPv6 端口变化', 'http://[2001:db8::1]:6650', 'http://[2001:db8::1]:9999', false],
  ['IPv6 默认端口', 'http://[2001:db8::1]:80', 'http://[2001:db8::1]', true],
  ['IPv6 展开与压缩', 'https://[2001:0DB8:0:0:0:0:0:1]:443', 'https://[2001:db8::1]', true],
  ['IPv6 内嵌 IPv4', 'http://[::ffff:192.0.2.1]', 'http://[0:0:0:0:0:ffff:c000:201]:80', true],
  ['域名大小写与默认端口', 'http://EXAMPLE.test:80', 'http://example.test', true],
  ['HTTPS 默认端口', 'https://example.test:443', 'https://example.test', true],
  ['同源反代路径', 'http://example.test/hmusic', 'http://example.test/bridge/', true],
  ['协议变化', 'http://example.test', 'https://example.test', false],
  ['域名变化', A, B, false],
  ['端口变化', 'http://example.test', 'http://example.test:8080', false],
];

for (const [runtime, url] of [['Node URL', URL], ['Songloft URL', HostURL]]) {
  for (const [name, from, to, keep] of originCases) {
    test(`${runtime}：${name}的凭据与实际出站请求一致`, async () => {
      const backend = makeBackend({ url });
      const saved = await call(backend.sandbox, 'POST', '/api/config', { baseUrl: from, token: TOKEN_A });
      assert.equal(saved.status, 200);
      const changed = await call(backend.sandbox, 'POST', '/api/config', { baseUrl: to });
      assert.equal(changed.status, 200);
      assert.equal(changed.body.hasToken, keep);
      await call(backend.sandbox, 'GET', '/api/status');
      assert.equal(backend.requests.at(-1).address, to.replace(/\/+$/, '') + '/api/v1/auth/status');
      assert.equal(backend.requests.at(-1).headers.Authorization, keep ? `Bearer ${TOKEN_A}` : undefined);
    });
  }
}

test('非法或有歧义的服务地址返回 400，保留原配置', async () => {
  const backend = makeBackend();
  await call(backend.sandbox, 'POST', '/api/config', { baseUrl: A, token: TOKEN_A });
  for (const baseUrl of [
    'http://', 'ftp://server-a.test', 'http://server-a.test:65536', 'http://server-a.test:bad',
    'http://[2001:db8::1', 'http://[2001:db8:::1]', 'http://[2001:db8:1]',
    'http://[::ffff:999.0.0.1]', 'http://[fe80::1%25eth0]', 'http://2001:db8::1',
    'http://user:password@server-a.test', 'http://server-a.test\\@server-b.test',
    'http://server-a.test\n.example', 'http://server-a.test?redirect=elsewhere',
    'http://server-a.test#fragment',
  ]) {
    const response = await call(backend.sandbox, 'POST', '/api/config', { baseUrl });
    assert.equal(response.status, 400, baseUrl);
    assert.equal(backend.storageMap.get('hmusic.config').baseUrl, A);
    assert.equal(backend.storageMap.get('hmusic.config').token, TOKEN_A);
  }
  assert.equal(backend.requests.length, 0);
});

test('旧存储中的非法地址不会携带凭据出站', async () => {
  const backend = makeBackend();
  backend.storageMap.set('hmusic.config', { baseUrl: 'http://user:password@server-a.test', token: TOKEN_A });
  const response = await call(backend.sandbox, 'GET', '/api/status');
  assert.equal(response.body.reachable, false);
  assert.equal(backend.requests.length, 0);
});

test('四个 POST 路由拒绝 null、数组、非法 JSON，且不产生副作用', async () => {
  const backend = makeBackend();
  for (const route of ['/api/config', '/api/import', '/api/music/url', '/api/search']) {
    for (const body of ['null', '[]', '{']) {
      assert.equal((await call(backend.sandbox, 'POST', route, body)).status, 400, `${route}: ${body}`);
    }
  }
  assert.equal(backend.requests.length, 0);
  assert.equal(backend.storageMap.size, 0);
  assert.equal(backend.importCalls.length, 0);
});

// 最小 DOM 只实现页面使用的能力；元素 ID 来自真实 HTML，漏改 HTML 会直接失败。
class Element {
  value = '';
  placeholder = '';
  disabled = false;
  checked = false;
  textContent = '';
  className = '';
  dataset = {};
  children = [];
  events = new Map();
  classList = {
    contains: (name) => this.className.split(/\s+/).includes(name),
    add: (name) => { if (!this.classList.contains(name)) this.className += ' ' + name; },
    remove: (name) => { this.className = this.className.split(/\s+/).filter((c) => c !== name).join(' '); },
  };
  set innerHTML(value) { this.children = []; this.textContent = value; }
  get innerHTML() { return this.textContent; }
  appendChild(child) { this.children.push(child); }
  addEventListener(name, handler) { this.events.set(name, handler); }
  fire(name) { return this.events.get(name)?.({ preventDefault() {} }); }
}

const settle = () => new Promise(setImmediate);
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function makePage({ backend = makeBackend(), getInfo = async () => ({ version: 'test', capabilities: ['player'] }), beforePost, beforeGet } = {}) {
  const elements = new Map([...pageHTML.matchAll(/id="([^"]+)"/g)].map((m) => [m[1], new Element()]));
  elements.get('results-wrap').className = 'hidden';
  const apiCalls = [];
  const api = async (method, route, body) => {
    apiCalls.push({ method, route, body: body && structuredClone(body) });
    if (method === 'POST' && beforePost) await beforePost(route, body);
    if (method === 'GET' && beforeGet) await beforeGet(route);
    const response = await call(backend.sandbox, method, route, body);
    if (response.status >= 400) throw new Error(response.body.error || `HTTP ${response.status}`);
    return response.body;
  };
  const document = {
    getElementById: (id) => elements.get(id),
    createElement: () => new Element(),
    querySelectorAll: () => elements.get('results').children.flatMap((li) => li.children.filter((child) => child.className === 'row-check')),
  };
  vm.runInNewContext(pageCode, {
    document, console,
    window: { SongloftPlugin: {
      apiGet: (route) => api('GET', route),
      apiPost: (route, body) => api('POST', route, body),
      host: { isAvailable: () => true, getInfo },
      player: { setQueue: async () => {} },
    } },
  });
  return {
    ...backend, apiCalls,
    el: (id) => elements.get(id),
    input: (id, value) => { elements.get(id).value = value; elements.get(id).fire('input'); },
    click: (id) => elements.get(id).fire('click'),
    submit: (id) => elements.get(id).fire('submit'),
  };
}

for (const failure of ['网络不可达', '鉴权失败', '配置保存失败']) {
  test(`页面：${failure}后换地址不发送残留 Token`, async () => {
    const backend = makeBackend({ fetch: async (address, init) => {
      if (address.startsWith(A)) {
        if (failure === '网络不可达') throw new Error('offline');
        return jsonRes({ authenticated: false }, 401);
      }
      return jsonRes({ authenticated: Boolean(init.headers.Authorization) });
    } });
    const page = makePage({ backend, beforePost: async (_route, body) => {
      if (failure === '配置保存失败' && body.baseUrl === A) throw new Error('save failed');
    } });
    await settle();
    page.input('config-baseurl', A);
    page.input('config-token', TOKEN_A);
    const pending = page.click('btn-test');
    assert.equal(page.el('config-token').value, '', '开始提交就清空，不等待鉴权结果');
    await pending;
    await settle();
    page.input('config-baseurl', B);
    await page.click('btn-test');
    await settle();
    const sent = backend.requests.filter((r) => r.address.startsWith(B));
    assert.ok(sent.length > 0);
    assert.ok(sent.every((r) => !r.headers.Authorization));
    assert.equal(backend.storageMap.get('hmusic.config').token, '');
  });
}

test('页面：提交之前改地址，旧输入和掩码立即失效', async () => {
  const page = makePage();
  await settle();
  page.input('config-baseurl', A);
  page.input('config-token', TOKEN_A);
  page.input('config-baseurl', B);
  assert.equal(page.el('config-token').value, '');
  assert.ok(!page.el('config-token').placeholder.includes('****'));
  await page.click('btn-test');
  await settle();
  assert.equal(page.requests.at(-1).headers.Authorization, undefined);
});

for (const stage of ['保存配置', '读取状态']) {
  for (const refill of [false, true]) {
    test(`页面：${stage}未返回时换地址${refill ? '并重填' : ''}，串行提交且忽略迟到响应`, async () => {
      const gate = deferred();
      const backend = makeBackend({ fetch: async (address, init) => {
        if (stage === '读取状态' && address.startsWith(A)) await gate.promise;
        return jsonRes({ authenticated: Boolean(init.headers.Authorization) });
      } });
      const page = makePage({ backend, beforePost: async (_route, body) => {
        if (stage === '保存配置' && body.baseUrl === A) await gate.promise;
      } });
      await settle();
      page.input('config-baseurl', A);
      page.input('config-token', TOKEN_A);
      const pending = page.click('btn-test');
      await settle();
      page.input('config-baseurl', B);
      if (refill) page.input('config-token', TOKEN_B);
      const changedHint = page.el('config-hint').textContent;
      for (const id of ['btn-test', 'btn-clear-token']) assert.equal(page.el(id).disabled, true);
      // 即使事件被脚本触发，也不能越过操作中的按钮门控。
      page.click('btn-test');
      page.click('btn-clear-token');
      page.submit('config-form');
      await settle();
      assert.equal(page.apiCalls.filter((r) => r.method === 'POST').length, 1);
      gate.resolve();
      await pending;
      await settle();
      assert.equal(page.el('config-token').value, refill ? TOKEN_B : '');
      assert.equal(page.el('config-hint').textContent, changedHint);
      assert.notEqual(page.el('status-chip').textContent, '已认证');
      assert.equal(page.el('btn-test').disabled, false);
      await page.click('btn-test');
      await settle();
      assert.equal(backend.storageMap.get('hmusic.config').baseUrl, B);
      assert.equal(backend.requests.at(-1).headers.Authorization, refill ? `Bearer ${TOKEN_B}` : undefined);
    });
  }
}

test('页面：保存成功后清空输入，切换地址不复用旧凭据', async () => {
  const page = makePage();
  await settle();
  page.input('config-baseurl', A);
  page.input('config-token', TOKEN_A);
  await page.submit('config-form');
  await settle();
  assert.equal(page.el('config-token').value, '');
  page.input('config-baseurl', B);
  await page.click('btn-test');
  await settle();
  assert.equal(page.requests.at(-1).headers.Authorization, undefined);
});

test('页面：清除 Token 后再次测试不会写回输入框的旧值', async () => {
  const page = makePage();
  await settle();
  page.input('config-baseurl', A);
  page.input('config-token', TOKEN_A);
  await page.submit('config-form');
  await settle();
  page.input('config-token', TOKEN_A);
  await page.click('btn-clear-token');
  await settle();
  assert.equal(page.el('config-token').value, '');
  await page.click('btn-test');
  await settle();
  assert.equal(page.requests.at(-1).headers.Authorization, undefined);
  assert.equal(page.storageMap.get('hmusic.config').token, '');
});

test('页面：迟到的初始配置不覆盖用户新输入', async () => {
  const gate = deferred();
  const page = makePage({ beforeGet: async (route) => { if (route === '/api/config') await gate.promise; } });
  page.input('config-baseurl', B);
  page.input('config-token', TOKEN_B);
  gate.resolve();
  await settle();
  assert.equal(page.el('config-baseurl').value, B);
  assert.equal(page.el('config-token').value, TOKEN_B);
  await page.click('btn-test');
  await settle();
  assert.equal(page.requests.at(-1).headers.Authorization, `Bearer ${TOKEN_B}`);
});

for (const mode of ['握手失败', '无 player 能力', '有 player 能力', '握手晚于搜索']) {
  test(`页面：${mode}时入库与播放按钮状态正确`, async () => {
    const gate = deferred();
    const page = makePage({ getInfo: async () => {
      if (mode === '握手失败') throw new Error('host offline');
      if (mode === '握手晚于搜索') return gate.promise;
      return { capabilities: mode === '无 player 能力' ? [] : ['player'] };
    } });
    await settle();
    page.input('search-keyword', '晴天');
    page.submit('search-form');
    await settle();
    assert.equal(page.el('results-wrap').classList.contains('hidden'), false);
    const ready = mode !== '握手失败' && mode !== '握手晚于搜索';
    assert.equal(page.el('btn-import').disabled, !ready);
    assert.equal(page.el('btn-import-play').disabled, mode !== '有 player 能力');
    if (mode === '握手晚于搜索') {
      gate.resolve({ capabilities: ['player'] });
      await settle();
      assert.equal(page.el('btn-import').disabled, false);
      assert.equal(page.el('btn-import-play').disabled, false);
    }
  });
}
