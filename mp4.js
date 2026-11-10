// Перепаковка HLS-сегментов (.ts) в обычный MP4 без перекодирования.
// Используется библиотека mux.js (лицензия Apache-2.0, см. mux.LICENSE.txt).

(function (g) {
  // mux.js не знает длину видео и пишет «неизвестно» — проставляем её сами,
  // чтобы плеер показывал длительность и можно было перематывать.
  function patchDuration(init, seconds) {
    const dv = new DataView(init.buffer, init.byteOffset, init.byteLength);
    let movieScale = 90000;
    (function walk(start, end) {
      for (const { type, body, end: boxEnd } of boxes(init, start, end)) {
        if (type === 'moov' || type === 'trak' || type === 'mdia') walk(body, boxEnd);
        else if (['mvhd', 'tkhd', 'mdhd'].includes(type)) {
          const v1 = init[body] === 1;
          let pos, scale;
          if (type === 'mvhd') {
            movieScale = dv.getUint32(body + (v1 ? 20 : 12));
            pos = body + (v1 ? 24 : 16); scale = movieScale;
          } else if (type === 'tkhd') {
            pos = body + (v1 ? 28 : 20); scale = movieScale;
          } else {
            pos = body + (v1 ? 24 : 16); scale = dv.getUint32(body + (v1 ? 20 : 12));
          }
          const duration = Math.round(seconds * scale);
          if (v1) dv.setBigUint64(pos, BigInt(duration));
          else dv.setUint32(pos, Math.min(0xfffffffe, duration));
        }
      }
    })(0, init.byteLength);
  }

  function boxes(data, start = 0, end = data.length) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const out = [];
    for (let p = start; p < end;) {
      if (p + 8 > end) throw new Error('Truncated MP4 box');
      let size = view.getUint32(p), header = 8;
      if (size === 1) {
        if (p + 16 > end) throw new Error('Truncated MP4 large box');
        size = Number(view.getBigUint64(p + 8)); header = 16;
      } else if (!size) size = end - p;
      if (!Number.isSafeInteger(size) || size < header || p + size > end) throw new Error('Invalid MP4 box size');
      out.push({ type: String.fromCharCode(...data.subarray(p + 4, p + 8)), start: p, body: p + header, end: p + size });
      p += size;
    }
    return out;
  }
  const child = (data, parent, type) => boxes(data, parent.body, parent.end).find(b => b.type === type);
  const bytes = (data, box) => data.slice(box.start, box.end);
  function join(parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let pos = 0;
    for (const p of parts) { out.set(p, pos); pos += p.length; }
    return out;
  }
  function box(type, parts) {
    const body = join(parts), out = new Uint8Array(body.length + 8);
    new DataView(out.buffer).setUint32(0, out.length);
    out.set([...type].map(c => c.charCodeAt(0)), 4); out.set(body, 8);
    return out;
  }
  const dv = data => new DataView(data.buffer, data.byteOffset, data.byteLength);
  // Для поиска достаточно небольшого заголовка; неполный файл не считаем видео без звука.
  function mp4MediaType(input) {
    const data = new Uint8Array(input), view = dv(data);
    try {
      for (let p = 0; p + 8 <= data.length;) {
        let size = view.getUint32(p), header = 8;
        if (size === 1) {
          if (p + 16 > data.length) return 'unknown';
          size = Number(view.getBigUint64(p + 8)); header = 16;
        }
        if (!Number.isSafeInteger(size) || size < header || p + size > data.length) return 'unknown';
        if (String.fromCharCode(...data.subarray(p + 4, p + 8)) === 'moov') {
          const kinds = boxes(data, p + header, p + size).filter(b => b.type === 'trak').map(track => {
            const mdia = child(data, track, 'mdia'), hdlr = mdia && child(data, mdia, 'hdlr');
            return hdlr ? String.fromCharCode(...data.subarray(hdlr.body + 8, hdlr.body + 12)) : '';
          });
          return kinds.includes('vide') ? kinds.includes('soun') ? 'av' : 'video' : kinds.includes('soun') ? 'audio' : 'unknown';
        }
        p += size;
      }
    } catch (e) { /* заголовок ещё не получен целиком */ }
    return 'unknown';
  }
  function movieScale(data, mvhd) {
    return dv(data).getUint32(mvhd.body + (data[mvhd.body] === 1 ? 20 : 12));
  }

  // Объединяем инициализацию дорожек; сами сжатые кадры не изменяются.
  // Фрагменты сохраняют временные метки и относительные смещения moof -> mdat.
  class FragmentedMp4 {
    constructor(inits, seconds) {
      this.maps = []; this.sequence = 0; this.kinds = []; this.stats = new Map();
      let ftyp, mvhd, scale, nextId = 1;
      const tracks = [], defaults = [];
      for (const input of inits) {
        const data = new Uint8Array(input), view = dv(data);
        const top = boxes(data), moov = top.find(b => b.type === 'moov');
        if (!moov) throw new Error('MP4 initialization has no moov');
        const header = child(data, moov, 'mvhd'), mvex = child(data, moov, 'mvex');
        if (!header || !mvex) throw new Error('Expected fragmented MP4');
        const sourceScale = movieScale(data, header);
        if (!ftyp) {
          const type = top.find(b => b.type === 'ftyp');
          if (!type) throw new Error('MP4 initialization has no ftyp');
          ftyp = bytes(data, type); mvhd = bytes(data, header); scale = sourceScale;
        }
        const map = new Map();
        for (const track of boxes(data, moov.body, moov.end).filter(b => b.type === 'trak')) {
          const tkhd = child(data, track, 'tkhd'), mdia = child(data, track, 'mdia');
          const hdlr = mdia && child(data, mdia, 'hdlr');
          if (!tkhd || !hdlr) throw new Error('Invalid MP4 track');
          const idPos = tkhd.body + (data[tkhd.body] === 1 ? 20 : 12);
          const oldId = view.getUint32(idPos), id = nextId++;
          if (map.has(oldId)) throw new Error('Duplicate MP4 track ID');
          map.set(oldId, id);
          const kind = String.fromCharCode(...data.subarray(hdlr.body + 8, hdlr.body + 12));
          this.kinds.push(kind);
          const mdhd = child(data, mdia, 'mdhd');
          if (!mdhd) throw new Error('MP4 track timescale missing');
          const timescale = view.getUint32(mdhd.body + (data[mdhd.body] === 1 ? 20 : 12));
          if (!timescale) throw new Error('Invalid MP4 track timescale');
          this.stats.set(id, { source: this.maps.length, kind, timescale, samples: 0, ticks: 0, first: null, end: null, maxGap: 0 });
          const minf = child(data, mdia, 'minf'), stbl = minf && child(data, minf, 'stbl');
          const stsd = stbl && child(data, stbl, 'stsd');
          if (!stsd) throw new Error('MP4 track has no sample description');
          if (boxes(data, stsd.body + 8, stsd.end).some(b => ['encv', 'enca'].includes(b.type))) {
            throw Object.assign(new Error('Encrypted MP4 sample description'), { hlsDrm: true });
          }
          const copy = bytes(data, track), copyView = dv(copy);
          copyView.setUint32(idPos - track.start, id);
          // tkhd/elst durations use the movie timescale, which may differ between sources.
          const durationPos = tkhd.body + (data[tkhd.body] === 1 ? 28 : 20) - track.start;
          if (data[tkhd.body] === 1) copyView.setBigUint64(durationPos, BigInt(Math.round(Number(copyView.getBigUint64(durationPos)) * scale / sourceScale)));
          else copyView.setUint32(durationPos, Math.round(copyView.getUint32(durationPos) * scale / sourceScale));
          const edts = child(data, track, 'edts'), elst = edts && child(data, edts, 'elst');
          if (elst && scale !== sourceScale) {
            const v1 = data[elst.body] === 1, count = view.getUint32(elst.body + 4);
            for (let n = 0; n < count; n++) {
              const p = elst.body + 8 + n * (v1 ? 20 : 12) - track.start;
              if (v1) copyView.setBigUint64(p, BigInt(Math.round(Number(copyView.getBigUint64(p)) * scale / sourceScale)));
              else copyView.setUint32(p, Math.round(copyView.getUint32(p) * scale / sourceScale));
            }
          }
          tracks.push(copy);
        }
        for (const trex of boxes(data, mvex.body, mvex.end).filter(b => b.type === 'trex')) {
          const copy = bytes(data, trex), id = map.get(view.getUint32(trex.body + 4));
          if (!id) throw new Error('Unknown MP4 trex track');
          this.stats.get(id).defaultDuration = view.getUint32(trex.body + 12);
          this.stats.get(id).defaultSize = view.getUint32(trex.body + 16);
          dv(copy).setUint32(trex.body + 4 - trex.start, id); defaults.push(copy);
        }
        if (defaults.length !== tracks.length) throw new Error('MP4 track defaults missing');
        this.maps.push(map);
      }
      // next_track_ID is the final field of mvhd for both versions.
      dv(mvhd).setUint32(mvhd.length - 4, nextId);
      this.init = join([ftyp, box('moov', [mvhd, ...tracks, box('mvex', defaults)])]);
      if (seconds > 0) patchDuration(this.init, seconds);
    }
    fragment(source, input) {
      const data = new Uint8Array(input).slice(), view = dv(data), map = this.maps[source];
      const top = boxes(data);
      let found = false;
      const mdats = top.filter(b => b.type === 'mdat');
      for (const moof of top.filter(b => b.type === 'moof')) {
        found = true;
        const mfhd = child(data, moof, 'mfhd');
        if (!mfhd) throw new Error('MP4 fragment has no mfhd');
        view.setUint32(mfhd.body + 4, ++this.sequence);
        const trafs = boxes(data, moof.body, moof.end).filter(b => b.type === 'traf');
        if (!trafs.length) throw new Error('MP4 fragment has no tracks');
        for (const traf of trafs) {
          const tfhd = child(data, traf, 'tfhd'), tfdt = child(data, traf, 'tfdt'), trun = child(data, traf, 'trun');
          if (!tfhd || !tfdt || !trun) throw new Error('Incomplete MP4 fragment');
          const flags = view.getUint32(tfhd.body) & 0xffffff;
          if ((flags & 1) || (trafs.length > 1 && !(flags & 0x020000)) || !(view.getUint32(trun.body) & 1)) {
            throw new Error('MP4 fragment requires moof-relative offsets');
          }
          const id = map.get(view.getUint32(tfhd.body + 4));
          if (!id) throw new Error('Unknown MP4 fragment track');
          view.setUint32(tfhd.body + 4, id);
          const stat = this.stats.get(id);
          let p = tfhd.body + 8;
          if (flags & 2) p += 4;
          const defaultDuration = flags & 8 ? view.getUint32(p) : stat.defaultDuration;
          if (flags & 8) p += 4;
          const defaultSize = flags & 16 ? view.getUint32(p) : stat.defaultSize;
          if (flags & 16) p += 4;
          if (flags & 32) p += 4;
          if (p > tfhd.end) throw new Error('Truncated tfhd');
          let time = data[tfdt.body] === 1 ? Number(view.getBigUint64(tfdt.body + 4)) : view.getUint32(tfdt.body + 4);
          if (!Number.isSafeInteger(time)) throw new Error('Invalid MP4 decode timestamp');
          if (stat.end !== null) stat.maxGap = Math.max(stat.maxGap, Math.abs(time - stat.end) / stat.timescale);
          if (stat.first === null) stat.first = time;
          let dataPosition = 0;
          for (const run of boxes(data, traf.body, traf.end).filter(b => b.type === 'trun')) {
            const runFlags = view.getUint32(run.body) & 0xffffff, count = view.getUint32(run.body + 4);
            if (count > 1000000) throw new Error('Invalid MP4 sample count');
            let q = run.body + 8, sampleBytes = 0;
            if (runFlags & 1) { dataPosition = moof.start + view.getInt32(q); q += 4; }
            if (runFlags & 4) q += 4;
            for (let sample = 0; sample < count; sample++) {
              const duration = runFlags & 0x100 ? view.getUint32(q) : defaultDuration;
              if (runFlags & 0x100) q += 4;
              const size = runFlags & 0x200 ? view.getUint32(q) : defaultSize;
              if (runFlags & 0x200) q += 4;
              if (runFlags & 0x400) q += 4;
              if (runFlags & 0x800) q += 4;
              if (q > run.end || !duration || !size) throw new Error('Invalid MP4 sample');
              time += duration; stat.ticks += duration; stat.samples++; sampleBytes += size;
            }
            if (sampleBytes && !mdats.some(m => dataPosition >= m.body && dataPosition + sampleBytes <= m.end)) {
              throw Object.assign(new Error('MP4 fragment sample data is incomplete'), { mediaIncomplete: true });
            }
            dataPosition += sampleBytes;
          }
          stat.end = time;
        }
      }
      if (!found) throw new Error('MP4 media segment has no moof');
      // sidx/mfra refer to offsets in the original separate file and become stale.
      return join(top.filter(b => !['sidx', 'mfra', 'ftyp', 'moov'].includes(b.type)).map(b => bytes(data, b)));
    }
    verify(expectedDurations = []) {
      const incomplete = text => { throw Object.assign(new Error(text), { mediaIncomplete: true }); };
      const tracks = [], warnings = [];
      for (const stat of this.stats.values()) {
        if (!['vide', 'soun'].includes(stat.kind)) continue;
        const duration = stat.ticks / stat.timescale;
        const expected = expectedDurations[stat.source] || 0;
        const tolerance = Math.max(1, Math.min(3, expected * 0.01));
        if (!stat.samples || (expected && Math.abs(duration - expected) > tolerance)) {
          incomplete(`Incomplete ${stat.kind}: ${duration.toFixed(3)}s / expected ${expected.toFixed(3)}s, gap ${stat.maxGap.toFixed(3)}s`);
        }
        if (stat.maxGap > 0.25) warnings.push(`${stat.kind}: разрыв временных меток ${stat.maxGap.toFixed(3)} сек.`);
        tracks.push({ kind: stat.kind, duration, samples: stat.samples, maxGap: stat.maxGap });
      }
      const lengths = tracks.map(t => t.duration);
      if (lengths.length > 1 && Math.max(...lengths) - Math.min(...lengths) > Math.max(1, Math.min(3, Math.max(...lengths) * 0.01))) {
        incomplete('Audio and video durations differ');
      }
      return { tracks, duration: Math.max(0, ...lengths), warnings };
    }
  }

  // seconds — длина видео из плейлиста (сумма #EXTINF), чтобы сразу записать её в заголовок.
  class TsToMp4 {
    constructor(seconds) {
      this.init = null;
      this.parts = [];
      this.t = new g.muxjs.mp4.Transmuxer();
      this.t.on('data', s => {
        if (!this.init) {
          this.init = new Uint8Array(s.initSegment);
          if (seconds > 0) patchDuration(this.init, seconds);
          this.parts.push(this.init);
        }
        this.parts.push(new Uint8Array(s.data));
      });
    }
    // Возвращает false, если из сегмента ничего не получилось.
    push(buf) {
      const before = this.parts.length;
      this.t.push(new Uint8Array(buf));
      this.t.flush();
      return this.parts.length > before;
    }
    // Забрать готовые куски файла (по порядку), чтобы сразу записать их на диск.
    take() {
      const out = this.parts;
      this.parts = [];
      return out;
    }
  }

  g.TsToMp4 = TsToMp4;
  g.FragmentedMp4 = FragmentedMp4;
  g.mp4MediaType = mp4MediaType;
})(globalThis);
