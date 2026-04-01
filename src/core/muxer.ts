// Audio/video muxer — ffmpeg.wasm integration (Phase 2)
// Current implementation provides segment concatenation and a fallback for muxing.

let ffmpegLoaded = false;

export function isFFmpegAvailable(): boolean {
  return ffmpegLoaded;
}

export function concatenateSegments(
  segments: ArrayBuffer[],
  onProgress?: (percent: number) => void,
): Blob {
  if (segments.length === 0) {
    return new Blob([], { type: 'video/mp2t' });
  }

  const totalLength = segments.reduce((sum, buf) => sum + buf.byteLength, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (let i = 0; i < segments.length; i++) {
    combined.set(new Uint8Array(segments[i]), offset);
    offset += segments[i].byteLength;
    if (onProgress) {
      onProgress(Math.round(((i + 1) / segments.length) * 100));
    }
  }

  // Detect format: fMP4 starts with an 'ftyp' or 'styp' box, MPEG-TS starts with 0x47
  const mimeType = isFMP4(segments[0]) ? 'video/mp4' : 'video/mp2t';
  return new Blob([combined], { type: mimeType });
}

/** Detect if a buffer starts with an fMP4 box (ftyp or styp). */
function isFMP4(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 8) return false;
  const view = new DataView(buffer);
  // MP4 boxes have a 4-byte size followed by a 4-byte type
  const boxType = String.fromCharCode(
    view.getUint8(4), view.getUint8(5), view.getUint8(6), view.getUint8(7),
  );
  return boxType === 'ftyp' || boxType === 'styp' || boxType === 'moov';
}

/**
 * Concatenate an initialization segment with media segments (fMP4).
 * For fMP4, the init segment (containing moov box) must precede the media segments.
 * For MPEG-TS, simple concatenation works, so init segment is prepended as-is.
 */
export function concatenateWithInit(
  initSegment: ArrayBuffer,
  segments: ArrayBuffer[],
  onProgress?: (percent: number) => void,
): Blob {
  const allSegments = [initSegment, ...segments];
  const totalLength = allSegments.reduce((sum, buf) => sum + buf.byteLength, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (let i = 0; i < allSegments.length; i++) {
    combined.set(new Uint8Array(allSegments[i]), offset);
    offset += allSegments[i].byteLength;
    if (onProgress) {
      onProgress(Math.round(((i + 1) / allSegments.length) * 100));
    }
  }

  const mimeType = isFMP4(initSegment) ? 'video/mp4' : 'video/mp2t';
  return new Blob([combined], { type: mimeType });
}

/**
 * Load ffmpeg.wasm. Call once before muxStreams.
 * TODO (Phase 2): Load @ffmpeg/ffmpeg and @ffmpeg/core.
 */
export async function loadFFmpeg(): Promise<boolean> {
  try {
    // Phase 2: Uncomment and implement when adding ffmpeg.wasm
    // const { FFmpeg } = await import('@ffmpeg/ffmpeg');
    // const ffmpeg = new FFmpeg();
    // await ffmpeg.load();
    // ffmpegLoaded = true;

    console.warn('[muxer] ffmpeg.wasm not yet integrated — using fallback');
    ffmpegLoaded = false;
    return false;
  } catch (err) {
    console.error('[muxer] Failed to load ffmpeg.wasm:', err);
    ffmpegLoaded = false;
    return false;
  }
}

/**
 * Mux video and audio blobs into a single container.
 * Phase 2: Will use ffmpeg.wasm for real muxing.
 * Current fallback: returns video blob as-is (audio will be downloaded separately).
 */
export async function muxStreams(
  videoBlob: Blob,
  audioBlob: Blob,
  outputFormat: string = 'mp4',
): Promise<Blob> {
  if (!ffmpegLoaded) {
    console.warn(
      '[muxer] ffmpeg.wasm not available — returning video blob without muxing.',
      `Audio blob (${audioBlob.size} bytes) will need separate download.`,
    );
    // Return video as-is; the caller (downloader.ts) handles the fallback
    return new Blob([videoBlob], {
      type: outputFormat === 'webm' ? 'video/webm' : 'video/mp4',
    });
  }

  // ffmpeg.wasm muxing not available in MV3 (can't load WASM from CDN).
  // The caller (downloader.ts) handles the fallback by downloading separate files.
  return new Blob([videoBlob], {
    type: outputFormat === 'webm' ? 'video/webm' : 'video/mp4',
  });
}
