import type { VideoInfo, VideoStream } from '../shared/types';
import type { VideoProvider, ExtractionContext } from './provider-interface';

function generateId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : 'dailymotion-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

const DAILYMOTION_URL_RE = /dailymotion\.com\/(?:embed\/)?video\/([a-zA-Z0-9]+)/;
const DAILYMOTION_SHORT_RE = /dai\.ly\/([a-zA-Z0-9]+)/;

function extractVideoId(url: string): string | null {
  let match = url.match(DAILYMOTION_URL_RE);
  if (match) return match[1];
  match = url.match(DAILYMOTION_SHORT_RE);
  return match ? match[1] : null;
}

interface DailymotionQuality {
  url?: string;
  type?: string;
}

interface DailymotionMetadata {
  title?: string;
  duration?: number;
  poster_url?: string;
  qualities?: Record<string, DailymotionQuality[]>;
}

const dailymotionProvider: VideoProvider = {
  name: 'dailymotion',
  displayName: 'Dailymotion',
  version: '1.0.0',

  canHandleUrl(url: string): boolean {
    return DAILYMOTION_URL_RE.test(url) || DAILYMOTION_SHORT_RE.test(url);
  },

  getEmbedPatterns(): RegExp[] {
    return [/dailymotion\.com\/embed\/video\/([a-zA-Z0-9]+)/];
  },

  async extractVideoInfo(context: ExtractionContext): Promise<VideoInfo> {
    const videoId = extractVideoId(context.url);
    if (!videoId) {
      throw new Error('Could not extract Dailymotion video ID from URL');
    }

    const metadataUrl = `https://www.dailymotion.com/player/metadata/video/${videoId}`;
    const resp = await fetch(metadataUrl);
    if (!resp.ok) {
      throw new Error(`Dailymotion metadata fetch failed: ${resp.status}`);
    }

    const data = (await resp.json()) as DailymotionMetadata;
    const streams: VideoStream[] = [];

    if (data.qualities) {
      // Quality keys are like "auto", "144", "240", "380", "480", "720", "1080"
      for (const [qualityKey, entries] of Object.entries(data.qualities)) {
        for (const entry of entries) {
          if (!entry.url) continue;

          const isHls = entry.type === 'application/x-mpegURL' || entry.url.includes('.m3u8');
          const format = isHls ? 'm3u8' : 'mp4';

          // Map resolution from quality key
          const heightNum = parseInt(qualityKey, 10);
          const resolution = !isNaN(heightNum) ? inferResolution(heightNum) : undefined;

          streams.push({
            url: entry.url,
            quality: qualityKey === 'auto' ? 'auto (HLS)' : `${qualityKey}p`,
            resolution,
            type: 'muxed',
            format,
          });
        }
      }
    }

    return {
      id: generateId(),
      title: data.title ?? `Dailymotion Video ${videoId}`,
      thumbnail: data.poster_url,
      duration: data.duration,
      provider: 'dailymotion',
      pageUrl: context.pageUrl ?? context.url,
      streams,
      subtitles: [],
      metadata: { dailymotionId: videoId },
    };
  },
};

function inferResolution(height: number): string {
  const widthMap: Record<number, number> = {
    2160: 3840,
    1440: 2560,
    1080: 1920,
    720: 1280,
    480: 854,
    380: 640,
    360: 640,
    240: 426,
    144: 256,
  };
  const width = widthMap[height] ?? Math.round(height * (16 / 9));
  return `${width}x${height}`;
}

export default dailymotionProvider;
