import type { VideoInfo, VideoStream } from '../shared/types';
import type { VideoProvider, ExtractionContext } from './provider-interface';

function generateId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : 'ehls-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

const M3U8_RE = /\.m3u8(\?|$)/i;

// ── Key / IV parsing ────────────────────────────────────────────────

interface HlsEncryptionKey {
  method: string;
  uri: string;
  iv: Uint8Array | null;
}

function parseKeyTag(line: string, baseUrl: string): HlsEncryptionKey | null {
  const methodMatch = line.match(/METHOD=([^,]+)/);
  if (!methodMatch) return null;
  const method = methodMatch[1].trim();
  if (method === 'NONE') return null;

  const uriMatch = line.match(/URI="([^"]+)"/);
  if (!uriMatch) return null;

  let uri = uriMatch[1];
  if (!uri.startsWith('http://') && !uri.startsWith('https://')) {
    try {
      uri = new URL(uri, baseUrl).href;
    } catch {
      // keep as-is
    }
  }

  let iv: Uint8Array | null = null;
  const ivMatch = line.match(/IV=0x([0-9a-fA-F]+)/);
  if (ivMatch) {
    iv = hexToBytes(ivMatch[1]);
  }

  return { method, uri, iv };
}

function hexToBytes(hex: string): Uint8Array {
  const padded = hex.length % 2 === 0 ? hex : '0' + hex;
  const bytes = new Uint8Array(padded.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(padded.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function sequenceNumberToIv(seqNo: number): Uint8Array {
  // IV is a 16-byte big-endian representation of the sequence number
  const iv = new Uint8Array(16);
  const view = new DataView(iv.buffer);
  // Put the sequence number in the last 4 bytes (big-endian)
  view.setUint32(12, seqNo, false);
  return iv;
}

// ── Segment parsing ─────────────────────────────────────────────────

interface HlsSegment {
  url: string;
  duration: number;
  sequenceNumber: number;
}

interface ParsedMediaPlaylist {
  segments: HlsSegment[];
  encryptionKey: HlsEncryptionKey | null;
  totalDuration: number;
}

function parseMediaPlaylist(
  content: string,
  baseUrl: string,
): ParsedMediaPlaylist {
  const lines = content.split('\n').map((l) => l.trim());
  const segments: HlsSegment[] = [];
  let encryptionKey: HlsEncryptionKey | null = null;
  let totalDuration = 0;

  // Default media sequence starts at 0
  let mediaSequence = 0;
  const seqMatch = content.match(/#EXT-X-MEDIA-SEQUENCE:\s*(\d+)/);
  if (seqMatch) {
    mediaSequence = parseInt(seqMatch[1], 10);
  }

  let segIndex = 0;
  let pendingDuration = 0;

  for (const line of lines) {
    if (line.startsWith('#EXT-X-KEY:')) {
      const key = parseKeyTag(line, baseUrl);
      if (key) encryptionKey = key;
      continue;
    }

    if (line.startsWith('#EXTINF:')) {
      const durMatch = line.match(/#EXTINF:([\d.]+)/);
      pendingDuration = durMatch ? parseFloat(durMatch[1]) : 0;
      continue;
    }

    if (line && !line.startsWith('#')) {
      let segUrl = line;
      if (!segUrl.startsWith('http://') && !segUrl.startsWith('https://')) {
        try {
          segUrl = new URL(segUrl, baseUrl).href;
        } catch {
          // keep as-is
        }
      }

      segments.push({
        url: segUrl,
        duration: pendingDuration,
        sequenceNumber: mediaSequence + segIndex,
      });
      totalDuration += pendingDuration;
      pendingDuration = 0;
      segIndex++;
    }
  }

  return { segments, encryptionKey, totalDuration };
}

// ── Variant / master playlist parsing ───────────────────────────────

interface HlsVariant {
  url: string;
  bandwidth: number;
  resolution?: string;
}

function parseMasterPlaylist(content: string, baseUrl: string): HlsVariant[] {
  const variants: HlsVariant[] = [];
  const lines = content.split('\n').map((l) => l.trim());

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
    const attrs = lines[i];
    const urlLine = lines[i + 1];
    if (!urlLine || urlLine.startsWith('#')) continue;

    let url = urlLine;
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      try {
        url = new URL(url, baseUrl).href;
      } catch {
        // keep as-is
      }
    }

    const bwMatch = attrs.match(/BANDWIDTH=(\d+)/);
    const resMatch = attrs.match(/RESOLUTION=([^\s,]+)/);

    variants.push({
      url,
      bandwidth: bwMatch ? parseInt(bwMatch[1], 10) : 0,
      resolution: resMatch ? resMatch[1] : undefined,
    });
  }

  return variants;
}

function isMasterPlaylist(content: string): boolean {
  return content.includes('#EXT-X-STREAM-INF:');
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Decrypt a single AES-128-CBC encrypted segment.
 */
export async function decryptSegment(
  encryptedData: ArrayBuffer,
  key: ArrayBuffer,
  iv: ArrayBuffer,
): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'AES-CBC' },
    false,
    ['decrypt'],
  );

  return crypto.subtle.decrypt(
    { name: 'AES-CBC', iv },
    cryptoKey,
    encryptedData,
  );
}

/**
 * Download and decrypt an entire AES-128 encrypted HLS stream.
 *
 * 1. Fetches and parses the manifest
 * 2. If master playlist, selects the highest-bandwidth variant
 * 3. Extracts the AES-128 key URI and IV
 * 4. Fetches the decryption key
 * 5. Downloads each segment, decrypts it
 * 6. Concatenates everything into a single Blob
 */
export async function downloadEncryptedHLS(
  manifestUrl: string,
  onProgress?: (progress: number) => void,
): Promise<Blob> {
  // Step 1: fetch manifest
  const manifestResp = await fetch(manifestUrl);
  if (!manifestResp.ok) {
    throw new Error(`Failed to fetch HLS manifest: ${manifestResp.status}`);
  }
  let content = await manifestResp.text();
  let baseUrl = manifestUrl;

  // Step 2: if master, resolve to the best media playlist
  if (isMasterPlaylist(content)) {
    const variants = parseMasterPlaylist(content, baseUrl);
    if (variants.length === 0) {
      throw new Error('No variants found in master playlist');
    }
    variants.sort((a, b) => b.bandwidth - a.bandwidth);
    const bestUrl = variants[0].url;

    const mediaResp = await fetch(bestUrl);
    if (!mediaResp.ok) {
      throw new Error(
        `Failed to fetch media playlist: ${mediaResp.status}`,
      );
    }
    content = await mediaResp.text();
    baseUrl = bestUrl;
  }

  // Step 3: parse media playlist
  const { segments, encryptionKey } = parseMediaPlaylist(content, baseUrl);

  if (segments.length === 0) {
    throw new Error('No segments found in media playlist');
  }

  // Step 4: fetch encryption key if present
  let keyData: ArrayBuffer | null = null;
  if (encryptionKey && encryptionKey.method === 'AES-128') {
    const keyResp = await fetch(encryptionKey.uri);
    if (!keyResp.ok) {
      throw new Error(`Failed to fetch AES key: ${keyResp.status}`);
    }
    keyData = await keyResp.arrayBuffer();
  }

  // Step 5+6: download, decrypt, collect
  const decryptedParts: ArrayBuffer[] = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const segResp = await fetch(seg.url);
    if (!segResp.ok) {
      throw new Error(
        `Failed to fetch segment ${i + 1}/${segments.length}: ${segResp.status}`,
      );
    }
    let segData = await segResp.arrayBuffer();

    // Decrypt if the stream is encrypted
    if (keyData && encryptionKey) {
      const iv = encryptionKey.iv
        ? encryptionKey.iv.buffer as ArrayBuffer
        : sequenceNumberToIv(seg.sequenceNumber).buffer as ArrayBuffer;

      segData = await decryptSegment(segData, keyData, iv);
    }

    decryptedParts.push(segData);

    if (onProgress) {
      onProgress((i + 1) / segments.length);
    }
  }

  return new Blob(decryptedParts, { type: 'video/mp2t' });
}

