// Offscreen document for downloading and concatenating video segments.
// Runs as a regular web page (not a service worker) so fetch() calls
// are not subject to the MV3 30-second service worker timeout.

const MAX_RETRIES = 3;
const SEGMENT_TIMEOUT_MS = 60_000;

interface DownloadSegmentsMessage {
  type: 'OFFSCREEN_DOWNLOAD_SEGMENTS';
  segmentUrls: string[];
  taskId: string;
}

interface MergeTracksMessage {
  type: 'OFFSCREEN_MERGE_TRACKS';
  videoSegmentUrls: string[];
  audioSegmentUrls: string[];
  taskId: string;
}

chrome.runtime.onMessage.addListener(
  (message: DownloadSegmentsMessage | MergeTracksMessage, _sender, sendResponse) => {
    if (message.type === 'OFFSCREEN_DOWNLOAD_SEGMENTS') {
      downloadAndConcatenate(message.segmentUrls, message.taskId)
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ error: err instanceof Error ? err.message : String(err) }));
      return true;
    }
    if (message.type === 'OFFSCREEN_MERGE_TRACKS') {
      downloadAndMergeTracks(message.videoSegmentUrls, message.audioSegmentUrls, message.taskId)
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ error: err instanceof Error ? err.message : String(err) }));
      return true;
    }
  },
);

function reportProgress(taskId: string, progress: number): void {
  chrome.runtime.sendMessage({
    type: 'OFFSCREEN_PROGRESS',
    taskId,
    progress,
  }).catch(() => {});
}

async function fetchSegmentWithRetry(
  url: string,
  segmentIndex: number,
  retries: number = MAX_RETRIES,
): Promise<ArrayBuffer> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SEGMENT_TIMEOUT_MS);

    try {
      const resp = await fetch(url, { signal: controller.signal });
      if (!resp.ok) {
        throw new Error(`Segment ${segmentIndex + 1} failed: HTTP ${resp.status}`);
      }
      return await resp.arrayBuffer();
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        lastError = new Error(`Segment ${segmentIndex + 1} timed out after ${SEGMENT_TIMEOUT_MS / 1000}s`);
      } else {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }
  throw lastError ?? new Error(`Segment ${segmentIndex + 1} failed after ${retries} retries`);
}

async function downloadAndConcatenate(
  segmentUrls: string[],
  taskId: string,
): Promise<{ blobUrl: string; size: number }> {
  const total = segmentUrls.length;
  const buffers: ArrayBuffer[] = [];

  for (let i = 0; i < segmentUrls.length; i++) {
    const buffer = await fetchSegmentWithRetry(segmentUrls[i], i);
    buffers.push(buffer);
    reportProgress(taskId, Math.round(((i + 1) / total) * 95));
  }

  const blob = new Blob(buffers, { type: 'video/mp4' });
  const blobUrl = URL.createObjectURL(blob);
  return { blobUrl, size: blob.size };
}

/**
 * Download both video and audio segments, then merge them into a single MP4.
 * 
 * For fMP4 (fragmented MP4), we create a merged file by:
 * 1. Combining the moov atoms from both init segments (fixing track IDs)
 * 2. Interleaving video and audio moof+mdat fragments
 */
async function downloadAndMergeTracks(
  videoUrls: string[],
  audioUrls: string[],
  taskId: string,
): Promise<{ blobUrl: string; size: number; mergeMode: 'merged' | 'video-only-fallback' }> {
  const totalSegments = videoUrls.length + audioUrls.length;
  let downloaded = 0;

  // Download video segments
  const videoBuffers: ArrayBuffer[] = [];
  for (let i = 0; i < videoUrls.length; i++) {
    videoBuffers.push(await fetchSegmentWithRetry(videoUrls[i], i));
    downloaded++;
    reportProgress(taskId, Math.round((downloaded / totalSegments) * 90));
  }

  // Download audio segments
  const audioBuffers: ArrayBuffer[] = [];
  for (let i = 0; i < audioUrls.length; i++) {
    audioBuffers.push(await fetchSegmentWithRetry(audioUrls[i], i));
    downloaded++;
    reportProgress(taskId, Math.round((downloaded / totalSegments) * 90));
  }

  reportProgress(taskId, 92);
  console.log(`[Offscreen] Downloaded video: ${videoBuffers.length} bufs, audio: ${audioBuffers.length} bufs`);

  // Try to merge, fall back to video-only if merge fails
  let merged: Uint8Array;
  let mergeMode: 'merged' | 'video-only-fallback' = 'merged';
  try {
    merged = mergeFMP4Tracks(videoBuffers, audioBuffers);
    console.log(`[Offscreen] Merged successfully: ${merged.length} bytes`);
  } catch (err) {
    console.error('[Offscreen] Merge failed, falling back to video-only:', err);
    merged = concatenateBuffers(videoBuffers);
    mergeMode = 'video-only-fallback';
  }

  reportProgress(taskId, 98);

  const blob = new Blob([merged.buffer as ArrayBuffer], { type: 'video/mp4' });
  const blobUrl = URL.createObjectURL(blob);
  return { blobUrl, size: blob.size, mergeMode };
}

