// Общий разбор HLS для фонового поиска и страницы скачивания.
(function (g) {
  function attr(line, key) {
    const attrs = line.slice(line.indexOf(':') + 1);
    const re = /(?:^|,)\s*([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    for (const m of attrs.matchAll(re)) {
      if (m[1] === key) return m[2].startsWith('"') ? m[2].slice(1, -1) : m[2];
    }
    return null;
  }

  function parseMaster(text, base) {
    const lines = text.split(/\r?\n/).map(s => s.trim());
    const variants = [], renditions = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('#EXT-X-MEDIA:')) {
        const uri = attr(line, 'URI');
        renditions.push({ type: attr(line, 'TYPE'), group: attr(line, 'GROUP-ID'),
          name: attr(line, 'NAME') || '', language: attr(line, 'LANGUAGE') || '',
          default: attr(line, 'DEFAULT') === 'YES', auto: attr(line, 'AUTOSELECT') === 'YES',
          url: uri ? new URL(uri, base).href : null });
      } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
        let j = i + 1;
        while (j < lines.length && (!lines[j] || lines[j].startsWith('#'))) j++;
        if (j < lines.length) variants.push({ url: new URL(lines[j], base).href,
          bw: Number(attr(line, 'BANDWIDTH')) || 0, res: attr(line, 'RESOLUTION') || '',
          codecs: attr(line, 'CODECS') || '', audio: attr(line, 'AUDIO') });
      }
    }
    return { variants, renditions };
  }

  function selectStreams({ variants, renditions = [] }, preferences = {}) {
    // Audio-only variants sometimes have their own EXT-X-STREAM-INF entry.
    const video = variants.filter(v => v.res || !v.codecs || /avc|hev|hvc|vp0?[89]|av01/i.test(v.codecs));
    let pool = video.length ? video : variants;
    if (preferences.maxHeight && video.length) {
      const height = v => Number((v.res || '').split('x')[1]) || 0;
      const fitting = pool.filter(v => height(v) && height(v) <= preferences.maxHeight);
      if (fitting.length) pool = fitting;
      else {
        const known = pool.filter(v => height(v));
        if (known.length) {
          const minimum = Math.min(...known.map(height));
          pool = known.filter(v => height(v) === minimum);
        } else pool = pool.length ? [pool.reduce((a, b) => b.bw < a.bw ? b : a)] : [];
      }
    }
    const bestOf = list => list.reduce((a, b) => !a || b.bw > a.bw ? b : a, null);
    let best = preferences.videoUrl ? variants.find(v => v.url === preferences.videoUrl) : null;
    // Signed URLs often change when a master is refreshed. Preserve the selected
    // stream by stable attributes instead of requiring the expired URL to exist.
    if (!best && preferences.videoUrl) {
      const previousKinescope = kinescopeInfo(preferences.videoUrl);
      let previous = null;
      try { previous = new URL(preferences.videoUrl); } catch (e) { /* invalid old URL */ }
      best = variants.find(v => {
        const currentKinescope = kinescopeInfo(v.url);
        if (previousKinescope && currentKinescope) {
          return currentKinescope.id === previousKinescope.id && currentKinescope.role === previousKinescope.role &&
            (!previousKinescope.quality || currentKinescope.quality === previousKinescope.quality);
        }
        if (!previous) return false;
        try {
          const current = new URL(v.url);
          return current.origin === previous.origin && current.pathname === previous.pathname;
        } catch (e) { return false; }
      });
      if (!best && preferences.videoRes) best = pool.find(v => v.res === preferences.videoRes);
      if (!best && preferences.videoBw) {
        const target = Number(preferences.videoBw);
        best = pool.reduce((a, b) => !a || Math.abs(b.bw - target) < Math.abs(a.bw - target) ? b : a, null);
      }
    }
    if (!best) best = bestOf(pool);
    if (!best) return null;
    const audio = renditions.filter(r => r.type === 'AUDIO' && r.group === best.audio);
    const requestedAudio = preferences.audioUrl && audio.find(r => r.url === preferences.audioUrl);
    // A refreshed master can contain new signed URLs. If the old URL now belongs
    // to another group, reject it; if it disappeared, use this variant's group.
    if (preferences.audioUrl && !requestedAudio && renditions.some(r => r.type === 'AUDIO' && r.url === preferences.audioUrl))
      throw new Error('Audio does not belong to the selected video group');
    const chosen = requestedAudio || audio.find(r => r.default) || audio.find(r => r.auto) || audio[0];
    if (best.audio && !chosen) throw new Error('HLS audio group missing: ' + best.audio);
    return { ...best, audioUrl: chosen ? chosen.url : null };
  }
  const pickBest = (text, base, preferences) => selectStreams(parseMaster(text, base), preferences);

  function kinescopeInfo(value) {
    try {
      const url = new URL(value);
      if (url.hostname !== 'kinescope.io' && !url.hostname.endsWith('.kinescope.io')) return null;
      const match = /^\/([a-zA-Z0-9-]+)\/(master|media)\.m3u8$/.exec(url.pathname);
      if (!match) return null;
      const role = match[2] === 'master' ? 'master' : url.searchParams.get('type');
      if (!['master', 'video', 'audio'].includes(role)) return null;
      const master = new URL(url);
      master.pathname = '/' + match[1] + '/master.m3u8';
      for (const key of ['type', 'quality', 'lang']) master.searchParams.delete(key);
      return { id: url.origin + '/' + match[1], role, masterUrl: master.href,
        quality: Number((url.searchParams.get('quality') || '').replace(/p$/, '')) || 0,
        language: url.searchParams.get('lang') || '' };
    } catch (e) { return null; }
  }

  // Используется и для сохранённых страниц, и для конфигурации встроенного плеера.
  function pageSources(html, base) {
    const result = new Set();
    const add = raw => {
      try {
        const value = raw.replace(/\\\//g, '/').replace(/\\u0026/gi, '&').replace(/&amp;/gi, '&');
        const url = new URL(value, base);
        if (allowedPageSource(url.href, base)) result.add(url.href);
      } catch (e) { /* это не ссылка */ }
    };
    for (const m of html.matchAll(/\b(?:data-master|data-video-src|data-src)\s*=\s*["']([^"']+)["']/gi)) add(m[1]);
    for (const m of html.matchAll(/["']([^"'<>\s]*\.m3u8(?:\?[^"'<>\s]*)?)["']/gi)) add(m[1]);
    return [...result].slice(0, 100);
  }
  function allowedPageSource(value, base) {
    try {
      const url = new URL(value), page = new URL(base);
      if (!/^https?:$/.test(url.protocol) || url.username || url.password) return false;
      const providers = ['kinescope.io', 'getcourse.ru', 'gceuproxy.com'];
      return url.origin === page.origin || providers.some(host => url.hostname === host || url.hostname.endsWith('.' + host));
    } catch (e) { return false; }
  }

  function groupKinescope(all) {
    const groups = new Map();
    for (const item of all) {
      if (item.kind !== 'hls') continue;
      const info = kinescopeInfo(item.url);
      if (!info) continue;
      if (!groups.has(info.id)) groups.set(info.id, []);
      groups.get(info.id).push({ item, info });
    }
    const hidden = new Set(), replacements = new Map();
    for (const members of groups.values()) {
      const masters = members.filter(m => m.info.role === 'master' && m.item.variants?.length)
        .sort((a, b) => b.item.variants.length - a.item.variants.length);
      if (masters.length) {
        const primary = masters[0].item;
        const others = members.filter(m => m.item !== primary).map(m => m.item.url);
        others.forEach(url => hidden.add(url));
        replacements.set(primary.url, { ...primary, groupedUrls: others,
          provider: 'Kinescope', groupRole: 'master' });
        continue;
      }
      const videos = members.filter(m => m.info.role === 'video').sort((a, b) => b.info.quality - a.info.quality);
      const audios = members.filter(m => m.info.role === 'audio');
      if (!videos.length || !audios.length) continue;
      const video = videos[0].item;
      const audio = audios.find(m => m.info.language === 'ru') || audios.find(m => m.info.language === 'und') || audios[0];
      const others = members.filter(m => m.item !== video && m.info.role !== 'master').map(m => m.item.url);
      others.forEach(url => hidden.add(url));
      replacements.set(video.url, { ...video, audioUrl: audio.item.url, mediaType: 'av',
        groupedUrls: others, provider: 'Kinescope', groupRole: 'paired',
        audioTracks: audios.map(m => ({ url: m.item.url, language: m.info.language })),
        videoTracks: videos.map(m => ({ url: m.item.url, res: m.info.quality ? '0x' + m.info.quality : '', bw: m.info.quality })) });
    }
    // Все узлы сохраняем для подсчёта дублей и связей; при отображении скрываем только известные связи.
    return { all: all.map(item => replacements.get(item.url) || item), hidden };
  }

  function range(value, previous, url) {
    const m = /^(\d+)(?:@(\d+))?$/.exec(value || '');
    if (!m) throw new Error('Invalid HLS byte range: ' + value);
    const length = Number(m[1]);
    const offset = m[2] !== undefined ? Number(m[2]) : previous && previous.url === url ? previous.end + 1 : NaN;
    const end = offset + length - 1;
    if (!length || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(end)) {
      throw new Error('Invalid HLS byte range offset');
    }
    return { start: offset, end };
  }

  function parseMedia(text, base) {
    const segments = [];
    let seq = 0, key = null, init = null, duration = 0, segmentDuration = 0;
    let byteRange = null, previous = null;
    const unsupported = detail => { throw Object.assign(new Error(detail), { hlsUnsupported: true }); };
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) seq = Number(line.split(':')[1]) || 0;
      else if (line.startsWith('#EXTINF:')) segmentDuration = parseFloat(line.slice(8)) || 0;
      else if (line.startsWith('#EXT-X-KEY:')) {
        const method = attr(line, 'METHOD');
        if (method === 'NONE') key = null;
        else if (method === 'AES-128' && (!attr(line, 'KEYFORMAT') || attr(line, 'KEYFORMAT') === 'identity')) {
          const uri = attr(line, 'URI');
          if (!uri) unsupported('HLS key URI missing');
          key = { uri: new URL(uri, base).href, iv: attr(line, 'IV') };
        } else throw Object.assign(new Error('EXT-X-KEY METHOD=' + method), { hlsDrm: true });
      } else if (line.startsWith('#EXT-X-MAP:')) {
        const uri = attr(line, 'URI');
        if (!uri) unsupported('HLS init URI missing');
        const url = new URL(uri, base).href;
        const value = attr(line, 'BYTERANGE');
        const nextInit = { url, range: value ? range(value, init && { url: init.url, end: init.range?.end }, url) : null, key };
        if (init && JSON.stringify(init) !== JSON.stringify(nextInit)) unsupported('Changing EXT-X-MAP');
        if (key && !key.iv) unsupported('Encrypted EXT-X-MAP without IV');
        init = nextInit;
      } else if (line.startsWith('#EXT-X-BYTERANGE:')) byteRange = line.slice(line.indexOf(':') + 1);
      else if (line.startsWith('#EXT-X-DISCONTINUITY:') || line === '#EXT-X-DISCONTINUITY') unsupported('EXT-X-DISCONTINUITY');
      else if (line === '#EXT-X-GAP') unsupported('EXT-X-GAP');
      else if (!line.startsWith('#')) {
        const url = new URL(line, base).href;
        const partRange = byteRange ? range(byteRange, previous, url) : null;
        segments.push({ url, key, seq: seq++, range: partRange, start: duration, duration: segmentDuration });
        previous = partRange ? { url, end: partRange.end } : null;
        duration += segmentDuration;
        segmentDuration = 0; byteRange = null;
      }
    }
    return { segments, init, duration };
  }

  function referencedUrls(text, base) {
    const urls = [];
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      const uri = line.startsWith('#EXT-X-MAP:') ? attr(line, 'URI') : !line.startsWith('#') ? line : null;
      if (uri) urls.push(new URL(uri, base).href);
    }
    return [...new Set(urls)];
  }

  function visibleItems(all) {
    const grouped = groupKinescope(all);
    all = grouped.all;
    // Дубль подтверждается содержимым плейлиста, а не названием урока.
    const byContent = new Map(), canonical = new Map(), groups = new Map();
    for (const item of all) {
      const key = item.contentKey ? item.kind + ':' + item.contentKey : null;
      const url = key && byContent.get(key) || item.url;
      if (key) byContent.set(key, url);
      canonical.set(item.url, url);
      if (!groups.has(url)) groups.set(url, []);
      groups.get(url).push(item);
    }
    const children = new Set(), edges = new Map();
    for (const item of all) {
      const parent = canonical.get(item.url);
      if (!edges.has(parent)) edges.set(parent, new Set());
      for (const ref of [...(item.variants || []).map(v => v.url), ...(item.renditions || []).map(r => r.url), ...(item.resources || []), ...(item.groupedUrls || [])]) {
        const url = canonical.get(ref);
        if (url && url !== parent) { children.add(url); edges.get(parent).add(url); }
      }
    }
    return all.filter(v => canonical.get(v.url) === v.url && !children.has(v.url) && !grouped.hidden.has(v.url)).map(item => {
      const descendants = new Set();
      const visit = url => {
        if (descendants.has(url)) return;
        descendants.add(url);
        for (const child of edges.get(url) || []) visit(child);
      };
      visit(item.url);
      const duplicateCount = [...descendants].reduce((n, url) => n + groups.get(url).length - 1, 0);
      return { ...item, mediaType: mediaType(item, all), duplicateCount, relatedCount: descendants.size - 1 };
    });
  }
  function mediaType(item, all = []) {
    if (['audio', 'video', 'av'].includes(item.mediaType)) return item.mediaType;
    if (/^audio\//i.test(item.mime || '')) return 'audio';
    if (all.some(m => (m.renditions || []).some(r => r.type === 'AUDIO' && r.url === item.url))) return 'audio';
    if (item.variants?.length) {
      const best = item.variants.reduce((a, b) => b.bw > a.bw ? b : a);
      const video = !!best.res || /avc|hev|hvc|vp0?[89]|av01/i.test(best.codecs || '');
      const audio = /mp4a|ac-3|ec-3|opus|flac/i.test(best.codecs || '') ||
        (item.renditions || []).some(r => r.type === 'AUDIO' && r.group === best.audio);
      if (video && audio) return 'av';
      if (audio && !video) return 'audio';
      // Наличие разрешения подтверждает изображение, но не отсутствие звука.
    }
    return 'unknown';
  }
  function mediaLabel(type) {
    return ({ audio: '🎵 Только аудио', video: '🎬 Видео без звука', av: '🎬 Видео со звуком' })[type] || '❔ Состав дорожек пока не определён';
  }
  g.Hls = { attr, parseMaster, selectStreams, pickBest, parseMedia, referencedUrls, visibleItems, mediaType, mediaLabel,
    kinescopeInfo, pageSources, allowedPageSource };
})(globalThis);
