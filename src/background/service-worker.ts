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
import {
  getSettings,
  saveSettings,
  getDownloadHistory,
  addToHistory,
  clearHistory,
  getAnalyzedVideosForTab,
  setAnalyzedVideosForTab,
  clearTabData,
} from '../core/storage';
import { downloadDirect, downloadAndMerge, triggerBrowserDownload } from '../core/downloader';
import { downloadAllSubtitles } from '../core/subtitle-extractor';
import {
  getDefaultAudioRendition,
  isMasterPlaylist,
  parseMasterPlaylist,
  parseMediaPlaylist,
} from '../core/hls-parser';
import { parseMPD, getVideoRepresentations, resolveSegmentUrls } from '../core/dash-parser';
import { providerRegistry } from '../providers/provider-registry';
import type { ExtractionContext } from '../providers/provider-interface';
import type { PageContextFetchResponse } from '../shared/messages';

const activeDownloads = new Map<string, DownloadTask>();
const analyzingUrls = new Set<string>();

function generateTaskId(): string {
  return `dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function generateVideoId(): string {
  return `vid_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function safeSendMessage(message: ExtensionMessage): void {
  chrome.runtime.sendMessage(message).catch(() => {
    // Popup may not be open.
  });
}

async function updateBadge(tabId: number): Promise<void> {
  try {
    const videos = await getAnalyzedVideosForTab(tabId);
    const count = videos.length;
    await chrome.action.setBadgeText({ text: count > 0 ? String(count) : '', tabId });
    if (count > 0) {
      await chrome.action.setBadgeBackgroundColor({ color: '#4CAF50', tabId });
    }
  } catch {
    // Tab may have been closed.
  }
}

chrome.runtime.onMessage.addListener((message: ExtensionMessage, sender, sendResponse) => {
  handleMessage(message, sender, sendResponse);
  return true;
});

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
        sendResponse({ videos: [] } satisfies PageVideosResponse);
        break;
      default:
        sendResponse({ error: 'Unknown message type' });
    }
  } catch (err) {
    sendResponse({ error: err instanceof Error ? err.message : String(err) });
  }
}

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

async function handleVideoDetected(
  video: DetectedVideo,
  sender: chrome.runtime.MessageSender,
): Promise<void> {
  const tabId = sender.tab?.id;
  if (tabId == null) return;

  const settings = await getSettings();
  if (!settings.autoDetect) return;

  video.tabId = tabId;
  video.frameId = sender.frameId;
  if (!video.id) {
    video.id = generateVideoId();
  }

  const existing = await getAnalyzedVideosForTab(tabId);
  const isDuplicate = existing.some((entry) => entry.detected.url === video.url);
  if (isDuplicate) return;

  const analyzed: AnalyzedVideo = {
    detected: video,
    status: 'analyzing',
  };
  existing.push(analyzed);
  await setAnalyzedVideosForTab(tabId, existing);
  await updateBadge(tabId);

  autoAnalyzeVideo(analyzed, tabId, sender.tab?.url).catch((err) => {
    console.error('[SW] Auto-analysis failed:', err);
  });
}

