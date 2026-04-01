import type { VideoInfo, VideoStream, SubtitleTrack } from '../shared/types';
import type { VideoProvider, ExtractionContext } from './provider-interface';

function generateId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : 'jwplayer-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

const JW_CDN_RE = /cdn\.jwplayer\.com\/(?:manifests|videos)\/([a-zA-Z0-9]+)/;
const JW_PLATFORM_RE = /content\.jwplatform\.com\/(?:manifests|videos)\/([a-zA-Z0-9]+)/;

interface JWSource {
  file?: string;
  src?: string;
  label?: string;
  type?: string;
  width?: number;
  height?: number;
  default?: boolean;
}

interface JWTrack {
  file?: string;
  src?: string;
  label?: string;
  kind?: string;
  language?: string;
  default?: boolean;
}

function inferFormat(url: string, mimeType?: string): string | undefined {
  if (url.includes('.m3u8')) return 'm3u8';
  if (url.includes('.mpd')) return 'mpd';
  if (url.includes('.mp4')) return 'mp4';
  if (url.includes('.webm')) return 'webm';
  if (mimeType) {
    if (mimeType.includes('mpegurl') || mimeType.includes('hls')) return 'm3u8';
    if (mimeType.includes('dash')) return 'mpd';
    if (mimeType.includes('mp4')) return 'mp4';
    if (mimeType.includes('webm')) return 'webm';
  }
  return undefined;
}

function inferStreamType(format?: string): 'video' | 'audio' | 'muxed' {
  if (format === 'm3u8' || format === 'mpd') return 'muxed';
  return 'muxed';
}

function extractSubtitleFormat(url: string): 'vtt' | 'srt' | 'ttml' | 'unknown' {
  if (url.includes('.vtt')) return 'vtt';
  if (url.includes('.srt')) return 'srt';
  if (url.includes('.ttml') || url.includes('.dfxp')) return 'ttml';
  return 'unknown';
}

function extractMediaIdFromUrl(url: string): string | null {
  let match = url.match(JW_CDN_RE);
  if (match) return match[1];
  match = url.match(JW_PLATFORM_RE);
  return match ? match[1] : null;
}

function extractSourcesFromPage(doc: Document): { sources: JWSource[]; tracks: JWTrack[]; title?: string } {
  const sources: JWSource[] = [];
  const tracks: JWTrack[] = [];
  let title: string | undefined;

  // Try to find jwplayer setup config in inline scripts
  const scripts = doc.querySelectorAll('script');
  for (const script of scripts) {
    const text = script.textContent ?? '';

    // Look for jwplayer(...).setup({ ... }) patterns
    const setupMatch = text.match(/jwplayer\s*\([^)]*\)\s*\.setup\s*\(\s*(\{[\s\S]*?\})\s*\)/);
    if (setupMatch) {
      try {
        // Attempt to parse the config — this won't work with non-JSON JS objects,
        // but handles many common cases where the config is JSON-like
        const configText = setupMatch[1]
          .replace(/'/g, '"')
          .replace(/(\w+)\s*:/g, '"$1":')
          .replace(/,\s*}/g, '}')
          .replace(/,\s*]/g, ']');
        const config = JSON.parse(configText) as {
          sources?: JWSource[];
          playlist?: Array<{ sources?: JWSource[]; tracks?: JWTrack[]; title?: string }>;
          tracks?: JWTrack[];
          title?: string;
        };

        if (config.sources) sources.push(...config.sources);
        if (config.tracks) tracks.push(...config.tracks);
        if (config.title) title = config.title;

        if (config.playlist?.length) {
          const item = config.playlist[0];
          if (item.sources) sources.push(...item.sources);
          if (item.tracks) tracks.push(...item.tracks);
          if (item.title) title = item.title;
        }
      } catch {
        // JSON parse may fail on complex JS objects — that's expected
      }
    }

    // Also look for bare source URLs in jwplayer CDN patterns
    const cdnMatches = text.matchAll(/["'](https?:\/\/cdn\.jwplayer\.com\/[^"']+)["']/g);
    for (const m of cdnMatches) {
      if (!sources.some((s) => s.file === m[1])) {
        sources.push({ file: m[1] });
      }
    }
  }

  // Check data-jw-config attribute
  const jwConfigEl = doc.querySelector('[data-jw-config]');
  if (jwConfigEl) {
    try {
      const config = JSON.parse(jwConfigEl.getAttribute('data-jw-config')!) as {
        sources?: JWSource[];
        tracks?: JWTrack[];
        title?: string;
      };
      if (config.sources) sources.push(...config.sources);
      if (config.tracks) tracks.push(...config.tracks);
      if (config.title) title = config.title;
    } catch {
      // ignore parse errors
    }
  }

  return { sources, tracks, title };
}

