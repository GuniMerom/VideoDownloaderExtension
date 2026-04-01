// HLS/M3U8 manifest parser

export interface HLSVariant {
  url: string;
  bandwidth: number;
  resolution?: string;
  codecs?: string;
  frameRate?: string;
  audio?: string;
}

export interface HLSSegment {
  url: string;
  duration: number;
  byteRange?: { length: number; offset: number };
}

export interface HLSEncryption {
  method: string;
  uri?: string;
  iv?: string;
}

export interface HLSMasterPlaylist {
  type: 'master';
  variants: HLSVariant[];
}

export interface HLSMediaPlaylist {
  type: 'media';
  segments: HLSSegment[];
  totalDuration: number;
  encryption?: HLSEncryption;
}

function resolveUrl(relative: string, baseUrl: string): string {
  try {
    return new URL(relative, baseUrl).href;
  } catch {
    return relative;
  }
}

export function isMasterPlaylist(content: string): boolean {
  return content.includes('#EXT-X-STREAM-INF');
}

export function parseMasterPlaylist(content: string, baseUrl: string): HLSMasterPlaylist {
  const variants: HLSVariant[] = [];
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;

    const attrs = line.substring('#EXT-X-STREAM-INF:'.length);

    const bandwidthMatch = attrs.match(/BANDWIDTH=(\d+)/);
    const resolutionMatch = attrs.match(/RESOLUTION=([\dx]+)/i);
    const codecsMatch = attrs.match(/CODECS="([^"]+)"/);
    const frameRateMatch = attrs.match(/FRAME-RATE=([\d.]+)/);
    const audioMatch = attrs.match(/AUDIO="([^"]+)"/);

    // The next non-empty, non-comment line is the URI
    let uri = '';
    for (let j = i + 1; j < lines.length; j++) {
      const nextLine = lines[j].trim();
      if (nextLine && !nextLine.startsWith('#')) {
        uri = nextLine;
        break;
      }
    }

    if (!uri || !bandwidthMatch) continue;

    variants.push({
      url: resolveUrl(uri, baseUrl),
      bandwidth: parseInt(bandwidthMatch[1], 10),
      resolution: resolutionMatch?.[1],
      codecs: codecsMatch?.[1],
      frameRate: frameRateMatch?.[1],
      audio: audioMatch?.[1],
    });
  }

  return { type: 'master', variants };
}

export function parseMediaPlaylist(content: string, baseUrl: string): HLSMediaPlaylist {
  const segments: HLSSegment[] = [];
  let totalDuration = 0;
  let encryption: HLSEncryption | undefined;
  const lines = content.split(/\r?\n/);

  let currentDuration = 0;
  let currentByteRange: { length: number; offset: number } | undefined;
  let segmentOffset = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Parse encryption key
    if (line.startsWith('#EXT-X-KEY:')) {
      const keyAttrs = line.substring('#EXT-X-KEY:'.length);
      const methodMatch = keyAttrs.match(/METHOD=([^,]+)/);
      const uriMatch = keyAttrs.match(/URI="([^"]+)"/);
      const ivMatch = keyAttrs.match(/IV=(0x[0-9a-fA-F]+)/i);

      if (methodMatch) {
        encryption = {
          method: methodMatch[1],
          uri: uriMatch ? resolveUrl(uriMatch[1], baseUrl) : undefined,
          iv: ivMatch?.[1],
        };
      }
      continue;
    }

    // Parse segment duration
    if (line.startsWith('#EXTINF:')) {
      const durationMatch = line.match(/#EXTINF:([\d.]+)/);
      if (durationMatch) {
        currentDuration = parseFloat(durationMatch[1]);
      }
      continue;
    }

    // Parse byte range
    if (line.startsWith('#EXT-X-BYTERANGE:')) {
      const rangeMatch = line.match(/#EXT-X-BYTERANGE:(\d+)(?:@(\d+))?/);
      if (rangeMatch) {
        const length = parseInt(rangeMatch[1], 10);
        const offset = rangeMatch[2] !== undefined
          ? parseInt(rangeMatch[2], 10)
          : segmentOffset;
        currentByteRange = { length, offset };
        segmentOffset = offset + length;
      }
      continue;
    }

    // Segment URI line
    if (line && !line.startsWith('#')) {
      if (currentDuration > 0) {
        segments.push({
          url: resolveUrl(line, baseUrl),
          duration: currentDuration,
          byteRange: currentByteRange,
        });
        totalDuration += currentDuration;
        currentDuration = 0;
        currentByteRange = undefined;
      }
    }
  }

  return { type: 'media', segments, totalDuration, encryption };
}

export async function fetchAndParse(
  url: string,
): Promise<HLSMasterPlaylist | HLSMediaPlaylist> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch HLS manifest: ${response.status} ${response.statusText}`);
  }

  const content = await response.text();

  if (isMasterPlaylist(content)) {
    return parseMasterPlaylist(content, url);
  }

  return parseMediaPlaylist(content, url);
}
