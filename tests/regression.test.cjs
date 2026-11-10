const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const source = name => fs.readFileSync(path.join(root, name), 'utf8');
const fixture = name => source('tests/fixtures/' + name);
const common = { URL, URLSearchParams, TextDecoder, TextEncoder, Uint8Array, ArrayBuffer, DataView, console, AbortController, setTimeout, clearTimeout, crypto: require('node:crypto').webcrypto };
const hlsContext = vm.createContext({ ...common });
vm.runInContext(source('hls.js'), hlsContext);
vm.runInContext(source('mp4.js'), hlsContext);
vm.runInContext(source('resource-mode.js'), hlsContext);
common.ResourceMode = hlsContext.ResourceMode;
const Hls = hlsContext.Hls;
const base = 'https://media.example.test/lesson/master.m3u8';
const master = fixture('kinescope-master.m3u8');

test('Kinescope master: highest video quality retains the associated audio', () => {
  const selected = Hls.pickBest(master, base);
  assert.match(selected.url, /quality=1080&type=video$/);
  assert.match(selected.audioUrl, /type=audio&lang=en$/);
  assert.equal(selected.res, '1920x1080');
});

test('attribute names match exactly and quoted commas do not split values', () => {
  assert.equal(Hls.attr('#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=1,BANDWIDTH=2,CODECS="avc1,mp4a"', 'BANDWIDTH'), '2');
  assert.equal(Hls.attr('#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=1', 'BANDWIDTH'), null);
  assert.equal(Hls.attr('#EXT-X-STREAM-INF:CODECS="avc1,mp4a",AUDIO="a"', 'CODECS'), 'avc1,mp4a');
});

test('default audio selection respects in-band audio and group identity', () => {
  const m = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="b",URI="wrong",DEFAULT=YES\n' +
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="optional",DEFAULT=NO\n' +
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",DEFAULT=YES\n#EXT-X-STREAM-INF:BANDWIDTH=5,AUDIO="a"\nv.m3u8';
  assert.equal(Hls.pickBest(m, base).audioUrl, null);
  assert.throws(() => Hls.pickBest('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5,AUDIO="missing"\nv', base), /audio group missing/);
});

test('Kinescope byte ranges include init ranges and independent audio timing', () => {
  const v = Hls.parseMedia(fixture('kinescope-video.m3u8'), base);
  const a = Hls.parseMedia(fixture('kinescope-audio.m3u8'), base);
  assert.equal(v.init.range.start, 0);
  assert.equal(v.init.range.end, 799);
  assert.equal(a.init.range.end, 659);
  assert.equal(v.segments[0].range.start, 800);
  assert.equal(a.segments[0].range.start, 660);
  assert.equal(v.segments[1].start, 4);
  assert.notEqual(a.segments[1].start, 4);
});

test('implicit byte ranges require a preceding range of the same resource', () => {
  const m = '#EXTM3U\n#EXTINF:2,\n#EXT-X-BYTERANGE:10@8\na.mp4\n#EXTINF:2,\n#EXT-X-BYTERANGE:12\na.mp4';
  assert.equal(Hls.parseMedia(m, base).segments[1].range.start, 18);
  assert.throws(() => Hls.parseMedia(m.replace(/a.mp4$/, 'b.mp4'), base), /range offset/);
  assert.throws(() => Hls.parseMedia('#EXTM3U\n#EXT-X-BYTERANGE:3\na.mp4', base), /range offset/);
});

test('encryption and discontinuities cannot silently produce a broken file', () => {
  assert.throws(() => Hls.parseMedia('#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key"\na.ts', base), e => e.hlsDrm);
  assert.throws(() => Hls.parseMedia('#EXTM3U\n#EXT-X-DISCONTINUITY\na.ts', base), e => e.hlsUnsupported);
  const m = Hls.parseMedia('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:9\n#EXT-X-KEY:METHOD=AES-128,URI="key",IV=0x01\na.ts\n#EXT-X-KEY:METHOD=NONE\nb.ts', base);
  assert.equal(m.segments[0].seq, 9);
  assert.equal(m.segments[0].key.iv, '0x01');
  assert.equal(m.segments[1].key, null);
});

test('background badge hides audio, video variants and their source MP4s', async () => {
  const storage = {};
  let badge;
  const listener = { addListener() {} };
  const ctx = vm.createContext({ ...common, Hls, mp4MediaType: hlsContext.mp4MediaType, fetch: async () => { throw new Error('unexpected network'); },
    chrome: { storage: { session: {
      get: async key => ({ [key]: storage[key] }),
      set: async value => Object.assign(storage, value), remove: async key => delete storage[key],
    } }, action: { setBadgeText: b => { badge = b.text; }, setBadgeBackgroundColor() {} },
    webRequest: { onHeadersReceived: listener }, runtime: { onMessage: listener },
    tabs: { onUpdated: listener, onRemoved: listener } },
  });
  vm.runInContext(source('background.js'), ctx);
  const selected = Hls.pickBest(master, base);
  await ctx.addHls(1, base, 0, master);
  for (const [url, text] of [[selected.url, fixture('kinescope-video.m3u8')], [selected.audioUrl, fixture('kinescope-audio.m3u8')]]) {
    await ctx.addHls(1, url, 0, text);
    for (const resource of Hls.referencedUrls(text, url)) await ctx.addItem(1, { url: resource, kind: 'mp4' });
  }
  assert.equal(badge, '1');
  assert.equal(Hls.visibleItems(storage.t1).length, 1);
  assert.equal(Hls.visibleItems(storage.t1)[0].url, base);
  // Плеер запросил ту же аудиодорожку через другую ссылку.
  await ctx.addHls(1, selected.audioUrl + '&session=another', 0, fixture('kinescope-audio.m3u8'));
  const grouped = Hls.visibleItems(storage.t1);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].url, base);
  assert.equal(grouped[0].duplicateCount, 1);
  assert.ok(grouped[0].relatedCount > 0);
});