// ── Provider ────────────────────────────────────────────────────────

function titleFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const filename = pathname.split('/').pop() ?? '';
    const name = filename.replace(/\.m3u8$/i, '').replace(/[_-]/g, ' ');
    return name || 'Encrypted HLS Stream';
  } catch {
    return 'Encrypted HLS Stream';
  }
}

const encryptedHlsProvider: VideoProvider = {
  name: 'encrypted-hls',
  displayName: 'Encrypted HLS',
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
    let content = await resp.text();
    let manifestBase = url;

    // If master playlist, list all variant streams
    if (isMasterPlaylist(content)) {
      const variants = parseMasterPlaylist(content, url);
      const streams: VideoStream[] = [];

      variants.sort((a, b) => b.bandwidth - a.bandwidth);

      for (const v of variants) {
        const heightMatch = v.resolution?.match(/x(\d+)/);
        streams.push({
          url: v.url,
          quality: heightMatch ? `${heightMatch[1]}p` : `${(v.bandwidth / 1_000_000).toFixed(1)} Mbps`,
          resolution: v.resolution,
          bandwidth: v.bandwidth,
          type: 'muxed',
          format: 'm3u8',
        });
      }

      // Probe the best variant to check for encryption
      let encrypted = false;
      if (variants.length > 0) {
        try {
          const probe = await fetch(variants[0].url);
          if (probe.ok) {
            const probeContent = await probe.text();
            encrypted = probeContent.includes('#EXT-X-KEY:METHOD=AES-128');
          }
        } catch {
          // ignore probe errors
        }
      }

      return {
        id: generateId(),
        title: titleFromUrl(url),
        provider: 'encrypted-hls',
        pageUrl: pageUrl ?? url,
        streams,
        subtitles: [],
        metadata: {
          encrypted,
          variantCount: variants.length,
          isMasterPlaylist: true,
        },
      };
    }

    // Media playlist – parse for encryption info and segments
    const parsed = parseMediaPlaylist(content, manifestBase);
    const encrypted =
      parsed.encryptionKey?.method === 'AES-128';

    const streams: VideoStream[] = [
      {
        url,
        quality: 'default',
        type: 'muxed',
        format: 'm3u8',
      },
    ];

    return {
      id: generateId(),
      title: titleFromUrl(url),
      duration: parsed.totalDuration > 0 ? parsed.totalDuration : undefined,
      provider: 'encrypted-hls',
      pageUrl: pageUrl ?? url,
      streams,
      subtitles: [],
      metadata: {
        encrypted,
        segmentCount: parsed.segments.length,
        encryptionMethod: parsed.encryptionKey?.method ?? 'NONE',
        isMediaPlaylist: true,
      },
    };
  },
};

export default encryptedHlsProvider;
