// Subtitle download manager

import type { SubtitleTrack } from '../shared/types';

const INVALID_FILENAME_CHARS = /[<>:"/\\|?*\x00-\x1F]/g;
const MAX_FILENAME_LENGTH = 200;

export function sanitizeFilename(name: string): string {
  return name
    .replace(INVALID_FILENAME_CHARS, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, MAX_FILENAME_LENGTH);
}

function buildSubtitleFilename(
  videoTitle: string,
  track: SubtitleTrack,
): string {
  const safeName = sanitizeFilename(videoTitle);
  const lang = track.language || 'und';
  const ext = track.format === 'unknown' ? 'txt' : track.format;
  return `${safeName}.${lang}.${ext}`;
}

export async function downloadSubtitle(
  track: SubtitleTrack,
  videoTitle: string,
): Promise<number> {
  const filename = buildSubtitleFilename(videoTitle, track);

  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      { url: track.url, filename, saveAs: false },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (downloadId === undefined) {
          reject(new Error('Subtitle download failed: no download ID returned'));
          return;
        }
        resolve(downloadId);
      },
    );
  });
}

export async function downloadAllSubtitles(
  tracks: SubtitleTrack[],
  videoTitle: string,
): Promise<Array<{ track: SubtitleTrack; downloadId?: number; error?: string }>> {
  const results: Array<{ track: SubtitleTrack; downloadId?: number; error?: string }> = [];

  for (const track of tracks) {
    try {
      const downloadId = await downloadSubtitle(track, videoTitle);
      results.push({ track, downloadId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ track, error: message });
    }
  }

  return results;
}
