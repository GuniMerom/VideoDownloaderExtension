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
 * 1. Combining the moov atoms from both init segments
 * 2. Interleaving video and audio moof+mdat fragments
 */
async function downloadAndMergeTracks(
  videoUrls: string[],
  audioUrls: string[],
  taskId: string,
): Promise<{ blobUrl: string; size: number }> {
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

  // Merge the fMP4 tracks
  const merged = mergeFMP4Tracks(videoBuffers, audioBuffers);
  reportProgress(taskId, 98);

  const blob = new Blob([merged.buffer as ArrayBuffer], { type: 'video/mp4' });
  const blobUrl = URL.createObjectURL(blob);
  return { blobUrl, size: blob.size };
}

// ─── fMP4 Box Parsing & Merging ───

function readUint32(data: DataView, offset: number): number {
  return data.getUint32(offset);
}

function readBoxType(data: DataView, offset: number): string {
  return String.fromCharCode(
    data.getUint8(offset), data.getUint8(offset + 1),
    data.getUint8(offset + 2), data.getUint8(offset + 3),
  );
}

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

  while (offset < buffer.byteLength) {
    if (offset + 8 > buffer.byteLength) break;
    const size = readUint32(view, offset);
    const type = readBoxType(view, offset + 4);
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
 * Merge video and audio fMP4 tracks into a single MP4 file.
 * 
 * Video buffers[0] = init segment (ftyp + moov with video trak)
 * Audio buffers[0] = init segment (ftyp + moov with audio trak)
 * 
 * Strategy: Use video's ftyp, create merged moov with both traks,
 * then append all video moof+mdat followed by all audio moof+mdat.
 * 
 * For simplicity, we renumber audio track IDs to avoid conflicts.
 */
function mergeFMP4Tracks(videoBuffers: ArrayBuffer[], audioBuffers: ArrayBuffer[]): Uint8Array {
  // Parse init segments
  const videoInitBoxes = parseBoxes(videoBuffers[0]);
  const audioInitBoxes = parseBoxes(audioBuffers[0]);

  // Get ftyp from video
  const ftyp = videoInitBoxes.find(b => b.type === 'ftyp');

  // Get moov from both
  const videoMoov = videoInitBoxes.find(b => b.type === 'moov');
  const audioMoov = audioInitBoxes.find(b => b.type === 'moov');

  if (!ftyp || !videoMoov || !audioMoov) {
    // Fallback: just concatenate video only (no merge possible)
    console.warn('[Offscreen] Cannot merge: missing init segment boxes, falling back to video-only');
    const totalSize = videoBuffers.reduce((sum, b) => sum + b.byteLength, 0);
    const result = new Uint8Array(totalSize);
    let offset = 0;
    for (const buf of videoBuffers) {
      result.set(new Uint8Array(buf), offset);
      offset += buf.byteLength;
    }
    return result;
  }

  // Extract trak boxes from audio moov
  const audioMoovInnerBuf = (audioMoov.data.buffer as ArrayBuffer).slice(
    audioMoov.data.byteOffset + 8,
    audioMoov.data.byteOffset + audioMoov.size,
  );
  const audioMoovBoxes = parseBoxes(audioMoovInnerBuf);
  const audioTraks = audioMoovBoxes.filter(b => b.type === 'trak');

  // Renumber track IDs in audio moof fragments to avoid conflict with video track
  // Video typically uses track_id=1, so we set audio to track_id=2
  const AUDIO_TRACK_ID = 2;

  // Build merged moov: video moov content + audio trak boxes
  const videoMoovContent = new Uint8Array(videoMoov.data.buffer,
    videoMoov.data.byteOffset + 8, videoMoov.size - 8);
  
  let audioTrakTotalSize = 0;
  for (const trak of audioTraks) {
    audioTrakTotalSize += trak.size;
  }

  const mergedMoovSize = 8 + videoMoovContent.length + audioTrakTotalSize;
  const mergedMoov = new Uint8Array(mergedMoovSize);
  const moovView = new DataView(mergedMoov.buffer);
  moovView.setUint32(0, mergedMoovSize);
  mergedMoov[4] = 0x6D; mergedMoov[5] = 0x6F; mergedMoov[6] = 0x6F; mergedMoov[7] = 0x76; // "moov"
  mergedMoov.set(videoMoovContent, 8);
  let trakOffset = 8 + videoMoovContent.length;
  for (const trak of audioTraks) {
    mergedMoov.set(trak.data, trakOffset);
    trakOffset += trak.size;
  }

  // Calculate total size
  let totalSize = ftyp.size + mergedMoovSize;
  // Video fragments (skip init segment at index 0)
  for (let i = 1; i < videoBuffers.length; i++) {
    totalSize += videoBuffers[i].byteLength;
  }
  // Audio fragments (skip init segment at index 0), with track ID rewriting
  for (let i = 1; i < audioBuffers.length; i++) {
    totalSize += audioBuffers[i].byteLength;
  }

  // Assemble the final file
  const result = new Uint8Array(totalSize);
  let writeOffset = 0;

  // ftyp
  result.set(ftyp.data, writeOffset);
  writeOffset += ftyp.size;

  // merged moov
  result.set(mergedMoov, writeOffset);
  writeOffset += mergedMoovSize;

  // Video moof+mdat fragments
  for (let i = 1; i < videoBuffers.length; i++) {
    const fragData = new Uint8Array(videoBuffers[i]);
    result.set(fragData, writeOffset);
    writeOffset += fragData.length;
  }

  // Audio moof+mdat fragments (rewrite track_id in moof/traf/tfhd)
  for (let i = 1; i < audioBuffers.length; i++) {
    const fragData = new Uint8Array(audioBuffers[i]);
    // Rewrite track_id in tfhd box (inside moof > traf > tfhd)
    rewriteTrackId(fragData, AUDIO_TRACK_ID);
    result.set(fragData, writeOffset);
    writeOffset += fragData.length;
  }

  return result;
}

/**
 * Rewrite the track_id field in tfhd boxes within an fMP4 fragment.
 * tfhd is at: moof > traf > tfhd, and track_id is at offset 12 in the tfhd box
 * (after size[4] + type[4] + version_flags[4]).
 */
function rewriteTrackId(data: Uint8Array, newTrackId: number): void {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;

  while (offset + 8 <= data.length) {
    const size = view.getUint32(offset);
    if (size < 8 || offset + size > data.length) break;
    const type = String.fromCharCode(
      data[offset + 4], data[offset + 5], data[offset + 6], data[offset + 7],
    );

    if (type === 'moof' || type === 'traf') {
      // Recurse into container boxes (skip 8-byte header)
      rewriteTrackId(
        new Uint8Array(data.buffer, data.byteOffset + offset + 8, size - 8),
        newTrackId,
      );
    } else if (type === 'tfhd') {
      // tfhd: size(4) + 'tfhd'(4) + version_flags(4) + track_id(4)
      if (size >= 16) {
        const tfhdView = new DataView(data.buffer, data.byteOffset + offset);
        tfhdView.setUint32(12, newTrackId);
      }
    }

    offset += size;
  }
}
