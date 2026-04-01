// Service Worker (Background Script) - Central coordinator for the extension
// CRITICAL: All chrome.* event listeners MUST be registered at module scope (MV3 requirement)

import type {
  VideoInfo,
  VideoStream,
  DetectedVideo,
  DownloadTask,
  ExtensionSettings,
  AnalyzedVideo,
} from '../shared/types';
import { DEFAULT_SETTINGS } from '../shared/types';
import type {
  ExtensionMessage,
  AnalyzeUrlResponse,
  DetectedVideosResponse,
  PageVideosResponse,
} from '../shared/messages';
import { getSettings, saveSettings, getDownloadHistory, addToHistory, clearHistory, getAnalyzedVideosForTab, setAnalyzedVideosForTab, clearTabData } from '../core/storage';
import { downloadDirect, downloadAndMerge, triggerBrowserDownload } from '../core/downloader';
import { downloadAllSubtitles } from '../core/subtitle-extractor';
import { isMasterPlaylist, parseMasterPlaylist, parseMediaPlaylist } from '../core/hls-parser';
import { parseMPD, getVideoRepresentations, resolveSegmentUrls } from '../core/dash-parser';
import { selectBestStreams } from '../core/quality-selector';
import { providerRegistry } from '../providers/provider-registry';
import type { ExtractionContext } from '../providers/provider-interface';
import type { PageContextFetchResponse } from '../shared/messages';

// ─── In-memory state ───

const activeDownloads = new Map<string, DownloadTask>();
/** URLs currently being auto-analyzed (prevents duplicate concurrent analysis) */
const analyzingUrls = new Set<string>();

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
    const videos = await getAnalyzedVideosForTab(tabId);
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

      case 'CLEAR_HISTORY':
        await clearHistory();
        sendResponse({ success: true });
        break;

      case 'OFFSCREEN_PROGRESS': {
        const activeTask = activeDownloads.get(message.taskId);
        if (activeTask) {
          activeTask.progress = message.progress;
          broadcastProgress(activeTask);
        }
        sendResponse({ ok: true });
        break;
      }

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

// ─── Page-context fetch helper ───

/**
 * Ask the content script running in the given tab to perform a fetch
 * in the page context. The page-context fetch carries the user's cookies,
 * which is required for authenticated video platforms (e.g., course sites).
 */
async function fetchViaContentScript(
  tabId: number,
  url: string,
  options?: RequestInit,
): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(
      tabId,
      { type: 'PAGE_CONTEXT_FETCH', url, options },
      (response: PageContextFetchResponse | undefined) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (response?.success) {
          resolve(response.data!);
        } else {
          reject(new Error(response?.error || 'Page context fetch failed'));
        }
      },
    );
  });
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

  const existing = await getAnalyzedVideosForTab(tabId);

  // Deduplicate by URL
  const isDuplicate = existing.some((v) => v.detected.url === video.url);
  if (!isDuplicate) {
    const analyzed: AnalyzedVideo = {
      detected: video,
      status: 'analyzing',
    };
    existing.push(analyzed);
    await setAnalyzedVideosForTab(tabId, existing);
    await updateBadge(tabId);

    // Fire-and-forget auto-analysis
    autoAnalyzeVideo(analyzed, tabId, sender.tab?.url).catch((err) => {
      console.error('[SW] Auto-analysis failed:', err);
    });
  }
}

async function handleStreamDetected(
  manifests: Array<{ url: string; type: 'hls' | 'dash' | 'mp4'; timestamp: number }>,
  sender: chrome.runtime.MessageSender,
): Promise<void> {
  const tabId = sender.tab?.id;
  if (tabId == null) return;

  const existing = await getAnalyzedVideosForTab(tabId);
  const newAnalyzed: AnalyzedVideo[] = [];

  for (const manifest of manifests) {
    // Deduplicate
    if (existing.some((v) => v.detected.url === manifest.url)) continue;

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
    const analyzed: AnalyzedVideo = {
      detected,
      status: 'analyzing',
    };
    existing.push(analyzed);
    newAnalyzed.push(analyzed);
  }

  await setAnalyzedVideosForTab(tabId, existing);
  await updateBadge(tabId);

  // Fire-and-forget auto-analysis for each new stream
  for (const analyzed of newAnalyzed) {
    autoAnalyzeVideo(analyzed, tabId, sender.tab?.url).catch((err) => {
      console.error('[SW] Auto-analysis of stream failed:', err);
    });
  }
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
  const videos = await getAnalyzedVideosForTab(tabId);
  return { videos };
}

