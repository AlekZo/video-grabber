const root = document.getElementById('root');

const cleanName = s => (s || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);

// Выполняется внутри страницы (и внутри рамок с плеером): собирает адреса видео,
// их положение на странице и ближайший заголовок над каждым видео.
function scanPage() {
  const isTop = window === window.top;
  const found = [];

  const posOf = el => el.getBoundingClientRect().top + window.scrollY;

  function labelFor(el) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let last = '';
    while (walker.nextNode()) {
      const n = walker.currentNode;
      if (!(n.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) break; // дошли до видео
      const p = n.parentElement;
      if (!p || /^(SCRIPT|STYLE|NOSCRIPT|BUTTON|OPTION)$/.test(p.tagName)) continue;
      const t = n.textContent.replace(/\s+/g, ' ').trim();
      if (t.length < 2 || t.length > 80 || /^[\d\s:\/.,%-]+$/.test(t)) continue;
      if (p.closest('video, [class*="player"], [class*="vjs"]')) continue;
      if (!p.offsetParent && getComputedStyle(p).position !== 'fixed') continue; // скрытый текст
      last = t;
    }
    return last;
  }

  const add = (u, el) => {
    try {
      if (!u) return;
      const url = new URL(u, location.href).href;
      if (!/^https?:/i.test(url) || found.some(f => f.url === url)) return;
      found.push({ url, label: el ? labelFor(el) : '', pos: el ? posOf(el) : null });
    } catch (e) {}
  };

  document.querySelectorAll('[data-master]').forEach(e => add(e.getAttribute('data-master'), e));
  document.querySelectorAll('video').forEach(v => {
    add(v.getAttribute('src'), v);
    if (v.currentSrc) add(v.currentSrc, v);
    v.querySelectorAll('source').forEach(s => add(s.getAttribute('src'), v));
  });
  const re = /m3u8|playlist|master|manifest|\/(144|240|360|480|540|576|720|1080|1440|2160)p?(\?|#|$)/i;
  performance.getEntriesByType('resource').forEach(e => { if (re.test(e.name)) add(e.name, null); });

  const frames = isTop
    ? [...document.querySelectorAll('iframe')].filter(f => f.src).map(f => ({ src: f.src, label: labelFor(f), pos: posOf(f) }))
    : [];
  return { href: location.href, isTop, found, frames };
}

// Сопоставляем рамки плееров с заголовками на основной странице.
// results — [{ frameId, result }] из chrome.scripting.executeScript.
function buildMeta(results) {
  const top = (results.find(r => r.result.isTop) || { result: { frames: [] } }).result;
  const unused = [...top.frames];
  const take = f => { unused.splice(unused.indexOf(f), 1); return f; };
  const samePage = (a, b) => { try { const x = new URL(a), y = new URL(b); return x.origin === y.origin && x.pathname === y.pathname; } catch (e) { return false; } };

  const byFrame = {}; // frameId -> { label, pos }
  const byUrl = {};   // адрес видео -> { label, pos }
  for (const { frameId, result: r } of results) {
    let frame = null;
    if (!r.isTop) {
      // Сначала точное совпадение адреса, потом единственное похожее, потом просто по порядку.
      const similar = unused.filter(f => samePage(f.src, r.href));
      frame = unused.find(f => f.src === r.href) || (similar.length === 1 ? similar[0] : null) || similar[0] || unused[0] || null;
      if (frame) take(frame);
      byFrame[frameId] = frame ? { label: frame.label, pos: frame.pos } : {};
    }
    for (const f of r.found) {
      byUrl[f.url] = {
        label: f.label || (frame && frame.label) || '',
        pos: r.isTop ? f.pos : frame ? frame.pos + (f.pos || 0) : f.pos,
      };
    }
  }
  return { byFrame, byUrl };
}

async function readItems(tabId, meta) {
  const key = 't' + tabId;
  const all = (await chrome.storage.session.get(key))[key] || [];
  // Отдельные качества прячем: мастер-плейлист сам выберет лучшее.
  const items = all
    .filter(v => !all.some(m => m.variants && m.variants.some(x => x.url === v.url)))
    .map(v => ({ ...v, ...(meta.byUrl[v.url] || meta.byFrame[v.frameId] || {}) }));
  // По порядку на странице; то, что нашлось только по сети, — в конце.
  items.sort((a, b) => (a.pos ?? 1e12) - (b.pos ?? 1e12));
  return items;
}

function startDownload(v, fileName, active) {
  const q = new URLSearchParams({ src: v.url, kind: v.kind, name: fileName });
  chrome.tabs.create({ url: chrome.runtime.getURL('download.html?' + q), active });
}

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  root.innerHTML = '<h1>Ищу видео…</h1>';

  let meta = { byFrame: {}, byUrl: {} };
  try {
    const results = (await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: scanPage }))
      .filter(r => r && r.result);
    meta = buildMeta(results);
    const urls = results.flatMap(r => r.result.found.map(f => ({ url: f.url, frameId: r.frameId })));
    if (urls.length) {
      await Promise.race([
        chrome.runtime.sendMessage({ type: 'check', tabId: tab.id, urls }),
        new Promise(r => setTimeout(r, 12000)),
      ]);
    }
  } catch (e) {
    console.warn(e); // например, служебная страница браузера — просто покажем, что нашли по сети
  }

  const items = await readItems(tab.id, meta);

  if (!items.length) {
    root.innerHTML = `
      <h1>Видео пока не найдено</h1>
      <ol>
        <li>Нажмите ▶ на видео, чтобы оно начало играть.</li>
        <li>Снова нажмите на красный значок со стрелкой.</li>
        <li>Если не помогло — обновите страницу (клавиша F5) и повторите.</li>
      </ol>`;
    return;
  }

  const page = cleanName(tab.title) || 'Видео';
  const titleOf = (v, i) => cleanName(v.label) || (items.length > 1 ? `Видео ${i + 1}` : 'Видео');
  const fileOf = (v, i) => {
    const label = cleanName(v.label);
    if (items.length === 1) return label && !page.includes(label) ? `${page} — ${label}` : page;
    return `${page} — ${String(i + 1).padStart(2, '0')} ${label || 'Видео'}`;
  };

  const h1 = document.createElement('h1');
  h1.textContent = items.length > 1 ? 'На странице видео: ' + items.length : 'Видео найдено';
  root.replaceChildren(h1);

  if (items.length > 1) {
    const all = document.createElement('button');
    all.className = 'all';
    all.textContent = `⬇ Скачать все (${items.length})`;
    all.onclick = () => {
      items.forEach((v, i) => startDownload(v, fileOf(v, i), i === 0));
      window.close();
    };
    root.appendChild(all);
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'Или по одному, сверху вниз, как на странице:';
    root.appendChild(p);
  }

  items.forEach((v, i) => {
    let quality = '';
    if (v.variants && v.variants.length) {
      const best = v.variants.reduce((a, b) => (b.bw > a.bw ? b : a));
      if (best.res) quality = 'Качество ' + best.res.split('x')[1] + 'p';
    } else if (v.size) {
      quality = 'Размер ' + (v.size / 1024 / 1024).toFixed(0) + ' МБ';
    }

    const btn = document.createElement('button');
    btn.textContent = (items.length > 1 ? `${i + 1}. ` : '⬇ ') + (items.length > 1 ? titleOf(v, i) : 'Скачать видео');
    if (quality) {
      const s = document.createElement('small');
      s.textContent = quality;
      btn.appendChild(s);
    }
    btn.onclick = () => {
      startDownload(v, fileOf(v, i), true);
      window.close();
    };
    root.appendChild(btn);
  });
})();
