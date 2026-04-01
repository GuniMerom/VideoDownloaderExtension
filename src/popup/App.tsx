import { useState, useEffect, useCallback } from 'preact/hooks';
import type { VideoInfo, DownloadTask, VideoStream, AnalyzedVideo } from '../shared/types';
import type {
  AnalyzeUrlResponse,
  DetectedVideosResponse,
  DownloadProgressMessage,
  DownloadCompleteMessage,
  VideoAnalyzedMessage,
} from '../shared/messages';
import { LinkInput } from './components/LinkInput';
import { VideoCard } from './components/VideoCard';
import { DownloadProgress } from './components/DownloadProgress';
import { Settings } from './components/Settings';

export function App() {
  const [urlInput, setUrlInput] = useState('');
  const [analyzing, setAnalyzing] = useState(false);
  const [videoInfo, setVideoInfo] = useState<VideoInfo | null>(null);
  const [detectedVideos, setDetectedVideos] = useState<AnalyzedVideo[]>([]);
  const [downloadTasks, setDownloadTasks] = useState<Map<string, DownloadTask>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  // Fetch detected videos from the current tab on mount
  useEffect(() => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab?.id) return;

      chrome.runtime.sendMessage(
        { type: 'GET_DETECTED_VIDEOS', tabId: tab.id },
        (response: DetectedVideosResponse | undefined) => {
          if (chrome.runtime.lastError) return;
          if (response?.videos) {
            setDetectedVideos(response.videos);
          }
        }
      );
    });
  }, []);

  // Listen for download progress, completion, and video analyzed messages
  useEffect(() => {
    const listener = (message: DownloadProgressMessage | DownloadCompleteMessage | VideoAnalyzedMessage) => {
      if (message.type === 'VIDEO_ANALYZED') {
        setDetectedVideos((prev) =>
          prev.map((v) =>
            v.detected.id === message.videoId ? message.analyzedVideo : v
          )
        );
        return;
      }

      if (message.type === 'DOWNLOAD_PROGRESS') {
        setDownloadTasks((prev) => {
          const next = new Map(prev);
          const existing = next.get(message.taskId);
          if (existing) {
            next.set(message.taskId, {
              ...existing,
              progress: message.progress,
              status: message.status,
              error: message.error,
            });
          }
          return next;
        });
      } else if (message.type === 'DOWNLOAD_COMPLETE') {
        setDownloadTasks((prev) => {
          const next = new Map(prev);
          const existing = next.get(message.taskId);
          if (existing) {
            next.set(message.taskId, {
              ...existing,
              status: 'complete',
              progress: 100,
              outputFilename: message.filename,
              completedAt: Date.now(),
            });
          }
          return next;
        });
      }
    };

    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  const handleAnalyze = useCallback(async (url: string) => {
    setAnalyzing(true);
    setError(null);
    setVideoInfo(null);
    setUrlInput(url);

    try {
      const response: AnalyzeUrlResponse = await chrome.runtime.sendMessage({
        type: 'ANALYZE_URL',
        url,
      });

      if (response.success && response.videoInfo) {
        setVideoInfo(response.videoInfo);
      } else {
        setError(response.error || 'Failed to analyze URL');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unexpected error occurred');
    } finally {
      setAnalyzing(false);
    }
  }, []);

  const handleDownload = useCallback(
    (
      info: VideoInfo,
      selectedStream: VideoStream,
      audioStream?: VideoStream,
      downloadSubs?: boolean
    ) => {
      const taskId = `dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const task: DownloadTask = {
        id: taskId,
        videoInfo: info,
        selectedStream,
        audioStream,
        subtitleTracks: downloadSubs ? info.subtitles : undefined,
        status: 'pending',
        progress: 0,
        startedAt: Date.now(),
      };

      setDownloadTasks((prev) => new Map(prev).set(taskId, task));

      chrome.runtime.sendMessage({
        type: 'DOWNLOAD_VIDEO',
        videoInfo: info,
        selectedStream,
        audioStream,
        downloadSubtitles: downloadSubs ?? false,
      });
    },
    []
  );

  const handleRetry = useCallback(
    async (video: AnalyzedVideo) => {
      // Set status to analyzing while we retry
      setDetectedVideos((prev) =>
        prev.map((v) =>
          v.detected.id === video.detected.id
            ? { ...v, status: 'analyzing' as const, error: undefined }
            : v
        )
      );

      try {
        const response: AnalyzeUrlResponse = await chrome.runtime.sendMessage({
          type: 'ANALYZE_URL',
          url: video.detected.url,
        });

        if (response.success && response.videoInfo) {
          setDetectedVideos((prev) =>
            prev.map((v) =>
              v.detected.id === video.detected.id
                ? { ...v, status: 'ready' as const, videoInfo: response.videoInfo, error: undefined }
                : v
            )
          );
        } else {
          setDetectedVideos((prev) =>
            prev.map((v) =>
              v.detected.id === video.detected.id
                ? { ...v, status: 'error' as const, error: response.error || 'Analysis failed' }
                : v
            )
          );
        }
      } catch (err) {
        setDetectedVideos((prev) =>
          prev.map((v) =>
            v.detected.id === video.detected.id
              ? { ...v, status: 'error' as const, error: err instanceof Error ? err.message : 'Unexpected error' }
              : v
          )
        );
      }
    },
    []
  );

  const activeTasks = Array.from(downloadTasks.values());

  // Ctrl+V keyboard shortcut: auto-paste-and-analyze
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
        // Let the LinkInput's own paste handler deal with focused input
        if ((e.target as HTMLElement)?.tagName === 'INPUT') return;

        try {
          const text = await navigator.clipboard.readText();
          const trimmed = text?.trim();
          if (trimmed && /^https?:\/\/.+/i.test(trimmed)) {
            handleAnalyze(trimmed);
          }
        } catch {
          // Clipboard access may be denied
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleAnalyze]);

  const hasNoContent = !videoInfo && detectedVideos.length === 0 && activeTasks.length === 0 && !analyzing;

  return (
    <div class="popup-container">
      <header class="popup-header">
        <h1>
          <span class="header-icon">🎬</span> Video Downloader
        </h1>
        <button
          class="btn-icon header-settings-btn"
          onClick={() => setShowSettings(!showSettings)}
          aria-label="Settings"
          title="Settings"
        >
          ⚙️
        </button>
      </header>

      {showSettings ? (
        <Settings onClose={() => setShowSettings(false)} />
      ) : (
        <main class="popup-body">
          <section class="section">
            <LinkInput
              onAnalyze={handleAnalyze}
              analyzing={analyzing}
              error={error ?? undefined}
            />
          </section>

          {analyzing && (
            <section class="section">
              <div class="loading-skeleton">
                <div class="skeleton-line skeleton-wide" />
                <div class="skeleton-line skeleton-medium" />
                <div class="skeleton-line skeleton-narrow" />
              </div>
            </section>
          )}

          {videoInfo && (
            <section class="section">
              <VideoCard videoInfo={videoInfo} onDownload={handleDownload} />
            </section>
          )}

          {detectedVideos.length > 0 && (
            <section class="section">
              <h2 class="section-title">
                <span class="section-icon">📡</span> Videos on this page ({detectedVideos.length})
              </h2>
              <div class="detected-list">
                {detectedVideos.map((video) => (
                  <div key={video.detected.id}>
                    {video.status === 'ready' && video.videoInfo ? (
                      <VideoCard videoInfo={video.videoInfo} onDownload={handleDownload} />
                    ) : video.status === 'analyzing' ? (
                      <div class="detected-item">
                        <div class="detected-info">
                          <div class="detected-meta">
                            <span class={`provider-badge provider-${video.detected.provider.toLowerCase()}`}>
                              {video.detected.provider}
                            </span>
                            <span class="detected-title">Analyzing {video.detected.provider} video...</span>
                          </div>
                        </div>
                        <div class="loading-spinner" />
                      </div>
                    ) : video.status === 'error' ? (
                      <div class="detected-item">
                        <div class="detected-info">
                          <div class="detected-meta">
                            <span class={`provider-badge provider-${video.detected.provider.toLowerCase()}`}>
                              {video.detected.provider}
                            </span>
                            <span class="detected-title error-text">
                              {video.error || 'Analysis failed'}
                            </span>
                          </div>
                        </div>
                        <button
                          class="btn btn-sm btn-primary"
                          onClick={() => handleRetry(video)}
                        >
                          Retry
                        </button>
                      </div>
                    ) : (
                      <div class="detected-item">
                        <div class="detected-info">
                          <div class="detected-meta">
                            <span class={`provider-badge provider-${video.detected.provider.toLowerCase()}`}>
                              {video.detected.provider}
                            </span>
                            <span class="detected-title">
                              Detected {video.detected.provider} video — waiting for analysis...
                            </span>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {activeTasks.length > 0 && (
            <section class="section">
              <DownloadProgress tasks={activeTasks} />
            </section>
          )}

          {hasNoContent && (
            <section class="section">
              <div class="empty-state">
                <span class="empty-state-icon">🔍</span>
                <p class="empty-state-text">No videos detected on this page.</p>
                <p class="empty-state-hint">Try pasting a URL above.</p>
              </div>
            </section>
          )}
        </main>
      )}
    </div>
  );
}
