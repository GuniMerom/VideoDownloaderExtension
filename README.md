# Video Downloader Extension

A Chrome browser extension (Manifest V3) that detects and downloads videos from online course platforms and embedded video players in the highest available quality. Outputs a single merged file (video + audio) with subtitles saved as separate `.vtt` / `.srt` files.

Built with a plugin-based architecture — adding support for a new video platform requires only a single provider file.

---

## Features

- **Paste & Download** — Paste any video URL into the popup, analyze it, and choose your preferred quality
- **Auto-Detection** — Automatically detects embedded `<video>` elements, `<iframe>` embeds, and network-level HLS/DASH streams on any page
- **15 Platform Providers** — Vimeo, Wistia, Brightcove, JW Player, Kaltura, Panopto, Loom, Vidyard, Dailymotion, Streamable, Cloudflare Stream, and more
- **Generic Stream Support** — Handles any HLS (`.m3u8`) or DASH (`.mpd`) manifest, including AES-128 encrypted HLS
- **Highest Quality** — Automatically selects the best available resolution and bitrate
- **Audio + Video Merge** — When video and audio are served as separate streams (common with DASH), downloads both and merges into a single file
- **Subtitles** — Downloads available captions/subtitles as separate `.vtt` / `.srt` files alongside the video
- **Player Framework Detection** — Detects Video.js, Plyr, MediaElement.js, Flowplayer, hls.js, and dash.js player instances
- **Dark Mode** — Follows system color scheme preference
- **Keyboard Shortcuts** — `Ctrl+Shift+D` to open popup, `Ctrl+V` to auto-paste and analyze

---

## Supported Platforms

### Site-Specific Providers

| Provider | Embed Detection Pattern | Protocols |
|----------|------------------------|-----------|
| **Vimeo** | `player.vimeo.com/video/{ID}` | HLS, MP4 |
| **Wistia** | `fast.wistia.net/embed/iframe/{ID}` | HLS, MP4 |
| **Brightcove** | `players.brightcove.net/{ACCT}/...` | HLS, DASH |
| **JW Player** | `cdn.jwplayer.com`, `jwplayer().setup()` | HLS, MP4, DASH |
| **Kaltura** | `cdnapisec.kaltura.com/p/{PID}/...` | HLS, DASH |
| **Panopto** | `*.hosted.panopto.com/Panopto/...` | HLS |
| **Vidyard** | `play.vidyard.com/{UUID}` | HLS, MP4 |
| **Loom** | `loom.com/embed/{ID}`, `loom.com/share/{ID}` | HLS, MP4 |
| **Dailymotion** | `dailymotion.com/embed/video/{ID}` | HLS |
| **Streamable** | `streamable.com/e/{ID}` | MP4 |
| **Cloudflare Stream** | `cloudflarestream.com/{ID}` | HLS, DASH |

### Generic Providers

| Provider | What It Handles |
|----------|----------------|
| **HTML5 Direct** | Any `<video>` or `<source>` element with a direct MP4/WebM URL |
| **Generic HLS** | Any `.m3u8` manifest URL detected in network traffic |
| **Generic DASH** | Any `.mpd` manifest URL detected in network traffic |
| **Encrypted HLS** | AES-128-CBC encrypted HLS streams (decrypts via Web Crypto API) |

### Player Framework Detection

The content script also detects these JavaScript-based players and extracts their configured video sources:

- Video.js (`window.videojs`)
- Plyr (`.plyr` class, `data-plyr-provider`)
- MediaElement.js (`window.mejs`)
- Flowplayer (`window.flowplayer`)
- hls.js (`window.Hls`)
- dash.js (`window.dashjs` / `window.MediaPlayer`)

---

## Requirements

- **Google Chrome** 110+ (or any Chromium-based browser: Edge, Brave, Vivaldi, Opera)
- **Node.js** 18+ and **npm** (for building from source)
- No external tools needed — all processing happens in-browser

---

## Installation (from source)

### 1. Clone the repository

```bash
git clone https://github.com/GuniMerom/VideoDownloaderExtension.git
cd VideoDownloaderExtension
```

### 2. Install dependencies

```bash
npm install
```

### 3. Build the extension

```bash
# Production build (minified)
npm run build

# Development build with file watching (rebuilds on save)
npm run dev
```

This creates a `dist/` folder containing the compiled extension.

### 4. Load into Chrome

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Select the `dist/` folder from this project
5. The extension icon (▶) appears in your toolbar

