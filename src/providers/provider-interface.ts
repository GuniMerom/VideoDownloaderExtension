import type { VideoInfo } from '../shared/types';

export interface ExtractionContext {
  url: string;
  pageUrl?: string;
  document?: Document;
  /** Pre-fetched page HTML from the page context (carries user cookies). */
  pageHtml?: string;
}

export interface VideoProvider {
  name: string;
  displayName: string;
  version: string;

  canHandleUrl(url: string): boolean;
  canHandlePage?(document: Document): boolean;
  getEmbedPatterns(): RegExp[];

  extractVideoInfo(context: ExtractionContext): Promise<VideoInfo>;
}
