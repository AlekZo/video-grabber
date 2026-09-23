// Страница скачивания: качает видео и записывает его прямо в папку, которую выбрал пользователь.

const params = new URLSearchParams(location.search);
const src = params.get('src');
const kind = params.get('kind') || 'hls';
const name = params.get('name') || 'Видео';

const $ = id => document.getElementById(id);
$('name').textContent = name;
document.title = 'Скачивание: ' + name;

// Chrome, Edge и Яндекс.Браузер умеют выбирать папку. Firefox — нет: там откроется обычное «Сохранить как».
const canPick = typeof window.showDirectoryPicker === 'function';

let saved = false, failed = false, stopped = false;
window.addEventListener('beforeunload', e => { if (!saved && !failed) { e.preventDefault(); e.returnValue = ''; } });

const mb = n => (n / 1024 / 1024).toFixed(0) + ' МБ';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const started = Date.now();
function progress(fraction, text, eta = true) {
  const pct = Math.min(99, Math.floor(fraction * 100));
  $('fill').style.width = pct + '%';
  $('percent').textContent = pct + '%';
  if (eta && fraction > 0.03) {
    const left = (Date.now() - started) / fraction * (1 - fraction) / 60000;
    text += left < 1 ? ' · осталось меньше минуты' : ` · осталось примерно ${Math.ceil(left)} мин`;
  }
  $('status').textContent = text;
}

// Спокойная подсказка во время скачивания (не ошибка).
function notice(text) {
  $('notice').textContent = text || '';
  $('notice').className = text ? 'box show' : 'box';
}

function pickStatus(text, cls = '') {
  $('pickStatus').textContent = text;
  $('pickStatus').className = cls;
}

const MSG = {
  generic: 'Попробуйте ещё раз — обычно это помогает. Если снова не выйдет: вернитесь на страницу урока, обновите её (клавиша F5), запустите видео и снова нажмите на красный значок.',
  expired: 'Ссылка на видео устарела. Вернитесь на страницу урока, обновите её (клавиша F5), запустите видео и снова нажмите на красный значок.',
  drm: 'Это видео защищено от копирования, поэтому скачать его нельзя.',
  unsupported: 'Это видео в необычном формате, расширение пока не умеет его скачивать.',
  memory: 'Видео слишком большое — компьютеру не хватило памяти. Закройте другие программы и вкладки и попробуйте ещё раз.',
  canceled: 'Скачивание было отменено. Чтобы начать заново, нажмите кнопку ниже.',
  space: 'В выбранной папке (или на флешке) закончилось место. Освободите место или выберите другую папку и попробуйте ещё раз.',
  gone: 'Выбранная папка пропала — возможно, вынули флешку. Вставьте её обратно и попробуйте ещё раз.',
  write: 'Не получилось записать видео в выбранную папку. Попробуйте ещё раз и выберите другую папку.',
};

const userError = (msg, detail) => Object.assign(new Error(detail || msg), { userMessage: msg, fatal: true });

function writeError(e) {
  if (e.userMessage) return e;
  if (e.name === 'QuotaExceededError' || /space|quota/i.test(e.message)) return userError(MSG.space, e.message);
  if (e.name === 'NotFoundError') return userError(MSG.gone, e.message);
  return userError(MSG.write, e.name + ': ' + e.message);
}

function fail(err) {
  if (failed) return;
  failed = true;
  stopped = true;
  console.error(err);
  let msg = err.userMessage;
  if (!msg && (err.name === 'RangeError' || /memory|allocation/i.test(err.message))) msg = MSG.memory;
  document.body.className = 'fail';
  $('head').textContent = 'Не получилось скачать видео';
  $('percent').textContent = 'Ничего страшного';
  $('status').textContent = msg || MSG.generic;
  $('tech').textContent = String(err && (err.stack || err.message || err));
  ['open', 'folder', 'watch'].forEach(id => { $(id).style.display = 'none'; });
  $('retry').onclick = () => location.reload();
  document.title = 'Не получилось: ' + name;
  // Недописанный файл в выбранной папке не оставляем.
  if (target && target.writable) {
    target.writable.abort().catch(() => {}).then(() => target.dir.removeEntry(target.fileName)).catch(() => {});
  }
}

// Если пропал интернет — спокойно ждём, пока он вернётся.
async function waitOnline() {
  if (navigator.onLine) return;
  notice('Пропал интернет. Жду, когда он появится — ничего нажимать не нужно.');
  await new Promise(r => window.addEventListener('online', r, { once: true }));
  notice('Интернет появился, продолжаю…');
}

