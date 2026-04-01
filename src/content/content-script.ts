// Content Script — Runs on all pages to detect videos and intercept network requests
// Operates in the content script isolated world; uses an injected <script> for page-context interception.

import type { DetectedVideo } from '../shared/types';
import type {
  ExtensionMessage,
  PageVideosResponse,
} from '../shared/messages';

// ─── State ───

const detectedVideos: DetectedVideo[] = [];
const processedElements = new WeakSet<Element>();
const seenUrls = new Set<string>();

// Known embed patterns for provider detection (duplicated as simple strings
// so the content script bundle stays self-contained — the full provider registry
// lives in the service worker context).
const EMBED_PATTERNS: Array<{ provider: string; pattern: RegExp }> = [
  { provider: 'youtube', pattern: /youtube\.com\/embed\//i },
  { provider: 'youtube', pattern: /youtube-nocookie\.com\/embed\//i },
  { provider: 'vimeo', pattern: /player\.vimeo\.com\/video\//i },
  { provider: 'dailymotion', pattern: /dailymotion\.com\/embed\/video\//i },
  { provider: 'wistia', pattern: /fast\.wistia\.(net|com)\/embed\//i },
  { provider: 'vidyard', pattern: /play\.vidyard\.com\//i },
  { provider: 'brightcove', pattern: /players\.brightcove\.net\//i },
  { provider: 'jwplayer', pattern: /cdn\.jwplayer\.com\//i },
  { provider: 'kaltura', pattern: /cdnapisec\.kaltura\.com\//i },
  { provider: 'panopto', pattern: /\.panopto\.com\//i },
];

// ─── Helpers ───

function generateId(): string {
  return `cs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Safely send a message to the service worker. Catches errors when SW is unavailable. */
function sendToServiceWorker(message: ExtensionMessage): void {
  try {
    chrome.runtime.sendMessage(message).catch(() => {
      // Service worker may be inactive or extension context invalidated
    });
  } catch {
    // chrome.runtime may be undefined if the extension was unloaded
  }
}

function isVideoUrl(url: string): boolean {
  if (!url) return false;
  try {
    const u = new URL(url, location.href);
    const path = u.pathname.toLowerCase();
    return (
      path.endsWith('.mp4') ||
      path.endsWith('.webm') ||
      path.endsWith('.m3u8') ||
      path.endsWith('.mpd') ||
      path.endsWith('.ogg') ||
      path.endsWith('.ogv')
    );
  } catch {
    return false;
  }
}

function resolveUrl(url: string): string {
  try {
    return new URL(url, location.href).href;
  } catch {
    return url;
  }
}

function addDetectedVideo(video: DetectedVideo): void {
  if (seenUrls.has(video.url)) return;
  seenUrls.add(video.url);
  detectedVideos.push(video);
  sendToServiceWorker({ type: 'VIDEO_DETECTED', video });
}

// ─── DOM Scanning ───

function scanVideoElement(el: HTMLVideoElement): void {
  if (processedElements.has(el)) return;
  processedElements.add(el);

  // Direct src
  if (el.src && isVideoUrl(el.src)) {
    addDetectedVideo({
      id: generateId(),
      type: 'html5',
      url: resolveUrl(el.src),
      title: el.title || document.title,
      provider: 'html5',
    });
  }

  // currentSrc (set after source selection)
  if (el.currentSrc && el.currentSrc !== el.src && isVideoUrl(el.currentSrc)) {
    addDetectedVideo({
      id: generateId(),
      type: 'html5',
      url: resolveUrl(el.currentSrc),
      title: el.title || document.title,
      provider: 'html5',
    });
  }

  // <source> children
  const sources = el.querySelectorAll('source');
  sources.forEach((source) => {
    const srcUrl = source.getAttribute('src');
    if (srcUrl && isVideoUrl(srcUrl)) {
      addDetectedVideo({
        id: generateId(),
        type: 'html5',
        url: resolveUrl(srcUrl),
        title: el.title || document.title,
        provider: 'html5',
      });
    }
  });

  // If the video has a src but we couldn't detect the URL type, still report it.
  // The service worker can attempt analysis later.
  if (el.src && !isVideoUrl(el.src) && el.src.startsWith('http')) {
    addDetectedVideo({
      id: generateId(),
      type: 'html5',
      url: resolveUrl(el.src),
      title: el.title || document.title,
      provider: 'html5',
    });
  }

  // Re-check when metadata loads (currentSrc may not be set until then)
  el.addEventListener(
    'loadedmetadata',
    () => {
      if (el.currentSrc && !seenUrls.has(resolveUrl(el.currentSrc))) {
        addDetectedVideo({
          id: generateId(),
          type: 'html5',
          url: resolveUrl(el.currentSrc),
          title: el.title || document.title,
          provider: 'html5',
        });
      }
    },
    { once: true },
  );
}

function scanIframeElement(iframe: HTMLIFrameElement): void {
  if (processedElements.has(iframe)) return;
  processedElements.add(iframe);

  const src = iframe.src || iframe.getAttribute('data-src') || '';
  if (!src) return;

  const resolvedSrc = resolveUrl(src);

  for (const { provider, pattern } of EMBED_PATTERNS) {
    if (pattern.test(resolvedSrc)) {
      addDetectedVideo({
        id: generateId(),
        type: 'iframe',
        url: resolvedSrc,
        title: iframe.title || document.title,
        provider,
      });
      return;
    }
  }
}

function scanDocument(): void {
  document.querySelectorAll('video').forEach((el) => scanVideoElement(el as HTMLVideoElement));
  document.querySelectorAll('iframe').forEach((el) => scanIframeElement(el as HTMLIFrameElement));
}

// ─── Mutation Observer ───

const observer = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (!(node instanceof HTMLElement)) continue;

      if (node.tagName === 'VIDEO') {
        scanVideoElement(node as HTMLVideoElement);
      } else if (node.tagName === 'IFRAME') {
        scanIframeElement(node as HTMLIFrameElement);
      } else if (node.tagName === 'SOURCE') {
        const parent = node.parentElement;
        if (parent?.tagName === 'VIDEO') {
          scanVideoElement(parent as HTMLVideoElement);
        }
      }

      // Also scan descendants
      node.querySelectorAll?.('video')?.forEach((v) => scanVideoElement(v as HTMLVideoElement));
      node.querySelectorAll?.('iframe')?.forEach((f) => scanIframeElement(f as HTMLIFrameElement));
    }

    // Handle attribute changes on existing elements (e.g., src changed)
    if (mutation.type === 'attributes' && mutation.target instanceof HTMLElement) {
      const target = mutation.target;
      if (target.tagName === 'VIDEO') {
        processedElements.delete(target);
        scanVideoElement(target as HTMLVideoElement);
      } else if (target.tagName === 'IFRAME') {
        processedElements.delete(target);
        scanIframeElement(target as HTMLIFrameElement);
      }
    }
  }
});

observer.observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['src', 'data-src'],
});

// ─── Network Interception (injected into page context) ───

function injectNetworkInterceptor(): void {
  const scriptContent = `
(function() {
  'use strict';
  const STREAM_EXTENSIONS = /\\.(m3u8|mpd|mp4|webm)(\\?|$)/i;
  const STREAM_CONTENT_TYPES = /application\\/(x-mpegURL|dash\\+xml|vnd\\.apple\\.mpegurl)/i;
  const detected = new Set();

  function reportStream(url, type) {
    if (!url || detected.has(url)) return;
    detected.add(url);
    try {
      window.postMessage({
        __videoDownloaderStream: true,
        url: url,
        type: type,
        timestamp: Date.now(),
      }, '*');
    } catch(e) {}
  }

  function classifyUrl(url) {
    if (!url) return null;
    if (/\\.m3u8(\\?|$)/i.test(url)) return 'hls';
    if (/\\.mpd(\\?|$)/i.test(url)) return 'dash';
    if (/\\.(mp4|webm)(\\?|$)/i.test(url)) return 'mp4';
    return null;
  }

  // ── Patch fetch ──
  const originalFetch = window.fetch;
  window.fetch = function(input, init) {
    try {
      const url = (typeof input === 'string') ? input
                : (input instanceof URL) ? input.href
                : (input instanceof Request) ? input.url
                : null;
      if (url) {
        const type = classifyUrl(url);
        if (type) reportStream(url, type);
      }
    } catch(e) {}
    return originalFetch.apply(this, arguments);
  };

  // ── Patch XMLHttpRequest ──
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    try {
      const urlStr = (typeof url === 'string') ? url
                   : (url instanceof URL) ? url.href
                   : String(url);
      const type = classifyUrl(urlStr);
      if (type) reportStream(urlStr, type);
    } catch(e) {}
    return originalOpen.apply(this, arguments);
  };
})();
`;

  try {
    const script = document.createElement('script');
    script.textContent = scriptContent;
    (document.head || document.documentElement).appendChild(script);
    script.remove(); // Clean up — the code has already executed
  } catch {
    // CSP may block inline scripts on some pages — this is expected and non-fatal
    console.debug('[VideoDownloader] Network interceptor blocked by CSP');
  }
}

// ─── Listen for messages from the injected page script ───

window.addEventListener('message', (event) => {
  // Only accept messages from the same frame
  if (event.source !== window) return;

  const data = event.data;
  if (!data || data.__videoDownloaderStream !== true) return;

  const { url, type, timestamp } = data as {
    url: string;
    type: 'hls' | 'dash' | 'mp4';
    timestamp: number;
  };

  if (!url || seenUrls.has(url)) return;

  // Report stream to service worker
  sendToServiceWorker({
    type: 'STREAM_DETECTED',
    manifests: [{ url, type, timestamp }],
  });

  // Also track locally as a detected video
  addDetectedVideo({
    id: generateId(),
    type: 'stream',
    url,
    title: document.title,
    provider: 'unknown',
  });
});

// ─── Message handler: respond to popup and service worker queries ───

chrome.runtime.onMessage.addListener(
  (message: ExtensionMessage, _sender, sendResponse) => {
    if (message.type === 'GET_PAGE_VIDEOS') {
      sendResponse({ videos: detectedVideos } satisfies PageVideosResponse);
    }
    // Return false for synchronous responses
    return false;
  },
);

// ─── Initialization ───

function init(): void {
  // Inject network interceptor first so we catch early requests
  injectNetworkInterceptor();

  // Scan existing DOM (may already have video elements if run_at is document_start
  // and the parser has added some, or document_idle)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scanDocument, { once: true });
  } else {
    scanDocument();
  }
}

init();
