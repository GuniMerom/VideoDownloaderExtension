import type { VideoInfo, VideoStream } from '../shared/types';
import type { VideoProvider, ExtractionContext } from './provider-interface';

function generateId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : 'streamable-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

const STREAMABLE_URL_RE = /streamable\.com\/(?:e\/)?([a-zA-Z0-9]+)/;

function extractVideoId(url: string): string | null {
  const match = url.match(STREAMABLE_URL_RE);
  return match ? match[1] : null;
}

interface StreamableFile {
  url?: string;
  width?: number;
  height?: number;
  framerate?: number;
  bitrate?: number;
  size?: number;
}

interface StreamableResponse {
  title?: string;
  thumbnail_url?: string;
  files?: Record<string, StreamableFile>;
}

const streamableProvider: VideoProvider = {
  name: 'streamable',
  displayName: 'Streamable',
  version: '1.0.0',

  canHandleUrl(url: string): boolean {
    return STREAMABLE_URL_RE.test(url);
  },

  getEmbedPatterns(): RegExp[] {
    return [/streamable\.com\/e\/([a-zA-Z0-9]+)/];
  },

  async extractVideoInfo(context: ExtractionContext): Promise<VideoInfo> {
    const videoId = extractVideoId(context.url);
    if (!videoId) {
      throw new Error('Could not extract Streamable video ID from URL');
    }

    const resp = await fetch(`https://api.streamable.com/videos/${videoId}`);
    if (!resp.ok) {
      throw new Error(`Streamable API fetch failed: ${resp.status}`);
    }

    const data = (await resp.json()) as StreamableResponse;
    const streams: VideoStream[] = [];

    if (data.files) {
      // Known quality keys in order of preference
      const qualityMap: Record<string, string> = {
        'mp4': 'original',
        'mp4-mobile': 'mobile',
        'mp4-hd': 'hd',
      };

      for (const [key, file] of Object.entries(data.files)) {
        if (!file.url) continue;
        const fileUrl = file.url.startsWith('//') ? `https:${file.url}` : file.url;
        streams.push({
          url: fileUrl,
          quality: qualityMap[key] ?? key,
          resolution: file.width && file.height ? `${file.width}x${file.height}` : undefined,
          bandwidth: file.bitrate,
          type: 'muxed',
          format: 'mp4',
          fileSize: file.size,
          frameRate: file.framerate ? String(file.framerate) : undefined,
        });
      }
    }

    return {
      id: generateId(),
      title: data.title ?? `Streamable Video ${videoId}`,
      thumbnail: data.thumbnail_url,
      provider: 'streamable',
      pageUrl: context.pageUrl ?? context.url,
      streams,
      subtitles: [],
      metadata: { streamableId: videoId },
    };
  },
};

export default streamableProvider;