// ---------- Запоминание последней папки ----------

const db = () => new Promise((resolve, reject) => {
  const req = indexedDB.open('video-grabber', 1);
  req.onupgradeneeded = () => req.result.createObjectStore('kv');
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
async function kv(key, value) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction('kv', value === undefined ? 'readonly' : 'readwrite');
    const req = value === undefined ? tx.objectStore('kv').get(key) : tx.objectStore('kv').put(value, key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function uniqueName(dir, fileName) {
  const dot = fileName.lastIndexOf('.');
  const base = fileName.slice(0, dot), ext = fileName.slice(dot);
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? fileName : `${base} (${n})${ext}`;
    try { await dir.getFileHandle(candidate); } catch (e) { return candidate; } // такого файла нет
  }
}

// ---------- Куда пишутся байты видео ----------
// Пока папка не выбрана — копим в памяти. Как только выбрана — переносим накопленное
// (с прогрессом) и дальше пишем прямо в файл. Порядок записи строго сохраняется.

const sink = {
  chunks: [], buffered: 0, written: 0, writable: null, chain: Promise.resolve(),

  queue(fn) {
    this.chain = this.chain.then(fn);
    this.chain.catch(e => fail(writeError(e)));
    return this.chain;
  },
  push(data) {
    const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.queue(async () => {
      if (this.writable) { await this.writable.write(u8); this.written += u8.byteLength; }
      else { this.chunks.push(u8); this.buffered += u8.byteLength; }
    });
  },
  // Начать заново (сервер не умеет докачку с середины).
  reset() {
    return this.queue(async () => {
      this.chunks = []; this.buffered = 0; this.written = 0;
      if (this.writable) await this.writable.truncate(0);
    });
  },
  attach(writable, onProgress) {
    return this.queue(async () => {
      const total = this.buffered;
      let doneBytes = 0;
      for (let i = 0; i < this.chunks.length; i++) {
        await writable.write(this.chunks[i]);
        doneBytes += this.chunks[i].byteLength;
        this.chunks[i] = null; // сразу освобождаем память
        if (total) onProgress(doneBytes, total);
      }
      this.chunks = []; this.buffered = 0; this.written = doneBytes;
      this.writable = writable;
    });
  },
};

// Расширение файла становится известно после первого кусочка видео (mp4 или, в редких случаях, ts).
let resolveExt;
const extReady = new Promise(r => { resolveExt = r; });

// ---------- Выбор, куда сохранить ----------

let target = null;       // { type: 'folder', dir, fileName, fh, writable } | { type: 'downloads', saveAs }
let downloadDone = false;
let finishing = null;

async function chooseFolder() {
  if (target || saved || failed) return; // папка уже выбрана или всё закончено
  pickStatus('');
  let dir;
  const last = await kv('folder').catch(() => null);
  try {
    dir = await window.showDirectoryPicker({ id: 'video-grabber', mode: 'readwrite', startIn: last || 'downloads' });
  } catch (e) {
    if (e.name === 'AbortError') return; // передумали — ничего страшного
    await kv('folder', null).catch(() => {}); // прошлая папка, видимо, пропала
    pickStatus('Не получилось открыть выбор папки. Нажмите кнопку ещё раз.', 'err');
    return;
  }
  kv('folder', dir).catch(() => {});
  if (target || saved || failed) return; // пока выбирали, уже сохранили другим способом

  target = { type: 'folder', dir };
  $('pick').style.display = 'none';
  $('toDownloads').style.display = 'none';
  $('chooseText').textContent = `Сохраняю в папку «${dir.name}».`;

  try {
    const ext = await extReady;
    target.fileName = await uniqueName(dir, `${name}.${ext}`);
    target.fh = await dir.getFileHandle(target.fileName, { create: true });
    target.writable = await target.fh.createWritable();
  } catch (e) {
    return fail(writeError(e));
  }
  sink.attach(target.writable, (d, t) => {
    const text = `Сохраняю в папку «${dir.name}»… ${Math.floor(d / t * 100)}%`;
    if (downloadDone) progress(d / t, text, false); else pickStatus(text);
  }).then(() => { if (!downloadDone) pickStatus(''); maybeFinish(); }, () => {});
  maybeFinish();
}

function chooseDownloads(saveAs) {
  if (target || saved || failed) return;
  target = { type: 'downloads', saveAs };
  $('pick').style.display = 'none';
  $('toDownloads').style.display = 'none';
  $('chooseText').textContent = saveAs ? 'Сейчас откроется окно — выберите папку и нажмите «Сохранить».' : 'Сохраню в папку «Загрузки».';
  maybeFinish();
}

function maybeFinish() {
  if (failed || !downloadDone || !target) return;
  if (target.type === 'folder' && !target.writable) return; // ещё создаём файл
  if (!finishing) finishing = (target.type === 'folder' ? finishFolder() : finishDownloads()).catch(e => fail(e));
  return finishing;
}

async function finishFolder() {
  await sink.chain;
  $('status').textContent = 'Завершаю сохранение…';
  await target.writable.close().catch(e => { throw writeError(e); });
  const ext = await extReady;
  done({
    where: `в папку «${target.dir.name}»`,
    fileName: target.fileName,
    watch: ext === 'mp4' ? () => target.fh.getFile() : null,
  });
}

async function finishDownloads() {
  await sink.chain;
  const ext = await extReady;
  const blob = new Blob(sink.chunks, { type: ext === 'mp4' ? 'video/mp4' : 'video/mp2t' });
  let r;
  try {
    r = await saveAndWait(URL.createObjectURL(blob), `${name}.${ext}`, target.saveAs);
  } catch (e) {
    if (target.saveAs && /отмен/i.test(e.userMessage || '')) {
      // Закрыли окно «Сохранить как» — даём попробовать ещё раз.
      finishing = null; target = null;
      showChooseAgain();
      return;
    }
    throw e;
  }
  done({ where: target.saveAs ? 'в выбранную папку' : 'в папку «Загрузки»', fileName: r.fileName, downloadId: r.id });
}

function showChooseAgain() {
  $('choose').style.display = 'block';
  $('pick').style.display = 'inline-block';
  $('pick').textContent = '💾 Сохранить видео…';
  $('pick').onclick = () => chooseDownloads(true);
  $('chooseText').textContent = 'Видео скачано. Нажмите кнопку и выберите, куда его сохранить.';
}

function done(info) {
  saved = true;
  document.body.className = 'done';
  $('head').textContent = 'Готово!';
  $('fill').style.width = '100%';
  $('percent').textContent = '✔ Видео сохранено';
  $('status').textContent = `Файл «${info.fileName}» сохранён ${info.where}.`;
  $('retry').style.display = 'none';
  if (info.downloadId) {
    $('watch').style.display = 'none';
    $('open').onclick = () => chrome.downloads.open(info.downloadId);
    $('folder').onclick = () => chrome.downloads.show(info.downloadId);
  } else {
    $('open').style.display = 'none';
    $('folder').style.display = 'none';
    if (info.watch) {
      $('watch').onclick = async () => {
        const v = $('player');
        v.src = URL.createObjectURL(await info.watch());
        v.style.display = 'block';
        v.play().catch(() => {});
      };
    } else {
      $('watch').style.display = 'none';
    }
  }
  document.title = 'Готово: ' + name;
}

// Видео скачано полностью: если папка ещё не выбрана — просим выбрать.
async function onDownloaded() {
  downloadDone = true;
  await sink.chain;
  if (failed) return;
  $('fill').style.width = '100%';
  if (!target) {
    $('head').textContent = 'Видео скачано!';
    $('percent').textContent = '100%';
    if (canPick) {
      $('status').textContent = 'Осталось выбрать, куда его сохранить.';
      $('chooseText').textContent = 'Нажмите оранжевую кнопку и выберите папку — например, флешку.';
    } else {
      $('status').textContent = 'Выберите, куда его сохранить.';
      chooseDownloads(true); // Firefox: сразу открываем окно «Сохранить как»
    }
  } else if (target.type === 'folder' && target.writable) {
    progress(0.99, `Сохраняю в папку «${target.dir.name}»…`, false);
  }
  maybeFinish();
}

// ---------- Сохранение через загрузки браузера (для «Загрузок» и Firefox) ----------

async function saveAndWait(url, fileName, saveAs) {
  let id;
  try {
    id = await chrome.downloads.download({ url, filename: fileName, saveAs: !!saveAs, conflictAction: 'uniquify' });
  } catch (e) {
    if (saveAs) throw userError(MSG.canceled, e.message); // в Firefox отмена окна приходит ошибкой
    throw e;
  }
  for (;;) {
    await sleep(500);
    const [d] = await chrome.downloads.search({ id });
    if (!d) throw userError(MSG.canceled, 'download disappeared');
    if (d.state === 'complete') return { id, fileName: (d.filename || fileName).split(/[\\/]/).pop() };
    if (d.state === 'interrupted') {
      if (d.error === 'USER_CANCELED') throw userError(MSG.canceled, d.error);
      if (/NO_SPACE/.test(d.error)) throw userError(MSG.space, d.error);
      throw new Error('interrupted: ' + d.error);
    }
  }
}

// ---------- Загрузка с терпеливыми повторами ----------
// До 10 попыток, паузы растут до 20 секунд, «зависший» запрос прерывается через 90 секунд.

function withTimeout(promise, ms, ctrl) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => { if (ctrl) ctrl.abort(); reject(new Error('timeout')); }, ms); }),
  ]).finally(() => clearTimeout(timer));
}

