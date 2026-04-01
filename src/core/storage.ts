// Chrome storage helpers

import type {
  ExtensionSettings,
  DownloadTask,
  AnalyzedVideo,
} from '../shared/types';
import { DEFAULT_SETTINGS } from '../shared/types';

const KEYS = {
  SETTINGS: 'settings',
  DOWNLOAD_HISTORY: 'downloadHistory',
  TAB_VIDEOS_PREFIX: 'tabVideos_',
} as const;

function storageGet<T>(key: string): Promise<T | undefined> {
  return new Promise((resolve) => {
    chrome.storage.local.get(key, (result) => {
      resolve(result[key] as T | undefined);
    });
  });
}

function storageSet(items: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set(items, resolve);
  });
}

function storageRemove(keys: string | string[]): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.remove(keys, resolve);
  });
}

// ─── Settings ───

export async function getSettings(): Promise<ExtensionSettings> {
  const stored = await storageGet<Partial<ExtensionSettings>>(KEYS.SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function saveSettings(
  settings: Partial<ExtensionSettings>,
): Promise<void> {
  const current = await getSettings();
  const merged = { ...current, ...settings };
  await storageSet({ [KEYS.SETTINGS]: merged });
}

// ─── Download History ───

export async function getDownloadHistory(): Promise<DownloadTask[]> {
  const history = await storageGet<DownloadTask[]>(KEYS.DOWNLOAD_HISTORY);
  return history ?? [];
}

export async function addToHistory(task: DownloadTask): Promise<void> {
  const history = await getDownloadHistory();
  history.unshift(task);
  await storageSet({ [KEYS.DOWNLOAD_HISTORY]: history });
}

export async function clearHistory(): Promise<void> {
  await storageSet({ [KEYS.DOWNLOAD_HISTORY]: [] });
}

// ─── Analyzed Videos per Tab ───

function tabKey(tabId: number): string {
  return `${KEYS.TAB_VIDEOS_PREFIX}${tabId}`;
}

export async function getAnalyzedVideosForTab(
  tabId: number,
): Promise<AnalyzedVideo[]> {
  const videos = await storageGet<AnalyzedVideo[]>(tabKey(tabId));
  return videos ?? [];
}

export async function setAnalyzedVideosForTab(
  tabId: number,
  videos: AnalyzedVideo[],
): Promise<void> {
  await storageSet({ [tabKey(tabId)]: videos });
}

// Backward-compatible aliases
export const getDetectedVideosForTab = getAnalyzedVideosForTab;
export const setDetectedVideosForTab = setAnalyzedVideosForTab;

export async function clearTabData(tabId: number): Promise<void> {
  await storageRemove(tabKey(tabId));
}
