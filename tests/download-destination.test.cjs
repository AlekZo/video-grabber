const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const source = name => fs.readFileSync(path.join(root, name), 'utf8');
const common = { URL, URLSearchParams, TextDecoder, TextEncoder, Uint8Array, ArrayBuffer, Blob,
  DataView, Response, console, AbortController, setTimeout, clearTimeout, crypto: webcrypto };

function destinationContext(errorName, directory = null) {
  const elements = new Map();
  const downloads = [];
  const context = vm.createContext({ ...common,
    navigator: { onLine: true },
    location: { search: '?' + new URLSearchParams({ src: 'https://example.test/video.mp4', kind: 'mp4', name: 'Урок', low: '0', media: 'av' }) },
    document: {
      title: '', body: { dataset: {}, className: '' },
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, { style: {}, textContent: '', className: '' });
        return elements.get(id);
      },
    },
    window: {
      addEventListener() {},
      showDirectoryPicker: async () => {
        if (directory) return directory;
        throw Object.assign(new Error('Folder unavailable'), { name: errorName });
      },
    },
    chrome: { downloads: {
      download: async options => { downloads.push(options); return 7; },
      search: async () => [{ id: 7, state: 'complete', filename: 'C:\\Users\\test\\Downloads\\Урок.mp4' }],
    } },
  });
  for (const file of ['mux.min.js', 'mp4.js', 'hls.js', 'fallback.js', 'resource-mode.js']) vm.runInContext(source(file), context);
  vm.runInContext(source('download.js').split('// ---------- Запуск ----------')[0] +
    '\nglobalThis.api = { chooseFolder, getTarget: () => target, getFinishing: () => finishing, resolveExt, setDownloadDone: value => { downloadDone = value; }, sink };', context);
  return { context, elements, downloads };
}

test('a forbidden system folder falls back to Save As and preserves the completed video', async () => {
  const { context, elements, downloads } = destinationContext('SecurityError');
  context.api.sink.chunks.push(new Uint8Array([1, 2, 3, 4]));
  context.api.resolveExt('mp4');
  context.api.setDownloadDone(true);
  await context.api.chooseFolder();
  assert.equal(context.api.getTarget().type, 'downloads');
  assert.equal(context.api.getTarget().saveAs, true);
  await context.api.getFinishing();
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].saveAs, true);
  assert.equal(downloads[0].filename, 'Урок.mp4');
  assert.equal(context.document.body.className, 'done');
  assert.match(elements.get('pickStatus').textContent, /Сохранить как/);
});

test('closing a blocked folder picker leaves the completed download available', async () => {
  const { context, elements, downloads } = destinationContext('AbortError');
  context.api.sink.chunks.push(new Uint8Array([1, 2, 3, 4]));
  context.api.setDownloadDone(true);
  await context.api.chooseFolder();
  assert.equal(context.api.getTarget(), null);
  assert.equal(context.api.sink.chunks.length, 1);
  assert.equal(downloads.length, 0);
  assert.match(elements.get('pickStatus').textContent, /сохранить в Загрузки/);
});

test('a drive root saves the file and is labelled as the selected drive root', async () => {
  const writes = [];
  let closed = false;
  const writable = {
    write: async data => { writes.push(Buffer.from(data)); },
    close: async () => { closed = true; },
    abort: async () => {},
  };
  const fileHandle = { createWritable: async () => writable, getFile: async () => { throw new Error('not used'); } };
  const directory = {
    name: '\\',
    getFileHandle: async (fileName, options) => {
      if (!options?.create) throw new Error('not found');
      assert.equal(fileName, 'Урок.mp4');
      return fileHandle;
    },
    removeEntry: async () => {},
  };
  const { context, elements, downloads } = destinationContext(null, directory);
  context.api.sink.chunks.push(new Uint8Array([1, 2, 3, 4]));
  context.api.resolveExt('mp4');
  context.api.setDownloadDone(true);
  await context.api.chooseFolder();
  assert.equal(context.api.getTarget().type, 'folder');
  assert.equal(elements.get('chooseText').textContent, 'Сохраняю в корень выбранного диска.');
  await context.api.getFinishing();
  assert.equal(Buffer.concat(writes).toString('hex'), '01020304');
  assert.equal(closed, true);
  assert.equal(context.document.body.className, 'done');
  assert.match(elements.get('status').textContent, /сохранён в корень выбранного диска/);
  assert.equal(downloads.length, 0);
});
