// 测试仅加载插件构建文件；上游与宿主由调用方注入，离线用例不访问真实服务。
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const code = readFileSync(new URL('../build/main.js', import.meta.url), 'utf8');

export function jsonRes(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function loadPlugin(sandbox) {
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
}

export async function call(sandbox, method, path, body) {
  const raw = typeof body === 'string' ? body : body === undefined ? '' : JSON.stringify(body);
  const req = { method, path, headers: {}, body: raw, query: '' };
  const handler = sandbox.globalThis?.onHTTPRequest ?? sandbox.onHTTPRequest;
  const res = await handler(req);
  let parsed;
  try { parsed = JSON.parse(res.body); } catch { parsed = res.body; }
  return { status: res.statusCode, body: parsed };
}

export function makeSongloft() {
  const storageMap = new Map();
  const importCalls = [];
  const songloft = {
    storage: {
      get: async (k) => (storageMap.has(k) ? storageMap.get(k) : null),
      set: async (k, v) => { storageMap.set(k, v); },
      delete: async (k) => { storageMap.delete(k); },
      keys: async () => [...storageMap.keys()],
    },
    songs: {
      create: async (inputs) => {
        importCalls.push(...inputs);
        return inputs.map((inp, i) => ({
          id: 1000 + importCalls.length + i,
          type: 'remote',
          title: inp.title,
          artist: inp.artist ?? '',
          album: inp.album ?? '',
          duration: inp.duration ?? 0,
          cover_url: inp.coverUrl ?? '',
          source_data: inp.sourceData,
        }));
      },
    },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  };
  return { songloft, storageMap, importCalls };
}
