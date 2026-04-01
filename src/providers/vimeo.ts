import type { VideoInfo, VideoStream, SubtitleTrack } from '../shared/types';
import type { VideoProvider, ExtractionContext } from './provider-interface';

function generateId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : 'vimeo-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

const VIMEO_URL_RE = /(?:player\.)?vimeo\.com\/(?:video\/)?(\d+)/;
const VIMEO_EMBED_RE = /player\.vimeo\.com\/video\/(\d+)/;

function extractVideoId(url: string): string | null {
  const match = url.match(VIMEO_URL_RE);
  return match ? match[1] : null;
}

interface VimeoProgressive {
  url: string;
  quality: string;
  width: number;
  height: number;
  fps: number;
  mime: string;
}

interface VimeoTextTrack {
  url: string;
  lang: string;
  label: string;
  kind: string;
}

interface VimeoConfig {
  video?: {
    id?: number;
    title?: string;
    duration?: number;
    width?: number;
    height?: number;
    thumbs?: Record<string, string>;
  };
  request?: {
    files?: {
      progressive?: VimeoProgressive[];
      hls?: {
        cdns?: Record<string, { url: string }>;
        default_cdn?: string;
      };
      dash?: {
        cdns?: Record<string, { url?: string; avc_url?: string }>;
        default_cdn?: string;
      };
    };
    text_tracks?: VimeoTextTrack[];
  };
}

async function fetchConfig(videoId: string, pageUrl?: string): Promise<VimeoConfig> {
  // Strategy 1: Try the /config API endpoint (works for public videos)
  try {
    const resp = await fetch(`https://player.vimeo.com/video/${videoId}/config`, {
      headers: { Accept: 'application/json' },
    });
    if (resp.ok) {
      return resp.json() as Promise<VimeoConfig>;
    }
  } catch {
    // /config endpoint blocked or failed — fall through to Strategy 2
  }

  // Strategy 2: Fetch the player page HTML and parse window.playerConfig
  // This works for private/embedded videos when we set the correct Referer
  const referer = pageUrl ?? 'https://vimeo.com/';
  const playerUrl = `https://player.vimeo.com/video/${videoId}`;
  const resp = await fetch(playerUrl, {
    headers: {
      Referer: referer,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  });
  if (!resp.ok) {
    throw new Error(`Vimeo player page fetch failed: ${resp.status}`);
  }

  const html = await resp.text();
  const configMatch = html.match(/window\.playerConfig\s*=\s*(\{.*\})/);
  if (!configMatch) {
    throw new Error('Could not find playerConfig in Vimeo player page');
  }

  try {
    return JSON.parse(configMatch[1]) as VimeoConfig;
  } catch {
    throw new Error('Failed to parse Vimeo playerConfig JSON');
  }
}

const vimeoProvider: VideoProvider = {
  name: 'vimeo',
  displayName: 'Vimeo',
  version: '1.0.0',

  canHandleUrl(url: string): boolean {
    return VIMEO_URL_RE.test(url);
  },

  getEmbedPatterns(): RegExp[] {
    return [VIMEO_EMBED_RE];
  },

  async extractVideoInfo(context: ExtractionContext): Promise<VideoInfo> {
    const videoId = extractVideoId(context.url);
    if (!videoId) {
      throw new Error('Could not extract Vimeo video ID from URL');
    }

    const config = await fetchConfig(videoId, context.pageUrl);
    const streams: VideoStream[] = [];
    const subtitles: SubtitleTrack[] = [];

    // Progressive MP4 streams
    const progressive = config.request?.files?.progressive ?? [];
    for (const p of progressive) {
      streams.push({
        url: p.url,
        quality: p.quality || `${p.height}p`,
        resolution: `${p.width}x${p.height}`,
        type: 'muxed',
        format: 'mp4',
        frameRate: p.fps ? String(p.fps) : undefined,
      });
    }

    // HLS master playlist
    const hls = config.request?.files?.hls;
    if (hls?.cdns) {
      const cdnKey = hls.default_cdn ?? Object.keys(hls.cdns)[0];
      const hlsUrl = hls.cdns[cdnKey]?.url;
      if (hlsUrl) {
        streams.push({
          url: hlsUrl,
          quality: 'auto (HLS)',
          type: 'muxed',
          format: 'hls',
        });
      }
    }

    // DASH streams (common for private/embedded videos)
    const dash = config.request?.files?.dash;
    if (dash?.cdns) {
      const cdnKey = dash.default_cdn ?? Object.keys(dash.cdns)[0];
      const cdn = dash.cdns[cdnKey];
      const dashUrl = cdn?.avc_url ?? cdn?.url;
      if (dashUrl) {
        const resolution = config.video?.width && config.video?.height
          ? `${config.video.width}x${config.video.height}`
          : undefined;
        streams.push({
          url: dashUrl,
          quality: resolution ? `${config.video!.height}p (DASH)` : 'auto (DASH)',
          resolution,
          type: 'muxed',
          format: 'dash',
        });
      }
    }

    // Text tracks / subtitles
    const textTracks = config.request?.text_tracks ?? [];
    for (const t of textTracks) {
      const trackUrl = t.url.startsWith('http')
        ? t.url
        : `https://player.vimeo.com${t.url}`;
      subtitles.push({
        url: trackUrl,
        language: t.lang,
        label: t.label,
        format: 'vtt',
        isAutoGenerated: t.kind === 'asr' ? true : t.kind === 'captions' ? false : undefined,
      });
    }

    // Thumbnail — pick the largest available
    let thumbnail: string | undefined;
    const thumbs = config.video?.thumbs;
    if (thumbs) {
      thumbnail = thumbs['1280'] ?? thumbs['960'] ?? thumbs['640'] ?? thumbs['base'] ?? Object.values(thumbs)[0];
    }

    return {
      id: generateId(),
      title: config.video?.title ?? `Vimeo Video ${videoId}`,
      thumbnail,
      duration: config.video?.duration,
      provider: 'vimeo',
      pageUrl: context.pageUrl ?? context.url,
      streams,
      subtitles,
      metadata: { vimeoId: videoId },
    };
  },
};

export default vimeoProvider;