async function handleStreamDetected(
  manifests: Array<{ url: string; type: 'hls' | 'dash' | 'mp4'; timestamp: number }>,
  sender: chrome.runtime.MessageSender,
): Promise<void> {
  const tabId = sender.tab?.id;
  if (tabId == null) return;

  const settings = await getSettings();
  if (!settings.autoDetect) return;

  const existing = await getAnalyzedVideosForTab(tabId);
  const newAnalyzed: AnalyzedVideo[] = [];

  for (const manifest of manifests) {
    if (existing.some((entry) => entry.detected.url === manifest.url)) continue;

    let providerName = 'unknown';
    try {
      providerName = providerRegistry.getProviderForUrl(manifest.url)?.name ?? providerName;
    } catch {
      // Best effort only.
    }

    const analyzed: AnalyzedVideo = {
      detected: {
        id: generateVideoId(),
        type: 'stream',
        url: manifest.url,
        provider: providerName,
        tabId,
        frameId: sender.frameId,
      },
      status: 'analyzing',
    };

    existing.push(analyzed);
    newAnalyzed.push(analyzed);
  }

  await setAnalyzedVideosForTab(tabId, existing);
  await updateBadge(tabId);

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

    const videoInfo = await provider.extractVideoInfo({ url, pageUrl: url });
    const settings = await getSettings();
    if (settings.enabledProviders.length > 0 && !settings.enabledProviders.includes(videoInfo.provider)) {
      return { success: false, error: `Provider ${videoInfo.provider} is disabled in settings` };
    }

    return { success: true, videoInfo };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function handleGetDetectedVideos(tabId: number): Promise<DetectedVideosResponse> {
  return { videos: await getAnalyzedVideosForTab(tabId) };
}

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

    if (!provider) {
      analyzedVideo.status = 'error';
      analyzedVideo.error = 'No provider found for this URL';
    } else {
      const settings = await getSettings();
      if (settings.enabledProviders.length > 0 && !settings.enabledProviders.includes(provider.name)) {
        analyzedVideo.status = 'error';
        analyzedVideo.error = `Provider ${provider.name} is disabled in settings`;
      } else {
        const context: ExtractionContext = { url, pageUrl: pageUrl ?? url };
        try {
          analyzedVideo.videoInfo = await provider.extractVideoInfo(context);
          analyzedVideo.status = 'ready';
        } catch {
          try {
            const html = await fetchViaContentScript(tabId, pageUrl ?? url);
            analyzedVideo.videoInfo = await provider.extractVideoInfo({
              url,
              pageUrl: pageUrl ?? url,
              pageHtml: html,
            });
            analyzedVideo.status = 'ready';
          } catch (innerErr) {
            analyzedVideo.status = 'error';
            analyzedVideo.error = innerErr instanceof Error ? innerErr.message : String(innerErr);
          }
        }
      }
    }
  } catch (err) {
    analyzedVideo.status = 'error';
    analyzedVideo.error = err instanceof Error ? err.message : String(err);
  } finally {
    analyzingUrls.delete(url);
  }

  try {
    const videos = await getAnalyzedVideosForTab(tabId);
    const idx = videos.findIndex((entry) => entry.detected.id === analyzedVideo.detected.id);
    if (idx >= 0) {
      videos[idx] = analyzedVideo;
    } else {
      videos.push(analyzedVideo);
    }
    await setAnalyzedVideosForTab(tabId, videos);
  } catch {
    // Best effort only.
  }

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
  executeDownload(task).catch((err) => {
    console.error(`[SW] Download ${taskId} failed:`, err);
  });

  return { taskId };
}

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

const KEEPALIVE_ALARM = 'download-keepalive';

function startKeepalive(): void {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.4 });
}