async function retrying(fn) {
  for (let attempt = 1; ; attempt++) {
    if (stopped) throw new Error('stopped');
    await waitOnline();
    try {
      const result = await fn(attempt);
      if (attempt > 1) notice('');
      return result;
    } catch (e) {
      if (e.fatal || stopped || attempt >= 10) throw e;
      notice(`Связь с сайтом прервалась. Пробую ещё раз (попытка ${attempt + 1} из 10)…`);
      await sleep(Math.min(20000, 2000 * attempt));
    }
  }
}

function get(url, as = 'text') {
  return retrying(async attempt => {
    const ctrl = new AbortController();
    const r = await withTimeout(fetch(url, { credentials: 'include', signal: ctrl.signal }), 90000, ctrl);
    if ([401, 403, 410].includes(r.status) && attempt >= 2) throw userError(MSG.expired, 'HTTP ' + r.status + ' ' + url);
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
    return withTimeout(as === 'text' ? r.text() : r.arrayBuffer(), 90000, ctrl);
  });
}

// ---------- Обычный MP4-файл: качаем потоком, при обрыве докачиваем с того же места ----------

async function downloadMp4() {
  resolveExt('mp4');
  let got = 0, total = 0;
  await retrying(async attempt => {
    const ctrl = new AbortController();
    const r = await withTimeout(fetch(src, { credentials: 'include', signal: ctrl.signal, headers: got ? { Range: `bytes=${got}-` } : {} }), 90000, ctrl);
    if ([401, 403, 410].includes(r.status) && attempt >= 2) throw userError(MSG.expired, 'HTTP ' + r.status);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    if (got && r.status !== 206) { await sink.reset(); got = 0; } // докачка не поддерживается — сначала
    if (!total) total = got + (Number(r.headers.get('content-length')) || 0);
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await withTimeout(reader.read(), 90000, ctrl);
      if (done) break;
      sink.push(value);
      got += value.byteLength;
      progress(total ? got / total : 0, total ? `Скачано ${mb(got)} из ${mb(total)}` : `Скачано ${mb(got)}`);
    }
    if (total && got < total) throw new Error(`incomplete ${got}/${total}`);
  });
}