const jwplayerProvider: VideoProvider = {
  name: 'jwplayer',
  displayName: 'JW Player',
  version: '1.0.0',

  canHandleUrl(url: string): boolean {
    return JW_CDN_RE.test(url) || JW_PLATFORM_RE.test(url);
  },

  canHandlePage(document: Document): boolean {
    // Check for jwplayer script tags
    const scripts = document.querySelectorAll('script[src]');
    for (const s of scripts) {
      const src = s.getAttribute('src') ?? '';
      if (/jwplayer|jwplatform/.test(src)) return true;
    }

    // Check for jwplayer container elements
    if (document.querySelector('[data-jw-config]')) return true;
    if (document.querySelector('.jwplayer, .jw-wrapper')) return true;

    // Check for jwplayer inline setup calls
    const inlineScripts = document.querySelectorAll('script:not([src])');
    for (const s of inlineScripts) {
      if (s.textContent && /jwplayer\s*\(/.test(s.textContent)) return true;
    }

    return false;
  },

  getEmbedPatterns(): RegExp[] {
    return [JW_CDN_RE, JW_PLATFORM_RE];
  },

  async extractVideoInfo(context: ExtractionContext): Promise<VideoInfo> {
    const streams: VideoStream[] = [];
    const subtitles: SubtitleTrack[] = [];
    let title: string | undefined;
    const mediaId = extractMediaIdFromUrl(context.url);

    // If we have a CDN URL, try fetching the manifest/config directly
    if (mediaId) {
      try {
        const configResp = await fetch(
          `https://cdn.jwplayer.com/v2/media/${mediaId}`,
          { headers: { Accept: 'application/json' } },
        );
        if (configResp.ok) {
          const config = (await configResp.json()) as {
            title?: string;
            playlist?: Array<{
              title?: string;
              duration?: number;
              image?: string;
              sources?: Array<{ file: string; type?: string; label?: string; width?: number; height?: number }>;
              tracks?: Array<{ file: string; kind?: string; label?: string; language?: string }>;
            }>;
          };
          const item = config.playlist?.[0];
          title = item?.title ?? config.title;

          if (item?.sources) {
            for (const s of item.sources) {
              const format = inferFormat(s.file, s.type);
              streams.push({
                url: s.file,
                quality: s.label ?? (s.height ? `${s.height}p` : 'unknown'),
                resolution: s.width && s.height ? `${s.width}x${s.height}` : undefined,
                type: inferStreamType(format),
                format,
              });
            }
          }

          if (item?.tracks) {
            for (const t of item.tracks) {
              if (t.kind === 'captions' || t.kind === 'subtitles') {
                subtitles.push({
                  url: t.file,
                  language: t.language ?? 'und',
                  label: t.label,
                  format: extractSubtitleFormat(t.file),
                });
              }
            }
          }
        }
      } catch {
        // Config fetch failed; fall through to page-based extraction
      }
    }

    // Page-based extraction if we have document access and no streams yet
    if (streams.length === 0 && context.document) {
      const pageData = extractSourcesFromPage(context.document);
      title = title ?? pageData.title;

      for (const s of pageData.sources) {
        const fileUrl = s.file ?? s.src;
        if (!fileUrl) continue;
        const format = inferFormat(fileUrl, s.type);
        streams.push({
          url: fileUrl,
          quality: s.label ?? (s.height ? `${s.height}p` : 'unknown'),
          resolution: s.width && s.height ? `${s.width}x${s.height}` : undefined,
          type: inferStreamType(format),
          format,
        });
      }

      for (const t of pageData.tracks) {
        const trackUrl = t.file ?? t.src;
        if (!trackUrl) continue;
        if (t.kind === 'captions' || t.kind === 'subtitles') {
          subtitles.push({
            url: trackUrl,
            language: t.language ?? 'und',
            label: t.label,
            format: extractSubtitleFormat(trackUrl),
          });
        }
      }
    }

    return {
      id: generateId(),
      title: title ?? `JW Player Video${mediaId ? ' ' + mediaId : ''}`,
      provider: 'jwplayer',
      pageUrl: context.pageUrl ?? context.url,
      streams,
      subtitles,
      metadata: mediaId ? { jwMediaId: mediaId } : undefined,
    };
  },
};

export default jwplayerProvider;