> **Tip:** Pin the extension to your toolbar for quick access (click the puzzle icon → pin).

### 5. Verify it works

1. Navigate to any page with an embedded video (e.g., a Vimeo embed)
2. Click the extension icon — detected videos should appear
3. Or paste a video URL directly into the input field and click **Analyze**

---

## Usage

### Paste a Link

1. Click the extension icon (or press `Ctrl+Shift+D`)
2. Paste a video URL into the input field (e.g., `https://player.vimeo.com/video/123456`)
3. Click **Analyze** (or press `Enter`)
4. Choose your preferred quality from the dropdown
5. Toggle subtitle download on/off
6. Click **Download**

### Auto-Detection

1. Browse to any page containing embedded videos
2. The extension badge shows a count of detected videos
3. Click the extension icon to see all detected videos
4. Select quality and click **Download** for any video

### Settings

Click the ⚙️ gear icon in the popup header to configure:

| Setting | Default | Description |
|---------|---------|-------------|
| Preferred Quality | Best | Auto-select: Best, 1080p, 720p, 480p, or 360p |
| Auto-Detect | On | Automatically scan pages for embedded videos |
| Download Subtitles | On | Download available captions alongside the video |
| Show Notifications | On | Browser notification when download completes |
| Enabled Providers | All | Enable/disable individual platform providers |

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+D` | Open the extension popup |
| `Ctrl+V` (in popup) | Auto-paste URL from clipboard and start analysis |
| `Enter` (in input) | Start analyzing the entered URL |

### Download Output

- **Video:** `{title}.mp4` (or `.webm` depending on source)
- **Subtitles:** `{title}.{language}.vtt` (e.g., `lesson-1.en.vtt`)
- Files are saved to your Chrome default download directory

---

## Architecture

```
src/
├── background/
│   └── service-worker.ts          # Central coordinator: message routing, download
│                                  # management, tab lifecycle, badge updates
├── content/
│   └── content-script.ts          # Per-page: DOM observer for <video>/<iframe>,
│                                  # network interceptor (fetch/XHR), player detection
├── core/
│   ├── hls-parser.ts              # HLS/M3U8 manifest parser (master + media playlists)
│   ├── dash-parser.ts             # DASH/MPD XML parser (periods, adaptation sets)
│   ├── downloader.ts              # Download orchestrator: direct, segmented (parallel
│   │                              # with retries + exponential backoff), merge
│   ├── muxer.ts                   # Audio+video merging, segment concatenation (TS/fMP4)
│   ├── quality-selector.ts        # Auto-select best quality, human-readable labels
│   ├── subtitle-extractor.ts      # VTT/SRT download with sanitized filenames
│   └── storage.ts                 # chrome.storage.local + IndexedDB helpers
├── popup/
│   ├── index.tsx                  # Entry point
│   ├── App.tsx                    # Main UI: link input, detected list, downloads
│   ├── popup.css                  # Styles with dark mode support
│   └── components/
│       ├── LinkInput.tsx           # URL input with validation and auto-paste
│       ├── VideoCard.tsx           # Video info card with quality selector
│       ├── QualitySelector.tsx     # Grouped quality dropdown (muxed vs separate)
│       ├── DownloadProgress.tsx    # Progress bars with status indicators
│       └── Settings.tsx            # Settings panel
├── providers/
│   ├── provider-interface.ts      # VideoProvider interface contract
│   ├── provider-registry.ts       # Registration, lookup, pattern matching
│   ├── vimeo.ts                   # Vimeo (config API → streams + subtitles)
│   ├── wistia.ts                  # Wistia (JSONP config → assets)
│   ├── brightcove.ts              # Brightcove (policy key → playback API)
│   ├── jwplayer.ts                # JW Player (inline config extraction)
│   ├── kaltura.ts                 # Kaltura (partner/entry IDs → HLS manifest)
│   ├── panopto.ts                 # Panopto (DeliveryInfo API)
│   ├── vidyard.ts                 # Vidyard (player JSON API)
│   ├── loom.ts                    # Loom (Next.js data / API)
│   ├── dailymotion.ts             # Dailymotion (metadata API)
│   ├── streamable.ts              # Streamable (public API)
│   ├── cloudflare-stream.ts       # Cloudflare Stream (manifest endpoints)
│   ├── html5-direct.ts            # Generic <video>/<source> detection
│   ├── hls-generic.ts             # Generic .m3u8 handling
│   ├── dash-generic.ts            # Generic .mpd handling
│   └── encrypted-hls.ts           # AES-128 encrypted HLS decryption
├── shared/
│   ├── types.ts                   # Shared TypeScript interfaces
│   └── messages.ts                # Message type definitions
├── assets/
│   ├── icon-16.png
│   ├── icon-48.png
│   └── icon-128.png
└── manifest.json                  # Chrome Manifest V3 configuration
```

### How It Works

1. **Content Script** runs on every page, observing the DOM for `<video>`, `<source>`, and `<iframe>` elements. It also injects a page-context script that monkey-patches `fetch()` and `XMLHttpRequest` to detect `.m3u8` / `.mpd` / `.mp4` URLs in network traffic.

2. **Service Worker** receives detected video reports from content scripts, manages download tasks, and resolves HLS/DASH manifests into segment URLs. It coordinates between the popup UI and content scripts via Chrome's message passing API.

3. **Popup UI** (Preact) provides the user interface: paste a URL to analyze, browse auto-detected videos, select quality, and monitor download progress.

4. **Provider Registry** matches URLs/embeds against registered providers. Each provider knows how to extract video stream URLs, quality variants, and subtitle tracks for its platform.

5. **Downloader** handles the actual download — direct single-file downloads use `chrome.downloads`, while segmented HLS/DASH streams are downloaded in parallel (4 concurrent, 3 retries with exponential backoff), concatenated, and optionally muxed with a separate audio stream.

---

## Adding a New Provider

1. Create `src/providers/my-platform.ts`:

```typescript
import type { VideoInfo } from '../shared/types';
import type { VideoProvider, ExtractionContext } from './provider-interface';