const tmp = path.join(root, 'tests/.tmp/generated');
function command(exe, args) {
  return execFileSync(exe, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function splitMp4(file) {
  const b = fs.readFileSync(file), init = [], fragments = [];
  let pending = [];
  for (let p = 0; p < b.length;) {
    const size = b.readUInt32BE(p), type = b.toString('ascii', p + 4, p + 8);
    assert.ok(size >= 8);
    const part = b.subarray(p, p + size);
    if (['ftyp', 'moov'].includes(type)) init.push(part);
    else if (type === 'moof') pending = [part];
    else if (type === 'mdat') { pending.push(part); fragments.push(Buffer.concat(pending)); pending = []; }
    p += size;
  }
  return { init: Buffer.concat(init), fragments };
}
let video, audio;
before(() => {
  fs.mkdirSync(tmp, { recursive: true });
  command('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=128x96:rate=25', '-t', '6', '-an',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '50', '-movflags', '+empty_moov+frag_keyframe+default_base_moof', path.join(tmp, 'video.mp4')]);
  command('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '6', '-vn',
    '-c:a', 'aac', '-frag_duration', '2000000', '-movflags', '+empty_moov+frag_keyframe+default_base_moof', path.join(tmp, 'audio.mp4')]);
  video = splitMp4(path.join(tmp, 'video.mp4')); audio = splitMp4(path.join(tmp, 'audio.mp4'));
});
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function downloadContext(fetch, params = {}, overrides = {}) {
  const elements = new Map();
  const context = vm.createContext({ ...common, fetch, Response, AbortController, setTimeout, clearTimeout,
    navigator: { onLine: true }, location: { search: '?' + new URLSearchParams({ src: base, ...params }) },
    document: { title: '', body: { dataset: {} }, getElementById: id => {
      if (!elements.has(id)) elements.set(id, { style: {}, textContent: '', className: '' });
      return elements.get(id);
    } }, window: { addEventListener() {} }, ...overrides,
  });
  for (const file of ['mux.min.js', 'mp4.js', 'hls.js', 'fallback.js', 'resource-mode.js']) vm.runInContext(source(file), context);
  vm.runInContext(source('download.js').split('// ---------- Запуск ----------')[0] +
    '\nglobalThis.api = { downloadHls, downloadMp4, get, sink, extReady, resource, prepareLowStorage, runDownload, continueBatch, finishDownloads, finishFolder, chooseDownloads, chooseFolder, refreshSourceFromPage, setTarget: t => { target = t; }, getSpool: () => spool, getSrc: () => src };', context);
  context.elements = elements;
  return context;
}
function verifyFile(chunks, name, expectedTypes) {
  const file = path.join(tmp, name + '.mp4');
  fs.writeFileSync(file, Buffer.concat(chunks.map(c => Buffer.from(c))));
  const metadata = JSON.parse(command('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', file]));
  assert.deepEqual(metadata.streams.map(s => s.codec_type).sort(), expectedTypes.sort());
  for (const stream of metadata.streams) assert.ok(Number(stream.duration) >= 5.9);
  // Decode both streams, rather than merely checking header metadata.
  assert.equal(command('ffmpeg', ['-v', 'error', '-xerror', '-i', file, '-map', '0', '-f', 'null', '-']), '');
  const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a:0', '-f', 's16le', '-']);
  assert.ok(pcm.length > 44100);
  assert.ok(pcm.some(byte => byte !== 0));
  return file;
}
function resourcesFor(stream, name) {
  const url = 'https://media.example.test/' + name + '.mp4';
  const parts = [stream.init, ...stream.fragments], file = Buffer.concat(parts);
  let start = stream.init.length;
  let playlist = '#EXTM3U\n#EXT-X-MAP:URI="' + url + '",BYTERANGE="' + stream.init.length + '@0"\n';
  for (const fragment of stream.fragments) {
    playlist += '#EXTINF:2,\n#EXT-X-BYTERANGE:' + fragment.length + '@' + start + '\n' + url + '\n';
    start += fragment.length;
  }
  return { url, file, playlist: playlist + '#EXT-X-ENDLIST\n' };
}

test('end-to-end HLS with byte ranges saves one decodable MP4 with audible audio', async () => {
  const v = resourcesFor(video, 'video'), a = resourcesFor(audio, 'audio');
  let rangeRequests = 0;
  const ctx = downloadContext(async (url, options) => {
    const u = new URL(url);
    if (u.pathname.endsWith('master.m3u8')) return new Response(master);
    if (u.pathname.endsWith('media.m3u8')) return new Response(u.searchParams.get('type') === 'audio' ? a.playlist : v.playlist);
    const resource = url === v.url ? v : url === a.url ? a : null;
    assert.ok(resource, url);
    const match = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);
    assert.ok(match);
    rangeRequests++;
    const start = Number(match[1]), end = Number(match[2]);
    return new Response(resource.file.subarray(start, end + 1), { status: 206,
      headers: { 'content-range': 'bytes ' + start + '-' + end + '/' + resource.file.length } });
  });
  await ctx.api.downloadHls(); await ctx.api.sink.chain;
  assert.equal(rangeRequests, video.fragments.length + audio.fragments.length + 2);
  verifyFile(ctx.api.sink.chunks, 'combined', ['video', 'audio']);
});

test('server ignoring byte ranges fails before consuming an entire MP4', async () => {
  let consumed = false;
  const ctx = downloadContext(async () => ({ status: 200, ok: true, headers: new Headers(),
    arrayBuffer: async () => { consumed = true; return new ArrayBuffer(10); } }));
  await assert.rejects(ctx.api.get('https://example.test/video', 'buf', { start: 1, end: 2 }), /honor HLS byte range/);
  assert.equal(consumed, false);
});