function concatenateBuffers(buffers: ArrayBuffer[]): Uint8Array {
  const totalSize = buffers.reduce((sum, b) => sum + b.byteLength, 0);
  const result = new Uint8Array(totalSize);
  let offset = 0;
  for (const buf of buffers) {
    result.set(new Uint8Array(buf), offset);
    offset += buf.byteLength;
  }
  return result;
}

// ─── fMP4 Box Parsing & Merging ───

interface MP4Box {
  type: string;
  offset: number;
  size: number;
  data: Uint8Array;
}

function parseBoxes(buffer: ArrayBuffer): MP4Box[] {
  const boxes: MP4Box[] = [];
  const view = new DataView(buffer);
  let offset = 0;

  while (offset + 8 <= buffer.byteLength) {
    const size = view.getUint32(offset);
    const type = String.fromCharCode(
      view.getUint8(offset + 4), view.getUint8(offset + 5),
      view.getUint8(offset + 6), view.getUint8(offset + 7),
    );
    if (size < 8 || offset + size > buffer.byteLength) break;
    boxes.push({
      type,
      offset,
      size,
      data: new Uint8Array(buffer, offset, size),
    });
    offset += size;
  }

  return boxes;
}

/**
 * Find a box by type within a container's payload (recursive search).
 */
function findBox(data: Uint8Array, targetType: string): Uint8Array | null {
  let offset = 0;
  while (offset + 8 <= data.length) {
    const view = new DataView(data.buffer, data.byteOffset + offset);
    const size = view.getUint32(0);
    const type = String.fromCharCode(data[offset + 4], data[offset + 5], data[offset + 6], data[offset + 7]);
    if (size < 8 || offset + size > data.length) break;
    if (type === targetType) {
      return new Uint8Array(data.buffer, data.byteOffset + offset, size);
    }
    offset += size;
  }
  return null;
}

/**
 * Merge video and audio fMP4 tracks into a single playable MP4 file.
 * 
 * Approach:
 * - Use video's ftyp box
 * - Build merged moov: video's mvhd (patched) + video's trak + audio's trak (patched track ID)
 * - Append all video fragments, then all audio fragments (with patched track IDs)
 */
function mergeFMP4Tracks(videoBuffers: ArrayBuffer[], audioBuffers: ArrayBuffer[]): Uint8Array {
  const videoInitBoxes = parseBoxes(videoBuffers[0]);
  const audioInitBoxes = parseBoxes(audioBuffers[0]);

  const ftyp = videoInitBoxes.find(b => b.type === 'ftyp');
  const videoMoov = videoInitBoxes.find(b => b.type === 'moov');
  const audioMoov = audioInitBoxes.find(b => b.type === 'moov');

  if (!ftyp || !videoMoov || !audioMoov) {
    console.warn('[Offscreen] Missing init boxes, video-only fallback');
    return concatenateBuffers(videoBuffers);
  }

  console.log(`[Offscreen] ftyp: ${ftyp.size}b, videoMoov: ${videoMoov.size}b, audioMoov: ${audioMoov.size}b`);

  // Parse moov children to get individual boxes
  const videoMoovChildren = parseBoxes(videoMoov.data.buffer.slice(
    videoMoov.data.byteOffset + 8, videoMoov.data.byteOffset + videoMoov.size) as ArrayBuffer);
  const audioMoovChildren = parseBoxes(audioMoov.data.buffer.slice(
    audioMoov.data.byteOffset + 8, audioMoov.data.byteOffset + audioMoov.size) as ArrayBuffer);

  console.log(`[Offscreen] Video moov children: ${videoMoovChildren.map(b => b.type).join(', ')}`);
  console.log(`[Offscreen] Audio moov children: ${audioMoovChildren.map(b => b.type).join(', ')}`);

  // Get audio trak(s) and patch their track IDs
  const audioTraks = audioMoovChildren.filter(b => b.type === 'trak');
  const AUDIO_TRACK_ID = 2; // Video is typically track 1

  // Patch track ID in each audio trak's tkhd box
  for (const trak of audioTraks) {
    const trakPayload = new Uint8Array(trak.data.buffer, trak.data.byteOffset + 8, trak.size - 8);
    patchTkhdTrackId(trakPayload, AUDIO_TRACK_ID);
  }

  // Patch mvhd.next_track_ID in video moov
  const mvhd = videoMoovChildren.find(b => b.type === 'mvhd');
  if (mvhd) {
    patchMvhdNextTrackId(mvhd.data, AUDIO_TRACK_ID + 1); // next available = 3
  }

  // Build merged moov: [mvhd + video traks + mvex + ...] + [audio traks]
  // We include all video moov children + audio trak boxes
  let moovContentSize = 0;
  for (const box of videoMoovChildren) {
    moovContentSize += box.size;
  }
  for (const trak of audioTraks) {
    moovContentSize += trak.size;
  }

  const mergedMoovSize = 8 + moovContentSize;
  const mergedMoov = new Uint8Array(mergedMoovSize);
  new DataView(mergedMoov.buffer).setUint32(0, mergedMoovSize);
  mergedMoov[4] = 0x6D; mergedMoov[5] = 0x6F; mergedMoov[6] = 0x6F; mergedMoov[7] = 0x76; // "moov"

  let writePos = 8;
  // Write video moov children (mvhd, trak, mvex, etc.)
  for (const box of videoMoovChildren) {
    mergedMoov.set(box.data, writePos);
    writePos += box.size;
  }
  // Write audio trak boxes (with patched track ID)
  for (const trak of audioTraks) {
    mergedMoov.set(trak.data, writePos);
    writePos += trak.size;
  }

  // Calculate total output size
  let totalSize = ftyp.size + mergedMoovSize;
  for (let i = 1; i < videoBuffers.length; i++) totalSize += videoBuffers[i].byteLength;
  for (let i = 1; i < audioBuffers.length; i++) totalSize += audioBuffers[i].byteLength;

  // Assemble final file
  const result = new Uint8Array(totalSize);
  let offset = 0;

  result.set(ftyp.data, offset);
  offset += ftyp.size;

  result.set(mergedMoov, offset);
  offset += mergedMoovSize;

  // Video fragments
  for (let i = 1; i < videoBuffers.length; i++) {
    result.set(new Uint8Array(videoBuffers[i]), offset);
    offset += videoBuffers[i].byteLength;
  }

  // Audio fragments with rewritten track IDs in tfhd
  for (let i = 1; i < audioBuffers.length; i++) {
    const frag = new Uint8Array(audioBuffers[i].slice(0)); // copy to avoid mutating original
    rewriteTrackIdInFragment(frag, AUDIO_TRACK_ID);
    result.set(frag, offset);
    offset += frag.length;
  }

  console.log(`[Offscreen] Final merged: ${offset} bytes (expected ${totalSize})`);
  return result;
}

