// Страница скачивания: показывает прогресс и сохраняет видео в «Загрузки».

const params = new URLSearchParams(location.search);
const src = params.get('src');
const kind = params.get('kind') || 'hls';
const name = params.get('name') || 'Видео';

const $ = id => document.getElementById(id);
$('name').textContent = name;
document.title = 'Скачивание: ' + name;

let working = true;
window.addEventListener('beforeunload', e => { if (working) { e.preventDefault(); e.returnValue = ''; } });

const started = Date.now();
function progress(fraction, text) {
  const pct = Math.min(99, Math.floor(fraction * 100));
  $('fill').style.width = pct + '%';
  $('percent').textContent = pct + '%';
  if (fraction > 0.03) {
    const left = (Date.now() - started) / fraction * (1 - fraction) / 60000;
    text += left < 1 ? ' · осталось меньше минуты' : ` · осталось примерно ${Math.ceil(left)} мин`;
  }
  $('status').textContent = text;
}

function finish(downloadId, fileName) {
  working = false;
  document.body.className = 'done';
  $('head').textContent = 'Готово!';
  $('fill').style.width = '100%';
  $('percent').textContent = '✔ Видео сохранено';
  $('status').textContent = `Файл «${fileName}» лежит в папке «Загрузки».`;
  $('retry').style.display = 'none';
  $('open').onclick = () => chrome.downloads.open(downloadId);
  $('folder').onclick = () => chrome.downloads.show(downloadId);
  document.title = 'Готово: ' + name;
}

// Спокойная подсказка во время скачивания (не ошибка).
function notice(text) {
  $('notice').textContent = text || '';
  $('notice').className = text ? 'show' : '';
}

const MSG = {
  generic: 'Попробуйте ещё раз — обычно это помогает. Если снова не выйдет: вернитесь на страницу урока, обновите её (клавиша F5), запустите видео и снова нажмите на красный значок.',
  expired: 'Ссылка на видео устарела. Вернитесь на страницу урока, обновите её (клавиша F5), запустите видео и снова нажмите на красный значок.',
  drm: 'Это видео защищено от копирования, поэтому скачать его нельзя.',
  unsupported: 'Это видео в необычном формате, расширение пока не умеет его скачивать.',
  memory: 'Видео слишком большое — компьютеру не хватило памяти. Закройте другие программы и вкладки и попробуйте ещё раз.',
  canceled: 'Скачивание было отменено. Чтобы начать заново, нажмите кнопку ниже.',
};

function fail(err) {
  working = false;
  stopped = true;
  console.error(err);
  let msg = err.userMessage;
  if (!msg && (err.name === 'RangeError' || /memory|allocation/i.test(err.message))) msg = MSG.memory;
  document.body.className = 'fail';
  $('head').textContent = 'Не получилось скачать видео';
  $('percent').textContent = 'Ничего страшного';
  $('status').textContent = msg || MSG.generic;
  $('tech').textContent = String(err && (err.stack || err.message || err));
  $('open').style.display = 'none';
  $('folder').style.display = 'none';
  $('retry').onclick = () => { working = false; location.reload(); };
  document.title = 'Не получилось: ' + name;
}

const userError = (msg, detail) => Object.assign(new Error(detail || msg), { userMessage: msg, fatal: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let stopped = false;

// Если пропал интернет — спокойно ждём, пока он вернётся.
async function waitOnline() {
  if (navigator.onLine) return;
  notice('Пропал интернет. Жду, когда он появится — ничего нажимать не нужно.');
  await new Promise(r => window.addEventListener('online', r, { once: true }));
  notice('Интернет появился, продолжаю…');
}

// ---------- Сохранение файла и ожидание, пока браузер его допишет ----------

async function saveAndWait(url, fileName, onBytes) {
  const id = await chrome.downloads.download({ url, filename: fileName, saveAs: false, conflictAction: 'uniquify' });
  let resumes = 0;
  for (;;) {
    await sleep(500);
    const [d] = await chrome.downloads.search({ id });
    if (!d) throw userError(MSG.canceled, 'download disappeared');
    if (onBytes && d.totalBytes > 0) onBytes(d.bytesReceived, d.totalBytes);
    if (d.state === 'complete') return { id, fileName: (d.filename || fileName).split(/[\\/]/).pop() };
    if (d.state === 'interrupted') {
      if (d.error === 'USER_CANCELED') throw userError(MSG.canceled, d.error);
      if (/FORBIDDEN|UNAUTHORIZED/.test(d.error)) throw userError(MSG.expired, d.error);
      if (/NO_SPACE/.test(d.error)) throw userError('На диске закончилось место. Освободите место и попробуйте ещё раз.', d.error);
      // Обрыв связи — докачиваем с того же места.
      if (d.canResume && resumes < 10) {
        resumes++;
        notice('Связь прервалась, продолжаю скачивание…');
        await waitOnline();
        await sleep(2000 * resumes);
        await chrome.downloads.resume(id).catch(() => {});
        continue;
      }
      throw new Error('interrupted: ' + d.error);
    }
    if (resumes) notice('');
  }
}

// ---------- Обычный MP4-файл ----------

async function downloadMp4() {
  const r = await saveAndWait(src, name + '.mp4', (got, total) =>
    progress(got / total, `Скачано ${mb(got)} из ${mb(total)}`));
  finish(r.id, r.fileName);
}

// ---------- HLS-поток ----------

const mb = n => (n / 1024 / 1024).toFixed(0) + ' МБ';

// Загрузка с терпеливыми повторами: до 10 попыток, паузы растут до 20 секунд,
// «зависший» запрос прерывается через 90 секунд и повторяется.
async function get(url, as = 'text') {
  for (let attempt = 1; ; attempt++) {
    if (stopped) throw new Error('stopped');
    await waitOnline();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90000);
    try {
      const r = await fetch(url, { credentials: 'include', signal: ctrl.signal });
      if ([401, 403, 410].includes(r.status) && attempt >= 2) throw userError(MSG.expired, 'HTTP ' + r.status + ' ' + url);
      if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
      const body = as === 'text' ? await r.text() : await r.arrayBuffer();
      if (attempt > 1) notice('');
      return body;
    } catch (e) {
      if (e.fatal || stopped) throw e;
      if (attempt >= 10) throw e;
      notice(`Связь с сайтом прервалась. Пробую ещё раз (попытка ${attempt + 1} из 10)…`);
      await sleep(Math.min(20000, 2000 * attempt));
    } finally {
      clearTimeout(timer);
    }
  }
}

const attr = (line, key) => {
  const m = line.match(new RegExp(key + '=("([^"]*)"|[^,]*)'));
  return m ? (m[2] !== undefined ? m[2] : m[1]) : null;
};

function pickBest(text, base) {
  const lines = text.split(/\r?\n/);
  let best = null;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
    const bw = Number(attr(lines[i], 'BANDWIDTH')) || 0;
    let j = i + 1;
    while (j < lines.length && (!lines[j].trim() || lines[j].startsWith('#'))) j++;
    if (j < lines.length && (!best || bw > best.bw)) best = { bw, url: new URL(lines[j].trim(), base).href };
  }
  return best && best.url;
}

