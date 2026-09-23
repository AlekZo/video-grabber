// Перепаковка HLS-сегментов (.ts) в обычный MP4 без перекодирования.
// Используется библиотека mux.js (лицензия Apache-2.0, см. mux.LICENSE.txt).

(function (g) {
  // mux.js не знает длину видео и пишет «неизвестно» — проставляем её сами,
  // чтобы плеер показывал длительность и можно было перематывать.
  function patchDuration(init, seconds) {
    const dv = new DataView(init.buffer, init.byteOffset, init.byteLength);
    let movieScale = 90000;
    (function walk(start, end) {
      for (let p = start; p + 8 <= end;) {
        const size = dv.getUint32(p);
        if (size < 8) return;
        const type = String.fromCharCode(init[p + 4], init[p + 5], init[p + 6], init[p + 7]);
        const body = p + 8;
        if (type === 'moov' || type === 'trak' || type === 'mdia') walk(body, p + size);
        else if (init[body] === 0) { // только version 0 (32-битные поля)
          if (type === 'mvhd') {
            movieScale = dv.getUint32(body + 12);
            dv.setUint32(body + 16, Math.round(seconds * movieScale));
          } else if (type === 'tkhd') {
            dv.setUint32(body + 20, Math.round(seconds * movieScale));
          } else if (type === 'mdhd') {
            dv.setUint32(body + 16, Math.round(seconds * dv.getUint32(body + 12)));
          }
        }
        p += size;
      }
    })(0, init.byteLength);
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
})(globalThis);
