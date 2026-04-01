// Service Worker (Background Script) - Central coordinator for the extension
// CRITICAL: All chrome.* event listeners MUST be registered at module scope (MV3 requirement)

import type {
  VideoInfo,
  VideoStream,
  DetectedVideo,
  DownloadTask,
  ExtensionSettings,
} from '../shared/types';
import { DEFAULT_SETTINGS } from '../shared/types';
import type {
  ExtensionMessage,
  AnalyzeUrlResponse,
  DetectedVideosResponse,
  PageVideosResponse,
} from '../shared/messages';
import { getSettings, saveSettings, getDownloadHistory, addToHistory, getDetectedVideosForTab, setDetectedVideosForTab, clearTabData } from '../core/storage';
import { downloadDirect, downloadSegmented, downloadAndMerge, triggerBrowserDownload } from '../core/downloader';
import { downloadAllSubtitles } from '../core/subtitle-extractor';
import { isMasterPlaylist, parseMasterPlaylist, parseMediaPlaylist } from '../core/hls-parser';
import { parseMPD, getVideoRepresentations, resolveSegmentUrls } from '../core/dash-parser';
import { selectBestStreams } from '../core/quality-selector';
import { providerRegistry } from '../providers/provider-registry';
import type { ExtractionContext } from '../providers/provider-interface';

// ─── In-memory state ───

const activeDownloads = new Map<string, DownloadTask>();

// ─── Helpers ───

