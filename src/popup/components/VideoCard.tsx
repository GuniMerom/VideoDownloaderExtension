import { useState } from 'preact/hooks';
import type { VideoInfo, VideoStream } from '../../shared/types';
import { QualitySelector } from './QualitySelector';

interface VideoCardProps {
  videoInfo: VideoInfo;
  onDownload: (
    videoInfo: VideoInfo,
    selectedStream: VideoStream,
    audioStream?: VideoStream,
    downloadSubs?: boolean
  ) => void;
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function VideoCard({ videoInfo, onDownload }: VideoCardProps) {
  const [selectedVideo, setSelectedVideo] = useState<VideoStream | null>(null);
  const [selectedAudio, setSelectedAudio] = useState<VideoStream | undefined>(undefined);
  const [downloadSubs, setDownloadSubs] = useState(videoInfo.subtitles.length > 0);

  const videoStreams = videoInfo.streams.filter((s) => s.type === 'video' || s.type === 'muxed');
  const audioStreams = videoInfo.streams.filter((s) => s.type === 'audio');

  const handleQualitySelect = (video: VideoStream, audio?: VideoStream) => {
    setSelectedVideo(video);
    setSelectedAudio(audio);
  };

  const handleDownload = () => {
    const stream = selectedVideo || videoStreams[0];
    if (!stream) return;
    onDownload(videoInfo, stream, selectedAudio, downloadSubs);
  };

  return (
    <div class="video-card">
      <div class="video-card-header">
        {videoInfo.thumbnail && (
          <img class="video-thumb" src={videoInfo.thumbnail} alt="" />
        )}
        <div class="video-meta">
          <h3 class="video-title">{videoInfo.title}</h3>
          <div class="video-details">
            <span class={`provider-badge provider-${videoInfo.provider.toLowerCase()}`}>
              {videoInfo.provider}
            </span>
            {videoInfo.duration != null && videoInfo.duration > 0 && (
              <span class="video-duration">
                ⏱ {formatDuration(videoInfo.duration)}
              </span>
            )}
          </div>
        </div>
      </div>

      <div class="video-card-body">
        <QualitySelector
          streams={videoStreams}
          audioStreams={audioStreams.length > 0 ? audioStreams : undefined}
          onSelect={handleQualitySelect}
        />

        {videoInfo.subtitles.length > 0 && (
          <div class="subtitle-toggle">
            <label class="checkbox-label">
              <input
                type="checkbox"
                checked={downloadSubs}
                onChange={(e) =>
                  setDownloadSubs((e.target as HTMLInputElement).checked)
                }
              />
              <span>
                Download subtitles ({videoInfo.subtitles.map((s) => s.language).join(', ')})
              </span>
            </label>
          </div>
        )}

        <button
          class="btn btn-primary btn-block download-btn"
          onClick={handleDownload}
          disabled={videoStreams.length === 0}
        >
          ⬇ Download
        </button>
      </div>
    </div>
  );
}