/**
 * Auto-analyze a detected video in the background.
 * On completion, updates storage and notifies the popup via VIDEO_ANALYZED.
 */
async function autoAnalyzeVideo(
  analyzedVideo: AnalyzedVideo,
  tabId: number,
  pageUrl?: string,
): Promise<void> {
  const url = analyzedVideo.detected.url;
  if (analyzingUrls.has(url)) return;
  analyzingUrls.add(url);

  try {
    const provider = providerRegistry.getProviderForUrl(url)
      ?? providerRegistry.getProviderForUrl(pageUrl ?? url);

    if (provider) {
      const context: ExtractionContext = { url, pageUrl: pageUrl ?? url };
      try {
        const videoInfo = await provider.extractVideoInfo(context);
        analyzedVideo.status = 'ready';
        analyzedVideo.videoInfo = videoInfo;
      } catch {
        // Provider extraction failed — try authenticated page-context fetch
        try {
          const html = await fetchViaContentScript(tabId, pageUrl ?? url);
          const contextWithHtml: ExtractionContext = { url, pageUrl: pageUrl ?? url, pageHtml: html };
          const videoInfo = await provider.extractVideoInfo(contextWithHtml);
          analyzedVideo.status = 'ready';
          analyzedVideo.videoInfo = videoInfo;
        } catch (innerErr) {
          analyzedVideo.status = 'error';
          analyzedVideo.error = innerErr instanceof Error ? innerErr.message : String(innerErr);
        }
      }
    } else {
      // No provider found — mark as error
      analyzedVideo.status = 'error';
      analyzedVideo.error = 'No provider found for this URL';
    }
  } catch (err) {
    analyzedVideo.status = 'error';
    analyzedVideo.error = err instanceof Error ? err.message : String(err);
  } finally {
    analyzingUrls.delete(url);
  }

  // Persist updated analysis to storage
  try {
    const videos = await getAnalyzedVideosForTab(tabId);
    const idx = videos.findIndex((v) => v.detected.id === analyzedVideo.detected.id);
    if (idx !== -1) {
      videos[idx] = analyzedVideo;
    } else {
      videos.push(analyzedVideo);
    }
    await setAnalyzedVideosForTab(tabId, videos);
  } catch {
    // Storage update may fail if tab was closed
  }

  // Notify popup of completed analysis
  safeSendMessage({
    type: 'VIDEO_ANALYZED',
    videoId: analyzedVideo.detected.id,
    analyzedVideo,
  });
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

// ─── Offscreen document management ───

async function ensureOffscreen(): Promise<void> {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  if (existingContexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: [chrome.offscreen.Reason.BLOBS],
    justification: 'Download and concatenate video segments',
  });
}

// ─── Download execution ───

/**
 * Keep the service worker alive during long operations.
 * MV3 service workers are killed after ~30s of inactivity.
 * We use chrome.alarms as a keepalive mechanism.
 */
const KEEPALIVE_ALARM = 'download-keepalive';

function startKeepalive(): void {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.4 });
}

function stopKeepalive(): void {
  chrome.alarms.clear(KEEPALIVE_ALARM);
}

// Listen for the keepalive alarm — just handling it keeps the SW alive
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    // No-op: just receiving this event keeps the service worker alive
  }
});

