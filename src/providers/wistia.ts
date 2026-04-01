import type { VideoInfo, VideoStream } from '../shared/types';
import type { VideoProvider, ExtractionContext } from './provider-interface';

function generateId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : 'wistia-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

const WISTIA_URL_RE = /fast\.wistia\.(?:net|com)\/embed\/iframe\/([a-zA-Z0-9]+)/;
const WISTIA_MEDIAS_RE = /fast\.wistia\.(?:net|com)\/embed\/medias\/([a-zA-Z0-9]+)/;

function extractMediaId(url: string): string | null {
  let match = url.match(WISTIA_URL_RE);
  if (match) return match[1];
  match = url.match(WISTIA_MEDIAS_RE);
  return match ? match[1] : null;
}

interface WistiaAsset {
  url: string;
  contentType: string;
  width: number;
  height: number;
  fileSize: number;
  codec?: string;
  type: string;
  bitrate?: number;
  ext?: string;
}

interface WistiaMedia {
  name?: string;
  duration?: number;
  assets: WistiaAsset[];
  thumbnail?: { url: string };
}

interface WistiaResponse {
  media: WistiaMedia;
}

const wistiaProvider: VideoProvider = {
  name: 'wistia',
  displayName: 'Wistia',
  version: '1.0.0',

  canHandleUrl(url: string): boolean {
    return WISTIA_URL_RE.test(url) || WISTIA_MEDIAS_RE.test(url);
  },

  getEmbedPatterns(): RegExp[] {
    return [WISTIA_URL_RE];
  },

  async extractVideoInfo(context: ExtractionContext): Promise<VideoInfo> {
    const mediaId = extractMediaId(context.url);
    if (!mediaId) {
      throw new Error('Could not extract Wistia media ID from URL');
    }

    const resp = await fetch(`https://fast.wistia.net/embed/medias/${mediaId}.json`);
    if (!resp.ok) {
      throw new Error(`Wistia config fetch failed: ${resp.status}`);
    }

    const data = (await resp.json()) as WistiaResponse;
    const media = data.media;
    const streams: VideoStream[] = [];

    for (const asset of media.assets) {
      // Skip still images and storyboard assets
      if (asset.contentType.startsWith('image/') || asset.type === 'storyboard') {
        continue;
      }

      const isHls = asset.type === 'hls' || asset.contentType === 'application/x-mpegURL';
      const format = isHls
        ? 'm3u8'
        : asset.ext ?? asset.contentType.split('/')[1] ?? 'mp4';

      streams.push({
        url: asset.url,
        quality: asset.type === 'original'
          ? 'original'
          : `${asset.height}p`,
        resolution: `${asset.width}x${asset.height}`,
        bandwidth: asset.bitrate,
        codec: asset.codec,
        type: isHls ? 'muxed' : 'muxed',
        format,
        fileSize: asset.fileSize,
      });
    }

    return {
      id: generateId(),
      title: media.name ?? `Wistia Video ${mediaId}`,
      thumbnail: media.thumbnail?.url,
      duration: media.duration,
      provider: 'wistia',
      pageUrl: context.pageUrl ?? context.url,
      streams,
      subtitles: [],
      metadata: { wistiaId: mediaId },
    };
  },
};

export default wistiaProvider;