function stopKeepalive(): void {
  chrome.alarms.clear(KEEPALIVE_ALARM);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    // No-op keepalive.
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
    const isSegmented = ['hls', 'dash', 'm3u8', 'mpd'].includes(format)
      || stream.url.includes('.m3u8')
      || stream.url.includes('.mpd');
    const audioIsSegmented = !!task.audioStream && (
      ['hls', 'dash', 'm3u8', 'mpd'].includes(task.audioStream.format?.toLowerCase() ?? '')
      || task.audioStream.url.includes('.m3u8')
      || task.audioStream.url.includes('.mpd')
    );

    const sanitizedTitle = task.videoInfo.title
      .replace(/[<>:"/\\|?*]/g, '_')
      .replace(/\s+/g, ' ')
      .trim();
    const filename = `${sanitizedTitle}.${getFileExtension(stream)}`;

    if (stream.type === 'muxed' && !isSegmented) {
      await downloadDirect(stream.url, filename);
      task.completionMessage = 'Saved as a single media file.';
    } else if (task.audioStream && (isSegmented || audioIsSegmented)) {
      task.status = 'muxing';
      broadcastProgress(task);

      const videoResolved = await resolveManifestToSegments(stream.url);
      const audioResolved = await resolveManifestToSegments(task.audioStream.url);

      await ensureOffscreen();

      const videoResult = await chrome.runtime.sendMessage({
        type: 'OFFSCREEN_DOWNLOAD_SEGMENTS',
        segmentUrls: videoResolved.videoSegments,
        taskId: task.id,
      }) as { blobUrl?: string; size?: number; error?: string };
      if (videoResult.error || !videoResult.blobUrl) {
        throw new Error(videoResult.error || 'Video assembly failed');
      }

      const audioResult = await chrome.runtime.sendMessage({
        type: 'OFFSCREEN_DOWNLOAD_SEGMENTS',
        segmentUrls: audioResolved.videoSegments,
        taskId: task.id,
      }) as { blobUrl?: string; size?: number; error?: string };
      if (audioResult.error || !audioResult.blobUrl) {
        throw new Error(audioResult.error || 'Audio assembly failed');
      }

      await downloadDirect(videoResult.blobUrl, filename.replace(/\.(mp4|webm|mkv)$/i, '_video.$1'));
      await downloadDirect(audioResult.blobUrl, `${sanitizedTitle}_audio.${getAudioExtension(task.audioStream)}`);
      task.completionMessage = 'Saved separate video and audio files because reliable in-browser muxing is not working for this stream yet.';
      await chrome.offscreen.closeDocument().catch(() => {});
    } else if (task.audioStream) {
      await downloadAndMerge(stream.url, task.audioStream.url, filename, onProgress);
      task.completionMessage = 'Saved media after downloading separate video and audio sources.';
    } else if (isSegmented) {
      const resolved = await resolveManifestToSegments(stream.url, { preferredAudioGroupId: stream.groupId });
      await ensureOffscreen();

      let result: { blobUrl?: string; size?: number; error?: string; mergeMode?: 'merged' | 'video-only-fallback' } | undefined;

      if (resolved.audioSegments && resolved.audioSegments.length > 0) {
        task.status = 'muxing';
        broadcastProgress(task);

        const videoResult = await chrome.runtime.sendMessage({
          type: 'OFFSCREEN_DOWNLOAD_SEGMENTS',
          segmentUrls: resolved.videoSegments,
          taskId: task.id,
        }) as { blobUrl?: string; size?: number; error?: string };
        if (videoResult.error || !videoResult.blobUrl) {
          throw new Error(videoResult.error || 'Video assembly failed');
        }

        const audioResult = await chrome.runtime.sendMessage({
          type: 'OFFSCREEN_DOWNLOAD_SEGMENTS',
          segmentUrls: resolved.audioSegments,
          taskId: task.id,
        }) as { blobUrl?: string; size?: number; error?: string };
        if (audioResult.error || !audioResult.blobUrl) {
          throw new Error(audioResult.error || 'Audio assembly failed');
        }

        await downloadDirect(videoResult.blobUrl, filename.replace(/\.(mp4|webm|mkv)$/i, '_video.$1'));
        await downloadDirect(audioResult.blobUrl, `${sanitizedTitle}_audio.${getAudioExtension(task.audioStream)}`);
        task.completionMessage = 'Saved separate video and audio files because reliable in-browser muxing is not working for this stream yet.';
        await chrome.offscreen.closeDocument().catch(() => {});
        result = undefined;
      } else {
        result = await chrome.runtime.sendMessage({
          type: 'OFFSCREEN_DOWNLOAD_SEGMENTS',
          segmentUrls: resolved.videoSegments,
          taskId: task.id,
        }) as { blobUrl?: string; size?: number; error?: string; mergeMode?: 'merged' | 'video-only-fallback' };
      }

      if (result?.error) {
        throw new Error(result.error);
      }

      if (result?.blobUrl) {
        await downloadDirect(result.blobUrl, filename);
        task.completionMessage = 'Saved as a single media file.';
        await chrome.offscreen.closeDocument().catch(() => {});
      }
    } else {
      await downloadDirect(stream.url, filename);
      task.completionMessage = 'Saved as a direct download.';
    }

    if (task.subtitleTracks && task.subtitleTracks.length > 0) {
      try {
        const subtitleResults = await downloadAllSubtitles(task.subtitleTracks, task.videoInfo.title);
        const downloadedSubtitleCount = subtitleResults.filter((result) => !!result.downloadId).length;
        if (downloadedSubtitleCount > 0) {
          task.completionMessage = `${task.completionMessage ?? 'Download complete.'} ${downloadedSubtitleCount} subtitle file(s) saved.`;
        }
      } catch (subErr) {
        console.warn('[SW] Subtitle download failed (non-fatal):', subErr);
      }
    }

    task.status = 'complete';
    task.progress = 100;
    task.completedAt = Date.now();
    task.outputFilename = filename;

    await addToHistory(task);

    safeSendMessage({
      type: 'DOWNLOAD_COMPLETE',
      taskId: task.id,
      filename,
    });

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
      // Notification permission may be unavailable.
    }
  } catch (err) {
    task.status = 'error';
    task.error = err instanceof Error ? err.message : String(err);
    task.completedAt = Date.now();
    broadcastProgress(task);
  } finally {
    stopKeepalive();
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
    const format = stream.format.toLowerCase();
    if (format === 'mp4' || format === 'webm' || format === 'mkv') {
      return format;
    }
  }
  if (stream.codec?.includes('vp9') || stream.codec?.includes('vp8')) {
    return 'webm';
  }
  return 'mp4';
}

