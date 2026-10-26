# Исследованные решения

Изменения версии 1.7 реализованы в коде этого расширения. Из перечисленных проектов не копировались исходники и не включались исполняемые файлы.

- [GetCoursePythonDownloader](https://github.com/snhplayer/GetCoursePythonDownloader), особенно [сборщик ссылок](https://github.com/snhplayer/GetCoursePythonDownloader/blob/main/gcpd_link_collector.user.js): связь видео и аудио Kinescope по ID ролика. В нашем расширении связь дополнительно ограничивается хостом плеера, дорожки разных роликов не объединяются.
- [HLS Downloader](https://github.com/puemos/hls-downloader): выбор качества и аудиодорожки пользователем. В нашем расширении используется собственная потоковая перепаковка; ffmpeg.wasm не включён.
- [yt-dlp](https://github.com/yt-dlp/yt-dlp): резервная загрузка мастер-плейлиста с выбором видео и аудио. Расширение подготавливает команду PowerShell для установленного пользователем yt-dlp.
- [FFmpeg](https://ffmpeg.org/ffmpeg.html): резервное объединение двух известных плейлистов. Команда явно выбирает видеодорожку первого входа и аудиодорожку второго, использует копирование без перекодирования и не обрезает результат по более короткой дорожке.
- [W3C: ISO BMFF Byte Stream Format](https://www.w3.org/TR/mse-byte-stream-format-isobmff/): структура фрагментов MP4. Проверка полноты опирается на реальные длительности и размеры сжатых кадров в tfhd/trun и временные метки tfdt.

Библиотека mux.js, включённая в расширение ранее, распространяется по Apache-2.0: см. mux.LICENSE.txt.

Версия 1.8 использует стандартные браузерные API для экономного режима:

- [OPFS](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system) и [createWritable](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/createWritable) — временный файл и потоковая запись.
- [Web Locks](https://developer.mozilla.org/en-US/docs/Web/API/LockManager/request) — одна активная экономная загрузка на расширение.
