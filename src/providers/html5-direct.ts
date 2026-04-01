import type { VideoInfo, VideoStream } from '../shared/types';
import type { VideoProvider, ExtractionContext } from './provider-interface';

function generateId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : 'html5-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function inferQualityFromUrl(url: string): string {
  const patterns: [RegExp, string][] = [
    [/2160p|3840x2160|4k/i, '2160p'],
    [/1440p|2560x1440/i, '1440p'],
    [/1080p|1920x1080/i, '1080p'],
    [/720p|1280x720/i, '720p'],
    [/480p|854x480/i, '480p'],
    [/360p|640x360/i, '360p'],
    [/240p|426x240/i, '240p'],
    [/144p|256x144/i, '144p'],
  ];
  for (const [re, quality] of patterns) {
    if (re.test(url)) return quality;
  }
  return 'unknown';
}

function getFormatFromUrl(url: string): string | undefined {
  const match = url.match(/\.(mp4|webm|ogg|mov|mkv|m3u8|mpd)(\?|$)/i);
  return match ? match[1].toLowerCase() : undefined;
}

const html5DirectProvider: VideoProvider = {
  name: 'html5-direct',
  displayName: 'HTML5 Video',
  version: '1.0.0',

  canHandleUrl(url: string): boolean {
    return /\.(mp4|webm|ogg|mov)(\?.*)?$/i.test(url);
  },

  canHandlePage(document: Document): boolean {
    const videos = document.querySelectorAll('video');
    return videos.length > 0;
  },

  getEmbedPatterns(): RegExp[] {
    return [];
  },

  async extractVideoInfo(context: ExtractionContext): Promise<VideoInfo> {
    const { url, pageUrl, document: doc } = context;
    const streams: VideoStream[] = [];
    const title = doc?.title ?? pageUrl ?? url;

    if (doc) {
      const videos = doc.querySelectorAll('video');
      videos.forEach((video) => {
        // Collect sources from <source> children
        const sources = video.querySelectorAll('source');
        if (sources.length > 0) {
          sources.forEach((source) => {
            const src = source.getAttribute('src');
            if (!src) return;
            const resolvedUrl = new URL(src, pageUrl ?? url).href;
            const mimeType = source.getAttribute('type') ?? '';
            const format = getFormatFromUrl(resolvedUrl) ?? mimeType.split('/')[1];
            streams.push({
              url: resolvedUrl,
              quality: inferQualityFromUrl(resolvedUrl),
              resolution: video.videoWidth && video.videoHeight
                ? `${video.videoWidth}x${video.videoHeight}`
                : undefined,
              type: 'muxed',
              format,
            });
          });
        }

        // Also check video.src directly
        const directSrc = video.getAttribute('src') ?? video.src;
        if (directSrc && !streams.some((s) => s.url === directSrc)) {
          const resolvedUrl = new URL(directSrc, pageUrl ?? url).href;
          streams.push({
            url: resolvedUrl,
            quality: inferQualityFromUrl(resolvedUrl),
            resolution: video.videoWidth && video.videoHeight
              ? `${video.videoWidth}x${video.videoHeight}`
              : undefined,
            type: 'muxed',
            format: getFormatFromUrl(resolvedUrl),
          });
        }
      });
    } else if (url) {
      // No document context — treat the URL as a direct video
      streams.push({
        url,
        quality: inferQualityFromUrl(url),
        type: 'muxed',
        format: getFormatFromUrl(url),
      });
    }

    return {
      id: generateId(),
      title: typeof title === 'string' ? title : 'HTML5 Video',
      provider: 'html5-direct',
      pageUrl: pageUrl ?? url,
      streams,
      subtitles: [],
      duration: doc
        ? (doc.querySelector('video') as HTMLVideoElement | null)?.duration ?? undefined
        : undefined,
    };
  },
};

export default html5DirectProvider;