test('missing audio aborts the download instead of saving a silent video', async () => {
  const v = resourcesFor(video, 'video');
  const ctx = downloadContext(async url => {
    if (url === base) return new Response(master);
    if (new URL(url).searchParams.get('type') === 'audio') return new Response('#EXTM3U\n#EXT-X-ENDLIST');
    return new Response(v.playlist);
  });
  await assert.rejects(ctx.api.downloadHls(), /empty playlist/);
  assert.equal(ctx.api.sink.chunks.length, 0);
});

test('ordinary MPEG-TS HLS still produces a decodable MP4 with both tracks', async () => {
  const dir = path.join(tmp, 'ts'); fs.mkdirSync(dir);
  command('ffmpeg', ['-v', 'error', '-y', '-i', path.join(tmp, 'video.mp4'), '-i', path.join(tmp, 'audio.mp4'),
    '-map', '0:v', '-map', '1:a', '-c', 'copy', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', path.join(dir, 'index.m3u8')]);
  const ctx = downloadContext(async url => {
    if (url === base) return new Response(fs.readFileSync(path.join(dir, 'index.m3u8')));
    return new Response(fs.readFileSync(path.join(dir, path.basename(new URL(url).pathname))));
  });
  await ctx.api.downloadHls(); await ctx.api.sink.chain;
  verifyFile(ctx.api.sink.chunks, 'ordinary-ts', ['video', 'audio']);
});

test('remuxing rejects absolute fragment offsets instead of corrupting the file', () => {
  const ctx = downloadContext(async () => {});
  const muxer = new ctx.FragmentedMp4([video.init, audio.init], 6);
  const fragment = Buffer.from(video.fragments[0]);
  const tfhd = fragment.indexOf('tfhd') + 4;
  fragment.writeUInt32BE(fragment.readUInt32BE(tfhd) | 1, tfhd);
  assert.throws(() => muxer.fragment(0, fragment), /relative offsets/);
});

test('MP4 track detection distinguishes audio, video and combined content', () => {
  assert.equal(hlsContext.mp4MediaType(audio.init), 'audio');
  assert.equal(hlsContext.mp4MediaType(video.init), 'video');
  const combined = new hlsContext.FragmentedMp4([video.init, audio.init], 6);
  assert.equal(hlsContext.mp4MediaType(combined.init), 'av');
  assert.equal(hlsContext.mp4MediaType(audio.init.subarray(0, 48)), 'unknown');
  assert.equal(Hls.mediaType({ kind: 'mp4', mime: 'video/mp4' }), 'unknown');
  assert.equal(Hls.mediaType({ ...Hls.parseMaster(master, base) }), 'av');
  assert.match(Hls.mediaLabel('audio'), /🎵 Только аудио/);
});

test('audio-only HLS is labelled as audio and saved as M4A', async () => {
  const a = resourcesFor(audio, 'audio');
  const ctx = downloadContext(async (url, options) => {
    if (url === base) return new Response(a.playlist);
    const m = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);
    return new Response(a.file.subarray(Number(m[1]), Number(m[2]) + 1), { status: 206,
      headers: { 'content-range': `bytes ${m[1]}-${m[2]}/${a.file.length}` } });
  });
  await ctx.api.downloadHls(); await ctx.api.sink.chain;
  assert.equal(await ctx.api.extReady, 'm4a');
  assert.equal(ctx.elements.get('mediaType').textContent, '🎵 Только аудио');
  assert.equal(ctx.elements.get('head').textContent, 'Скачиваю аудио…');
  verifyFile(ctx.api.sink.chunks, 'audio-only', ['audio']);
});

test('direct MP4 with audio tracks is classified from its contents despite video MIME', async () => {
  const data = Buffer.concat([audio.init, ...audio.fragments]);
  const ctx = downloadContext(async () => new Response(data, { headers: { 'content-type': 'video/mp4', 'content-length': String(data.length) } }));
  await ctx.api.downloadMp4(); await ctx.api.sink.chain;
  assert.equal(await ctx.api.extReady, 'm4a');
  assert.equal(ctx.elements.get('mediaType').textContent, '🎵 Только аудио');
});

test('background probes an audio MP4 once even when the player requests many ranges', async () => {
  const storage = {}, listener = { addListener() {} };
  let probes = 0;
  const ctx = vm.createContext({ ...common, Hls, mp4MediaType: hlsContext.mp4MediaType,
    fetch: async () => { probes++; return new Response(audio.init, { status: 206 }); },
    chrome: { storage: { session: { get: async key => ({ [key]: storage[key] }), set: async values => Object.assign(storage, values) } },
      action: { setBadgeText() {}, setBadgeBackgroundColor() {} }, webRequest: { onHeadersReceived: listener },
      runtime: { onMessage: listener }, tabs: { onUpdated: listener, onRemoved: listener } },
  });
  vm.runInContext(source('background.js'), ctx);
  const item = { url: 'https://example.test/audio.mp4', kind: 'mp4', mime: 'video/mp4' };
  await ctx.addFile(1, { ...item }); await ctx.addFile(1, { ...item });
  assert.equal(probes, 1);
  assert.equal(storage.t1[0].mediaType, 'audio');
});

test('popup shows a distinct audio badge and passes the type to the download page', async () => {
  const node = () => ({ children: [], style: {}, appendChild(n) { this.children.push(n); }, replaceChildren(...nodes) { this.children = nodes; } });
  const rootNode = node();
  const items = [{ url: 'https://example.test/audio.mp4', kind: 'mp4', mediaType: 'audio' },
    { url: base, kind: 'hls', ...Hls.parseMaster(master, base) }];
  let opened;
  const ctx = vm.createContext({ ...common, Hls, document: { getElementById: () => rootNode, createElement: node }, window: { close() {} },
    chrome: { tabs: { query: async () => [{ id: 1, title: 'Урок' }], create: options => { opened = options.url; } },
      scripting: { executeScript: async () => [] }, storage: { session: { get: async () => ({ t1: items }) } },
      runtime: { getURL: name => 'chrome-extension://test/' + name } },
  });
  await vm.runInContext(source('popup.js'), ctx);
  const audioButton = rootNode.children.find(n => n.className === 'audio');
  assert.ok(audioButton);
  assert.equal(audioButton.children[0].textContent, '🎵 Только аудио');
  assert.equal(rootNode.children[0].textContent, 'Найдено файлов: 2');
  audioButton.onclick();
  assert.equal(new URL(opened).searchParams.get('media'), 'audio');
});

test('matching names never hide different video and audio content as duplicates', () => {
  const items = Hls.visibleItems([
    { url: 'https://example.test/a', kind: 'hls', label: 'Урок', contentKey: 'audio-content', mediaType: 'audio' },
    { url: 'https://example.test/v', kind: 'hls', label: 'Урок', contentKey: 'video-content', mediaType: 'video' },
    { url: 'https://example.test/v-alias', kind: 'hls', label: 'Другое название', contentKey: 'video-content', mediaType: 'video' },
  ]);
  assert.equal(items.length, 2);
  assert.equal(items.find(v => v.mediaType === 'audio').duplicateCount, 0);
  assert.equal(items.find(v => v.mediaType === 'video').duplicateCount, 1);
});

test('Kinescope master groups changing audio URLs by player ID without hiding another lesson', () => {
  const b = 'https://kinescope.io/lesson-one/';
  const items = Hls.visibleItems([
    { url: b + 'media.m3u8?type=audio&quality=360&lang=en&session=2', kind: 'hls', mediaType: 'audio' },
    { url: b + 'media.m3u8?type=video&quality=720', kind: 'hls', mediaType: 'video' },
    { url: b + 'master.m3u8', kind: 'hls', ...Hls.parseMaster(master, b + 'master.m3u8') },
    { url: 'https://kinescope.io/lesson-two/media.m3u8?type=audio', kind: 'hls', mediaType: 'audio' },
  ]);
  assert.equal(items.length, 2);
  assert.equal(items.find(v => v.groupRole === 'master').relatedCount, 2);
  assert.ok(items.some(v => v.url.includes('lesson-two')));
  assert.equal(Hls.kinescopeInfo('https://kinescope.io.evil.test/id/media.m3u8?type=audio'), null);
});

test('captured Kinescope tracks form one download when the master is unavailable', () => {
  const b = 'https://kinescope.io/lesson-one/media.m3u8?';
  const audio = b + 'type=audio&lang=ru';
  const items = Hls.visibleItems([
    { url: b + 'type=video&quality=360', kind: 'hls', mediaType: 'video' },
    { url: b + 'type=video&quality=1080', kind: 'hls', mediaType: 'video' },
    { url: audio, kind: 'hls', mediaType: 'audio' },
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].mediaType, 'av');
  assert.equal(items[0].audioUrl, audio);
  assert.match(items[0].url, /1080/);
});

function backgroundContext(fetch) {
  const storage = {}, listener = { handlers: [], addListener(fn) { this.handlers.push(fn); } };
  const ctx = vm.createContext({ ...common, Hls, mp4MediaType: hlsContext.mp4MediaType, fetch,
    chrome: { storage: { session: { get: async key => ({ [key]: storage[key] }), set: async value => Object.assign(storage, value) } },
      action: { setBadgeText() {}, setBadgeBackgroundColor() {} }, webRequest: { onHeadersReceived: listener },
      runtime: { onMessage: listener }, tabs: { onUpdated: listener, onRemoved: listener } },
  });
  vm.runInContext(source('background.js'), ctx);
  ctx.storage = storage;
  ctx.listener = listener;
  return ctx;
}

test('background recovers a missed Kinescope master without sending cookies', async () => {
  const url = 'https://kinescope.io/lesson-one/media.m3u8?quality=720&type=video';
  const calls = [];
  const ctx = backgroundContext(async (url, options) => {
    calls.push({ url, credentials: options.credentials });
    assert.match(url, /lesson-one\/master.m3u8$/);
    return new Response(master);
  });
  await ctx.addHls(1, url, 0, '#EXTM3U\n#EXTINF:2,\nhttps://media.example.test/a.ts\n#EXT-X-ENDLIST');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].credentials, 'omit');
  assert.equal(Hls.visibleItems(ctx.storage.t1).length, 1);
  assert.match(Hls.visibleItems(ctx.storage.t1)[0].url, /master.m3u8$/);
});

