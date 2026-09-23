// Ловим сетевые запросы вкладки и запоминаем найденные видео.

const SEGMENT_RE = /\.(ts|m4s|aac|m4a|vtt|key)(\?|#|$)|[\/_-](seg|segment|chunk|frag)[^\/]*$/i;
// Адреса, которые могут оказаться плейлистом без «.m3u8» в имени
// (например, на GetCourse: .../playlist/..., .../master/..., .../720).
const CANDIDATE_RE = /playlist|master|manifest|\/(144|240|360|480|540|576|720|1080|1440|2160)p?(\?|#|$)/i;

function header(headers, name) {
  const h = (headers || []).find(h => h.name.toLowerCase() === name);
  return h ? h.value : '';
}

function detect(url, type) {
  if (/\.m3u8(\?|#|$)/i.test(url) || /mpegurl/i.test(type)) return 'hls';
  if (SEGMENT_RE.test(new URL(url).pathname)) return null;
  if (/^video\/(mp4|webm|quicktime)/i.test(type) || /\.(mp4|webm|mov)(\?|#|$)/i.test(url)) return 'mp4';
  return null;
}

function totalSize(headers) {
  const range = header(headers, 'content-range'); // "bytes 0-100/12345"
  const m = range.match(/\/(\d+)/);
  return Number(m ? m[1] : header(headers, 'content-length')) || 0;
}

// Разбор мастер-плейлиста: список качеств.
function parseMaster(text, base) {
  const lines = text.split(/\r?\n/);
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
    const bw = Number((lines[i].match(/BANDWIDTH=(\d+)/) || [])[1]) || 0;
    const res = (lines[i].match(/RESOLUTION=(\d+x\d+)/) || [])[1] || '';
    let j = i + 1;
    while (j < lines.length && (!lines[j].trim() || lines[j].startsWith('#'))) j++;
    if (j < lines.length) variants.push({ url: new URL(lines[j].trim(), base).href, bw, res });
  }
  return variants;
}

// Очередь, чтобы параллельные события не затирали друг друга.
let queue = Promise.resolve();
const run = fn => (queue = queue.then(fn).catch(console.error));

async function addItem(tabId, item) {
  const key = 't' + tabId;
  const list = (await chrome.storage.session.get(key))[key] || [];
  if (list.some(v => v.url === item.url)) return;
  list.unshift(item);
  list.splice(40);
  await chrome.storage.session.set({ [key]: list });
  const visible = list.filter(v => !list.some(m => m.variants && m.variants.some(x => x.url === v.url)));
  chrome.action.setBadgeText({ tabId, text: String(visible.length) });
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#2e7d32' });
}

async function addHls(tabId, url, text) {
  const item = { url, kind: 'hls', size: 0, time: Date.now() };
  try {
    if (text === undefined) text = await (await fetch(url, { credentials: 'include' })).text();
    if (text.includes('#EXT-X-STREAM-INF')) item.variants = parseMaster(text, url);
  } catch (e) { /* не страшно — скачаем как есть */ }
  await addItem(tabId, item);
}

// Проверяем адрес «на вкус»: плейлист это, видеофайл или что-то другое.
async function checkUrl(tabId, url) {
  const known = (await chrome.storage.session.get('t' + tabId))['t' + tabId] || [];
  if (known.some(v => v.url === url)) return;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    const r = await fetch(url, { credentials: 'include', signal: ctrl.signal });
    const type = r.headers.get('content-type') || '';
    const size = Number(r.headers.get('content-length')) || 0;
    // Читаем только начало ответа, чтобы не тянуть целое видео.
    const reader = r.body.getReader();
    const first = await reader.read();
    reader.cancel().catch(() => {});
    clearTimeout(timer);
    if (!r.ok) return;
    const head = new TextDecoder().decode((first.value || new Uint8Array()).slice(0, 4096));
    if (head.replace(/^﻿/, '').trimStart().startsWith('#EXTM3U')) return addHls(tabId, url);
    if (/^video\//i.test(type) && !/mp2t/i.test(type)) {
      if (size && size < 1024 * 1024) return;
      return addItem(tabId, { url, kind: 'mp4', size, time: Date.now() });
    }
  } catch (e) { /* не получилось — значит не видео */ }
}

chrome.webRequest.onHeadersReceived.addListener(
  d => {
    if (d.tabId < 0 || (d.initiator || '').startsWith('chrome-extension://') || (d.originUrl || '').startsWith('moz-extension://')) return;
    if (d.statusCode >= 400) return;
    const kind = detect(d.url, header(d.responseHeaders, 'content-type'));

    if (kind === 'hls') return run(() => addHls(d.tabId, d.url));
    if (kind === 'mp4') {
      const size = totalSize(d.responseHeaders);
      if (size && size < 1024 * 1024) return; // мелочь (превью, реклама) не показываем
      return run(() => addItem(d.tabId, { url: d.url, kind, size, time: Date.now() }));
    }
    if (d.type === 'xmlhttprequest' && CANDIDATE_RE.test(d.url) && !SEGMENT_RE.test(new URL(d.url).pathname)) {
      run(() => checkUrl(d.tabId, d.url));
    }
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

// Окно расширения присылает адреса, найденные прямо на странице.
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg && msg.type === 'check') {
    Promise.all(msg.urls.map(u => run(() => checkUrl(msg.tabId, u)))).then(() => reply(true));
    return true;
  }
});

// Новая страница во вкладке — чистим список.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading' && info.url) {
    run(() => chrome.storage.session.remove('t' + tabId));
    chrome.action.setBadgeText({ tabId, text: '' });
  }
});
chrome.tabs.onRemoved.addListener(tabId => run(() => chrome.storage.session.remove('t' + tabId)));
