const root = document.getElementById('root');

const cleanName = s => (s || 'Видео').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || 'Видео';

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const key = 't' + tab.id;
  const all = (await chrome.storage.session.get(key))[key] || [];

  // Отдельные качества прячем: мастер-плейлист сам выберет лучшее.
  const items = all
    .filter(v => !all.some(m => m.variants && m.variants.some(x => x.url === v.url)))
    .sort((a, b) => (b.variants ? 1 : 0) - (a.variants ? 1 : 0));

  if (!items.length) {
    root.innerHTML = `
      <h1>Видео пока не найдено</h1>
      <ol>
        <li>Нажмите ▶ на видео, чтобы оно начало играть.</li>
        <li>Снова нажмите на красный значок со стрелкой.</li>
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