function parseMedia(text, base) {
  const segments = [];
  let seq = 0, key = null, init = null, duration = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) seq = Number(line.split(':')[1]) || 0;
    else if (line.startsWith('#EXTINF:')) duration += parseFloat(line.slice(8)) || 0;
    else if (line.startsWith('#EXT-X-KEY:')) {
      const method = attr(line, 'METHOD');
      if (method === 'NONE') key = null;
      else if (method === 'AES-128') key = { uri: new URL(attr(line, 'URI'), base).href, iv: attr(line, 'IV') };
      else throw userError(MSG.drm, 'EXT-X-KEY METHOD=' + method);
    } else if (line.startsWith('#EXT-X-MAP:')) init = new URL(attr(line, 'URI'), base).href;
    else if (line.startsWith('#EXT-X-BYTERANGE')) throw userError(MSG.unsupported, 'EXT-X-BYTERANGE');
    else if (!line.startsWith('#')) segments.push({ url: new URL(line, base).href, key, seq: seq++ });
  }
  return { segments, init, duration };
}

const keyCache = {};
async function decrypt(data, seg) {
  if (!keyCache[seg.key.uri]) {
    keyCache[seg.key.uri] = get(seg.key.uri, 'buf').then(raw =>
      crypto.subtle.importKey('raw', raw, 'AES-CBC', false, ['decrypt']));
  }
  const iv = new Uint8Array(16);
  if (seg.key.iv) {
    const hex = seg.key.iv.replace(/^0x/i, '').padStart(32, '0');
    for (let i = 0; i < 16; i++) iv[i] = parseInt(hex.substr(i * 2, 2), 16);
  } else {
    new DataView(iv.buffer).setUint32(12, seg.seq);
  }
  return crypto.subtle.decrypt({ name: 'AES-CBC', iv }, await keyCache[seg.key.uri], data);
}

async function downloadHls() {
  let url = src;
  let text = await get(url);
  if (text.includes('#EXT-X-STREAM-INF')) {
    url = pickBest(text, url);
    text = await get(url);
  }
  if (!text.includes('#EXTM3U')) throw userError(MSG.expired, 'not a playlist: ' + text.slice(0, 200));
  const { segments, init, duration } = parseMedia(text, url);
  if (!segments.length) throw userError(MSG.unsupported, 'empty playlist');

  // mode: 'mp4' — перепаковываем .ts в MP4; 'raw' — склеиваем как есть.
  let mode = init ? 'raw' : 'mp4';
  const conv = mode === 'mp4' ? new TsToMp4() : null;
  const raw = init ? [await get(init, 'buf')] : [];

  // Качаем параллельно, а собираем строго по порядку, сразу освобождая память.
  const ready = new Array(segments.length);
  let next = 0, nextToAdd = 0, done = 0, bytes = 0;

  function addReady() {
    while (nextToAdd < segments.length && ready[nextToAdd]) {
      const data = ready[nextToAdd];
      ready[nextToAdd] = null;
      if (mode === 'mp4') {
        let ok = false;
        try { ok = conv.push(data); } catch (e) { console.warn(e); }
        if (!ok && nextToAdd === 0) { mode = 'ts'; raw.push(data); } // не вышло — сохраним как .ts
      } else {
        raw.push(data);
      }
      nextToAdd++;
    }
  }

  async function worker() {
    while (next < segments.length && !stopped) {
      const i = next++;
      let data = await get(segments[i].url, 'buf');
      if (segments[i].key) data = await decrypt(data, segments[i]);
      ready[i] = data;
      done++; bytes += data.byteLength;
      progress(done / segments.length * 0.97, `Скачано ${mb(bytes)}`);
      addReady();
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  addReady();

  $('status').textContent = 'Сохраняю файл…';
  const parts = mode === 'mp4' ? conv.finish(duration) : raw;
  const ext = mode === 'ts' ? 'ts' : 'mp4';
  const blob = new Blob(parts, { type: ext === 'mp4' ? 'video/mp4' : 'video/mp2t' });
  const r = await saveAndWait(URL.createObjectURL(blob), `${name}.${ext}`);
  finish(r.id, r.fileName);
}

(kind === 'mp4' ? downloadMp4() : downloadHls()).catch(fail);
