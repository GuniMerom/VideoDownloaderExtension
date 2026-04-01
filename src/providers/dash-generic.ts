import type { VideoInfo, VideoStream } from '../shared/types';
import type { VideoProvider, ExtractionContext } from './provider-interface';

function generateId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : 'dash-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

const MPD_RE = /\.mpd(\?|$)/i;

interface DashRepresentation {
  url: string;
  bandwidth: number;
  width?: number;
  height?: number;
  codec?: string;
  mimeType: string;
  frameRate?: string;
  type: 'video' | 'audio';
  id?: string;
}

/**
 * Minimal inline DASH MPD parser.
 * Parses AdaptationSets and Representations from MPD XML.
 */
function parseMpd(xmlText: string, baseUrl: string): DashRepresentation[] {
  const representations: DashRepresentation[] = [];

  // Parse XML using DOMParser if available (content script / background)
  let doc: XMLDocument;
  if (typeof DOMParser !== 'undefined') {
    doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  } else {
    // Minimal regex-based fallback for environments without DOMParser
    return parseWithRegex(xmlText, baseUrl);
  }

  const adaptationSets = doc.querySelectorAll('AdaptationSet');
  for (const as of adaptationSets) {
    const asMimeType = as.getAttribute('mimeType') ?? '';
    const asCodecs = as.getAttribute('codecs') ?? '';
    const asContentType = as.getAttribute('contentType') ?? '';

    // Determine if this is video or audio
    const isAudio =
      asContentType === 'audio' ||
      asMimeType.startsWith('audio/') ||
      (!asContentType && !asMimeType.startsWith('video/') && asMimeType.includes('audio'));
    const streamType: 'video' | 'audio' = isAudio ? 'audio' : 'video';

    // Get BaseURL at AdaptationSet level
    const asBaseUrlEl = as.querySelector(':scope > BaseURL');
    const asBaseUrl = asBaseUrlEl?.textContent
      ? resolveUrl(asBaseUrlEl.textContent, baseUrl)
      : baseUrl;

    // Check for SegmentTemplate at AdaptationSet level
    const segTemplate = as.querySelector(':scope > SegmentTemplate');
    const initTemplate = segTemplate?.getAttribute('initialization') ?? '';
    const mediaTemplate = segTemplate?.getAttribute('media') ?? '';

    const reps = as.querySelectorAll('Representation');
    for (const rep of reps) {
      const id = rep.getAttribute('id') ?? undefined;
      const bandwidth = parseInt(rep.getAttribute('bandwidth') ?? '0', 10);
      const width = parseInt(rep.getAttribute('width') ?? as.getAttribute('width') ?? '0', 10) || undefined;
      const height = parseInt(rep.getAttribute('height') ?? as.getAttribute('height') ?? '0', 10) || undefined;
      const codec = (rep.getAttribute('codecs') ?? asCodecs) || undefined;
      const mimeType = rep.getAttribute('mimeType') ?? asMimeType;
      const frameRate = rep.getAttribute('frameRate') ?? as.getAttribute('frameRate') ?? undefined;

      // Determine the URL for this representation
      let repUrl: string;
      const repBaseUrlEl = rep.querySelector(':scope > BaseURL');
      if (repBaseUrlEl?.textContent) {
        repUrl = resolveUrl(repBaseUrlEl.textContent, asBaseUrl);
      } else if (initTemplate && id) {
        // Build URL from SegmentTemplate initialization pattern
        const initUrl = initTemplate
          .replace(/\$RepresentationID\$/g, id)
          .replace(/\$Bandwidth\$/g, String(bandwidth));
        repUrl = resolveUrl(initUrl, asBaseUrl);
      } else if (mediaTemplate && id) {
        const mediaUrl = mediaTemplate
          .replace(/\$RepresentationID\$/g, id)
          .replace(/\$Bandwidth\$/g, String(bandwidth));
        repUrl = resolveUrl(mediaUrl, asBaseUrl);
      } else {
        // Fall back to the base URL with representation ID
        repUrl = asBaseUrl;
      }

      representations.push({
        url: repUrl,
        bandwidth,
        width,
        height,
        codec,
        mimeType,
        frameRate,
        type: streamType,
        id,
      });
    }
  }

  return representations;
}

/**
 * Regex-based fallback parser for environments without DOMParser.
 */