test('GetCourse page discovery decodes links and excludes unapproved hosts', async () => {
  const page = 'https://school.example.test/lesson';
  const html = '<video data-master="/api/playlist/master?x=1&amp;y=2"></video>' +
    '<script>{"src":"https:\\/\\/kinescope.io\\/id\\/master.m3u8"}</script>' +
    '<script>{"src":"https://unrelated.example.test/track.m3u8"}</script>';
  const urls = Hls.pageSources(html, page);
  assert.equal(urls.length, 2);
  assert.ok(urls.includes('https://school.example.test/api/playlist/master?x=1&y=2'));
  const calls = [];
  const ctx = backgroundContext(async (url, options) => {
    calls.push({ url, credentials: options.credentials });
    if (url === page) return new Response(html, { headers: { 'content-type': 'text/html' } });
    assert.ok(urls.includes(url));
    assert.equal(options.credentials, 'omit');
    return new Response(master);
  });
  await ctx.checkUrl(1, page, 0);
  assert.equal(calls.length, 3);
  assert.equal(ctx.storage.t1.length, 2);
});

test('quality/audio selection never pairs audio from a different HLS group', () => {
  const m = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Русский",LANGUAGE="ru",URI="ru.m3u8"\n' +
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="b",NAME="English",URI="en.m3u8"\n' +
    '#EXT-X-STREAM-INF:BANDWIDTH=10,RESOLUTION=1280x720,AUDIO="a"\n720.m3u8\n' +
    '#EXT-X-STREAM-INF:BANDWIDTH=20,RESOLUTION=1920x1080,AUDIO="b"\n1080.m3u8';
  const selected = Hls.pickBest(m, base, { videoUrl: new URL('720.m3u8', base).href });
  assert.match(selected.audioUrl, /ru.m3u8$/);
  assert.throws(() => Hls.pickBest(m, base, { videoUrl: selected.url, audioUrl: new URL('en.m3u8', base).href }), /does not belong/);
});