async function executeDownload(task: DownloadTask): Promise<void> {
  task.status = 'downloading';
  broadcastProgress(task);
  startKeepalive();

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
      // HLS/DASH segmented stream — resolve manifest then download via offscreen document
      console.log('[SW] Resolving manifest to segments:', stream.url.substring(0, 100));
      const resolved = await resolveManifestToSegments(stream.url);
      console.log(`[SW] Video: ${resolved.videoSegments.length} segments, Audio: ${resolved.audioSegments?.length ?? 'none'}`);

      await ensureOffscreen();

      let result: { blobUrl?: string; size?: number; error?: string };

      if (resolved.audioSegments && resolved.audioSegments.length > 0) {
        // Has separate audio track — download both and merge in offscreen doc
        console.log('[SW] Merging video + audio tracks...');
        result = await chrome.runtime.sendMessage({
          type: 'OFFSCREEN_MERGE_TRACKS',
          videoSegmentUrls: resolved.videoSegments,
          audioSegmentUrls: resolved.audioSegments,
          taskId: task.id,
        }) as { blobUrl?: string; size?: number; error?: string };
      } else {
        // Video-only (already muxed)
        result = await chrome.runtime.sendMessage({
          type: 'OFFSCREEN_DOWNLOAD_SEGMENTS',
          segmentUrls: resolved.videoSegments,
          taskId: task.id,
        }) as { blobUrl?: string; size?: number; error?: string };
      }

      if (result.error) {
        throw new Error(result.error);
      }

      console.log(`[SW] Download complete, size: ${result.size} bytes`);
      await downloadDirect(result.blobUrl!, filename);
      await chrome.offscreen.closeDocument().catch(() => {});
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
    stopKeepalive();
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
 * Resolve an HLS/DASH manifest URL into segment URLs for downloading.
 * Returns { videoSegments, audioSegments? } where audio is included if the
 * HLS manifest uses separate audio tracks (common for Vimeo).
 */
interface ResolvedSegments {
  videoSegments: string[];
  audioSegments?: string[];
}

async function resolveManifestToSegments(manifestUrl: string): Promise<ResolvedSegments> {
  console.log('[SW] Fetching manifest:', manifestUrl.substring(0, 120));
  const response = await fetch(manifestUrl);
  if (!response.ok) {
    throw new Error(`Manifest fetch failed: HTTP ${response.status} ${response.statusText}`);
  }
  const text = await response.text();
  console.log(`[SW] Manifest fetched: ${text.length} bytes, starts with: ${text.substring(0, 50)}`);

  if (text.trimStart().startsWith('#EXTM3U') || manifestUrl.includes('.m3u8')) {
    if (isMasterPlaylist(text)) {
      const master = parseMasterPlaylist(text, manifestUrl);
      if (master.variants.length === 0) {
        throw new Error('No HLS variants found in master playlist');
      }
      const best = master.variants.sort((a, b) => b.bandwidth - a.bandwidth)[0];

      // Parse the video media playlist
      const mediaResp = await fetch(best.url);
      const mediaText = await mediaResp.text();
      const media = parseMediaPlaylist(mediaText, best.url);
      const videoUrls = media.segments.map(s => s.url);
      if (media.initSegment?.url) {
        videoUrls.unshift(media.initSegment.url);
      }

      // Check for separate audio track in master playlist
      const audioMatch = text.match(/#EXT-X-MEDIA:.*?TYPE=AUDIO.*?URI="([^"]+)"/);
      let audioUrls: string[] | undefined;
      if (audioMatch) {
        const audioPlaylistUrl = new URL(audioMatch[1], manifestUrl).href;
        console.log('[SW] Separate audio track found, fetching:', audioPlaylistUrl.substring(0, 100));
        try {
          const audioResp = await fetch(audioPlaylistUrl);
          const audioText = await audioResp.text();
          const audioMedia = parseMediaPlaylist(audioText, audioPlaylistUrl);
          audioUrls = audioMedia.segments.map(s => s.url);
          if (audioMedia.initSegment?.url) {
            audioUrls.unshift(audioMedia.initSegment.url);
          }
          console.log(`[SW] Audio: ${audioUrls.length} segments (including init)`);
        } catch (audioErr) {
          console.warn('[SW] Audio track fetch failed (non-fatal):', audioErr);
        }
      }

      return { videoSegments: videoUrls, audioSegments: audioUrls };
    } else {
      // Direct media playlist (specific variant selected by user)
      const media = parseMediaPlaylist(text, manifestUrl);
      const urls = media.segments.map(s => s.url);
      if (media.initSegment?.url) {
        urls.unshift(media.initSegment.url);
      }

      // If this is a video-only variant, try to find audio from the master playlist
      // The variant URL was derived from a master — reconstruct the master URL
      // by going up to the primary playlist level
      // For now, return video-only; the caller should handle audio separately
      return { videoSegments: urls };
    }
  } else if (manifestUrl.includes('.mpd') || text.trimStart().startsWith('<?xml') || text.trimStart().startsWith('<MPD')) {
    const parsed = parseMPD(text, manifestUrl);
    const videoReps = getVideoRepresentations(parsed);
    if (videoReps.length === 0) {
      throw new Error('No DASH video representations found');
    }
    const best = videoReps[0];
    return { videoSegments: resolveSegmentUrls(best, manifestUrl) };
  }

  return { videoSegments: [manifestUrl] };
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
