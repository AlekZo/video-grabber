const root = document.getElementById('root');

const cleanName = s => (s || 'Видео').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || 'Видео';

// Выполняется внутри страницы (и внутри рамки с плеером): собирает адреса видео.
function scanPage() {
  const urls = new Set();
  const add = u => { try { if (u) urls.add(new URL(u, location.href).href); } catch (e) {} };
  document.querySelectorAll('[data-master]').forEach(e => add(e.getAttribute('data-master')));
  document.querySelectorAll('video, source').forEach(v => {
    add(v.getAttribute('src'));
    if (v.currentSrc) add(v.currentSrc);
  });
  const re = /m3u8|playlist|master|manifest|\/(144|240|360|480|540|576|720|1080|1440|2160)p?(\?|#|$)/i;
  performance.getEntriesByType('resource').forEach(e => { if (re.test(e.name)) add(e.name); });
  return [...urls].filter(u => /^https?:/i.test(u));
}

async function readItems(tabId) {
  const key = 't' + tabId;
  const all = (await chrome.storage.session.get(key))[key] || [];
  // Отдельные качества прячем: мастер-плейлист сам выберет лучшее.
  return all
    .filter(v => !all.some(m => m.variants && m.variants.some(x => x.url === v.url)))
    .sort((a, b) => (b.variants ? 1 : 0) - (a.variants ? 1 : 0));
}

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  root.innerHTML = '<h1>Ищу видео…</h1>';

  try {
    const results = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: scanPage });
    const urls = [...new Set(results.flatMap(r => r.result || []))];
    if (urls.length) {
      await Promise.race([
        chrome.runtime.sendMessage({ type: 'check', tabId: tab.id, urls }),
        new Promise(r => setTimeout(r, 12000)),
      ]);
    }
  } catch (e) {
    console.warn(e); // например, служебная страница браузера — просто покажем, что нашли по сети
  }

  const items = await readItems(tab.id);

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

  const name = cleanName(tab.title);
  root.innerHTML = `<h1>${items.length > 1 ? 'Найдено видео: ' + items.length : 'Видео найдено'}</h1>`;

  items.forEach((v, i) => {
    let quality = '';
    if (v.variants && v.variants.length) {
      const best = v.variants.reduce((a, b) => (b.bw > a.bw ? b : a));
      if (best.res) quality = 'Качество ' + best.res.split('x')[1] + 'p';
    } else if (v.size) {
      quality = 'Размер ' + (v.size / 1024 / 1024).toFixed(0) + ' МБ';
    }

    const btn = document.createElement('button');
    btn.textContent = items.length > 1 ? `⬇ Скачать видео ${i + 1}` : '⬇ Скачать видео';
    if (quality) {
      const s = document.createElement('small');
      s.textContent = quality;
      btn.appendChild(s);
    }
    btn.onclick = () => {
      const q = new URLSearchParams({
        src: v.url,
        kind: v.kind,
        name: items.length > 1 ? `${name} (${i + 1})` : name,
      });
      chrome.tabs.create({ url: chrome.runtime.getURL('download.html?' + q) });
      window.close();
    };
    root.appendChild(btn);
  });

  if (items.length > 1) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'Обычно нужное видео — первое в списке.';
    root.appendChild(p);
  }
})();
