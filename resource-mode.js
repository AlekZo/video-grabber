// Экономный режим: настройки, очередь в одной вкладке и временный файл вместо RAM.
(function (g) {
  const settings = enabled => ({ enabled: !!enabled, parallel: enabled ? 2 : 6,
    maxHeight: enabled ? 720 : null, maxPartBytes: enabled ? 32 * 1024 * 1024 : Infinity });
  function jobParams(item, name, options = {}) {
    const q = new URLSearchParams({ src: item.url, kind: item.kind || 'hls', name,
      media: item.mediaType || 'unknown', low: options.enabled ? '1' : '0' });
    for (const [key, value] of Object.entries({ audio: item.audioUrl, video: item.videoUrl, page: item.pageUrl,
      batch: options.batch, index: options.index, destination: options.destination })) {
      if (value !== undefined && value !== null && value !== '') q.set(key, value);
    }
    return q;
  }
  class DiskSpool {
    static async open(storage, cleanStale = false) {
      if (!storage?.getDirectory) throw new Error('Disk buffering is unavailable');
      const root = await storage.getDirectory();
      const dir = await root.getDirectoryHandle('video-grabber-low-resource-v1', { create: true });
      if (cleanStale && dir.values) {
        for await (const entry of dir.values()) {
          if (entry.kind === 'file' && /^job-[0-9a-f-]{36}\.part$/i.test(entry.name)) {
            await dir.removeEntry(entry.name).catch(e => { if (!['NotFoundError', 'NoModificationAllowedError'].includes(e.name)) throw e; });
          }
        }
      }
      const name = 'job-' + crypto.randomUUID() + '.part';
      const handle = await dir.getFileHandle(name, { create: true });
      try {
        if (typeof handle.createWritable !== 'function') throw new Error('Disk buffering is unavailable');
        const writable = await handle.createWritable();
        return new DiskSpool(dir, name, handle, writable);
      } catch (e) { await dir.removeEntry(name).catch(() => {}); throw e; }
    }
    constructor(dir, name, handle, writable) {
      Object.assign(this, { dir, name, handle, writable, closed: false, closing: null, disposed: false });
    }
    async file() {
      if (!this.closing) this.closing = this.writable.close().then(() => { this.closed = true; });
      await this.closing;
      return this.handle.getFile();
    }
    async copyTo(writable, onProgress = () => {}) {
      const file = await this.file(), reader = file.stream().getReader();
      let copied = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          await writable.write(value);
          copied += value.byteLength;
          onProgress(copied, file.size);
        }
      } finally { reader.releaseLock(); }
    }
    async dispose() {
      if (this.disposed) return;
      if (this.closing) await this.closing.catch(() => {});
      if (!this.closed) await this.writable.abort().catch(() => {});
      await this.dir.removeEntry(this.name).catch(e => { if (e.name !== 'NotFoundError') throw e; });
      this.disposed = true;
    }
  }
  async function serial(locks, work, onWaiting = () => {}) {
    if (!locks?.request) throw new Error('Download queue is unavailable');
    onWaiting();
    return locks.request('video-grabber-low-resource-download', { mode: 'exclusive' }, work);
  }
  g.ResourceMode = { settings, jobParams, DiskSpool, serial };
})(globalThis);
