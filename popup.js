const root = document.getElementById('root');
let lowResource = true;
const resetQuality = [];

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
  document.querySelectorAll('[data-video-src]').forEach(e => add(e.getAttribute('data-video-src'), e));
  // GetCourse sometimes keeps a lazy player URL in data-src instead of src.
  document.querySelectorAll('video[data-src], source[data-src], iframe[data-src]').forEach(e => add(e.getAttribute('data-src'), e));
  if (/(^|\.)kinescope\.io$/i.test(location.hostname) && /^\/embed\//.test(location.pathname)) add(location.href, null);
  document.querySelectorAll('video').forEach(v => {
    add(v.getAttribute('src'), v);
    if (v.currentSrc) add(v.currentSrc, v);
    v.querySelectorAll('source').forEach(s => { add(s.getAttribute('src'), v); add(s.getAttribute('data-src'), v); });
  });
  const re = /m3u8|playlist|master|manifest|\.(mp4|webm|mov)(\?|#|$)|\/(144|240|360|480|540|576|720|1080|1440|2160)p?(\?|#|$)/i;
  performance.getEntriesByType('resource').forEach(e => { if (re.test(e.name)) add(e.name, null); });

  const frames = isTop
    ? [...document.querySelectorAll('iframe')].filter(f => f.src).map(f => ({ src: f.src, title: f.getAttribute('title') || '', label: labelFor(f), pos: posOf(f) }))
    : [];
  const metaTitle = document.querySelector('meta[property="og:title"], meta[name="twitter:title"]')?.getAttribute('content') || '';
  return { href: location.href, title: metaTitle || document.title || '', isTop, found, frames };
}

// Сопоставляем рамки плееров с заголовками на основной странице и используем названия самих плееров.
// results — [{ frameId, result }] из chrome.scripting.executeScript.
function buildMeta(results) {
  const top = (results.find(r => r.result.isTop) || { result: { frames: [] } }).result;
  const unused = [...top.frames];
  const take = f => { unused.splice(unused.indexOf(f), 1); return f; };
  const samePage = (a, b) => { try { const x = new URL(a), y = new URL(b); return x.origin === y.origin && x.pathname === y.pathname; } catch (e) { return false; } };
  const usefulTitle = value => {
    const title = cleanName(value);
    return /^(?:video|audio|player|video player|audio player|html5 video player|youtube video player|kinescope|vimeo|youtube|vk video|rutube|dailymotion|видео|аудио|плеер|видеоплеер|аудиоплеер)$/i.test(title) ? '' : title;
  };

  const byFrame = {}; // frameId -> { label, pos }
  const byUrl = {};   // адрес видео -> { label, pos }
  for (const { frameId, result: r } of results) {
    let frame = null;
    const playerTitle = r.isTop ? '' : usefulTitle(r.title);
    if (!r.isTop) {
      // Сначала точное совпадение адреса, потом единственное похожее, потом просто по порядку.
      const similar = unused.filter(f => samePage(f.src, r.href));
      frame = unused.find(f => f.src === r.href) || (similar.length === 1 ? similar[0] : null) || similar[0] || unused[0] || null;
      if (frame) take(frame);
      const frameTitle = usefulTitle(frame && frame.title);
      byFrame[frameId] = { label: playerTitle || frameTitle || (frame && frame.label) || '', ...(frame ? { pos: frame.pos } : {}) };
    }
    const frameTitle = usefulTitle(frame && frame.title);
    for (const f of r.found) {
      byUrl[f.url] = {
        label: playerTitle || frameTitle || f.label || (frame && frame.label) || '',
        pos: r.isTop ? f.pos : frame ? frame.pos + (f.pos || 0) : f.pos,
      };
    }
  }
  return { byFrame, byUrl };
}

async function readItems(tabId, meta) {
  const key = 't' + tabId;
  const all = (await chrome.storage.session.get(key))[key] || [];
  // Дорожки и исходные MP4 из HLS не являются отдельными видео.
  const items = Hls.visibleItems(all)
    .map(v => ({ ...v, ...(meta.byUrl[v.url] || meta.byFrame[v.frameId] || {}) }));
  // По порядку на странице; то, что нашлось только по сети, — в конце.
  items.sort((a, b) => (a.pos ?? 1e12) - (b.pos ?? 1e12));
  return items;
}

async function startDownload(v, fileName, active, batch = null, index = 0) {
  const q = ResourceMode.jobParams(v, fileName, { enabled: lowResource, batch, index: batch ? index : null });
  if (batch) await (chrome.storage.local || chrome.storage.session).set({
    ['batch-progress:' + batch]: { index, updatedAt: Date.now() },
  });
  return chrome.tabs.create({ url: chrome.runtime.getURL('download.html?' + q), active });
}

(async () => {
  try { lowResource = (await chrome.storage.local?.get('lowResource'))?.lowResource ?? true; } catch (e) { /* включён по умолчанию */ }
  const modeToggle = document.getElementById('lowResource');
  modeToggle.checked = lowResource;
  modeToggle.onchange = () => {
    lowResource = modeToggle.checked;
    Promise.resolve(chrome.storage.local?.set({ lowResource })).catch(console.warn);
    resetQuality.forEach(reset => reset());
  };
  const resume = document.getElementById('resume');
  try {
    const stored = await chrome.storage.local?.get(null);
    const openTabs = await chrome.tabs.query({});
    for (const [key, jobs] of Object.entries(stored || {})) {
      if (!key.startsWith('batch:') || !Array.isArray(jobs)) continue;
      const id = key.slice(6), progress = stored['batch-progress:' + id];
      const index = Math.max(0, Math.min(Number(progress?.index) || 0, jobs.length - 1)), job = jobs[index];
      const alreadyOpen = openTabs.some(t => {
        try { return new URL(t.url).searchParams.get('batch') === id; } catch (e) { return false; }
      });
      if (!job || alreadyOpen) continue;
      const button = document.createElement('button');
      button.className = 'resume';
      button.textContent = `↻ Продолжить очередь (${index + 1} из ${jobs.length})`;
      button.onclick = async () => {
        button.disabled = true;
        try { await startDownload(job, job.fileName, true, id, index); window.close(); }
        catch (e) { button.disabled = false; console.error(e); }
      };
      resume.appendChild(button);
    }
  } catch (e) { console.warn(e); }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  root.innerHTML = '<h1>Ищу видео и аудио…</h1>';

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

  const items = (await readItems(tab.id, meta)).map(v => ({ ...v, pageUrl: tab.url }));

  if (!items.length) {
    root.innerHTML = `
      <h1>Видео пока не найдено</h1>
      <ol>
        <li>Нажмите ▶ на видео, чтобы оно начало играть.</li>
        <li>Нажмите «Найти ещё раз» через пару секунд.</li>
        <li>Если не помогло — обновите страницу (клавиша F5) и повторите.</li>
      </ol>
      <button id="scanAgain" type="button">↻ Найти ещё раз</button>`;
    document.getElementById('scanAgain').onclick = () => location.reload();
    return;
  }

  const page = cleanName(tab.title) || 'Видео';
  const titleOf = (v, i) => cleanName(v.label) || (v.mediaType === 'audio' ? 'Аудио' : 'Видео') + (items.length > 1 ? ` ${i + 1}` : '');
  const fileOf = (v, i) => {
    const label = cleanName(v.label);
    if (items.length === 1) return label && !page.includes(label) ? `${page} — ${label}` : page;
    return `${page} — ${String(i + 1).padStart(2, '0')} ${label || (v.mediaType === 'audio' ? 'Аудио' : 'Видео')}`;
  };

  const h1 = document.createElement('h1');
  h1.textContent = items.length > 1 ? 'Найдено файлов: ' + items.length : items[0].mediaType === 'audio' ? 'Аудио найдено' : items[0].mediaType === 'unknown' ? 'Файл найден' : 'Видео найдено';
  const scanAgain = document.createElement('button');
  scanAgain.type = 'button';
  scanAgain.className = 'secondary';
  scanAgain.textContent = '↻ Найти ещё раз';
  scanAgain.onclick = () => location.reload();
  root.replaceChildren(h1, scanAgain);
  const selections = new Map();
  const selectedName = (v, i) => cleanName(selections.get(v.url)?.fileName) || fileOf(v, i);

  if (items.length > 1) {
    const all = document.createElement('button');
    all.className = 'all';
    all.textContent = `⬇ Скачать все (${items.length})`;
    all.onclick = async () => {
      all.disabled = true;
      try {
        if (lowResource) {
          const id = crypto.randomUUID();
          const jobs = items.map((v, i) => ({ ...v, ...selections.get(v.url), fileName: selectedName(v, i) }));
          // Только необходимые для загрузки поля: не сохраняем заново длинные списки сегментов.
          const queue = jobs.map(v => ({ url: v.url, kind: v.kind, mediaType: v.mediaType, audioUrl: v.audioUrl,
            videoUrl: v.videoUrl, videoRes: v.videoRes, videoBw: v.videoBw, pageUrl: v.pageUrl, fileName: v.fileName }));
          // Local storage keeps an interrupted course queue after a browser restart.
          await (chrome.storage.local || chrome.storage.session).set({ ['batch:' + id]: queue });
          await startDownload(queue[0], queue[0].fileName, true, id);
        } else {
          for (let i = 0; i < items.length; i++) await startDownload({ ...items[i], ...selections.get(items[i].url) }, selectedName(items[i], i), i === 0);
        }
        window.close();
      } catch (e) { all.disabled = false; console.error(e); }
    };
    root.appendChild(all);
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'Или по одному, сверху вниз, как на странице:';
    root.appendChild(p);
  }

  items.forEach((v, i) => {
    const choice = { fileName: cleanName(fileOf(v, i)) };
    selections.set(v.url, choice);
    let quality = '';
    const availableQualities = v.variants || v.videoTracks || [];
    if (availableQualities.length) {
      const best = Hls.selectStreams({ variants: availableQualities, renditions: v.renditions || [] });
      if (best?.res) quality = 'Качество ' + best.res.split('x')[1] + 'p';
    } else if (v.size) {
      quality = 'Размер ' + (v.size / 1024 / 1024).toFixed(0) + ' МБ';
    }

    const btn = document.createElement('button');
    btn.className = v.mediaType === 'audio' ? 'audio' : '';
    btn.textContent = (items.length > 1 ? `${i + 1}. ` : '⬇ ') + (items.length > 1 ? titleOf(v, i) : v.mediaType === 'audio' ? 'Скачать аудио' : 'Скачать видео');
    const badge = document.createElement('small');
    badge.className = 'media-kind';
    badge.textContent = Hls.mediaLabel(v.mediaType);
    btn.appendChild(badge);
    const explain = text => {
      const line = document.createElement('small');
      line.textContent = text;
      btn.appendChild(line);
    };
    if (v.kind === 'hls' && v.mediaType === 'av') explain('🔗 Видео и звук — один файл');
    if (v.duplicateCount) explain(`♻ Скрыто подтверждённых дублей: ${v.duplicateCount}`);
    if (v.relatedCount) explain('Дорожки и варианты качества сгруппированы');
    if (v.label && items.some(other => other !== v && other.label === v.label)) explain('Совпадает название; дубль не подтверждён');
    let qualityInfo = null;
    if (quality) {
      const s = document.createElement('small');
      qualityInfo = s;
      s.textContent = quality;
      btn.appendChild(s);
    }
    btn.onclick = () => {
      startDownload({ ...v, ...selections.get(v.url) }, selectedName(v, i), true);
      window.close();
    };
    root.appendChild(btn);

    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'Название и настройки';
    details.appendChild(summary);
    const nameLabel = document.createElement('label');
    nameLabel.className = 'file-name';
    nameLabel.textContent = 'Имя файла (без расширения)';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = choice.fileName;
    nameInput.maxLength = 100;
    nameInput.ariaLabel = 'Имя файла для ' + titleOf(v, i);
    nameInput.oninput = () => { choice.fileName = nameInput.value; };
    nameLabel.appendChild(nameInput);
    details.appendChild(nameLabel);

    const variants = v.variants || v.videoTracks || [];
    const audioTracks = v.renditions?.filter(r => r.type === 'AUDIO') || v.audioTracks || [];
    if (variants.length > 1 || audioTracks.length > 1) {
      const quality = document.createElement('select'), audio = document.createElement('select');
      quality.ariaLabel = 'Качество видео'; audio.ariaLabel = 'Язык звука';
      const defaultVariant = () => Hls.selectStreams({ variants, renditions: v.renditions || [] });
      const best = defaultVariant();
      Object.assign(choice, { videoUrl: best?.url, videoRes: best?.res || '', videoBw: best?.bw || 0,
        audioUrl: v.audioUrl || null });
      for (const variant of variants) {
        const option = document.createElement('option');
        option.value = variant.url;
        option.textContent = variant.res ? variant.res.split('x')[1] + 'p' : 'Качество ' + (variant.bw || 'по умолчанию');
        quality.appendChild(option);
      }
      quality.value = best?.url || '';
      const updateAudio = () => {
        const variant = variants.find(x => x.url === quality.value);
        const tracks = v.renditions ? audioTracks.filter(a => a.group === variant?.audio) : audioTracks;
        audio.replaceChildren();
        for (const track of tracks) {
          const option = document.createElement('option');
          option.value = track.url || '';
          option.textContent = track.name || track.language || 'Звук по умолчанию';
          audio.appendChild(option);
        }
        const selected = tracks.find(t => t.url === choice.audioUrl) || tracks.find(t => t.default) || tracks[0];
        choice.audioUrl = selected?.url || null;
        audio.value = choice.audioUrl || '';
        audio.style.display = tracks.length > 1 ? 'block' : 'none';
      };
      quality.onchange = () => {
        choice.videoUrl = quality.value;
        const variant = variants.find(x => x.url === quality.value);
        choice.videoRes = variant?.res || '';
        choice.videoBw = variant?.bw || 0;
        if (qualityInfo && variant?.res) qualityInfo.textContent = 'Качество ' + variant.res.split('x')[1] + 'p';
        updateAudio();
      };
      audio.onchange = () => { choice.audioUrl = audio.value || null; };
      updateAudio();
      resetQuality.push(() => { quality.value = defaultVariant()?.url || ''; quality.onchange(); });
      if (variants.length > 1) details.appendChild(quality);
      details.appendChild(audio);
    }
    root.appendChild(details);
  });
})();
