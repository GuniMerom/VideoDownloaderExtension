import type { VideoInfo, VideoStream } from '../shared/types';
import type { VideoProvider, ExtractionContext } from './provider-interface';

function generateId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : 'hls-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

const M3U8_RE = /\.m3u8(\?|$)/i;

interface HlsVariant {
  url: string;
  bandwidth: number;
  resolution?: string;
  codecs?: string;
  frameRate?: string;
  name?: string;
}

/**
 * Minimal inline HLS master playlist parser.
 * Parses #EXT-X-STREAM-INF lines to extract variant streams.
 */
function parseMasterPlaylist(content: string, baseUrl: string): HlsVariant[] {
  const variants: HlsVariant[] = [];
  const lines = content.split('\n').map((l) => l.trim());

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;

    const attrs = line.substring('#EXT-X-STREAM-INF:'.length);
    const urlLine = lines[i + 1];
    if (!urlLine || urlLine.startsWith('#')) continue;

    const url = resolveUrl(urlLine, baseUrl);
    const bandwidth = parseAttrInt(attrs, 'BANDWIDTH') ?? 0;
    const resolution = parseAttrString(attrs, 'RESOLUTION');
    const codecs = parseAttrString(attrs, 'CODECS');
    const frameRate = parseAttrString(attrs, 'FRAME-RATE');
    const name = parseAttrString(attrs, 'NAME');

    variants.push({ url, bandwidth, resolution, codecs, frameRate, name });
  }

  return variants;
}

/**
 * Check if the playlist is a media playlist (contains segments, not variants).
 */
function isMediaPlaylist(content: string): boolean {
  return content.includes('#EXTINF:') && !content.includes('#EXT-X-STREAM-INF:');
}

/**
 * Count segments in a media playlist for progress tracking.
 */
function countSegments(content: string): number {
  const matches = content.match(/#EXTINF:/g);
  return matches ? matches.length : 0;
}

/**
 * Calculate total duration from a media playlist.
 */
function calculateDuration(content: string): number {
  let totalDuration = 0;
  const matches = content.matchAll(/#EXTINF:([\d.]+)/g);
  for (const m of matches) {
    totalDuration += parseFloat(m[1]);
  }
  return totalDuration;
}

function parseAttrInt(attrs: string, name: string): number | undefined {
  const re = new RegExp(`${name}=(\\d+)`);
  const match = attrs.match(re);
  return match ? parseInt(match[1], 10) : undefined;
}

function parseAttrString(attrs: string, name: string): string | undefined {
  // Try quoted value first: NAME="value"
  const quotedRe = new RegExp(`${name}="([^"]+)"`);
  const quotedMatch = attrs.match(quotedRe);
  if (quotedMatch) return quotedMatch[1];

  // Unquoted value: RESOLUTION=1920x1080
  const unquotedRe = new RegExp(`${name}=([^,\\s]+)`);
  const unquotedMatch = attrs.match(unquotedRe);
  return unquotedMatch ? unquotedMatch[1] : undefined;
}

function resolveUrl(url: string, baseUrl: string): string {
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  try {
    return new URL(url, baseUrl).href;
  } catch {
    return url;
  }
}

function qualityFromVariant(variant: HlsVariant): string {
  if (variant.name) return variant.name;
  if (variant.resolution) {
    const heightMatch = variant.resolution.match(/x(\d+)/);
    if (heightMatch) return `${heightMatch[1]}p`;
  }
  if (variant.bandwidth) {
    const mbps = (variant.bandwidth / 1_000_000).toFixed(1);
    return `${mbps} Mbps`;
  }
  return 'unknown';
}

const hlsGenericProvider: VideoProvider = {
  name: 'hls-generic',
  displayName: 'HLS Stream',
  version: '1.0.0',

  canHandleUrl(url: string): boolean {
    return M3U8_RE.test(url);
  },

  getEmbedPatterns(): RegExp[] {
    return [];
  },

  async extractVideoInfo(context: ExtractionContext): Promise<VideoInfo> {
    const { url, pageUrl } = context;

    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`HLS manifest fetch failed: ${resp.status}`);
    }
    const content = await resp.text();
    const streams: VideoStream[] = [];

    if (isMediaPlaylist(content)) {
      // Single media playlist — one stream, count segments for progress
      const segmentCount = countSegments(content);
      const duration = calculateDuration(content);

      streams.push({
        url,
        quality: 'default',
        type: 'muxed',
        format: 'm3u8',
      });

      return {
        id: generateId(),
        title: titleFromUrl(url),
        duration: duration > 0 ? duration : undefined,
        provider: 'hls-generic',
        pageUrl: pageUrl ?? url,
        streams,
        subtitles: [],
        metadata: { segmentCount, isMediaPlaylist: true },
      };
    }

    // Master playlist — parse variants
    const variants = parseMasterPlaylist(content, url);

    if (variants.length === 0) {
      // Couldn't parse variants, add the manifest as-is
      streams.push({
        url,
        quality: 'auto',
        type: 'muxed',
        format: 'm3u8',
      });
    } else {
      // Sort by bandwidth descending (best quality first)
      variants.sort((a, b) => b.bandwidth - a.bandwidth);

      for (const variant of variants) {
        streams.push({
          url: variant.url,
          quality: qualityFromVariant(variant),
          resolution: variant.resolution,
          bandwidth: variant.bandwidth,
          codec: variant.codecs,
          type: 'muxed',
          format: 'm3u8',
          frameRate: variant.frameRate,
        });
      }
    }

    return {
      id: generateId(),
      title: titleFromUrl(url),
      provider: 'hls-generic',
      pageUrl: pageUrl ?? url,
      streams,
      subtitles: [],
      metadata: { variantCount: variants.length, isMasterPlaylist: true },
    };
  },
};

function titleFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const filename = pathname.split('/').pop() ?? '';
    const name = filename.replace(/\.m3u8$/i, '').replace(/[_-]/g, ' ');
    return name || 'HLS Stream';
  } catch {
    return 'HLS Stream';
  }
}

export default hlsGenericProvider;
