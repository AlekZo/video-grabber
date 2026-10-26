// Ловим сетевые запросы вкладки и запоминаем найденные видео.
if (!globalThis.Hls) importScripts('hls.js');
if (!globalThis.mp4MediaType) importScripts('mp4.js');

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
  if (/^audio\/(mp4|x-m4a)/i.test(type)) return 'mp4';
  if (SEGMENT_RE.test(new URL(url).pathname)) return null;
  if (/^video\/(mp4|webm|quicktime)/i.test(type) || /\.(mp4|webm|mov)(\?|#|$)/i.test(url)) return 'mp4';
  return null;
}

function totalSize(headers) {
  const range = header(headers, 'content-range'); // "bytes 0-100/12345"
  const m = range.match(/\/(\d+)/);
  return Number(m ? m[1] : header(headers, 'content-length')) || 0;
}

// Очередь, чтобы параллельные события не затирали друг друга.
let queue = Promise.resolve();
const run = fn => (queue = queue.then(fn).catch(console.error));

async function inspectUrl(url, credentials = 'include') {
  const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const response = await fetch(url, { credentials, signal: ctrl.signal });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const mime = response.headers.get('content-type') || '';
    const info = { url: response.url || url, mime, size: Number(response.headers.get('content-length')) || 0 };
    if ((/^video\//i.test(mime) && !/mp2t/i.test(mime)) || /^audio\/(mp4|x-m4a)/i.test(mime)) return info;
    const reader = response.body.getReader(), chunks = [];
    let length = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 2 * 1024 * 1024) throw new Error('Playlist/page is too large');
      chunks.push(value);
    }
    const data = new Uint8Array(length);
    let pos = 0;
    for (const chunk of chunks) { data.set(chunk, pos); pos += chunk.length; }
    return { ...info, text: new TextDecoder().decode(data) };
  } finally { clearTimeout(timer); ctrl.abort(); }
}
const masterAttempts = new Map();

async function probeMedia(url, range = null) {
  const ctrl = new AbortController(), limit = 65536;
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const start = range?.start || 0, end = Math.min(range?.end ?? limit - 1, start + limit - 1);
    const response = await fetch(url, { credentials: 'include', signal: ctrl.signal, headers: { Range: `bytes=${start}-${end}` } });
    if (!response.ok || !response.body || (start && response.status !== 206)) return 'unknown';
    const reader = response.body.getReader(), data = new Uint8Array(limit);
    let used = 0;
    while (used < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      const part = value.subarray(0, limit - used); data.set(part, used); used += part.length;
      const type = mp4MediaType(data.subarray(0, used));
      if (type !== 'unknown') return type;
    }
  } catch (e) { /* не подписываем неизвестный файл как видео */ }
  finally { clearTimeout(timer); ctrl.abort(); }
  return 'unknown';
}

async function addFile(tabId, item) {
  const key = 't' + tabId;
  const known = ((await chrome.storage.session.get(key))[key] || []).find(v => v.url === item.url);
  if (known?.metadataChecked) return; // один MP4 запрашивается плеером десятками диапазонов
  const list = (await chrome.storage.session.get(key))[key] || [];
  if (list.some(v => v.resources?.includes(item.url))) return;
  item.mediaType = /^audio\//i.test(item.mime || '') ? 'audio' : await probeMedia(item.url);
  item.metadataChecked = true;
  await addItem(tabId, item);
}

async function addItem(tabId, item) {
  const key = 't' + tabId;
  const list = (await chrome.storage.session.get(key))[key] || [];
  const index = list.findIndex(v => v.url === item.url);
  if (index >= 0) list[index] = { ...list[index], ...item };
  else list.unshift(item);
  if (list.length > 40) {
    // Сохраняем мастера и плейлисты раньше исходных файлов, запрашиваемых плеером.
    list.sort((a, b) => Number(!!b.variants?.length) - Number(!!a.variants?.length) || Number(b.kind === 'hls') - Number(a.kind === 'hls'));
    list.splice(40);
  }
  await chrome.storage.session.set({ [key]: list });
  const visible = Hls.visibleItems(list);
  chrome.action.setBadgeText({ tabId, text: String(visible.length) });
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#2e7d32' });
}

