// Ловим сетевые запросы вкладки и запоминаем найденные видео.

const SEGMENT_RE = /\.(ts|m4s|aac|m4a|vtt|key)(\?|#|$)|[\/_-](seg|segment|chunk|frag)[^\/]*$/i;

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

chrome.webRequest.onHeadersReceived.addListener(
  d => {
    if (d.tabId < 0 || (d.initiator || '').startsWith('chrome-extension://')) return;
    if (d.statusCode >= 400) return;
    const kind = detect(d.url, header(d.responseHeaders, 'content-type'));
    if (!kind) return;

    run(async () => {
      const item = { url: d.url, kind, size: totalSize(d.responseHeaders), time: Date.now() };
      if (kind === 'hls') {
        try {
          const text = await (await fetch(d.url, { credentials: 'include' })).text();
          if (text.includes('#EXT-X-STREAM-INF')) item.variants = parseMaster(text, d.url);
        } catch (e) { /* не страшно — скачаем как есть */ }
      } else if (item.size && item.size < 1024 * 1024) {
        return; // мелочь (превью, реклама) не показываем
      }
      await addItem(d.tabId, item);
    });
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

// Новая страница во вкладке — чистим список.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading' && info.url) {
    run(() => chrome.storage.session.remove('t' + tabId));
    chrome.action.setBadgeText({ tabId, text: '' });
  }
});
chrome.tabs.onRemoved.addListener(tabId => run(() => chrome.storage.session.remove('t' + tabId)));