export class MyPlatformProvider implements VideoProvider {
  name = 'my-platform';
  displayName = 'My Platform';
  version = '1.0.0';

  canHandleUrl(url: string): boolean {
    return /myplatform\.com\/(embed|video)\//.test(url);
  }

  getEmbedPatterns(): RegExp[] {
    return [/myplatform\.com\/embed\/([a-zA-Z0-9]+)/];
  }

  async extractVideoInfo(context: ExtractionContext): Promise<VideoInfo> {
    // Fetch video metadata from the platform's API
    // Return VideoInfo with streams, subtitles, etc.
  }
}
```

2. Register in `src/providers/provider-registry.ts`:

```typescript
import { MyPlatformProvider } from './my-platform';
// In the constructor:
this.register(new MyPlatformProvider());
```

3. Rebuild: `npm run build`

---

## Available Scripts

| Command | Description |
|---------|-------------|
| `npm run build` | Production build (minified, output in `dist/`) |
| `npm run dev` | Development build with watch mode (rebuilds on file changes) |
| `npm run typecheck` | Run TypeScript type checking without emitting files |
| `npm run clean` | Remove the `dist/` folder |

---

## Tech Stack

| Technology | Purpose |
|-----------|---------|
| **TypeScript** | Type-safe development across all modules |
| **Preact** | Lightweight UI framework (~3KB, React-compatible API) |
| **Webpack** | Bundle and build the extension |
| **Chrome Manifest V3** | Modern extension platform (service worker, declarativeNetRequest) |
| **Web Crypto API** | AES-128-CBC decryption for encrypted HLS streams |
| **chrome.downloads** | Native browser download API (bypasses CORS) |

---

## Limitations

- **DRM-protected content is not supported** — Widevine, PlayReady, and FairPlay encrypted streams cannot be downloaded
- **YouTube is not supported** — by design; this extension focuses on course/educational platforms
- **Large files (>1GB)** — may be slow due to in-memory segment concatenation; a streaming approach is planned
- **Some platforms require authentication** — if you're logged into a course platform, the extension uses your existing session cookies; it cannot access content you don't have permission to view
- **ffmpeg.wasm is not yet bundled** — when audio and video streams are separate and require muxing, they are currently downloaded as separate files (full muxing integration is planned)

---

## Legal Disclaimer

This extension is a personal productivity tool. It downloads content that the user **already has legitimate access to** in their browser. It:

- ✅ Downloads publicly accessible video streams
- ✅ Saves content you have paid for / have a license to access
- ✅ Respects your existing authentication and permissions
- ❌ Does **not** circumvent DRM (Widevine/PlayReady)
- ❌ Does **not** bypass authentication or access controls
- ❌ Does **not** support bulk/automated downloading

Users are responsible for complying with the terms of service of the platforms they use and applicable copyright laws in their jurisdiction.
