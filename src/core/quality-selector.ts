// Quality selection logic for video streams

import type { VideoInfo, VideoStream } from '../shared/types';

interface SelectedStreams {
  video: VideoStream;
  audio?: VideoStream;
}

const QUALITY_HEIGHT_MAP: Record<string, number> = {
  '2160p': 2160,
  '1440p': 1440,
  '1080p': 1080,
  '720p': 720,
  '480p': 480,
  '360p': 360,
  '240p': 240,
  '144p': 144,
};

function parseResolutionHeight(resolution?: string): number {
  if (!resolution) return 0;
  const match = resolution.match(/(\d+)x(\d+)/);
  return match ? parseInt(match[2], 10) : 0;
}

function parseQualityHeight(quality: string): number {
  const match = quality.match(/(\d+)p/i);
  return match ? parseInt(match[1], 10) : 0;
}

function streamScore(stream: VideoStream): number {
  const height = parseResolutionHeight(stream.resolution) || parseQualityHeight(stream.quality);
  return height || (stream.bandwidth ?? 0);
}

export function sortStreamsByQuality(streams: VideoStream[]): VideoStream[] {
  return [...streams].sort((a, b) => {
    const scoreA = streamScore(a);
    const scoreB = streamScore(b);
    if (scoreB !== scoreA) return scoreB - scoreA;
    return (b.bandwidth ?? 0) - (a.bandwidth ?? 0);
  });
}

export function selectBestStreams(
  videoInfo: VideoInfo,
  preferredQuality: string,
): SelectedStreams | null {
  const videoStreams = videoInfo.streams.filter(
    (s) => s.type === 'video' || s.type === 'muxed',
  );
  const audioStreams = videoInfo.streams.filter((s) => s.type === 'audio');

  if (videoStreams.length === 0) return null;

  let selectedVideo: VideoStream;

  if (preferredQuality === 'best') {
    // Pick the highest quality stream
    selectedVideo = sortStreamsByQuality(videoStreams)[0];
  } else {
    // Pick closest match to preferred quality
    const targetHeight = QUALITY_HEIGHT_MAP[preferredQuality] ?? parseQualityHeight(preferredQuality);
    if (targetHeight === 0) {
      selectedVideo = sortStreamsByQuality(videoStreams)[0];
    } else {
      selectedVideo = findClosestQuality(videoStreams, targetHeight);
    }
  }

  // If the selected stream is muxed, no separate audio needed
  if (selectedVideo.type === 'muxed') {
    return { video: selectedVideo };
  }

  // Find best audio stream for video-only stream
  const bestAudio = audioStreams.length > 0
    ? sortStreamsByQuality(audioStreams)[0]
    : undefined;

  return { video: selectedVideo, audio: bestAudio };
}

function findClosestQuality(
  streams: VideoStream[],
  targetHeight: number,
): VideoStream {
  let best = streams[0];
  let bestDiff = Infinity;

  for (const stream of streams) {
    const height =
      parseResolutionHeight(stream.resolution) ||
      parseQualityHeight(stream.quality);
    const diff = Math.abs(height - targetHeight);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = stream;
    }
  }

  return best;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function getQualityLabel(stream: VideoStream): string {
  let label = '';

  // Determine resolution label
  const height =
    parseResolutionHeight(stream.resolution) ||
    parseQualityHeight(stream.quality);
  if (height > 0) {
    label = `${height}p`;
  } else if (stream.quality) {
    label = stream.quality;
  } else if (stream.bandwidth) {
    label = `${Math.round(stream.bandwidth / 1000)} kbps`;
  } else {
    label = 'Unknown';
  }

  // Append codec info
  if (stream.codec) {
    label += ` ${stream.codec}`;
  }

  // Append file size
  if (stream.fileSize) {
    label += ` (${formatFileSize(stream.fileSize)})`;
  }

  return label;
}
