// Message type definitions for extension communication
// Content Script ↔ Service Worker ↔ Popup

import type { DetectedVideo, VideoInfo, VideoStream, DownloadTask } from './types';

// ─── Content Script → Service Worker ───

export interface VideoDetectedMessage {
  type: 'VIDEO_DETECTED';
  video: DetectedVideo;
}

export interface StreamDetectedMessage {
  type: 'STREAM_DETECTED';
  manifests: Array<{ url: string; type: 'hls' | 'dash' | 'mp4'; timestamp: number }>;
}

export interface PageVideoScanMessage {
  type: 'PAGE_VIDEO_SCAN';
  videos: DetectedVideo[];
}

// ─── Popup → Service Worker ───

export interface AnalyzeUrlMessage {
  type: 'ANALYZE_URL';
  url: string;
}

export interface DownloadVideoMessage {
  type: 'DOWNLOAD_VIDEO';
  videoInfo: VideoInfo;
  selectedStream: VideoStream;
  audioStream?: VideoStream;
  downloadSubtitles: boolean;
}

export interface GetDetectedVideosMessage {
  type: 'GET_DETECTED_VIDEOS';
  tabId: number;
}

export interface GetDownloadHistoryMessage {
  type: 'GET_DOWNLOAD_HISTORY';
}

export interface GetSettingsMessage {
  type: 'GET_SETTINGS';
}

export interface UpdateSettingsMessage {
  type: 'UPDATE_SETTINGS';
  settings: Record<string, unknown>;
}

// ─── Service Worker → Popup / Content Script ───

export interface AnalyzeUrlResponse {
  success: boolean;
  videoInfo?: VideoInfo;
  error?: string;
}

export interface DetectedVideosResponse {
  videos: DetectedVideo[];
}

export interface DownloadProgressMessage {
  type: 'DOWNLOAD_PROGRESS';
  taskId: string;
  progress: number;
  status: DownloadTask['status'];
  error?: string;
}

export interface DownloadCompleteMessage {
  type: 'DOWNLOAD_COMPLETE';
  taskId: string;
  filename: string;
}

// ─── Content Script ↔ Popup ───

export interface GetPageVideosMessage {
  type: 'GET_PAGE_VIDEOS';
}

export interface PageVideosResponse {
  videos: DetectedVideo[];
}

// ─── Union type for all messages ───

export type ExtensionMessage =
  | VideoDetectedMessage
  | StreamDetectedMessage
  | PageVideoScanMessage
  | AnalyzeUrlMessage
  | DownloadVideoMessage
  | GetDetectedVideosMessage
  | GetDownloadHistoryMessage
  | GetSettingsMessage
  | UpdateSettingsMessage
  | DownloadProgressMessage
  | DownloadCompleteMessage
  | GetPageVideosMessage;