test('refreshed audio URL falls back to the selected video group', () => {
  const m = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Русский",DEFAULT=YES,URI="audio.m3u8?token=new"\n' +
    '#EXT-X-STREAM-INF:BANDWIDTH=10,RESOLUTION=1280x720,AUDIO="a"\nvideo.m3u8';
  const selected = Hls.pickBest(m, base, { videoUrl: new URL('video.m3u8', base).href,
    audioUrl: new URL('audio.m3u8?token=old', base).href });
  assert.equal(selected.audioUrl, new URL('audio.m3u8?token=new', base).href);
});

test('refreshed signed video URL preserves the selected stream', () => {
  const m = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=20,RESOLUTION=1920x1080\n1080.m3u8?token=new\n' +
    '#EXT-X-STREAM-INF:BANDWIDTH=10,RESOLUTION=1280x720\n720.m3u8?token=new';
  const selected = Hls.pickBest(m, base, { videoUrl: new URL('1080.m3u8?token=old', base).href,
    videoRes: '1920x1080', videoBw: 20 });
  assert.equal(selected.url, new URL('1080.m3u8?token=new', base).href);
  const changedPath = Hls.pickBest(m.replaceAll('1080.m3u8', 'high.m3u8'), base, {
    videoUrl: new URL('old.m3u8?token=old', base).href, videoRes: '1920x1080', videoBw: 20,
  });
  assert.match(changedPath.url, /high\.m3u8\?token=new$/);
});

test('MP4 verification counts actual samples and catches truncated tracks despite full header duration', () => {
  const full = new hlsContext.FragmentedMp4([video.init, audio.init], 6);
  for (const part of video.fragments) full.fragment(0, part);
  for (const part of audio.fragments) full.fragment(1, part);
  const report = full.verify([6, 6]);
  assert.equal(report.tracks.length, 2);
  assert.ok(report.tracks.every(t => t.samples > 0));
  const partial = new hlsContext.FragmentedMp4([video.init, audio.init], 6);
  for (const part of video.fragments.slice(0, -1)) partial.fragment(0, part);
  for (const part of audio.fragments) partial.fragment(1, part);
  assert.throws(() => partial.verify([6, 6]), e => e.mediaIncomplete === true);
});

test('MP4 verification catches timeline gaps even when all samples are present', () => {
  const mux = new hlsContext.FragmentedMp4([video.init], 6);
  for (let i = 0; i < video.fragments.length; i++) {
    const part = Buffer.from(video.fragments[i]);
    if (i === 1) {
      const body = part.indexOf('tfdt') + 4;
      if (part[body] === 1) part.writeBigUInt64BE(part.readBigUInt64BE(body + 4) + 12800n, body + 4);
      else part.writeUInt32BE(part.readUInt32BE(body + 4) + 12800, body + 4);
    }
    mux.fragment(0, part);
  }
  const report = mux.verify([6]);
  assert.ok(report.warnings.length > 0);
  assert.ok(report.tracks[0].samples > 0);
});

test('video-only response cannot pass when the master promises audio', async () => {
  const v = resourcesFor(video, 'video');
  const ctx = downloadContext(async (url, options) => {
    if (url === base) return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=9,CODECS="avc1.4d,mp4a.40.2",RESOLUTION=128x96\nvideo.m3u8');
    if (url.endsWith('.m3u8')) return new Response(v.playlist);
    const m = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);
    return new Response(v.file.subarray(Number(m[1]), Number(m[2]) + 1), { status: 206,
      headers: { 'content-range': `bytes ${m[1]}-${m[2]}/${v.file.length}` } });
  });
  await assert.rejects(ctx.api.downloadHls(), /Expected audio track is missing/);
  assert.equal(ctx.api.sink.chunks.length, 0);
});

test('external download commands quote URLs and names as literal PowerShell arguments', () => {
  const ctx = vm.createContext({ URL });
  vm.runInContext(source('fallback.js'), ctx);
  const single = ctx.DownloadFallback.command({ url: 'https://example.test/master.m3u8?x=1&y=2', name: "Урок '; Write-Host bad; '" });
  assert.match(single.text, /--ignore-config/);
  assert.ok(single.text.includes("Урок ''; Write-Host bad; ''"));
  const pair = ctx.DownloadFallback.command({ url: 'https://example.test/v.m3u8', audioUrl: 'https://example.test/a.m3u8', pageUrl: 'https://school.example.test/lesson' });
  assert.match(pair.text, /'0:v:0'/);
  assert.match(pair.text, /'1:a:0'/);
  assert.ok(!pair.text.includes('-shortest'));
  assert.throws(() => ctx.DownloadFallback.command({ url: 'file:///C:/secrets' }), /HTTP video URL/);
});