/**
 * Patch the track_id in a tkhd (Track Header) box within a trak payload.
 * tkhd structure: size(4) + 'tkhd'(4) + version(1) + flags(3) + ...
 *   version 0: creation_time(4) + modification_time(4) + track_ID(4)
 *   version 1: creation_time(8) + modification_time(8) + track_ID(4)
 */
function patchTkhdTrackId(trakPayload: Uint8Array, newTrackId: number): void {
  let offset = 0;
  while (offset + 8 <= trakPayload.length) {
    const view = new DataView(trakPayload.buffer, trakPayload.byteOffset + offset);
    const size = view.getUint32(0);
    const type = String.fromCharCode(
      trakPayload[offset + 4], trakPayload[offset + 5],
      trakPayload[offset + 6], trakPayload[offset + 7],
    );
    if (size < 8 || offset + size > trakPayload.length) break;

    if (type === 'tkhd') {
      const version = trakPayload[offset + 8];
      const trackIdOffset = version === 1 ? 20 : 12; // after version+flags + time fields
      view.setUint32(trackIdOffset, newTrackId);
      console.log(`[Offscreen] Patched tkhd track_id to ${newTrackId}`);
      return;
    }
    offset += size;
  }
}

/**
 * Patch mvhd.next_track_ID.
 * mvhd structure: size(4) + 'mvhd'(4) + version(1) + flags(3) + ...
 *   version 0: ... next_track_ID at offset 96+8 = byte 104 from box start
 *   version 1: ... next_track_ID at offset 108+8 = byte 116 from box start
 * Actually: next_track_ID is the last 4 bytes of mvhd.
 */
function patchMvhdNextTrackId(mvhdData: Uint8Array, nextTrackId: number): void {
  // next_track_ID is always the last 4 bytes of the mvhd box
  const view = new DataView(mvhdData.buffer, mvhdData.byteOffset);
  const size = view.getUint32(0);
  view.setUint32(size - 4, nextTrackId);
  console.log(`[Offscreen] Patched mvhd next_track_id to ${nextTrackId}`);
}

/**
 * Rewrite track_id in tfhd boxes within an fMP4 fragment (moof container).
 */
function rewriteTrackIdInFragment(data: Uint8Array, newTrackId: number): void {
  let offset = 0;
  while (offset + 8 <= data.length) {
    const view = new DataView(data.buffer, data.byteOffset + offset);
    const size = view.getUint32(0);
    const type = String.fromCharCode(
      data[offset + 4], data[offset + 5], data[offset + 6], data[offset + 7],
    );
    if (size < 8 || offset + size > data.length) break;

    if (type === 'moof' || type === 'traf') {
      // Recurse into container (skip 8-byte header)
      rewriteTrackIdInFragment(
        new Uint8Array(data.buffer, data.byteOffset + offset + 8, size - 8),
        newTrackId,
      );
    } else if (type === 'tfhd' && size >= 16) {
      // tfhd: size(4) + 'tfhd'(4) + version_flags(4) + track_id(4)
      view.setUint32(12, newTrackId);
    }

    offset += size;
  }
}
