// 使用官方宿主自带的 Flutter Web 客户端与真实插件 iframe，未模拟 player/host 桥。
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright-core';

const root = resolve(process.argv[2]);
const auth = JSON.parse(readFileSync(join(root, 'host-auth.json'), 'utf8'));
const host = 'http://127.0.0.1:58192';
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true, args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const mediaResponses = [];
let importRequests = 0;
page.on('request', (request) => {
  if (new URL(request.url()).pathname.endsWith('/hmusic-bridge/api/import')) importRequests++;
});
page.on('response', (response) => {
  if (/\/songs\/\d+\/play/.test(response.url())) mediaResponses.push({ status: response.status(), path: new URL(response.url()).pathname });
});
await page.addInitScript(({ auth, origin }) => {
  if (location.origin !== origin) return;
  localStorage.setItem('flutter.access_token', JSON.stringify(auth.access_token));
  localStorage.setItem('flutter.refresh_token', JSON.stringify(auth.refresh_token));
  localStorage.setItem('flutter.token_expires_at', JSON.stringify(new Date(Date.now() + auth.expires_in * 1000).toISOString()));
}, { auth, origin: host });
try {
  await page.goto(host + '/#/plugin?url=' + encodeURIComponent(host + '/api/v1/jsplugin/hmusic-bridge/') + '&name=HMusic', { waitUntil: 'networkidle' });
  const pluginFrame = page.frameLocator('iframe').first();
  await pluginFrame.locator('#search-keyword').waitFor({ timeout: 30000 });
  await pluginFrame.locator('#search-keyword').fill('晴天 周杰伦');
  await pluginFrame.locator('#search-source').selectOption('tx');
  await pluginFrame.locator('#btn-search').click();
  await pluginFrame.locator('#results-wrap:not(.hidden)').waitFor({ timeout: 30000 });
  await pluginFrame.locator('#check-all').uncheck();
  await pluginFrame.locator('.row-check').first().check();
  assert.match(await pluginFrame.locator('#host-hint').textContent(), /支持播放/);
  await pluginFrame.locator('#btn-import-play').click();
  await pluginFrame.locator('#search-meta').filter({ hasText: '已入库并开始播放' }).waitFor({ timeout: 60000 });
  let state;
  for (let i = 0; i < 15; i++) {
    state = await pluginFrame.locator('body').evaluate(() => window.SongloftPlugin.player.getState());
    if (state.is_playing && state.current_time > 0) break;
    await new Promise(done => setTimeout(done, 1000));
  }
  assert.equal(state.is_playing, true);
  assert.ok(state.current_time > 0);
  // 已播放媒体可能被浏览器缓存；用真实播放器收到 503 后再恢复网络验证重试。
  let failMedia = true;
  await page.route('**/api/v1/songs/*/play*', route =>
    failMedia && /\/play$/.test(new URL(route.request().url()).pathname)
      ? route.fulfill({ status: 503, headers: { 'Cache-Control': 'no-store' }, body: 'acceptance media failure' })
      : route.continue());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await pluginFrame.locator('#search-keyword').fill('晴天 周杰伦');
  await pluginFrame.locator('#search-source').selectOption('tx');
  await pluginFrame.locator('#btn-search').click();
  await pluginFrame.locator('#results-wrap:not(.hidden)').waitFor({ timeout: 30000 });
  await pluginFrame.locator('#check-all').uncheck();
  await pluginFrame.locator('.row-check').first().check();
  const failedMedia = page.waitForResponse(response =>
    /\/songs\/\d+\/play$/.test(new URL(response.url()).pathname) && response.status() === 503);
  await pluginFrame.locator('#btn-import-play').click();
  await failedMedia;
  await pluginFrame.locator('#btn-retry-play:not([disabled])').waitFor({ timeout: 30000 });
  const importsBeforeRetry = importRequests;
  const nextMedia = page.waitForResponse(response =>
    /\/songs\/\d+\/play$/.test(new URL(response.url()).pathname) && [200, 206].includes(response.status()),
  { timeout: 30000 });
  failMedia = false;
  await pluginFrame.locator('#btn-retry-play').click();
  await pluginFrame.locator('#search-meta').filter({ hasText: '已重新发起播放' }).waitFor({ timeout: 30000 });
  await nextMedia;
  assert.equal(importRequests, importsBeforeRetry, '重试不应重复入库');
  for (let i = 0; i < 15; i++) {
    state = await pluginFrame.locator('body').evaluate(() => window.SongloftPlugin.player.getState());
    if (state.is_playing && state.current_time > 0) break;
    await new Promise(done => setTimeout(done, 1000));
  }
  const evidence = { hostHint: await pluginFrame.locator('#host-hint').textContent(),
    state: { is_playing: state.is_playing, current_time: state.current_time, songId: state.current_song?.id }, mediaResponses,
    retry: { failureStatus: 503, requestedMediaAgain: true, repeatedImport: false },
    meta: await pluginFrame.locator('#search-meta').textContent() };
  writeFileSync(join(root, 'web-results.json'), JSON.stringify(evidence, null, 2));
  await page.screenshot({ path: join(root, 'web-playback.png'), fullPage: true });
  console.log(JSON.stringify(evidence));
  assert.ok(mediaResponses.some(r => r.status === 200 || r.status === 206));
  assert.equal(state.is_playing, true);
  assert.ok(state.current_time > 0);
} catch (error) {
  await page.screenshot({ path: join(root, 'web-failure.png'), fullPage: true });
  console.log('Failure evidence:', JSON.stringify({ mediaResponses, importRequests,
    frames: page.frames().map(f => new URL(f.url() || host).pathname) }));
  throw error;
} finally { await browser.close(); }