test('paired Kinescope download honours selected quality and outputs verified video with audio', async () => {
  const b = 'https://kinescope.io/lesson-one/media.m3u8?';
  const selectedVideo = b + 'type=video&quality=360', selectedAudio = b + 'type=audio&lang=ru';
  const v = resourcesFor(video, 'video'), a = resourcesFor(audio, 'audio');
  const seen = [];
  const ctx = downloadContext(async (url, options) => {
    if (url.startsWith('https://kinescope.io/')) {
      seen.push(url);
      assert.ok([selectedVideo, selectedAudio].includes(url));
      return new Response(url === selectedVideo ? v.playlist : a.playlist);
    }
    const resource = url === v.url ? v : a;
    const m = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);
    return new Response(resource.file.subarray(Number(m[1]), Number(m[2]) + 1), { status: 206,
      headers: { 'content-range': `bytes ${m[1]}-${m[2]}/${resource.file.length}` } });
  }, { src: b + 'type=video&quality=1080', video: selectedVideo, audio: selectedAudio, media: 'av' });
  await ctx.api.downloadHls(); await ctx.api.sink.chain;
  assert.deepEqual(seen, [selectedVideo, selectedAudio]);
  assert.match(ctx.elements.get('verification').textContent, /изображение и звук/);
  assert.match(ctx.elements.get('externalCommand').value, /'ffmpeg'/);
  verifyFile(ctx.api.sink.chunks, 'paired-kinescope', ['audio', 'video']);
});

test('a different Kinescope player cannot supply the selected video', async () => {
  const ctx = downloadContext(async () => { throw new Error('Should not fetch another player'); }, {
    src: 'https://kinescope.io/lesson-one/media.m3u8?type=video',
    video: 'https://kinescope.io/lesson-two/media.m3u8?type=video',
  });
  await assert.rejects(ctx.api.downloadHls(), /another player/);
});

test('complete HLS playlists do not hide missing audio samples in the downloaded media', async () => {
  const v = resourcesFor(video, 'video');
  // Объявлено 6 секунд, но в аудиофрагментах реально только около 4 секунд.
  const a = resourcesFor({ init: audio.init, fragments: audio.fragments.slice(0, 2) }, 'audio');
  a.playlist = a.playlist.replaceAll('#EXTINF:2,', '#EXTINF:3,');
  const ctx = downloadContext(async (url, options) => {
    if (url === base) return new Response(master);
    if (url.includes('media.m3u8')) return new Response(new URL(url).searchParams.get('type') === 'audio' ? a.playlist : v.playlist);
    const resource = url === v.url ? v : a;
    const m = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);
    return new Response(resource.file.subarray(Number(m[1]), Number(m[2]) + 1), { status: 206,
      headers: { 'content-range': `bytes ${m[1]}-${m[2]}/${resource.file.length}` } });
  });
  await assert.rejects(ctx.api.downloadHls(), e => e.mediaIncomplete === true);
  assert.equal(ctx.elements.get('verification')?.textContent || '', '');
});

function fakeDisk() {
  const files = new Map();
  const dir = {
    async *values() { for (const name of files.keys()) yield { kind: 'file', name }; },
    async removeEntry(name) { files.delete(name); },
    async getFileHandle(name) {
      const entry = { parts: [], closed: false, position: 0 };
      files.set(name, entry);
      return {
        async createWritable() {
          return {
            async write(value) {
              await new Promise(r => setTimeout(r, 1));
              entry.parts.push(Buffer.from(value)); entry.position += value.byteLength;
            },
            async truncate(size) { entry.parts = [Buffer.concat(entry.parts).subarray(0, size)]; },
            async seek(position) { entry.position = position; },
            async close() { entry.closed = true; }, async abort() { entry.parts = []; },
          };
        },
        async getFile() { assert.equal(entry.closed, true); return new Blob(entry.parts); },
      };
    },
  };
  return { files, storage: { getDirectory: async () => ({ getDirectoryHandle: async name => {
    assert.equal(name, 'video-grabber-low-resource-v1'); return dir;
  } }) } };
}

test('low-resource mode keeps best quality and six-way segment downloading', () => {
  const settings = common.ResourceMode.settings(true);
  assert.equal(settings.maxHeight, null);
  assert.equal(settings.parallel, 6);
  assert.match(Hls.pickBest(master, base, settings).url, /quality=1080&type=video/);
  const explicit = Hls.pickBest(master, base, { ...settings, videoUrl: new URL('media.m3u8?quality=720&type=video', base).href });
  assert.equal(explicit.res, '1280x720');
});

test('low-resource HLS uses parallel requests, disk buffering and a disk-backed browser download', async () => {
  const disk = fakeDisk(), v = resourcesFor(video, 'video'), a = resourcesFor(audio, 'audio');
  let inFlight = 0, maxInFlight = 0, savedBytes, savedOptions, savedType;
  const ctx = downloadContext(async (url, options) => {
    if (url === base) return new Response(master);
    if (url.includes('media.m3u8')) {
      if (new URL(url).searchParams.get('type') === 'video') assert.equal(new URL(url).searchParams.get('quality'), '1080');
      return new Response(new URL(url).searchParams.get('type') === 'audio' ? a.playlist : v.playlist);
    }
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise(r => setTimeout(r, 3)); inFlight--;
    const file = url === v.url ? v.file : a.file;
    const m = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);
    return new Response(file.subarray(Number(m[1]), Number(m[2]) + 1), { status: 206,
      headers: { 'content-range': `bytes ${m[1]}-${m[2]}/${file.length}` } });
  }, { low: '1' }, {
    navigator: { onLine: true, storage: disk.storage }, Blob,
    chrome: { downloads: {
      download: async options => { savedOptions = options; const response = await fetch(options.url); savedType = response.headers.get('content-type'); savedBytes = Buffer.from(await response.arrayBuffer()); return 1; },
      search: async () => [{ state: 'complete', filename: 'lesson.mp4' }],
    } },
  });
  await ctx.api.prepareLowStorage(); await ctx.api.downloadHls(); await ctx.api.sink.chain;
  assert.ok(maxInFlight > 2 && maxInFlight <= 6);
  assert.equal(ctx.api.sink.chunks.length, 0);
  assert.equal(ctx.api.sink.buffered, 0);
  assert.ok(ctx.api.sink.written > 0);
  ctx.api.setTarget({ type: 'downloads', saveAs: false });
  await ctx.api.finishDownloads();
  assert.match(savedOptions.filename, /\.mp4$/);
  assert.equal(savedType, 'video/mp4');
  assert.equal(disk.files.size, 0);
  verifyFile([savedBytes], 'low-resource-disk', ['video', 'audio']);
});

