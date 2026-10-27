// Страница скачивания: качает видео и записывает его прямо в папку, которую выбрал пользователь.

const params = new URLSearchParams(location.search);
const src = params.get('src');
const kind = params.get('kind') || 'hls';
const name = params.get('name') || 'Видео';
const resource = ResourceMode.settings(params.get('low') === '1');

const $ = id => document.getElementById(id);
$('name').textContent = name;
document.title = 'Скачивание: ' + name;
const externalPlan = { url: src, videoUrl: params.get('video'), audioUrl: params.get('audio'),
  pageUrl: params.get('page'), name, mediaType: params.get('media') };
function updateExternalCommand() {
  try {
    const command = DownloadFallback.command(externalPlan);
    $('externalCommand').value = command.text;
    $('commandHelp').textContent = `Если на компьютере установлены ${command.tool}, скопируйте команду в PowerShell. Файл сохранится в текущую папку. Команда сама не запускается.`;
    $('copyCommand').onclick = async () => {
      try { await navigator.clipboard.writeText(command.text); $('commandStatus').textContent = 'Команда скопирована.'; }
      catch (e) { $('commandStatus').textContent = 'Выделите команду выше и скопируйте её вручную.'; }
    };
  } catch (e) { $('alternative').hidden = true; }
}
updateExternalCommand();

// Chrome, Edge и Яндекс.Браузер умеют выбирать папку. Firefox — нет: там откроется обычное «Сохранить как».
const canPick = typeof window.showDirectoryPicker === 'function';

let saved = false, failed = false, stopped = false;
let spool = null;
let resolveCompleted;
const completed = new Promise(resolve => { resolveCompleted = resolve; });
if (resource.enabled) {
  document.body.dataset.lowResource = 'true';
  $('resourceMode').textContent = '🌿 Экономный режим: до 720p по умолчанию, 2 части одновременно, запись на диск.';
}
let mediaType = 'unknown';
const isAudio = () => mediaType === 'audio';
function setMediaType(type) {
  mediaType = ['audio', 'video', 'av'].includes(type) ? type : 'unknown';
  $('mediaType').textContent = Hls.mediaLabel(mediaType);
  $('mediaType').className = mediaType;
  externalPlan.mediaType = mediaType;
  updateExternalCommand();
  if (saved || failed) return;
  $('head').textContent = isAudio() ? 'Скачиваю аудио…' : 'Скачиваю видео…';
  $('open').textContent = isAudio() ? '▶ Открыть аудио' : '▶ Открыть видео';
  if (isAudio() && $('pick').style.display !== 'none') $('chooseText').textContent = 'Куда сохранить аудио? Выберите папку. Пока вы выбираете, аудио уже скачивается.';
}
setMediaType(params.get('media'));
window.addEventListener('beforeunload', e => { if (!saved && !failed) { e.preventDefault(); e.returnValue = ''; } });

const mb = n => (n / 1024 / 1024).toFixed(0) + ' МБ';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const started = Date.now();
let lastProgress = 0;
function progress(fraction, text, eta = true) {
  if (resource.enabled && eta && fraction < 1 && Date.now() - lastProgress < 250) return;
  lastProgress = Date.now();
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
  incomplete: 'Сайт вернул неполный ролик: изображение и звук не совпадают по длительности или отсутствует часть кадров. Обновите страницу урока и попробуйте снова.',
  noAudio: 'Для этого ролика ожидается звук, но аудиодорожка не получена. Файл без звука сохранять не буду. Обновите урок и повторите скачивание.',
  diskBuffer: 'Экономному режиму недоступен временный файл на диске. Обновите браузер или отключите экономный режим. Загрузка в оперативную память не началась.',
  partTooLarge: 'У этого видео слишком крупные части для экономного режима. Выберите более низкое качество или отключите экономный режим.',
  temporarySpace: 'Во временном хранилище браузера закончилось место. Освободите место на системном диске и попробуйте снова.',
};

