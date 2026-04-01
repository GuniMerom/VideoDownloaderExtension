import type { VideoInfo, VideoStream, SubtitleTrack } from '../shared/types';
import type { VideoProvider, ExtractionContext } from './provider-interface';

function generateId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : 'brightcove-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

const BRIGHTCOVE_EMBED_RE = /players\.brightcove\.net\/(\d+)\/([^/]+)\/index\.html\?videoId=(\d+)/;
const BRIGHTCOVE_PLAYER_RE = /players\.brightcove\.net\/(\d+)/;

interface BrightcoveSource {
  src: string;
  type?: string;
  width?: number;
  height?: number;
  avg_bitrate?: number;
  size?: number;
  codec?: string;
  container?: string;
}

interface BrightcoveTextTrack {
  src: string;
  srclang: string;
  label?: string;
  kind?: string;
  mime_type?: string;
}

interface BrightcoveVideoResponse {
  id: string;
  name?: string;
  description?: string;
  duration?: number;
  poster?: string;
  thumbnail?: string;
  sources: BrightcoveSource[];
  text_tracks?: BrightcoveTextTrack[];
}

function extractIdsFromUrl(url: string): { accountId: string; playerId: string; videoId: string } | null {
  const match = url.match(BRIGHTCOVE_EMBED_RE);
  if (match) {
    return { accountId: match[1], playerId: match[2], videoId: match[3] };
  }
  return null;
}

function extractIdsFromPage(doc: Document): { accountId: string; videoId: string } | null {
  // Look for <video-js> element with data attributes
  const videoJs = doc.querySelector('video-js[data-video-id][data-account]');
  if (videoJs) {
    const accountId = videoJs.getAttribute('data-account');
    const videoId = videoJs.getAttribute('data-video-id');
    if (accountId && videoId) {
      return { accountId, videoId };
    }
  }

  // Also check standard video elements
  const video = doc.querySelector('video[data-video-id][data-account]');
  if (video) {
    const accountId = video.getAttribute('data-account');
    const videoId = video.getAttribute('data-video-id');
    if (accountId && videoId) {
      return { accountId, videoId };
    }
  }

  return null;
}

async function fetchPolicyKey(accountId: string, playerId: string): Promise<string> {
  const playerUrl = `https://players.brightcove.net/${accountId}/${playerId}_default/index.min.js`;
  const resp = await fetch(playerUrl);
  if (!resp.ok) {
    throw new Error(`Failed to fetch Brightcove player JS: ${resp.status}`);
  }
  const js = await resp.text();

  // Policy key is embedded in the player JS
  const policyMatch = js.match(/policyKey\s*:\s*["']([^"']+)["']/);
  if (policyMatch) {
    return policyMatch[1];
  }

  // Alternative pattern
  const altMatch = js.match(/policy_key\s*:\s*["']([^"']+)["']/);
  if (altMatch) {
    return altMatch[1];
  }

  throw new Error('Could not extract Brightcove policy key from player JS');
}

function inferFormat(source: BrightcoveSource): string | undefined {
  if (source.container) return source.container.toLowerCase();
  const type = source.type ?? '';
  if (type.includes('mpegurl') || type.includes('hls')) return 'm3u8';
  if (type.includes('dash')) return 'mpd';
  if (type.includes('mp4')) return 'mp4';
  if (source.src.includes('.m3u8')) return 'm3u8';
  if (source.src.includes('.mpd')) return 'mpd';
  if (source.src.includes('.mp4')) return 'mp4';
  return undefined;
}

function inferStreamType(source: BrightcoveSource): 'video' | 'audio' | 'muxed' {
  const type = source.type ?? '';
  if (type.includes('audio')) return 'audio';
  return 'muxed';
}

function subtitleFormat(track: BrightcoveTextTrack): 'vtt' | 'srt' | 'ttml' | 'unknown' {
  const mime = track.mime_type ?? '';
  if (mime.includes('vtt') || track.src.includes('.vtt')) return 'vtt';
  if (mime.includes('srt') || track.src.includes('.srt')) return 'srt';
  if (mime.includes('ttml') || track.src.includes('.ttml')) return 'ttml';
  return 'unknown';
}

const brightcoveProvider: VideoProvider = {
  name: 'brightcove',
  displayName: 'Brightcove',
  version: '1.0.0',

  canHandleUrl(url: string): boolean {
    return BRIGHTCOVE_EMBED_RE.test(url) || BRIGHTCOVE_PLAYER_RE.test(url);
  },

  canHandlePage(document: Document): boolean {
    return !!(
      document.querySelector('video-js[data-video-id][data-account]') ||
      document.querySelector('video[data-video-id][data-account]')
    );
  },

  getEmbedPatterns(): RegExp[] {
    return [BRIGHTCOVE_EMBED_RE];
  },

  async extractVideoInfo(context: ExtractionContext): Promise<VideoInfo> {
    let accountId: string | undefined;
    let videoId: string | undefined;
    let playerId = 'default';

    // Try URL-based extraction first
    const urlIds = extractIdsFromUrl(context.url);
    if (urlIds) {
      accountId = urlIds.accountId;
      playerId = urlIds.playerId;
      videoId = urlIds.videoId;
    }

    // Fall back to page-based extraction
    if ((!accountId || !videoId) && context.document) {
      const pageIds = extractIdsFromPage(context.document);
      if (pageIds) {
        accountId = pageIds.accountId;
        videoId = pageIds.videoId;
      }
    }

    if (!accountId || !videoId) {
      throw new Error('Could not extract Brightcove account/video IDs');
    }

    // Fetch policy key from player JS
    const policyKey = await fetchPolicyKey(accountId, playerId);

    // Fetch video data from Playback API
    const apiUrl = `https://edge.api.brightcove.com/playback/v1/accounts/${accountId}/videos/${videoId}`;
    const resp = await fetch(apiUrl, {
      headers: {
        Accept: `application/json;pk=${policyKey}`,
      },
    });

    if (!resp.ok) {
      throw new Error(`Brightcove API fetch failed: ${resp.status}`);
    }

    const data = (await resp.json()) as BrightcoveVideoResponse;
    const streams: VideoStream[] = [];
    const subtitles: SubtitleTrack[] = [];

    for (const source of data.sources) {
      if (!source.src) continue;
      const format = inferFormat(source);
      streams.push({
        url: source.src,
        quality: source.height ? `${source.height}p` : (format === 'm3u8' ? 'auto (HLS)' : 'unknown'),
        resolution: source.width && source.height ? `${source.width}x${source.height}` : undefined,
        bandwidth: source.avg_bitrate,
        codec: source.codec,
        type: inferStreamType(source),
        format,
        fileSize: source.size,
      });
    }

    if (data.text_tracks) {
      for (const track of data.text_tracks) {
        if (track.kind === 'captions' || track.kind === 'subtitles') {
          subtitles.push({
            url: track.src,
            language: track.srclang,
            label: track.label,
            format: subtitleFormat(track),
          });
        }
      }
    }

    return {
      id: generateId(),
      title: data.name ?? `Brightcove Video ${videoId}`,
      thumbnail: data.poster ?? data.thumbnail,
      duration: data.duration ? data.duration / 1000 : undefined,
      provider: 'brightcove',
      pageUrl: context.pageUrl ?? context.url,
      streams,
      subtitles,
      metadata: { brightcoveAccountId: accountId, brightcoveVideoId: videoId },
    };
  },
};

export default brightcoveProvider;