test('disk-backed saving copies to a chosen folder and cleans the temporary file', async () => {
  const disk = fakeDisk();
  const spool = await common.ResourceMode.DiskSpool.open(disk.storage);
  await spool.writable.write(new Uint8Array([1, 2, 3]));
  const parts = [];
  await spool.copyTo({ write: async bytes => parts.push(Buffer.from(bytes)) });
  assert.deepEqual(Buffer.concat(parts), Buffer.from([1, 2, 3]));
  await spool.dispose();
  assert.equal(disk.files.size, 0);
});

test('low-resource startup never fetches video if disk buffering is unavailable', async () => {
  let requests = 0;
  const ctx = downloadContext(async () => { requests++; throw new Error('unexpected network'); }, { low: '1' }, {
    navigator: { onLine: true, locks: { request: async (_name, _options, work) => work() } },
  });
  await assert.rejects(ctx.api.runDownload(), /Disk buffering is unavailable/);
  assert.equal(requests, 0);
  assert.equal(ctx.api.sink.buffered, 0);
});

test('low-resource mode rejects oversized HLS ranges before allocation or network activity', async () => {
  let requests = 0;
  const ctx = downloadContext(async () => { requests++; }, { low: '1' });
  await assert.rejects(ctx.api.get('https://example.test/part.mp4', 'buf', { start: 0, end: 40 * 1024 * 1024 }), /memory limit/);
  assert.equal(requests, 0);
});

test('low-resource lock runs independent downloads serially', async () => {
  let queue = Promise.resolve(), active = 0, maximum = 0;
  const locks = { request: (_name, _options, work) => {
    const current = queue.then(work); queue = current.catch(() => {}); return current;
  } };
  const work = async () => { active++; maximum = Math.max(maximum, active); await new Promise(r => setTimeout(r, 5)); active--; };
  await Promise.all([common.ResourceMode.serial(locks, work), common.ResourceMode.serial(locks, work)]);
  assert.equal(maximum, 1);
});

test('low-resource Download all creates a persistent queue at best quality', async () => {
  const node = () => ({ children: [], style: {}, appendChild(n) { this.children.push(n); }, replaceChildren(...nodes) { this.children = nodes; } });
  const rootNode = node(), toggle = node();
  const items = [1, 2].map(id => ({ url: 'https://kinescope.io/lesson-' + id + '/master.m3u8', kind: 'hls',
    ...Hls.parseMaster(master, 'https://kinescope.io/lesson-' + id + '/master.m3u8') }));
  const storage = {}, opened = [];
  const ctx = vm.createContext({ ...common, Hls,
    document: { getElementById: id => id === 'lowResource' ? toggle : rootNode, createElement: node }, window: { close() {} },
    chrome: { tabs: { query: async () => [{ id: 1, title: 'Урок' }], create: options => opened.push(options.url) },
      scripting: { executeScript: async () => [] }, storage: { session: { get: async () => ({ t1: items }), set: async value => Object.assign(storage, value) },
        local: { get: async () => ({ lowResource: true }), set: async value => Object.assign(storage, value) } },
      runtime: { getURL: name => 'chrome-extension://test/' + name } },
  });
  await vm.runInContext(source('popup.js'), ctx);
  assert.equal(toggle.checked, true);
  await rootNode.children.find(n => n.className === 'all').onclick();
  assert.equal(opened.length, 1);
  const q = new URL(opened[0]).searchParams;
  assert.equal(q.get('low'), '1');
  const batch = storage['batch:' + q.get('batch')];
  assert.equal(batch.length, 2);
  assert.ok(batch.every(v => v.videoUrl.includes('quality=1080')));
  assert.ok(batch.every(v => !v.variants));
  assert.equal(storage['batch-progress:' + q.get('batch')].index, 0);
  toggle.checked = false; toggle.onchange();
  assert.equal(storage.lowResource, false);
});

test('next queued lesson stores resume state and preserves destination after failure', async () => {
  let nextUrl;
  const jobs = [{ url: base, fileName: 'one' }, { url: base + '?two', kind: 'hls', fileName: 'two', mediaType: 'av' }];
  const storage = { 'batch:queue-id': jobs };
  const local = { get: async key => ({ [key]: storage[key] }), set: async value => Object.assign(storage, value),
    remove: async key => { delete storage[key]; } };
  const ctx = downloadContext(async () => {}, { low: '1', batch: 'queue-id', index: '0', destination: 'folder' }, {
    chrome: { storage: { local }, runtime: { getURL: name => 'chrome-extension://test/' + name } },
    location: { search: '?' + new URLSearchParams({ src: base, low: '1', batch: 'queue-id', index: '0', destination: 'folder' }), replace: url => { nextUrl = url; } },
  });
  // No target exists after a failure; the previous destination must still survive.
  await ctx.api.continueBatch();
  const q = new URL(nextUrl).searchParams;
  assert.equal(q.get('name'), 'two');
  assert.equal(q.get('index'), '1');
  assert.equal(q.get('destination'), 'folder');
  assert.equal(q.get('low'), '1');
  assert.equal(storage['batch-progress:queue-id'].index, 1);
});

