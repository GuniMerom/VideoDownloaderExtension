import { useState, useEffect, useCallback } from 'preact/hooks';
import type { VideoInfo, DetectedVideo, DownloadTask, VideoStream, SubtitleTrack } from '../shared/types';
import type {
  AnalyzeUrlResponse,
  DetectedVideosResponse,
  DownloadProgressMessage,
  DownloadCompleteMessage,
} from '../shared/messages';
import { LinkInput } from './components/LinkInput';
import { VideoCard } from './components/VideoCard';
import { DownloadProgress } from './components/DownloadProgress';

export function App() {
  const [urlInput, setUrlInput] = useState('');
  const [analyzing, setAnalyzing] = useState(false);
  const [videoInfo, setVideoInfo] = useState<VideoInfo | null>(null);
  const [detectedVideos, setDetectedVideos] = useState<DetectedVideo[]>([]);
  const [downloadTasks, setDownloadTasks] = useState<Map<string, DownloadTask>>(new Map());
  const [error, setError] = useState<string | null>(null);

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

  // Listen for download progress and completion messages
  useEffect(() => {
    const listener = (message: DownloadProgressMessage | DownloadCompleteMessage) => {
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

  const handleDetectedDownload = useCallback(
    (video: DetectedVideo) => {
      // Create a minimal VideoInfo from the detected video and trigger analysis
      handleAnalyze(video.url);
    },
    [handleAnalyze]
  );

  const activeTasks = Array.from(downloadTasks.values());

  return (
    <div class="popup-container">
      <header class="popup-header">
        <h1>
          <span class="header-icon">🎬</span> Video Downloader
        </h1>
      </header>

      <main class="popup-body">
        <section class="section">
          <LinkInput
            onAnalyze={handleAnalyze}
            analyzing={analyzing}
            error={error ?? undefined}
          />
        </section>

        {videoInfo && (
          <section class="section">
            <VideoCard videoInfo={videoInfo} onDownload={handleDownload} />
          </section>
        )}

        {detectedVideos.length > 0 && (
          <section class="section">
            <h2 class="section-title">
              <span class="section-icon">📡</span> Detected on this page
            </h2>
            <div class="detected-list">
              {detectedVideos.map((video) => (
                <div class="detected-item" key={video.id}>
                  <div class="detected-info">
                    {video.thumbnail && (
                      <img
                        class="detected-thumb"
                        src={video.thumbnail}
                        alt=""
                      />
                    )}
                    <div class="detected-meta">
                      <span class="detected-title">
                        {video.title || 'Untitled Video'}
                      </span>
                      <span class={`provider-badge provider-${video.provider.toLowerCase()}`}>
                        {video.provider}
                      </span>
                    </div>
                  </div>
                  <button
                    class="btn btn-sm btn-primary"
                    onClick={() => handleDetectedDownload(video)}
                  >
                    Download ▾
                  </button>
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
      </main>
    </div>
  );
}
