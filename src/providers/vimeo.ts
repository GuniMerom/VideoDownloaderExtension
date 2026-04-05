import type { VideoInfo, VideoStream, SubtitleTrack } from '../shared/types';
import type { VideoProvider, ExtractionContext } from './provider-interface';
import { getAudioRenditionsForGroup, parseMasterPlaylist } from '../core/hls-parser';

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
    // /config endpoint blocked or failed — fall through
  }

  // Strategy 2: Fetch the player page HTML and parse window.playerConfig
  // Note: the service worker can't set Referer (forbidden header), and Vimeo
  // checks Referer for private embeds. This only works if Vimeo doesn't require
  // a specific Referer for this video.
  try {
    const playerUrl = `https://player.vimeo.com/video/${videoId}`;
    const resp = await fetch(playerUrl);
    if (resp.ok) {
      const html = await resp.text();
      const configMatch = html.match(/window\.playerConfig\s*=\s*(\{.*\})/);
      if (configMatch) {
        return JSON.parse(configMatch[1]) as VimeoConfig;
      }
    }
  } catch {
    // HTML fetch failed — fall through
  }

  // Strategy 3: Extract playerConfig from the Vimeo iframe via chrome.scripting.
  // The iframe already has the config loaded in its DOM context.
  // This works for private embeds because the iframe was loaded with the correct
  // Referer by the browser.
  try {
    const config = await extractConfigFromIframe(videoId);
    if (config) return config;
  } catch {
    // Iframe extraction failed — fall through
  }

  throw new Error(
    'Vimeo config fetch failed: video may be private. ' +
    'Ensure the video is playing on the page and try again.',
  );
}

/**
 * Extract window.playerConfig from inside a Vimeo iframe using chrome.scripting.
 * The iframe loaded the config with the correct Referer, so it's available in its DOM.
 */
async function extractConfigFromIframe(videoId: string): Promise<VimeoConfig | null> {
  // Find the tab that has this Vimeo iframe
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id) return null;

  // Execute script inside all frames to find the one with our video
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: (targetVideoId: string) => {
      // Check if this frame is a Vimeo player for our video
      if (!window.location.href.includes('player.vimeo.com')) return null;
      if (!window.location.href.includes(targetVideoId)) return null;

      // Try to get playerConfig from the window object
      const config = (window as unknown as Record<string, unknown>).playerConfig;
      if (config) return JSON.stringify(config);

      // Fallback: parse from script tags in the document
      const scripts = document.querySelectorAll('script');
      for (const script of scripts) {
        const text = script.textContent ?? '';
        const match = text.match(/window\.playerConfig\s*=\s*(\{.*\})/);
        if (match) return match[1];
      }

      return null;
    },
    args: [videoId],
  });

  // Find the result from the Vimeo iframe frame
  for (const result of results) {
    if (result.result) {
      try {
        return JSON.parse(result.result) as VimeoConfig;
      } catch {
        continue;
      }
    }
  }

  return null;
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
    const downloadWarnings: string[] = [];

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

    // HLS master playlist — parse it to extract individual quality variants
    const hls = config.request?.files?.hls;
    if (hls?.cdns) {
      const cdnKey = hls.default_cdn ?? Object.keys(hls.cdns)[0];
      const hlsUrl = hls.cdns[cdnKey]?.url;
      if (hlsUrl) {
        let hasSeparateAudio = false;
        try {
          const masterResp = await fetch(hlsUrl);
          if (masterResp.ok) {
            const masterText = await masterResp.text();
            const master = parseMasterPlaylist(masterText, hlsUrl);
            hasSeparateAudio = master.renditions.some((rendition) => rendition.type === 'AUDIO');

            for (const variant of master.variants) {
              const height = variant.resolution?.split('x')[1];
              streams.push({
                url: variant.url,
                quality: height ? `${height}p` : `${Math.round(variant.bandwidth / 1000)}kbps`,
                resolution: variant.resolution,
                bandwidth: variant.bandwidth,
                codec: variant.codecs,
                type: variant.audio ? 'video' : 'muxed',
                format: 'hls',
                frameRate: variant.frameRate,
                groupId: variant.audio,
              });
            }

            const seenAudioUrls = new Set<string>();
            for (const variant of master.variants) {
              const audioRenditions = getAudioRenditionsForGroup(master, variant.audio);
              for (const audio of audioRenditions) {
                if (!audio.uri || seenAudioUrls.has(audio.uri)) continue;
                seenAudioUrls.add(audio.uri);
                streams.push({
                  url: audio.uri,
                  quality: audio.name,
                  type: 'audio',
                  format: 'hls',
                  groupId: audio.groupId,
                });
              }
            }
          }
        } catch {
          downloadWarnings.push('Could not fully inspect Vimeo HLS variants; using best-effort stream selection.');
        }

        if (!streams.some((stream) => stream.url === hlsUrl)) {
          streams.push({
            url: hlsUrl,
            quality: 'auto (HLS)',
            type: hasSeparateAudio ? 'video' : 'muxed',
            format: 'hls',
          });
        }
      }
    }

    // Note: Vimeo DASH uses a proprietary playlist.json format, not standard MPD.
    // We skip DASH and use HLS instead, which provides the same quality variants.

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
      downloadReadiness: streams.some((stream) => stream.type === 'audio')
        ? 'ready_with_separate_audio_needing_merge'
        : streams.some((stream) => stream.type === 'muxed')
          ? 'ready_with_muxed_output'
          : 'ready_video_only',
      downloadWarnings,
      metadata: { vimeoId: videoId },
    };
  },
};

export default vimeoProvider;
