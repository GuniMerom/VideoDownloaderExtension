import type { VideoInfo, VideoStream } from '../shared/types';
import type { VideoProvider, ExtractionContext } from './provider-interface';

function generateId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : 'cfstream-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

const CF_STREAM_RE = /(?:iframe\.cloudflarestream\.com|customer-[a-zA-Z0-9]+\.cloudflarestream\.com)\/([a-zA-Z0-9]+)/;

function extractVideoId(url: string): string | null {
  const match = url.match(CF_STREAM_RE);
  return match ? match[1] : null;
}

function extractCustomerSubdomain(url: string): string | null {
  const match = url.match(/(customer-[a-zA-Z0-9]+)\.cloudflarestream\.com/);
  return match ? match[1] : null;
}

const cloudflareStreamProvider: VideoProvider = {
  name: 'cloudflare-stream',
  displayName: 'Cloudflare Stream',
  version: '1.0.0',

  canHandleUrl(url: string): boolean {
    return CF_STREAM_RE.test(url);
  },

  getEmbedPatterns(): RegExp[] {
    return [CF_STREAM_RE];
  },

  async extractVideoInfo(context: ExtractionContext): Promise<VideoInfo> {
    const videoId = extractVideoId(context.url);
    if (!videoId) {
      throw new Error('Could not extract Cloudflare Stream video ID from URL');
    }

    const customerSubdomain = extractCustomerSubdomain(context.url);
    const streams: VideoStream[] = [];

    // Build manifest URLs
    const baseHost = customerSubdomain
      ? `${customerSubdomain}.cloudflarestream.com`
      : 'cloudflarestream.com';

    const hlsUrl = `https://${baseHost}/${videoId}/manifest/video.m3u8`;
    const dashUrl = `https://${baseHost}/${videoId}/manifest/video.mpd`;

    // Verify HLS manifest is accessible
    try {
      const hlsResp = await fetch(hlsUrl, { method: 'HEAD' });
      if (hlsResp.ok) {
        streams.push({
          url: hlsUrl,
          quality: 'auto (HLS)',
          type: 'muxed',
          format: 'm3u8',
        });
      }
    } catch {
      // HLS unavailable
    }

    // Verify DASH manifest is accessible
    try {
      const dashResp = await fetch(dashUrl, { method: 'HEAD' });
      if (dashResp.ok) {
        streams.push({
          url: dashUrl,
          quality: 'auto (DASH)',
          type: 'muxed',
          format: 'mpd',
        });
      }
    } catch {
      // DASH unavailable
    }

    // If neither manifest check succeeded, add them anyway (HEAD may be blocked)
    if (streams.length === 0) {
      streams.push(
        { url: hlsUrl, quality: 'auto (HLS)', type: 'muxed', format: 'm3u8' },
        { url: dashUrl, quality: 'auto (DASH)', type: 'muxed', format: 'mpd' },
      );
    }

    return {
      id: generateId(),
      title: `Cloudflare Stream Video ${videoId}`,
      provider: 'cloudflare-stream',
      pageUrl: context.pageUrl ?? context.url,
      streams,
      subtitles: [],
      metadata: { cloudflareVideoId: videoId, customerSubdomain },
    };
  },
};

export default cloudflareStreamProvider;