const userError = (msg, detail) => Object.assign(new Error(detail || msg), { userMessage: msg, fatal: true });

function writeError(e, temporary = false) {
  if (e.userMessage) return e;
  if (e.name === 'QuotaExceededError' && temporary) return userError(MSG.temporarySpace, e.message);
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
  $('head').textContent = isAudio() ? 'Не получилось скачать аудио' : 'Не получилось скачать видео';
  $('percent').textContent = 'Ничего страшного';
  $('status').textContent = msg || MSG.generic;
  $('tech').textContent = String(err && (err.stack || err.message || err));
  ['open', 'folder', 'watch'].forEach(id => { $(id).style.display = 'none'; });
  $('retry').onclick = () => location.reload();
  if (err.userMessage === MSG.drm) $('alternative').hidden = true;
  document.title = 'Не получилось: ' + name;
  resolveCompleted();
  if (spool) sink.chain.catch(() => {}).then(() => spool.dispose()).catch(console.warn);
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
    this.chain.catch(e => fail(writeError(e, resource.enabled && !!spool)));
    return this.chain;
  },
  push(data) {
    const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
    return this.queue(async () => {
      if (failed) return;
      if (this.writable) { await this.writable.write(u8); this.written += u8.byteLength; }
      else if (resource.enabled) throw userError(MSG.diskBuffer, 'Disk sink not initialized');
      else { this.chunks.push(u8); this.buffered += u8.byteLength; }
    });
  },
  // Начать заново (сервер не умеет докачку с середины).
  reset() {
    return this.queue(async () => {
      this.chunks = []; this.buffered = 0; this.written = 0;
      if (this.writable) { await this.writable.truncate(0); await this.writable.seek(0); }
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

async function prepareLowStorage(cleanStale = false) {
  if (!resource.enabled || spool) return;
  try {
    spool = await ResourceMode.DiskSpool.open(navigator.storage, cleanStale);
    await sink.attach(spool.writable, () => {});
  } catch (e) {
    if (e.name === 'QuotaExceededError') throw userError(MSG.temporarySpace, e.message);
    throw userError(MSG.diskBuffer, e.message);
  }
}
window.addEventListener('pagehide', () => { if (!saved && spool) spool.dispose().catch(() => {}); });

// Расширение файла становится известно после первого кусочка видео (mp4 или, в редких случаях, ts).
let resolveExt;
const extReady = new Promise(r => { resolveExt = r; });

// ---------- Выбор, куда сохранить ----------

let target = null;       // { type: 'folder', dir, fileName, fh, writable } | { type: 'downloads', saveAs }
let downloadDone = false;
let finishing = null;

async function chooseFolder(reuse = false) {
  if (target || saved || failed) return; // папка уже выбрана или всё закончено
  pickStatus('');
  let dir;
  const last = await kv('folder').catch(() => null);
  try {
    if (reuse) {
      if (!last || await last.queryPermission({ mode: 'readwrite' }) !== 'granted') return;
      dir = last;
    } else dir = await window.showDirectoryPicker({ id: 'video-grabber', mode: 'readwrite', startIn: last || 'downloads' });
  } catch (e) {
    if (e.name === 'AbortError') return; // передумали — ничего страшного
    await kv('folder', null).catch(() => {}); // прошлая папка, видимо, пропала
    pickStatus('Не получилось открыть выбор папки. Нажмите кнопку ещё раз.', 'err');
    return;
  }
  await kv('folder', dir).catch(() => {});
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
  if (failed) { await target.writable.abort().catch(() => {}); await dir.removeEntry(target.fileName).catch(() => {}); return; }
  if (!resource.enabled) sink.attach(target.writable, (d, t) => {
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
  if (spool) {
    await spool.copyTo(target.writable, (d, total) => progress(total ? d / total : 1, `Сохраняю в папку «${target.dir.name}»…`, false))
      .catch(e => { throw writeError(e); });
  }
  $('status').textContent = 'Завершаю сохранение…';
  await target.writable.close().catch(e => { throw writeError(e); });
  if (spool) await spool.dispose().catch(console.warn);
  const ext = await extReady;
  done({
    where: `в папку «${target.dir.name}»`,
    fileName: target.fileName,
    watch: ['mp4', 'm4a'].includes(ext) ? () => target.fh.getFile() : null,
  });
}

async function finishDownloads() {
  await sink.chain;
  const ext = await extReady;
  const mime = ext === 'm4a' ? 'audio/mp4' : ext === 'mp4' ? 'video/mp4' : 'video/mp2t';
  const file = spool ? await spool.file() : null;
  const blob = file ? file.slice(0, file.size, mime) : new Blob(sink.chunks, { type: mime });
  const objectUrl = URL.createObjectURL(blob);
  let r;
  try {
    r = await saveAndWait(objectUrl, `${name}.${ext}`, target.saveAs);
  } catch (e) {
    if (target.saveAs && /отмен/i.test(e.userMessage || '')) {
      // Закрыли окно «Сохранить как» — даём попробовать ещё раз.
      finishing = null; target = null;
      showChooseAgain();
      return;
    }
    throw e;
  } finally { URL.revokeObjectURL(objectUrl); }
  if (spool) await spool.dispose().catch(console.warn);
  sink.chunks = []; sink.buffered = 0;
  done({ where: target.saveAs ? 'в выбранную папку' : 'в папку «Загрузки»', fileName: r.fileName, downloadId: r.id });
}

function showChooseAgain() {
  $('choose').style.display = 'block';
  $('pick').style.display = 'inline-block';
  $('pick').textContent = isAudio() ? '💾 Сохранить аудио…' : '💾 Сохранить видео…';
  $('pick').onclick = () => chooseDownloads(true);
  $('chooseText').textContent = `${isAudio() ? 'Аудио скачано' : 'Видео скачано'}. Нажмите кнопку и выберите, куда его сохранить.`;
}

function done(info) {
  saved = true;
  resolveCompleted();
  document.body.className = 'done';
  $('head').textContent = 'Готово!';
  $('fill').style.width = '100%';
  $('percent').textContent = isAudio() ? '✔ Аудио сохранено' : '✔ Видео сохранено';
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
  continueBatch().catch(e => {
    $('status').textContent += ' Не получилось открыть следующий ролик; запустите его со страницы урока.';
    console.error(e);
  });
}

async function continueBatch() {
  const id = params.get('batch');
  if (!id) return;
  const key = 'batch:' + id;
  const jobs = (await chrome.storage.session.get(key))[key];
  const next = (Number(params.get('index')) || 0) + 1;
  if (!jobs?.[next]) { await chrome.storage.session.remove(key); return; }
  const q = ResourceMode.jobParams(jobs[next], jobs[next].fileName, { enabled: resource.enabled,
    batch: id, index: next, destination: target.type === 'folder' ? 'folder' : 'downloads' });
  location.replace(chrome.runtime.getURL('download.html?' + q));
}

// Видео скачано полностью: если папка ещё не выбрана — просим выбрать.
async function onDownloaded() {
  downloadDone = true;
  await sink.chain;
  if (failed) return;
  $('fill').style.width = '100%';
  if (!target) {
    $('head').textContent = isAudio() ? 'Аудио скачано!' : 'Видео скачано!';
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

function get(url, as = 'text', range = null) {
  return retrying(async attempt => {
    if (resource.enabled && range && range.end - range.start + 1 > resource.maxPartBytes) throw userError(MSG.partTooLarge, 'HLS part exceeds memory limit');
    const ctrl = new AbortController();
    const headers = range ? { Range: `bytes=${range.start}-${range.end}` } : {};
    const r = await withTimeout(fetch(url, { credentials: 'include', signal: ctrl.signal, headers }), 90000, ctrl);
    if ([401, 403, 410].includes(r.status) && attempt >= 2) throw userError(MSG.expired, 'HTTP ' + r.status + ' ' + url);
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
    if (range) {
      const contentRange = /^bytes (\d+)-(\d+)\/(?:\d+|\*)$/i.exec(r.headers.get('content-range') || '');
      if (r.status !== 206 || !contentRange || Number(contentRange[1]) !== range.start || Number(contentRange[2]) !== range.end) {
        ctrl.abort();
        throw userError(MSG.unsupported, 'Server did not honor HLS byte range');
      }
    }
    let body;
    if (resource.enabled && as === 'buf') {
      if (Number(r.headers.get('content-length')) > resource.maxPartBytes) { ctrl.abort(); throw userError(MSG.partTooLarge, 'HLS part exceeds memory limit'); }
      const reader = r.body.getReader(), chunks = [];
      let length = 0;
      try {
        for (;;) {
          const { done, value } = await withTimeout(reader.read(), 90000, ctrl);
          if (done) break;
          length += value.byteLength;
          if (length > resource.maxPartBytes) { ctrl.abort(); throw userError(MSG.partTooLarge, 'HLS part exceeds memory limit'); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const data = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
      body = data.buffer;
    } else body = await withTimeout(as === 'text' || as === 'playlist' ? r.text() : r.arrayBuffer(), 90000, ctrl);
    if (range && body.byteLength !== range.end - range.start + 1) throw new Error('Incomplete HLS byte range');
    return as === 'playlist' ? { text: body, url: r.url || url } : body;
  });
}

// ---------- Обычный MP4-файл: качаем потоком, при обрыве докачиваем с того же места ----------

async function downloadMp4() {
  const header = new Uint8Array(65536);
  let headerBytes = 0, typeReady = false;
  const finishType = () => {
    if (!typeReady) { resolveExt(isAudio() ? 'm4a' : 'mp4'); typeReady = true; }
  };
  let got = 0, total = 0;
  await retrying(async attempt => {
    const ctrl = new AbortController();
    const r = await withTimeout(fetch(src, { credentials: 'include', signal: ctrl.signal, headers: got ? { Range: `bytes=${got}-` } : {} }), 90000, ctrl);
    if ([401, 403, 410].includes(r.status) && attempt >= 2) throw userError(MSG.expired, 'HTTP ' + r.status);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    if (/^audio\//i.test(r.headers.get('content-type') || '')) { setMediaType('audio'); finishType(); }
    if (got && r.status !== 206) { await sink.reset(); got = 0; headerBytes = 0; } // докачка не поддерживается — сначала
    if (!total) total = got + (Number(r.headers.get('content-length')) || 0);
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await withTimeout(reader.read(), 90000, ctrl);
      if (done) break;
      if (!typeReady) {
        const part = value.subarray(0, header.length - headerBytes);
        header.set(part, headerBytes); headerBytes += part.length;
        const detected = mp4MediaType(header.subarray(0, headerBytes));
        if (detected !== 'unknown') { setMediaType(detected); finishType(); }
        else if (headerBytes === header.length) finishType();
      }
      await sink.push(value); // не читаем сеть быстрее, чем диск успевает записывать
      got += value.byteLength;
      progress(total ? got / total : 0, total ? `Скачано ${mb(got)} из ${mb(total)}` : `Скачано ${mb(got)}`);
    }
    if (total && got < total) throw new Error(`incomplete ${got}/${total}`);
  });
  finishType();
}

// ---------- HLS-поток ----------

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
  const requestedVideo = params.get('video'), requestedAudio = params.get('audio');
  // Сохраняем связь с AUDIO из мастер-плейлиста при выборе качества.
  async function resolvePlaylist(start, preferences = {}) {
    let url = start, audioUrl = null, expectedAudio = false, usedPreferences = false;
    const seen = new Set();
    for (let depth = 0; depth < 8; depth++) {
      if (seen.has(url)) throw userError(MSG.unsupported, 'HLS playlist cycle');
      seen.add(url);
      const response = await get(url, 'playlist');
      url = response.url;
      const text = response.text;
      if (!text.trimStart().startsWith('#EXTM3U')) throw userError(MSG.expired, 'not an HLS playlist');
      if (!text.includes('#EXT-X-STREAM-INF:')) {
        const media = Hls.parseMedia(text, url);
        if (!media.segments.length) throw userError(MSG.unsupported, 'empty playlist');
        return { ...media, audioUrl, url, expectedAudio };
      }
      const selected = Hls.pickBest(text, url, { maxHeight: resource.maxHeight, ...(usedPreferences ? {} : preferences) });
      usedPreferences = true;
      if (!selected) throw userError(MSG.unsupported, 'empty master playlist');
      audioUrl = selected.audioUrl || audioUrl;
      expectedAudio ||= !!selected.audioUrl || /mp4a|ac-3|ec-3|opus|flac/i.test(selected.codecs);
      url = selected.url;
    }
    throw userError(MSG.unsupported, 'HLS nesting too deep');
  }
  let start = src;
  const identity = Hls.kinescopeInfo(src);
  if (requestedVideo && identity?.role === 'video') {
    const selected = Hls.kinescopeInfo(requestedVideo);
    if (!selected || selected.id !== identity.id || selected.role !== 'video') throw userError(MSG.unsupported, 'Video belongs to another player');
    start = requestedVideo;
  }
  const video = await resolvePlaylist(start, { videoUrl: requestedVideo, audioUrl: requestedAudio });
  if (!video.audioUrl && requestedAudio) {
    const audio = Hls.kinescopeInfo(requestedAudio);
    if (!identity || !audio || identity.id !== audio.id || audio.role !== 'audio') throw userError(MSG.unsupported, 'Audio belongs to another player');
    video.audioUrl = requestedAudio;
  }
  const streams = [video];
  if (video.audioUrl) {
    notice('Видео и звук передаются отдельно. Объединяю их в один MP4.');
    streams.push(await resolvePlaylist(video.audioUrl));
  }
  externalPlan.videoUrl = video.url;
  externalPlan.audioUrl = streams[1]?.url || null;
  updateExternalCommand();
  if (streams.length > 1 && Math.abs(streams[0].duration - streams[1].duration) > Math.max(1, Math.min(3, streams[0].duration * 0.01))) {
    throw userError(MSG.incomplete, 'Audio/video playlist durations differ');
  }
  const duration = Math.max(...streams.map(s => s.duration));
  const prepared = [];
  const loadPart = async part => {
    const data = await get(part.url, 'buf', part.range);
    return part.key ? decrypt(data, part) : data;
  };
  // До записи файла получаем заголовки обеих дорожек и проверяем их формат.
  for (const stream of streams) {
    const first = await loadPart(stream.segments[0]);
    if (stream.init) {
      prepared.push({ init: await loadPart(stream.init), first });
    } else {
      const conv = new TsToMp4(duration);
      const ok = conv.push(first);
      if (!ok && streams.length > 1) throw userError(MSG.unsupported, 'Cannot convert separate HLS track');
      const parts = conv.take();
      prepared.push(ok ? { init: parts.shift(), first: parts, conv } : { first, rawTs: true });
    }
  }
  const rawTs = prepared[0].rawTs;
  const muxer = rawTs ? null : new FragmentedMp4(prepared.map(p => p.init), duration);
  if ((video.expectedAudio || params.get('media') === 'av') && (!muxer || !muxer.kinds.includes('soun'))) {
    throw userError(MSG.noAudio, 'Expected audio track is missing');
  }
  if (streams.length > 1 && (muxer.kinds.filter(k => k === 'vide').length !== 1 || muxer.kinds.filter(k => k === 'soun').length !== 1)) {
    throw userError(MSG.unsupported, 'Expected one video track and one audio track');
  }
  if (muxer) setMediaType(muxer.kinds.includes('vide') ? muxer.kinds.includes('soun') ? 'av' : 'video' : muxer.kinds.includes('soun') ? 'audio' : 'unknown');
  resolveExt(rawTs ? 'ts' : isAudio() ? 'm4a' : 'mp4');
  if (muxer) sink.push(muxer.init);
  // Чередуем дорожки по времени, даже если длина их сегментов различается.
  const tasks = streams.flatMap((s, track) => s.segments.map((segment, index) => ({ track, index, segment })));
  tasks.sort((a, b) => a.segment.start - b.segment.start || a.track - b.track);
  let doneCount = 0, bytes = 0;
  // Ограниченное окно: медленный сегмент не заставит держать весь фильм в памяти.
  for (let offset = 0; offset < tasks.length; offset += resource.parallel) {
    if (stopped) throw new Error('stopped');
    const batch = tasks.slice(offset, offset + resource.parallel);
    const data = await Promise.all(batch.map(async task => {
      const p = prepared[task.track];
      const part = task.index === 0 ? p.first : await loadPart(task.segment);
      bytes += Array.isArray(part) ? part.reduce((n, b) => n + b.byteLength, 0) : part.byteLength;
      progress(++doneCount / tasks.length, 'Скачано ' + mb(bytes));
      return part;
    }));
    for (let i = 0; i < batch.length; i++) {
      const task = batch[i], p = prepared[task.track];
      if (task.index === 0) p.first = null;
      if (rawTs) { sink.push(data[i]); continue; }
      let parts;
      if (p.conv && task.index > 0) {
        if (!p.conv.push(data[i])) throw userError(MSG.unsupported, 'HLS segment conversion produced no data');
        parts = p.conv.take();
      } else parts = Array.isArray(data[i]) ? data[i] : [data[i]];
      for (const part of parts) sink.push(muxer.fragment(task.track, part));
    }
    await sink.chain;
  }
  if (muxer) {
    $('status').textContent = 'Проверяю полноту изображения и звука…';
    const report = muxer.verify(streams.map(s => s.duration));
    const hasVideo = report.tracks.some(t => t.kind === 'vide'), hasAudio = report.tracks.some(t => t.kind === 'soun');
    $('verification').textContent = `✓ Проверено: ${hasVideo && hasAudio ? 'изображение и звук' : hasAudio ? 'аудиодорожка' : 'видеодорожка'}, ${Math.round(report.duration)} сек.`;
  }
}

async function runDownload() {
  const work = async () => {
    if (stopped) return;
    if (params.get('batch') && resource.enabled) {
      try {
        const key = 'batch:' + params.get('batch');
        const jobs = (await chrome.storage.session.get(key))[key];
        if (jobs?.length) $('resourceMode').textContent += ` Ролик ${(Number(params.get('index')) || 0) + 1} из ${jobs.length}.`;
      } catch (e) { console.warn(e); }
    }
    if (resource.enabled) await prepareLowStorage(true);
    if (params.get('destination') === 'downloads') chooseDownloads(!canPick);
    if (params.get('destination') === 'folder' && canPick) chooseFolder(true).catch(fail);
    $('status').textContent = 'Подготовка…';
    await (kind === 'mp4' ? downloadMp4() : downloadHls());
    await onDownloaded();
    if (resource.enabled) await completed; // следующий ролик начнётся после сохранения, а не только скачивания
  };
  if (resource.enabled) {
    if (!navigator.locks?.request) throw userError(MSG.diskBuffer, 'Web Locks unavailable');
    return ResourceMode.serial(navigator.locks, work, () => {
      $('status').textContent = 'Жду своей очереди. В экономном режиме скачивается один ролик за раз.';
    });
  }
  return work();
}

// ---------- Запуск ----------

if (canPick) {
  $('pick').onclick = () => chooseFolder();
  $('toDownloads').onclick = e => { e.preventDefault(); chooseDownloads(false); };
} else {
  $('choose').style.display = 'none'; // в Firefox спросим в конце обычным окном «Сохранить как»
}

runDownload()
  .catch(e => fail(e.hlsDrm ? userError(MSG.drm, e.message) : e.mediaIncomplete ? userError(MSG.incomplete, e.message) : e.hlsUnsupported ? userError(MSG.unsupported, e.message) : e));
