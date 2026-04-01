import type { VideoInfo, VideoStream, SubtitleTrack } from '../shared/types';
import type { VideoProvider, ExtractionContext } from './provider-interface';

function generateId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : 'vidyard-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

const VIDYARD_PLAY_RE = /play\.vidyard\.com\/([a-zA-Z0-9]+)/;
const VIDYARD_EMBED_RE = /embed\.vidyard\.com\/share\/([a-zA-Z0-9]+)/;
const VIDYARD_WATCH_RE = /vidyard\.com\/watch\/([a-zA-Z0-9]+)/;
const VIDYARD_UUID_RE =
  /(?:play|embed)\.vidyard\.com\/(?:share\/|player\/)?([a-zA-Z0-9]+)|vidyard\.com\/watch\/([a-zA-Z0-9]+)/;

function extractUuid(url: string): string | null {
  const m = url.match(VIDYARD_UUID_RE);
  if (!m) return null;
  return m[1] ?? m[2] ?? null;
}

interface VidyardSource {
  profile: string;
  url: string;
  mimeType: string;
  width?: number;
  height?: number;
}

interface VidyardCaption {
  language: string;
  name: string;
  vttUrl: string;
  isDefault?: boolean;
}

interface VidyardChapter {
  sources: VidyardSource[];
  captions?: VidyardCaption[];
  title?: string;
  description?: string;
  duration?: number;
  imageUrl?: string;
}

interface VidyardPayload {
  chapters: VidyardChapter[];
  name?: string;
  description?: string;
  length_in_seconds?: number;
}

interface VidyardPlayerJson {
  payload: VidyardPayload;
}

const vidyardProvider: VideoProvider = {
  name: 'vidyard',
  displayName: 'Vidyard',
  version: '1.0.0',

  canHandleUrl(url: string): boolean {
    return (
      VIDYARD_PLAY_RE.test(url) ||
      VIDYARD_EMBED_RE.test(url) ||
      VIDYARD_WATCH_RE.test(url)
    );
  },

  getEmbedPatterns(): RegExp[] {
    return [VIDYARD_PLAY_RE, VIDYARD_EMBED_RE];
  },

  async extractVideoInfo(context: ExtractionContext): Promise<VideoInfo> {
    const uuid = extractUuid(context.url);
    if (!uuid) {
      throw new Error('Could not extract Vidyard UUID from URL');
    }

    const resp = await fetch(
      `https://play.vidyard.com/player/${uuid}.json`,
      { headers: { Accept: 'application/json' } },
    );
    if (!resp.ok) {
      throw new Error(`Vidyard config fetch failed: ${resp.status}`);
    }

    const data = (await resp.json()) as VidyardPlayerJson;
    const payload = data.payload;
    const streams: VideoStream[] = [];
    const subtitles: SubtitleTrack[] = [];

    let thumbnail: string | undefined;
    let totalDuration = 0;

    for (const chapter of payload.chapters) {
      if (!thumbnail && chapter.imageUrl) {
        thumbnail = chapter.imageUrl;
      }
      if (chapter.duration) {
        totalDuration += chapter.duration;
      }

      for (const source of chapter.sources) {
        const heightMatch = source.profile.match(/(\d+)p?/);
        const height = heightMatch ? parseInt(heightMatch[1], 10) : undefined;

        streams.push({
          url: source.url,
          quality: source.profile,
          resolution:
            source.width && source.height
              ? `${source.width}x${source.height}`
              : height
                ? `${Math.round((height * 16) / 9)}x${height}`
                : undefined,
          type: 'muxed',
          format: mimeToFormat(source.mimeType),
        });
      }

      // Captions for this chapter
      if (chapter.captions) {
        for (const cap of chapter.captions) {
          if (!cap.vttUrl) continue;
          // Avoid duplicates across chapters
          if (subtitles.some((s) => s.url === cap.vttUrl)) continue;
          subtitles.push({
            url: cap.vttUrl,
            language: cap.language ?? 'en',
            label: cap.name,
            format: 'vtt',
          });
        }
      }
    }

    return {
      id: generateId(),
      title: payload.name ?? `Vidyard Video ${uuid}`,
      thumbnail,
      duration: totalDuration > 0 ? totalDuration : (payload.length_in_seconds ?? undefined),
      provider: 'vidyard',
      pageUrl: context.pageUrl ?? context.url,
      streams,
      subtitles,
      metadata: { vidyardUuid: uuid, chapterCount: payload.chapters.length },
    };
  },
};

function mimeToFormat(mime: string): string {
  if (mime.includes('mp4')) return 'mp4';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('mpegURL') || mime.includes('m3u8')) return 'm3u8';
  return mime.split('/')[1] ?? 'mp4';
}

export default vidyardProvider;
