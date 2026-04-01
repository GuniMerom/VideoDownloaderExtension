import type { VideoInfo, VideoStream, SubtitleTrack } from '../shared/types';
import type { VideoProvider, ExtractionContext } from './provider-interface';

function generateId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : 'panopto-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

// Matches both hosted and self-hosted Panopto instances
const PANOPTO_URL_RE =
  /([^/]+)\/Panopto\/Pages\/(?:Embed|Viewer)\.aspx/i;

const PANOPTO_EMBED_RE =
  /([^/]+)\/Panopto\/Pages\/Embed\.aspx/i;

function extractHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    const m = url.match(/https?:\/\/([^/]+)/);
    return m ? m[1] : null;
  }
}

function extractSessionId(url: string): string | null {
  try {
    const u = new URL(url);
    return u.searchParams.get('id') ?? u.searchParams.get('Id') ?? null;
  } catch {
    const m = url.match(/[?&]id=([a-f0-9-]+)/i);
    return m ? m[1] : null;
  }
}

interface PanoptoSubtitle {
  Url: string;
  Language: string;
  Label?: string;
}

interface PanoptoStream {
  StreamUrl: string;
  StreamHttpUrl?: string;
  ViewerMediaFileTypeName?: string;
  Tag?: string;
  Width?: number;
  Height?: number;
  Subtitles?: PanoptoSubtitle[];
}

interface PanoptoDeliveryInfo {
  Delivery?: {
    SessionName?: string;
    Duration?: number;
    ThumbnailUrl?: string;
    Streams?: PanoptoStream[];
  };
}

async function fetchDeliveryInfo(
  host: string,
  sessionId: string,
): Promise<PanoptoDeliveryInfo> {
  const apiUrl = `https://${host}/Panopto/Pages/Viewer/DeliveryInfo.aspx`;

  const resp = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      deliveryId: sessionId,
      invocationId: '',
      isLiveNotes: 'false',
      refreshAuthCookie: 'true',
      isActiveBroadcast: 'false',
      isEditing: 'false',
      isKoll498: 'false',
      isEmbed: 'true',
      responseType: 'json',
    }),
    credentials: 'include',
  });

  if (!resp.ok) {
    throw new Error(
      `Panopto delivery info fetch failed: ${resp.status}. The video may require authentication.`,
    );
  }

  return (await resp.json()) as PanoptoDeliveryInfo;
}

const panoptoProvider: VideoProvider = {
  name: 'panopto',
  displayName: 'Panopto',
  version: '1.0.0',

  canHandleUrl(url: string): boolean {
    return PANOPTO_URL_RE.test(url);
  },

  getEmbedPatterns(): RegExp[] {
    return [PANOPTO_EMBED_RE];
  },

  async extractVideoInfo(context: ExtractionContext): Promise<VideoInfo> {
    const { url, pageUrl } = context;

    const host = extractHost(url);
    if (!host) {
      throw new Error('Could not extract Panopto host from URL');
    }

    const sessionId = extractSessionId(url);
    if (!sessionId) {
      throw new Error(
        'Could not extract Panopto session ID from URL. Expected ?id= parameter.',
      );
    }

    const info = await fetchDeliveryInfo(host, sessionId);
    const delivery = info.Delivery;

    if (!delivery?.Streams || delivery.Streams.length === 0) {
      throw new Error(
        'No streams found in Panopto delivery info. The video may require authentication.',
      );
    }

    const streams: VideoStream[] = [];
    const subtitles: SubtitleTrack[] = [];

    for (const stream of delivery.Streams) {
      const streamUrl = stream.StreamUrl || stream.StreamHttpUrl;
      if (!streamUrl) continue;

      const isHls =
        streamUrl.includes('.m3u8') ||
        stream.ViewerMediaFileTypeName === 'HLS';
      const format = isHls ? 'm3u8' : 'mp4';
      const tag = stream.Tag ?? stream.ViewerMediaFileTypeName ?? '';

      streams.push({
        url: streamUrl,
        quality: tag
          ? `${tag}${stream.Height ? ` (${stream.Height}p)` : ''}`
          : stream.Height
            ? `${stream.Height}p`
            : 'default',
        resolution:
          stream.Width && stream.Height
            ? `${stream.Width}x${stream.Height}`
            : undefined,
        type: 'muxed',
        format,
      });

      // Subtitles attached to this stream
      if (stream.Subtitles) {
        for (const sub of stream.Subtitles) {
          if (!sub.Url) continue;
          const subUrl = sub.Url.startsWith('http')
            ? sub.Url
            : `https://${host}${sub.Url}`;

          if (subtitles.some((s) => s.url === subUrl)) continue;
          subtitles.push({
            url: subUrl,
            language: sub.Language ?? 'en',
            label: sub.Label,
            format: sub.Url.endsWith('.srt') ? 'srt' : 'vtt',
          });
        }
      }
    }

    let thumbnail = delivery.ThumbnailUrl;
    if (thumbnail && !thumbnail.startsWith('http')) {
      thumbnail = `https://${host}${thumbnail}`;
    }

    return {
      id: generateId(),
      title: delivery.SessionName ?? `Panopto Video ${sessionId}`,
      thumbnail,
      duration: delivery.Duration,
      provider: 'panopto',
      pageUrl: pageUrl ?? url,
      streams,
      subtitles,
      metadata: { panoptoHost: host, sessionId },
    };
  },
};

export default panoptoProvider;
