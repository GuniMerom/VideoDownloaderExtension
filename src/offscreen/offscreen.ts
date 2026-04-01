// Offscreen document for downloading and concatenating video segments.
// Runs as a regular web page (not a service worker) so fetch() calls
// are not subject to the MV3 30-second service worker timeout.

const MAX_RETRIES = 3;
const SEGMENT_TIMEOUT_MS = 60_000;

chrome.runtime.onMessage.addListener(
  (message: { type: string; segmentUrls?: string[]; taskId?: string }, _sender, sendResponse) => {
    if (message.type === 'OFFSCREEN_DOWNLOAD_SEGMENTS') {
      downloadAndConcatenate(message.segmentUrls!, message.taskId!)
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ error: err instanceof Error ? err.message : String(err) }));
      return true; // keep channel open for async response
    }
  },
);

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

    // Report progress back to service worker (95% for download, 5% for concat)
    chrome.runtime.sendMessage({
      type: 'OFFSCREEN_PROGRESS',
      taskId,
      progress: Math.round(((i + 1) / total) * 95),
    }).catch(() => {
      // Service worker may not be listening — non-fatal
    });
  }

  const blob = new Blob(buffers, { type: 'video/mp4' });
  const blobUrl = URL.createObjectURL(blob);
  return { blobUrl, size: blob.size };
}
