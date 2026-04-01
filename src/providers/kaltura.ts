import type { VideoInfo, VideoStream, SubtitleTrack } from '../shared/types';
import type { VideoProvider, ExtractionContext } from './provider-interface';

function generateId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : 'kaltura-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

// cdnapisec.kaltura.com/p/{PARTNER_ID}/sp/...  or  *.kaltura.com/p/{PARTNER_ID}/...
const KALTURA_URL_RE =
  /(?:cdnapisec\.)?kaltura\.com\/p\/(\d+)(?:\/sp\/\d+)?/i;
const KALTURA_ENTRY_RE = /entry_?[Ii]d[/=]([0-9a-z_]+)/i;
const KAF_RE = /kaf\.[^/]+/i;

const KALTURA_EMBED_RE =
  /(?:cdnapisec\.)?kaltura\.com\/p\/(\d+)\/(?:sp\/\d+\/)?embedIframeJs/i;

function extractPartnerId(url: string): string | null {
  const m = url.match(KALTURA_URL_RE);
  return m ? m[1] : null;
}

function extractEntryId(url: string): string | null {
  const m = url.match(KALTURA_ENTRY_RE);
  return m ? m[1] : null;
}

interface KalturaIframeData {
  entryResult?: {
    meta?: {
      name?: string;
      duration?: number;
      thumbnailUrl?: string;
    };
    contextData?: {
      flavorAssets?: Array<{
        id: string;
        width?: number;
        height?: number;
        bitrate?: number;
        fileExt?: string;
        isOriginal?: boolean;
      }>;
    };
  };
  partnerId?: number;
  entryId?: string;
}

interface KalturaTextTrack {
  language: string;
  label: string;
  url: string;
  isDefault?: boolean;
}

function buildManifestUrl(partnerId: string, entryId: string): string {
  return (
    `https://cdnapisec.kaltura.com/p/${partnerId}` +
    `/sp/${partnerId}00/playManifest/entryId/${entryId}` +
    `/format/applehttp/protocol/https/a.m3u8`
  );
}

async function tryFetchEmbedPage(
  url: string,
): Promise<KalturaIframeData | null> {
  try {
    const resp = await fetch(url, { credentials: 'include' });
    if (!resp.ok) return null;
    const html = await resp.text();

    const iframeMatch = html.match(
      /kalturaIframePackageData\s*=\s*(\{[\s\S]*?\});?\s*<\/script/,
    );
    if (iframeMatch) {
      return JSON.parse(iframeMatch[1]) as KalturaIframeData;
    }

    const kWidgetMatch = html.match(
      /kWidget\.(?:thumb)?embed\s*\(\s*(\{[\s\S]*?\})\s*\)/,
    );
    if (kWidgetMatch) {
      return JSON.parse(kWidgetMatch[1]) as KalturaIframeData;
    }
  } catch {
    // ignore fetch / parse errors
  }
  return null;
}

function parseSubtitlesFromConfig(
  iframeData: KalturaIframeData,
): SubtitleTrack[] {
  const tracks: SubtitleTrack[] = [];
  const raw = (iframeData as Record<string, unknown>)['closedCaptions'] as
    | KalturaTextTrack[]
    | undefined;
  if (!Array.isArray(raw)) return tracks;
  for (const t of raw) {
    if (!t.url) continue;
    tracks.push({
      url: t.url,
      language: t.language ?? 'und',
      label: t.label,
      format: t.url.endsWith('.srt') ? 'srt' : 'vtt',
    });
  }
  return tracks;
}

const kalturaProvider: VideoProvider = {
  name: 'kaltura',
  displayName: 'Kaltura',
  version: '1.0.0',

  canHandleUrl(url: string): boolean {
    return KALTURA_URL_RE.test(url) || KAF_RE.test(url);
  },

  getEmbedPatterns(): RegExp[] {
    return [KALTURA_EMBED_RE];
  },

  async extractVideoInfo(context: ExtractionContext): Promise<VideoInfo> {
    const { url, pageUrl } = context;

    const partnerId = extractPartnerId(url);
    const entryId = extractEntryId(url);

    if (!partnerId) {
      throw new Error('Could not extract Kaltura partner ID from URL');
    }
    if (!entryId) {
      throw new Error('Could not extract Kaltura entry ID from URL');
    }

    const streams: VideoStream[] = [];
    const subtitles: SubtitleTrack[] = [];
    let title: string | undefined;
    let duration: number | undefined;
    let thumbnail: string | undefined;

    // Try to fetch embed page for rich metadata
    const iframeData = await tryFetchEmbedPage(url);

    if (iframeData) {
      const meta = iframeData.entryResult?.meta;
      title = meta?.name;
      duration = meta?.duration;
      thumbnail = meta?.thumbnailUrl;

      // Build direct MP4 streams from flavor assets
      const flavors =
        iframeData.entryResult?.contextData?.flavorAssets ?? [];
      for (const flavor of flavors) {
        if (flavor.isOriginal) continue;
        const flavorUrl =
          `https://cdnapisec.kaltura.com/p/${partnerId}` +
          `/sp/${partnerId}00/playManifest/entryId/${entryId}` +
          `/flavorId/${flavor.id}/format/url/protocol/https/a.${flavor.fileExt ?? 'mp4'}`;

        streams.push({
          url: flavorUrl,
          quality: flavor.height ? `${flavor.height}p` : 'unknown',
          resolution:
            flavor.width && flavor.height
              ? `${flavor.width}x${flavor.height}`
              : undefined,
          bandwidth: flavor.bitrate ? flavor.bitrate * 1000 : undefined,
          type: 'muxed',
          format: flavor.fileExt ?? 'mp4',
        });
      }

      subtitles.push(...parseSubtitlesFromConfig(iframeData));
    }

    // Always add the HLS manifest as a stream option
    const hlsUrl = buildManifestUrl(partnerId, entryId);
    streams.push({
      url: hlsUrl,
      quality: 'auto (HLS)',
      type: 'muxed',
      format: 'm3u8',
    });

    if (!thumbnail) {
      thumbnail =
        `https://cdnapisec.kaltura.com/p/${partnerId}` +
        `/sp/${partnerId}00/thumbnail/entry_id/${entryId}/width/640`;
    }

    return {
      id: generateId(),
      title: title ?? `Kaltura Video ${entryId}`,
      thumbnail,
      duration,
      provider: 'kaltura',
      pageUrl: pageUrl ?? url,
      streams,
      subtitles,
      metadata: { partnerId, entryId },
    };
  },
};

export default kalturaProvider;