// ---------- HLS-поток ----------

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

  // mode: 'mp4' — перепаковываем .ts в MP4; 'raw' — поток уже в MP4, склеиваем как есть; 'ts' — запасной вариант.
  let mode = init ? 'raw' : 'mp4';
  const conv = mode === 'mp4' ? new TsToMp4(duration) : null;
  if (init) { sink.push(await get(init, 'buf')); resolveExt('mp4'); }

  // Качаем параллельно, а записываем строго по порядку.
  const ready = new Array(segments.length);
  let next = 0, nextToAdd = 0, doneCount = 0, bytes = 0;

  function addReady() {
    while (nextToAdd < segments.length && ready[nextToAdd]) {
      const data = ready[nextToAdd];
      ready[nextToAdd] = null;
      if (mode === 'mp4') {
        let ok = false;
        try { ok = conv.push(data); } catch (e) { console.warn(e); }
        if (ok) conv.take().forEach(c => sink.push(c));
        else if (nextToAdd === 0) { mode = 'ts'; sink.push(data); } // не вышло перепаковать — сохраним как .ts
        if (nextToAdd === 0) resolveExt(mode === 'ts' ? 'ts' : 'mp4');
      } else {
        sink.push(data);
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
      doneCount++; bytes += data.byteLength;
      progress(doneCount / segments.length, `Скачано ${mb(bytes)}`);
      addReady();
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  addReady();
}

// ---------- Запуск ----------

if (canPick) {
  $('pick').onclick = chooseFolder;
  $('toDownloads').onclick = e => { e.preventDefault(); chooseDownloads(false); };
} else {
  $('choose').style.display = 'none'; // в Firefox спросим в конце обычным окном «Сохранить как»
}

(kind === 'mp4' ? downloadMp4() : downloadHls())
  .then(onDownloaded)
  .catch(fail);
