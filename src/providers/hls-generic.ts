import type { VideoInfo, VideoStream } from '../shared/types';
import type { VideoProvider, ExtractionContext } from './provider-interface';
import { getAudioRenditionsForGroup, parseMasterPlaylist as parseMasterPlaylistCore } from '../core/hls-parser';

function generateId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : 'hls-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

const M3U8_RE = /\.m3u8(\?|$)/i;

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

function qualityFromVariant(variant: { resolution?: string; bandwidth: number }): string {
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
    const master = parseMasterPlaylistCore(content, url);
    const variants = master.variants;

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
          type: variant.audio ? 'video' : 'muxed',
          format: 'm3u8',
          frameRate: variant.frameRate,
          groupId: variant.audio,
        });
      }

      const seenAudioUrls = new Set<string>();
      for (const variant of variants) {
        const audioRenditions = getAudioRenditionsForGroup(master, variant.audio);
        for (const audio of audioRenditions) {
          if (!audio.uri || seenAudioUrls.has(audio.uri)) continue;
          seenAudioUrls.add(audio.uri);
          streams.push({
            url: audio.uri,
            quality: audio.name,
            type: 'audio',
            format: 'm3u8',
            groupId: audio.groupId,
          });
        }
      }
    }

    return {
      id: generateId(),
      title: titleFromUrl(url),
      provider: 'hls-generic',
      pageUrl: pageUrl ?? url,
      streams,
      subtitles: [],
      downloadReadiness: streams.some((stream) => stream.type === 'audio')
        ? 'ready_with_separate_audio_needing_merge'
        : streams.some((stream) => stream.type === 'muxed')
          ? 'ready_with_muxed_output'
          : 'ready_video_only',
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