function getAudioExtension(stream?: VideoStream): string {
  const format = stream?.format?.toLowerCase();
  if (format === 'mp4' || format === 'm4a' || format === 'aac' || format === 'mp3' || format === 'webm') {
    return format === 'mp4' ? 'm4a' : format;
  }
  if (stream?.codec?.includes('mp4a') || stream?.codec?.includes('aac')) {
    return 'm4a';
  }
  return 'm4a';
}

interface ResolvedSegments {
  videoSegments: string[];
  audioSegments?: string[];
}

async function resolveManifestToSegments(
  manifestUrl: string,
  options?: { preferredAudioGroupId?: string },
): Promise<ResolvedSegments> {
  const response = await fetch(manifestUrl);
  if (!response.ok) {
    throw new Error(`Manifest fetch failed: HTTP ${response.status} ${response.statusText}`);
  }

  const text = await response.text();

  if (text.trimStart().startsWith('#EXTM3U') || manifestUrl.includes('.m3u8')) {
    if (isMasterPlaylist(text)) {
      const master = parseMasterPlaylist(text, manifestUrl);
      if (master.variants.length === 0) {
        throw new Error('No HLS variants found in master playlist');
      }

      const best = [...master.variants].sort((a, b) => b.bandwidth - a.bandwidth)[0];
      const mediaResp = await fetch(best.url);
      const mediaText = await mediaResp.text();
      const media = parseMediaPlaylist(mediaText, best.url);
      const videoUrls = media.segments.map((segment) => segment.url);
      if (media.initSegment?.url) {
        videoUrls.unshift(media.initSegment.url);
      }

      const selectedAudio = getDefaultAudioRendition(master, options?.preferredAudioGroupId ?? best.audio);
      let audioUrls: string[] | undefined;
      if (selectedAudio?.uri) {
        try {
          const audioResp = await fetch(selectedAudio.uri);
          const audioText = await audioResp.text();
          const audioMedia = parseMediaPlaylist(audioText, selectedAudio.uri);
          audioUrls = audioMedia.segments.map((segment) => segment.url);
          if (audioMedia.initSegment?.url) {
            audioUrls.unshift(audioMedia.initSegment.url);
          }
        } catch (audioErr) {
          console.warn('[SW] Audio track fetch failed (non-fatal):', audioErr);
        }
      }

      return { videoSegments: videoUrls, audioSegments: audioUrls };
    }

    const media = parseMediaPlaylist(text, manifestUrl);
    const urls = media.segments.map((segment) => segment.url);
    if (media.initSegment?.url) {
      urls.unshift(media.initSegment.url);
    }
    return { videoSegments: urls };
  }

  if (manifestUrl.includes('.mpd') || text.trimStart().startsWith('<?xml') || text.trimStart().startsWith('<MPD')) {
    const parsed = parseMPD(text, manifestUrl);
    const videoReps = getVideoRepresentations(parsed);
    if (videoReps.length === 0) {
      throw new Error('No DASH video representations found');
    }
    return { videoSegments: resolveSegmentUrls(videoReps[0], manifestUrl) };
  }

  return { videoSegments: [manifestUrl] };
}

chrome.tabs.onRemoved.addListener((tabId) => {
  clearTabData(tabId).catch(() => {
    // Best effort cleanup.
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) {
    clearTabData(tabId)
      .then(() => updateBadge(tabId))
      .catch(() => {
        // Best effort cleanup.
      });
  }
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  updateBadge(tabId).catch(() => {
    // Best effort badge refresh.
  });
});

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    try {
      await saveSettings(DEFAULT_SETTINGS);
    } catch {
      // Best effort initialization.
    }
  }
  console.log(`[SW] Extension ${details.reason}: v${chrome.runtime.getManifest().version}`);
});