function parseWithRegex(xmlText: string, baseUrl: string): DashRepresentation[] {
  const representations: DashRepresentation[] = [];
  const adaptationSetRe = /<AdaptationSet([^>]*)>([\s\S]*?)<\/AdaptationSet>/g;
  const representationRe = /<Representation([^>]*?)(?:\/>|>([\s\S]*?)<\/Representation>)/g;

  let asMatch;
  while ((asMatch = adaptationSetRe.exec(xmlText)) !== null) {
    const asAttrs = asMatch[1];
    const asBody = asMatch[2];

    const asMimeType = getAttr(asAttrs, 'mimeType') ?? '';
    const asCodecs = getAttr(asAttrs, 'codecs') ?? '';
    const asContentType = getAttr(asAttrs, 'contentType') ?? '';
    const isAudio = asContentType === 'audio' || asMimeType.startsWith('audio/');
    const streamType: 'video' | 'audio' = isAudio ? 'audio' : 'video';

    let repMatch;
    representationRe.lastIndex = 0;
    const content = asBody;
    while ((repMatch = representationRe.exec(content)) !== null) {
      const repAttrs = repMatch[1];
      const id = getAttr(repAttrs, 'id') ?? undefined;
      const bandwidth = parseInt(getAttr(repAttrs, 'bandwidth') ?? '0', 10);
      const width = parseInt(getAttr(repAttrs, 'width') ?? '0', 10) || undefined;
      const height = parseInt(getAttr(repAttrs, 'height') ?? '0', 10) || undefined;
      const codec = (getAttr(repAttrs, 'codecs') ?? asCodecs) || undefined;
      const mimeType = getAttr(repAttrs, 'mimeType') ?? asMimeType;
      const frameRate = getAttr(repAttrs, 'frameRate') ?? undefined;

      // Try to find BaseURL in representation body
      const repBody = repMatch[2] ?? '';
      const baseUrlMatch = repBody.match(/<BaseURL>([^<]+)<\/BaseURL>/);
      const repUrl = baseUrlMatch
        ? resolveUrl(baseUrlMatch[1], baseUrl)
        : baseUrl;

      representations.push({
        url: repUrl,
        bandwidth,
        width,
        height,
        codec,
        mimeType,
        frameRate,
        type: streamType,
        id,
      });
    }
  }

  return representations;
}

function getAttr(attrs: string, name: string): string | null {
  const re = new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`);
  const match = attrs.match(re);
  return match ? match[1] : null;
}

function resolveUrl(url: string, baseUrl: string): string {
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  try {
    return new URL(url, baseUrl).href;
  } catch {
    return url;
  }
}

function qualityLabel(rep: DashRepresentation): string {
  if (rep.height) return `${rep.height}p`;
  if (rep.bandwidth) {
    if (rep.type === 'audio') {
      return `${Math.round(rep.bandwidth / 1000)} kbps`;
    }
    return `${(rep.bandwidth / 1_000_000).toFixed(1)} Mbps`;
  }
  return 'unknown';
}

/**
 * Extract total duration from MPD Period/mediaPresentationDuration attribute.
 */
function extractDuration(xmlText: string): number | undefined {
  const match = xmlText.match(/mediaPresentationDuration="PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?"/);
  if (!match) return undefined;
  const hours = parseInt(match[1] ?? '0', 10);
  const minutes = parseInt(match[2] ?? '0', 10);
  const seconds = parseFloat(match[3] ?? '0');
  return hours * 3600 + minutes * 60 + seconds;
}

const dashGenericProvider: VideoProvider = {
  name: 'dash-generic',
  displayName: 'DASH Stream',
  version: '1.0.0',

  canHandleUrl(url: string): boolean {
    return MPD_RE.test(url);
  },

  getEmbedPatterns(): RegExp[] {
    return [];
  },

  async extractVideoInfo(context: ExtractionContext): Promise<VideoInfo> {
    const { url, pageUrl } = context;

    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`DASH MPD fetch failed: ${resp.status}`);
    }
    const xmlText = await resp.text();

    const representations = parseMpd(xmlText, url);
    const duration = extractDuration(xmlText);
    const streams: VideoStream[] = [];

    if (representations.length === 0) {
      // Couldn't parse — add the MPD as-is
      streams.push({
        url,
        quality: 'auto',
        type: 'muxed',
        format: 'mpd',
      });
    } else {
      // Separate video and audio, sort by bandwidth descending
      const videoReps = representations
        .filter((r) => r.type === 'video')
        .sort((a, b) => b.bandwidth - a.bandwidth);
      const audioReps = representations
        .filter((r) => r.type === 'audio')
        .sort((a, b) => b.bandwidth - a.bandwidth);

      for (const rep of videoReps) {
        streams.push({
          url: rep.url,
          quality: qualityLabel(rep),
          resolution: rep.width && rep.height ? `${rep.width}x${rep.height}` : undefined,
          bandwidth: rep.bandwidth,
          codec: rep.codec,
          type: 'video',
          format: 'mpd',
          frameRate: rep.frameRate,
        });
      }

      for (const rep of audioReps) {
        streams.push({
          url: rep.url,
          quality: qualityLabel(rep),
          bandwidth: rep.bandwidth,
          codec: rep.codec,
          type: 'audio',
          format: 'mpd',
        });
      }
    }

    return {
      id: generateId(),
      title: titleFromUrl(url),
      duration,
      provider: 'dash-generic',
      pageUrl: pageUrl ?? url,
      streams,
      subtitles: [],
      metadata: {
        representationCount: representations.length,
        videoCount: representations.filter((r) => r.type === 'video').length,
        audioCount: representations.filter((r) => r.type === 'audio').length,
      },
    };
  },
};

function titleFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const filename = pathname.split('/').pop() ?? '';
    const name = filename.replace(/\.mpd$/i, '').replace(/[_-]/g, ' ');
    return name || 'DASH Stream';
  } catch {
    return 'DASH Stream';
  }
}

export default dashGenericProvider;
