// Подготовка команд для внешних загрузчиков. Команды выполняются только самим пользователем.
(function (g) {
  const quote = value => "'" + String(value).replace(/'/g, "''") + "'";
  function http(value) {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error('Expected an HTTP video URL');
    return url.href;
  }
  function command(plan) {
    const url = http(plan.videoUrl || plan.url);
    const audio = plan.audioUrl ? http(plan.audioUrl) : null;
    const page = plan.pageUrl ? http(plan.pageUrl) : null;
    const name = (plan.name || 'Видео').replace(/[\\/:*?"<>|\r\n\x00-\x1f]/g, ' ').trim().slice(0, 100) || 'Видео';
    const output = './' + name + (plan.mediaType === 'audio' ? '.m4a' : '.mp4');
    if (audio) {
      const args = ['ffmpeg', '-nostdin', '-n'];
      const input = value => {
        args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
        if (page) args.push('-referer', page);
        args.push('-i', value);
      };
      input(url); input(audio);
      args.push('-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-movflags', '+faststart', output);
      return { tool: 'FFmpeg', text: '& ' + args.map(quote).join(' ') };
    }
    const args = ['yt-dlp', '--ignore-config', '--no-playlist', '--no-overwrites'];
    if (page) args.push('--referer', page);
    if (plan.mediaType !== 'audio') args.push('-f', 'bv*+ba/b', '--merge-output-format', 'mp4');
    args.push('-o', output.replace(/%/g, '%%'), '--', url);
    return { tool: 'yt-dlp и FFmpeg', text: '& ' + args.map(quote).join(' ') };
  }
  g.DownloadFallback = { command };
})(globalThis);