async function addHls(tabId, url, frameId, text) {
  const item = { url, kind: 'hls', size: 0, frameId, time: Date.now() };
  try {
    let base = url;
    if (text === undefined) {
      const response = await inspectUrl(url);
      base = response.url;
      text = response.text || '';
    }
    if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('Not an HLS playlist');
    let content;
    if (text.includes('#EXT-X-STREAM-INF')) {
      Object.assign(item, Hls.parseMaster(text, base));
      content = { variants: item.variants, renditions: item.renditions };
    }
    else {
      item.resources = Hls.referencedUrls(text, base);
      const media = Hls.parseMedia(text, base);
      item.duration = media.duration;
      content = media;
      if (media.init && !media.init.key) item.mediaType = await probeMedia(media.init.url, media.init.range);
    }
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(content)));
    item.contentKey = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  } catch (e) { /* не страшно — скачаем как есть */ }
  await addItem(tabId, item);
  // Восстанавливаем только известный адрес мастера того же плеера, без cookies.
  const info = Hls.kinescopeInfo(url);
  if (info && info.role !== 'master') {
    const known = (await chrome.storage.session.get('t' + tabId))['t' + tabId] || [];
    const key = tabId + ':' + info.masterUrl;
    if (!known.some(v => Hls.kinescopeInfo(v.url)?.id === info.id && v.variants?.length) && Date.now() - (masterAttempts.get(key) || 0) > 30000) {
      masterAttempts.set(key, Date.now());
      try {
        const master = await inspectUrl(info.masterUrl, 'omit');
        if (master.text?.includes('#EXT-X-STREAM-INF:')) await addHls(tabId, info.masterUrl, frameId, master.text);
      } catch (e) { /* недоступный мастер заменим парой захваченных дорожек */ }
    }
  }
}

// Проверяем адрес «на вкус»: плейлист это, видеофайл или что-то другое.
async function checkUrl(tabId, url, frameId) {
  const known = (await chrome.storage.session.get('t' + tabId))['t' + tabId] || [];
  if (known.some(v => v.url === url && (v.contentKey || v.metadataChecked))) return;
  try {
    const response = await inspectUrl(url);
    const { mime: type, size, text = '' } = response;
    if (text.trimStart().startsWith('#EXTM3U')) return addHls(tabId, url, frameId, text);
    if ((/^video\//i.test(type) && !/mp2t/i.test(type)) || /^audio\/(mp4|x-m4a)/i.test(type)) {
      if (size && size < 1024 * 1024) return;
      return addFile(tabId, { url, kind: 'mp4', mime: type, size, frameId, time: Date.now() });
    }
    // Один уровень поиска, только текущий сайт и известные хосты плееров.
    // Новые ссылки проверяем без cookies; произвольные вложенные страницы не обходим.
    if (/html|json|javascript|text\//i.test(type)) {
      for (const source of Hls.pageSources(text, response.url)) {
        if (source === url || !Hls.allowedPageSource(source, response.url)) continue;
        const playlist = await inspectUrl(source, 'omit').catch(() => null);
        if (playlist?.text?.trimStart().startsWith('#EXTM3U')) await addHls(tabId, source, frameId, playlist.text);
      }
    }
  } catch (e) { /* не получилось — значит не видео */ }
}

chrome.webRequest.onHeadersReceived.addListener(
  d => {
    if (d.tabId < 0 || (d.initiator || '').startsWith('chrome-extension://') || (d.originUrl || '').startsWith('moz-extension://')) return;
    if (d.statusCode >= 400) return;
    const mime = header(d.responseHeaders, 'content-type');
    const kind = detect(d.url, mime);

    if (kind === 'hls') return run(() => addHls(d.tabId, d.url, d.frameId));
    if (kind === 'mp4') {
      const size = totalSize(d.responseHeaders);
      if (size && size < 1024 * 1024) return; // мелочь (превью, реклама) не показываем
      return run(() => addFile(d.tabId, { url: d.url, kind, mime, size, frameId: d.frameId, time: Date.now() }));
    }
    if (d.type === 'xmlhttprequest' && CANDIDATE_RE.test(d.url) && !SEGMENT_RE.test(new URL(d.url).pathname)) {
      run(() => checkUrl(d.tabId, d.url, d.frameId));
    }
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

// Окно расширения присылает адреса, найденные прямо на странице.
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg && msg.type === 'check') {
    Promise.all(msg.urls.map(u => run(() => checkUrl(msg.tabId, u.url, u.frameId)))).then(() => reply(true));
    return true;
  }
});

// Новая страница во вкладке — чистим список.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading' && info.url) {
    for (const key of masterAttempts.keys()) if (key.startsWith(tabId + ':')) masterAttempts.delete(key);
    run(() => chrome.storage.session.remove('t' + tabId));
    chrome.action.setBadgeText({ tabId, text: '' });
  }
});
chrome.tabs.onRemoved.addListener(tabId => {
  for (const key of masterAttempts.keys()) if (key.startsWith(tabId + ':')) masterAttempts.delete(key);
  run(() => chrome.storage.session.remove('t' + tabId));
});
