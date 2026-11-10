const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const source = name => fs.readFileSync(path.join(root, name), 'utf8');
const common = { URL, URLSearchParams, TextDecoder, TextEncoder, Uint8Array, ArrayBuffer,
  DataView, console, AbortController, setTimeout, clearTimeout, crypto: webcrypto };
const hlsContext = vm.createContext({ ...common });
for (const file of ['hls.js', 'mp4.js', 'resource-mode.js']) vm.runInContext(source(file), hlsContext);

const node = () => ({
  children: [], style: {},
  appendChild(child) { this.children.push(child); },
  replaceChildren(...children) { this.children = children; },
});

async function popupContext(items, { batch = false } = {}) {
  const rootNode = node(), toggle = node(), resume = node();
  const storage = {}, opened = [];
  const elements = { root: rootNode, lowResource: toggle, resume };
  const context = vm.createContext({ ...common, Hls: hlsContext.Hls, ResourceMode: hlsContext.ResourceMode,
    document: { getElementById: id => elements[id], createElement: node }, window: { close() {} },
    chrome: {
      tabs: {
        query: async () => [{ id: 1, title: 'Курс' }],
        create: options => { opened.push(options.url); },
      },
      scripting: { executeScript: async () => [] },
      storage: {
        session: { get: async () => ({ t1: items }), set: async values => Object.assign(storage, values) },
        local: {
          get: async key => key === null ? { ...storage } : { lowResource: true },
          set: async values => Object.assign(storage, values),
        },
      },
      runtime: { getURL: name => 'chrome-extension://test/' + name },
    },
  });
  await vm.runInContext(source('popup.js'), context);
  const nameInputs = rootNode.children
    .filter(child => child.children?.[1]?.className === 'file-name')
    .map(details => details.children[1].children[0]);
  assert.equal(nameInputs.length, items.length);
  return { rootNode, storage, opened, nameInputs };
}

const item = id => ({ url: `https://example.test/video-${id}.mp4`, kind: 'mp4', mediaType: 'video', label: '' });

test('a user can set a safe file name before a single download', async () => {
  const { rootNode, opened, nameInputs } = await popupContext([item(1)]);
  assert.equal(nameInputs[0].value, 'Курс');
  nameInputs[0].value = 'Мой: урок/01?';
  nameInputs[0].oninput();
  rootNode.children.find(child => child.tagName === undefined && child.className === '').onclick();
  const params = new URL(opened[0]).searchParams;
  assert.equal(params.get('name'), 'Мой урок 01');
});

test('Download all preserves custom names and fills blank names automatically', async () => {
  const { rootNode, storage, opened, nameInputs } = await popupContext([item(1), item(2)], { batch: true });
  nameInputs[0].value = 'Первый урок';
  nameInputs[0].oninput();
  nameInputs[1].value = '';
  nameInputs[1].oninput();
  await rootNode.children.find(child => child.className === 'all').onclick();
  const params = new URL(opened[0]).searchParams;
  assert.equal(params.get('name'), 'Первый урок');
  const queue = storage['batch:' + params.get('batch')];
  assert.deepEqual(Array.from(queue, job => job.fileName), ['Первый урок', 'Курс — 02 Видео']);
});

test('embedded player titles replace misleading nearby page instructions', () => {
  const context = vm.createContext({ ...common, document: { getElementById: node } });
  vm.runInContext(source('popup.js').split('async function readItems')[0], context);
  const titles = ['funduk-izumtesto', 'funduk-izumganas', 'funduk-izumsborka-i-dekor'];
  const frames = titles.map((_, index) => ({
    src: `https://kinescope.io/embed/player-${index}`,
    label: index === 0 ? 'кнопка не работает' : 'Текст рядом с плеером',
    pos: 100 + index * 500,
  }));
  const results = [
    { frameId: 0, result: { isTop: true, href: 'https://school.example.test/lesson', title: 'Фундук-изюм', found: [], frames } },
    ...titles.map((title, index) => ({ frameId: index + 1, result: {
      isTop: false, href: frames[index].src, title, frames: [],
      found: [{ url: `${frames[index].src}/master.m3u8`, label: '', pos: 0 }],
    } })),
  ];
  const meta = context.buildMeta(results);
  assert.deepEqual(titles.map((_, index) => meta.byUrl[`${frames[index].src}/master.m3u8`].label), titles);
  assert.equal(meta.byFrame[1].label, 'funduk-izumtesto');
});

test('untitled GetCourse players use the page labels from the chicken-roll lesson', () => {
  const context = vm.createContext({ ...common, document: { getElementById: node } });
  vm.runInContext(source('popup.js').split('async function readItems')[0], context);
  const labels = ['Начинка с пикантной курицей', 'Бисквит', 'Сборка'];
  const frames = labels.map((label, index) => ({ src: `https://api2.gcvh.ru/sign-player/${index}`, title: '', label, pos: index * 500 }));
  const results = [
    { frameId: 0, result: { isTop: true, href: 'https://cakepro.example/lesson', title: 'Рулет с пикантной курицей', found: [], frames } },
    ...frames.map((frame, index) => ({ frameId: index + 1, result: {
      isTop: false, href: frame.src, title: '', frames: [],
      found: [{ url: `${frame.src}/master.m3u8`, label: '', pos: 0 }],
    } })),
  ];
  const meta = context.buildMeta(results);
  assert.deepEqual(frames.map(frame => meta.byUrl[`${frame.src}/master.m3u8`].label), labels);
});

test('generic provider names fall back to a useful iframe or page title', () => {
  const context = vm.createContext({ ...common, document: { getElementById: node } });
  vm.runInContext(source('popup.js').split('async function readItems')[0], context);
  const frames = [
    { src: 'https://youtube.example/embed/1', title: '', label: 'Урок с YouTube', pos: 1 },
    { src: 'https://vimeo.example/embed/2', title: 'Название из рамки', label: 'Текст на странице', pos: 2 },
  ];
  const results = [
    { frameId: 0, result: { isTop: true, href: 'https://school.example/lesson', title: 'Курс', found: [], frames } },
    { frameId: 1, result: { isTop: false, href: frames[0].src, title: 'YouTube video player', frames: [], found: [{ url: 'https://youtube.example/1.m3u8', label: '', pos: 0 }] } },
    { frameId: 2, result: { isTop: false, href: frames[1].src, title: 'Vimeo', frames: [], found: [{ url: 'https://vimeo.example/2.m3u8', label: '', pos: 0 }] } },
  ];
  const meta = context.buildMeta(results);
  assert.equal(meta.byUrl['https://youtube.example/1.m3u8'].label, 'Урок с YouTube');
  assert.equal(meta.byUrl['https://vimeo.example/2.m3u8'].label, 'Название из рамки');
});
