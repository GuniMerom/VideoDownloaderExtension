// Download orchestrator for video segments and direct files

import { muxStreams, isFFmpegAvailable, concatenateSegments } from './muxer';

const DEFAULT_CONCURRENCY = 4;
const MAX_RETRIES = 3;
const SEGMENT_TIMEOUT_MS = 30_000;

export type ProgressCallback = (progress: number) => void;

export async function downloadDirect(
  url: string,
  filename: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    chrome.downloads.download({ url, filename, saveAs: false }, (downloadId) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (downloadId === undefined) {
        reject(new Error('Download failed: no download ID returned'));
        return;
      }
      resolve(downloadId);
    });
  });
}

async function fetchWithRetry(
  url: string,
  retries: number = MAX_RETRIES,
  segmentIndex?: number,
  externalSignal?: AbortSignal,
): Promise<ArrayBuffer> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    // Check if cancelled before attempting
    if (externalSignal?.aborted) {
      throw new Error('Download cancelled');
    }

    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), SEGMENT_TIMEOUT_MS);

    // Combine external signal and timeout signal
    const onExternalAbort = () => timeoutController.abort();
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

    try {
      const response = await fetch(url, { signal: timeoutController.signal });
      if (!response.ok) {
        const segInfo = segmentIndex !== undefined ? ` (segment ${segmentIndex + 1})` : '';
        throw new Error(`HTTP ${response.status} ${response.statusText}${segInfo}`);
      }
      return await response.arrayBuffer();
    } catch (err) {
      if (externalSignal?.aborted) {
        throw new Error('Download cancelled');
      }

      if (err instanceof Error) {
        // Distinguish network errors from HTTP errors
        if (err.name === 'AbortError') {
          const segInfo = segmentIndex !== undefined ? ` (segment ${segmentIndex + 1})` : '';
          lastError = new Error(`Request timed out after ${SEGMENT_TIMEOUT_MS / 1000}s${segInfo}`);
        } else if (err.name === 'TypeError') {
          // TypeError from fetch usually means network failure
          const segInfo = segmentIndex !== undefined ? ` (segment ${segmentIndex + 1})` : '';
          lastError = new Error(`Network error: ${err.message}${segInfo}`);
        } else {
          lastError = err;
        }
      } else {
        lastError = new Error(String(err));
      }

      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
      }
    } finally {
      clearTimeout(timeoutId);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }
  }

  const segInfo = segmentIndex !== undefined ? ` segment ${segmentIndex + 1}` : '';
  throw lastError ?? new Error(`Download failed after ${retries} retries:${segInfo}`);
}

export async function downloadSegmented(
  segments: string[],
  onProgress?: ProgressCallback,
  abortSignal?: AbortSignal,
): Promise<Blob> {
  const total = segments.length;
  let completed = 0;
  const results = new Array<ArrayBuffer>(total);

  // Process segments in batches with concurrency limit
  const queue = segments.map((url, index) => ({ url, index }));
  const workers: Promise<void>[] = [];

  const processQueue = async (): Promise<void> => {
    while (queue.length > 0) {
      if (abortSignal?.aborted) {
        throw new Error('Download cancelled');
      }

      const item = queue.shift();
      if (!item) break;

      const buffer = await fetchWithRetry(item.url, MAX_RETRIES, item.index, abortSignal);
      results[item.index] = buffer;

      completed++;
      if (onProgress) {
        onProgress(Math.round((completed / total) * 100));
      }
    }
  };

  const concurrency = Math.min(DEFAULT_CONCURRENCY, total);
  for (let i = 0; i < concurrency; i++) {
    workers.push(processQueue());
  }

  await Promise.all(workers);

  return concatenateSegments(results);
}

export async function downloadAndMerge(
  videoUrl: string,
  audioUrl: string | undefined,
  filename: string,
  onProgress?: ProgressCallback,
): Promise<void> {
  if (!audioUrl) {
    // No separate audio — direct download
    await downloadDirect(videoUrl, filename);
    return;
  }

  // Download both video and audio
  const reportVideoProgress = onProgress
    ? (p: number) => onProgress(Math.round(p * 0.45))
    : undefined;
  const reportAudioProgress = onProgress
    ? (p: number) => onProgress(45 + Math.round(p * 0.45))
    : undefined;

  const [videoBuffer, audioBuffer] = await Promise.all([
    fetchWithProgress(videoUrl, reportVideoProgress),
    fetchWithProgress(audioUrl, reportAudioProgress),
  ]);

  const videoBlob = new Blob([videoBuffer]);
  const audioBlob = new Blob([audioBuffer]);

  if (isFFmpegAvailable()) {
    if (onProgress) onProgress(90);
    const muxedBlob = await muxStreams(videoBlob, audioBlob, 'mp4');
    if (onProgress) onProgress(95);
    await triggerBrowserDownload(muxedBlob, filename);
  } else {
    // FFmpeg not available — download as separate files
    const ext = filename.lastIndexOf('.');
    const baseName = ext > 0 ? filename.substring(0, ext) : filename;
    const extension = ext > 0 ? filename.substring(ext) : '.mp4';

    await triggerBrowserDownload(videoBlob, `${baseName}_video${extension}`);
    await triggerBrowserDownload(audioBlob, `${baseName}_audio${extension}`);
  }

  if (onProgress) onProgress(100);
}

async function fetchWithProgress(
  url: string,
  onProgress?: (percent: number) => void,
): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const contentLength = response.headers.get('Content-Length');
  if (!contentLength || !response.body) {
    const buffer = await response.arrayBuffer();
    if (onProgress) onProgress(100);
    return buffer;
  }

  const total = parseInt(contentLength, 10);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (onProgress) {
      onProgress(Math.round((received / total) * 100));
    }
  }

  const result = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result.buffer;
}

export async function triggerBrowserDownload(
  blob: Blob,
  filename: string,
): Promise<number> {
  const url = URL.createObjectURL(blob);
  return new Promise((resolve, reject) => {
    chrome.downloads.download({ url, filename, saveAs: false }, (downloadId) => {
      // Revoke after a short delay to ensure the download has started
      setTimeout(() => URL.revokeObjectURL(url), 10_000);

      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (downloadId === undefined) {
        reject(new Error('Download failed: no download ID returned'));
        return;
      }
      resolve(downloadId);
    });
  });
}