test('direct downloads apply disk backpressure instead of retaining pending writes', async () => {
  let reads = 0, writes = 0, release;
  const blockedWrite = new Promise(resolve => { release = resolve; });
  const chunks = [video.init, ...video.fragments];
  const ctx = downloadContext(async () => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'video/mp4' }),
    body: { getReader: () => ({ read: async () => {
      const value = chunks[reads++]; return value ? { value, done: false } : { done: true };
    } }) },
  }), { low: '1', kind: 'mp4' });
  ctx.api.sink.writable = { write: async () => { if (++writes === 1) await blockedWrite; } };
  const downloading = ctx.api.downloadMp4();
  await new Promise(r => setTimeout(r, 5));
  assert.equal(reads, 1);
  assert.equal(writes, 1);
  release(); await downloading;
  assert.equal(ctx.api.sink.buffered, 0);
});

test('cancelling Save As keeps the disk-backed file available for a second save', async () => {
  const disk = fakeDisk(); let attempts = 0;
  const ctx = downloadContext(async () => new Response(audio.init), { low: '1', kind: 'mp4' }, {
    Blob, navigator: { onLine: true, storage: disk.storage }, chrome: { downloads: {
      download: async () => { if (++attempts === 1) throw new Error('User canceled'); return 1; },
      search: async () => [{ state: 'complete', filename: 'audio.m4a' }],
    } },
  });
  await ctx.api.prepareLowStorage(); await ctx.api.downloadMp4(); await ctx.api.sink.chain;
  ctx.api.setTarget({ type: 'downloads', saveAs: true });
  await ctx.api.finishDownloads();
  assert.equal(disk.files.size, 1);
  assert.equal(ctx.elements.get('pick').style.display, 'inline-block');
  ctx.api.setTarget({ type: 'downloads', saveAs: true });
  await ctx.api.finishDownloads();
  assert.equal(disk.files.size, 0);
});

test('disposing an interrupted disk buffer removes only its own temporary file', async () => {
  const disk = fakeDisk();
  disk.files.set('keep-other-file.txt', { parts: [] });
  const spool = await common.ResourceMode.DiskSpool.open(disk.storage);
  await spool.writable.write(new Uint8Array([1, 2, 3]));
  await spool.dispose();
  assert.equal(disk.files.size, 1);
  assert.ok(disk.files.has('keep-other-file.txt'));
});

test('lazy data-src players are included in page discovery', () => {
  const urls = Hls.pageSources('<iframe data-src="/api/master?token=new"></iframe>', 'https://school.example.test/lesson');
  assert.deepEqual(Array.from(urls), ['https://school.example.test/api/master?token=new']);
});

test('background keeps short MP4 lessons and inspects media playlist candidates', async () => {
  const ctx = backgroundContext(async () => new Response(new Uint8Array(0), { status: 206 }));
  const onHeaders = ctx.listener.handlers[0];
  await onHeaders({ tabId: 1, frameId: 0, url: 'https://cdn.example.test/short.mp4', type: 'media', statusCode: 200,
    responseHeaders: [{ name: 'content-type', value: 'video/mp4' }, { name: 'content-length', value: '500' }] });
  assert.equal(ctx.storage.t1.length, 1);
  assert.equal(ctx.storage.t1[0].size, 500);

  const playlistCtx = backgroundContext(async () => new Response(master));
  await playlistCtx.listener.handlers[0]({ tabId: 2, frameId: 0, url: 'https://school.example.test/playlist/master', type: 'media', statusCode: 200,
    responseHeaders: [{ name: 'content-type', value: 'text/plain' }] });
  assert.equal(playlistCtx.storage.t2[0].kind, 'hls');
});

test('slow discovery in one tab does not block another tab', async () => {
  const ctx = backgroundContext(async () => { throw new Error('not used'); });
  let active = 0, maximum = 0;
  const work = async () => {
    active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 20));
    active--;
  };
  const run = vm.runInContext('run', ctx);
  await Promise.all([run(1, work), run(2, work)]);
  assert.equal(maximum, 2);
});

test('queued Kinescope media refreshes through its master playlist', async () => {
  const old = 'https://kinescope.io/lesson-one/media.m3u8?type=video&quality=1080&token=old';
  const ctx = downloadContext(async url => {
    assert.equal(url, 'https://kinescope.io/lesson-one/master.m3u8?token=old');
    return new Response(master);
  }, { src: old });
  assert.equal(await ctx.api.refreshSourceFromPage(), true);
  assert.equal(ctx.api.getSrc(), 'https://kinescope.io/lesson-one/master.m3u8?token=old');
});

test('choosing a folder switches disk buffering to direct destination writes', async () => {
  const disk = fakeDisk(), output = { parts: [] };
  let destinationWritable;
  const dir = { name: 'Lessons', async getFileHandle(name, options = {}) {
    if (!options.create) throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
    return { async createWritable() {
      destinationWritable = { write: async value => output.parts.push(Buffer.from(value)), close: async () => {}, abort: async () => {} };
      return destinationWritable;
    } };
  } };
  const ctx = downloadContext(async () => new Response(audio.init), { low: '1', kind: 'mp4' }, {
    Blob, navigator: { onLine: true, storage: disk.storage },
    window: { addEventListener() {}, showDirectoryPicker: async () => dir },
  });
  await ctx.api.prepareLowStorage(); await ctx.api.downloadMp4(); await ctx.api.sink.chain;
  await ctx.api.chooseFolder(); await ctx.api.sink.chain;
  assert.equal(ctx.api.getSpool(), null);
  assert.equal(ctx.api.sink.writable, destinationWritable);
  assert.ok(output.parts.length > 0);
  assert.equal(disk.files.size, 0);
});
