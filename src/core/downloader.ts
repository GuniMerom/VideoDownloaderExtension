// Download orchestrator for video segments and direct files

import { muxStreams, isFFmpegAvailable, concatenateSegments } from './muxer';

const DEFAULT_CONCURRENCY = 4;
const MAX_RETRIES = 3;

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
): Promise<ArrayBuffer> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      return await response.arrayBuffer();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < retries) {
        // Exponential backoff: 500ms, 1000ms, 2000ms
        await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
      }
    }
  }
  throw lastError ?? new Error('Download failed after retries');
}

export async function downloadSegmented(
  segments: string[],
  onProgress?: ProgressCallback,
): Promise<Blob> {
  const total = segments.length;
  let completed = 0;
  const results = new Array<ArrayBuffer>(total);

  // Process segments in batches with concurrency limit
  const queue = segments.map((url, index) => ({ url, index }));
  const workers: Promise<void>[] = [];

  const processQueue = async (): Promise<void> => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;

      const buffer = await fetchWithRetry(item.url);
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