function generateTaskId(): string {
  return `dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function generateVideoId(): string {
  return `vid_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Safely send a message to the popup or other extension pages. */
function safeSendMessage(message: ExtensionMessage): void {
  chrome.runtime.sendMessage(message).catch(() => {
    // Popup may not be open — swallow the "Could not establish connection" error
  });
}

/** Update the extension badge with the number of detected videos for a tab. */
async function updateBadge(tabId: number): Promise<void> {
  try {
    const videos = await getDetectedVideosForTab(tabId);
    const count = videos.length;
    const text = count > 0 ? String(count) : '';
    await chrome.action.setBadgeText({ text, tabId });
    if (count > 0) {
      await chrome.action.setBadgeBackgroundColor({ color: '#4CAF50', tabId });
    }
  } catch {
    // Tab may have been closed between the call and the badge update
  }
}

// ─── Message handler (registered at module scope) ───

chrome.runtime.onMessage.addListener(
  (message: ExtensionMessage, sender, sendResponse) => {
    // Every branch that needs async work must call handleMessageAsync and return true
    handleMessage(message, sender, sendResponse);
    return true; // keep the message channel open for async responses
  },
);

async function handleMessage(
  message: ExtensionMessage,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
): Promise<void> {
  try {
    switch (message.type) {
      case 'VIDEO_DETECTED':
        await handleVideoDetected(message.video, sender);
        sendResponse({ success: true });
        break;

      case 'STREAM_DETECTED':
        await handleStreamDetected(message.manifests, sender);
        sendResponse({ success: true });
        break;

      case 'ANALYZE_URL':
        sendResponse(await handleAnalyzeUrl(message.url));
        break;

      case 'DOWNLOAD_VIDEO':
        sendResponse(
          await handleDownloadVideo(
            message.videoInfo,
            message.selectedStream,
            message.audioStream,
            message.downloadSubtitles,
          ),
        );
        break;

      case 'GET_DETECTED_VIDEOS':
        sendResponse(await handleGetDetectedVideos(message.tabId));
        break;

      case 'GET_DOWNLOAD_HISTORY':
        sendResponse(await getDownloadHistory());
        break;

      case 'GET_SETTINGS':
        sendResponse(await getSettings());
        break;

      case 'UPDATE_SETTINGS':
        await saveSettings(message.settings as Partial<ExtensionSettings>);
        sendResponse({ success: true });
        break;

      case 'GET_PAGE_VIDEOS':
        // This is handled by the content script, not the service worker
        sendResponse({ videos: [] } satisfies PageVideosResponse);
        break;

      default:
        sendResponse({ error: 'Unknown message type' });
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[SW] Error handling message ${message.type}:`, errorMsg);
    sendResponse({ error: errorMsg });
  }
}

// ─── Individual message handlers ───

async function handleVideoDetected(
  video: DetectedVideo,
  sender: chrome.runtime.MessageSender,
): Promise<void> {
  const tabId = sender.tab?.id;
  if (tabId == null) return;

  video.tabId = tabId;
  video.frameId = sender.frameId;
  if (!video.id) {
    video.id = generateVideoId();
  }

  const existing = await getDetectedVideosForTab(tabId);

  // Deduplicate by URL
  const isDuplicate = existing.some((v) => v.url === video.url);
  if (!isDuplicate) {
    existing.push(video);
    await setDetectedVideosForTab(tabId, existing);
    await updateBadge(tabId);
  }
}

async function handleStreamDetected(
  manifests: Array<{ url: string; type: 'hls' | 'dash' | 'mp4'; timestamp: number }>,
  sender: chrome.runtime.MessageSender,
): Promise<void> {
  const tabId = sender.tab?.id;
  if (tabId == null) return;

  const existing = await getDetectedVideosForTab(tabId);

  for (const manifest of manifests) {
    // Deduplicate
    if (existing.some((v) => v.url === manifest.url)) continue;

    // Try to identify the provider from the manifest URL
    let providerName = 'unknown';
    try {
      const provider = providerRegistry.getProviderForUrl(manifest.url);
      if (provider) {
        providerName = provider.name;
      }
    } catch {
      // Provider identification is best-effort
    }

    const detected: DetectedVideo = {
      id: generateVideoId(),
      type: 'stream',
      url: manifest.url,
      provider: providerName,
      tabId,
      frameId: sender.frameId,
    };
    existing.push(detected);
  }

  await setDetectedVideosForTab(tabId, existing);
  await updateBadge(tabId);
}

async function handleAnalyzeUrl(url: string): Promise<AnalyzeUrlResponse> {
  try {
    const provider = providerRegistry.getProviderForUrl(url);
    if (!provider) {
      return { success: false, error: 'No provider found for this URL' };
    }

    const context: ExtractionContext = { url, pageUrl: url };
    const videoInfo = await provider.extractVideoInfo(context);
    return { success: true, videoInfo };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return { success: false, error: errorMsg };
  }
}

async function handleGetDetectedVideos(
  tabId: number,
): Promise<DetectedVideosResponse> {
  const videos = await getDetectedVideosForTab(tabId);
  return { videos };
}

async function handleDownloadVideo(
  videoInfo: VideoInfo,
  selectedStream: VideoStream,
  audioStream: VideoStream | undefined,
  downloadSubs: boolean,
): Promise<{ taskId: string }> {
  const taskId = generateTaskId();

  const task: DownloadTask = {
    id: taskId,
    videoInfo,
    selectedStream,
    audioStream,
    subtitleTracks: downloadSubs ? videoInfo.subtitles : undefined,
    status: 'pending',
    progress: 0,
    startedAt: Date.now(),
  };

  activeDownloads.set(taskId, task);

  // Run the download asynchronously — don't block the response
  executeDownload(task).catch((err) => {
    console.error(`[SW] Download ${taskId} failed:`, err);
  });

  return { taskId };
}

// ─── Download execution ───

async function executeDownload(task: DownloadTask): Promise<void> {
  task.status = 'downloading';
  broadcastProgress(task);

  const onProgress = (progress: number) => {
    task.progress = progress;
    broadcastProgress(task);
  };

  try {
    const stream = task.selectedStream;
    const format = stream.format?.toLowerCase() ?? '';
    const isSegmented = format === 'hls' || format === 'dash' ||
      stream.url.includes('.m3u8') || stream.url.includes('.mpd');

    const sanitizedTitle = task.videoInfo.title
      .replace(/[<>:"/\\|?*]/g, '_')
      .replace(/\s+/g, ' ')
      .trim();
    const extension = getFileExtension(stream);
    const filename = `${sanitizedTitle}.${extension}`;

    if (stream.type === 'muxed' && !isSegmented) {
      // Direct download of a muxed file (mp4/webm)
      await downloadDirect(stream.url, filename);
    } else if (task.audioStream) {
      // Separate video + audio streams → download both and mux
      await downloadAndMerge(
        stream.url,
        task.audioStream.url,
        filename,
        onProgress,
      );
    } else if (isSegmented) {
      // HLS/DASH segmented stream — resolve manifest to actual segment URLs
      const segmentUrls = await resolveManifestToSegments(stream.url);
      const segmentBlob = await downloadSegmented(segmentUrls, onProgress);
      await triggerBrowserDownload(segmentBlob, filename);
    } else {
      // Fallback: treat as direct download
      await downloadDirect(stream.url, filename);
    }

    // Download subtitles if requested
    if (task.subtitleTracks && task.subtitleTracks.length > 0) {
      try {
        await downloadAllSubtitles(task.subtitleTracks, task.videoInfo.title);
      } catch (subErr) {
        console.warn('[SW] Subtitle download failed (non-fatal):', subErr);
      }
    }

    task.status = 'complete';
    task.progress = 100;
    task.completedAt = Date.now();
    task.outputFilename = filename;

    // Persist to download history
    await addToHistory(task);

    safeSendMessage({
      type: 'DOWNLOAD_COMPLETE',
      taskId: task.id,
      filename,
    });

    // Show notification if enabled
    try {
      const settings = await getSettings();
      if (settings.showNotifications) {
        chrome.notifications?.create({
          type: 'basic',
          iconUrl: 'assets/icon-128.png',
          title: 'Download Complete',
          message: `${sanitizedTitle} has been downloaded.`,
        });
      }
    } catch {
      // Notifications permission may not be available
    }
  } catch (err) {
    task.status = 'error';
    task.error = err instanceof Error ? err.message : String(err);
    task.completedAt = Date.now();
    broadcastProgress(task);
  } finally {
    // Clean up from in-memory map after a delay so the popup can query final status
    setTimeout(() => {
      activeDownloads.delete(task.id);
    }, 60_000);
  }
}

function broadcastProgress(task: DownloadTask): void {
  safeSendMessage({
    type: 'DOWNLOAD_PROGRESS',
    taskId: task.id,
    progress: task.progress,
    status: task.status,
    error: task.error,
  });
}

function getFileExtension(stream: VideoStream): string {
  if (stream.format) {
    const fmt = stream.format.toLowerCase();
    if (fmt === 'mp4' || fmt === 'webm' || fmt === 'mkv') return fmt;
  }
  if (stream.codec?.includes('vp9') || stream.codec?.includes('vp8')) return 'webm';
  return 'mp4';
}

/**
 * Resolve an HLS/DASH manifest URL into an array of actual segment URLs.
 * For HLS: fetches the manifest, picks the highest-quality variant if master,
 * then returns segment URLs from the media playlist.
 * For DASH: fetches the MPD, picks the highest-bandwidth video representation,
 * and resolves segment URLs from templates or segment lists.
 */
async function resolveManifestToSegments(manifestUrl: string): Promise<string[]> {
  const response = await fetch(manifestUrl);
  const text = await response.text();

  if (manifestUrl.includes('.m3u8') || text.trimStart().startsWith('#EXTM3U')) {
    // HLS manifest
    if (isMasterPlaylist(text)) {
      const master = parseMasterPlaylist(text, manifestUrl);
      if (master.variants.length === 0) {
        throw new Error('No HLS variants found in master playlist');
      }
      // Pick highest bandwidth variant
      const best = master.variants.sort((a, b) => b.bandwidth - a.bandwidth)[0];
      // Fetch and parse the media playlist
      const mediaResp = await fetch(best.url);
      const mediaText = await mediaResp.text();
      const media = parseMediaPlaylist(mediaText, best.url);
      return media.segments.map(s => s.url);
    } else {
      const media = parseMediaPlaylist(text, manifestUrl);
      return media.segments.map(s => s.url);
    }
  } else if (manifestUrl.includes('.mpd') || text.trimStart().startsWith('<?xml') || text.trimStart().startsWith('<MPD')) {
    // DASH manifest
    const parsed = parseMPD(text, manifestUrl);
    const videoReps = getVideoRepresentations(parsed);
    if (videoReps.length === 0) {
      throw new Error('No DASH video representations found');
    }
    // Pick highest bandwidth representation
    const best = videoReps[0]; // already sorted by bandwidth desc
    return resolveSegmentUrls(best, manifestUrl);
  }

  // Fallback: treat the URL itself as a single segment
  return [manifestUrl];
}

// ─── Tab lifecycle (registered at module scope) ───

chrome.tabs.onRemoved.addListener((tabId) => {
  clearTabData(tabId).catch(() => {
    // Best-effort cleanup
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // When the URL changes (new navigation), clear old detection data
  if (changeInfo.url) {
    clearTabData(tabId)
      .then(() => updateBadge(tabId))
      .catch(() => {
        // Best-effort cleanup
      });
  }
});

// ─── Keep badge in sync when the active tab changes ───

chrome.tabs.onActivated.addListener(({ tabId }) => {
  updateBadge(tabId).catch(() => {});
});

// ─── Extension install / update ───

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    // Initialize default settings on first install
    try {
      await saveSettings(DEFAULT_SETTINGS);
    } catch {
      // Storage write may fail in rare edge cases
    }
  }
  console.log(`[SW] Extension ${details.reason}: v${chrome.runtime.getManifest().version}`);
});
