import { useState, useEffect } from 'preact/hooks';
import type { VideoStream } from '../../shared/types';

interface QualitySelectorProps {
  streams: VideoStream[];
  audioStreams?: VideoStream[];
  onSelect: (video: VideoStream, audio?: VideoStream) => void;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function streamLabel(stream: VideoStream): string {
  const parts: string[] = [];

  parts.push(stream.resolution || stream.quality);

  if (stream.codec) {
    parts.push(`(${stream.codec}`);
    if (stream.fileSize) {
      parts[parts.length - 1] += `, ${formatFileSize(stream.fileSize)}`;
    }
    parts[parts.length - 1] += ')';
  } else if (stream.fileSize) {
    parts.push(`(${formatFileSize(stream.fileSize)})`);
  }

  if (stream.frameRate && stream.frameRate !== '30') {
    parts.push(`${stream.frameRate}fps`);
  }

  return parts.join(' ');
}

function findBestStream(streams: VideoStream[]): number {
  if (streams.length === 0) return -1;

  // Sort by bandwidth descending and pick the best
  let bestIdx = 0;
  let bestBandwidth = streams[0].bandwidth ?? 0;

  for (let i = 1; i < streams.length; i++) {
    const bw = streams[i].bandwidth ?? 0;
    if (bw > bestBandwidth) {
      bestBandwidth = bw;
      bestIdx = i;
    }
  }
  return bestIdx;
}

export function QualitySelector({
  streams,
  audioStreams,
  onSelect,
}: QualitySelectorProps) {
  const muxedStreams = streams.filter((s) => s.type === 'muxed');
  const videoOnlyStreams = streams.filter((s) => s.type === 'video');
  const allStreams = [...muxedStreams, ...videoOnlyStreams];

  const bestIdx = findBestStream(allStreams);
  const [selectedIdx, setSelectedIdx] = useState(bestIdx >= 0 ? bestIdx : 0);

  // Auto-select best quality on mount
  useEffect(() => {
    if (allStreams.length > 0) {
      const best = bestIdx >= 0 ? bestIdx : 0;
      setSelectedIdx(best);
      const bestAudio =
        audioStreams && audioStreams.length > 0 ? audioStreams[0] : undefined;
      onSelect(allStreams[best], allStreams[best].type === 'video' ? bestAudio : undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleChange = (e: Event) => {
    const idx = parseInt((e.target as HTMLSelectElement).value, 10);
    setSelectedIdx(idx);

    const stream = allStreams[idx];
    const audio =
      stream.type === 'video' && audioStreams && audioStreams.length > 0
        ? audioStreams[0]
        : undefined;
    onSelect(stream, audio);
  };

  if (allStreams.length === 0) {
    return <p class="no-streams">No downloadable streams found</p>;
  }

  return (
    <div class="quality-selector">
      <label class="quality-label" htmlFor="quality-select">
        Quality
      </label>
      <select
        id="quality-select"
        class="quality-dropdown"
        value={selectedIdx}
        onChange={handleChange}
      >
        {muxedStreams.length > 0 && (
          <optgroup label="Video + Audio">
            {muxedStreams.map((stream, i) => (
              <option key={`muxed-${i}`} value={i}>
                {streamLabel(stream)}
              </option>
            ))}
          </optgroup>
        )}
        {videoOnlyStreams.length > 0 && (
          <optgroup label="Video Only">
            {videoOnlyStreams.map((stream, i) => (
              <option key={`video-${i}`} value={muxedStreams.length + i}>
                {streamLabel(stream)}
              </option>
            ))}
          </optgroup>
        )}
      </select>
    </div>
  );
}
