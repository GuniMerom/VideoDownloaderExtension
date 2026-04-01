# Video Downloader Extension

A Chrome browser extension (Manifest V3) that detects and downloads videos from online course platforms and content providers in the highest available quality.

## Features

- **Paste & Download** — Paste any video URL and get download options with quality selection
- **Auto-Detection** — Automatically detects embedded videos and iframes on the current page
- **Multi-Platform** — Supports 12+ video providers with a plugin-based architecture
- **Highest Quality** — Automatically selects the best available resolution and bitrate
- **Audio + Video Merge** — Merges separate audio/video streams into a single file
- **Subtitles** — Downloads subtitles as separate .vtt/.srt files

## Supported Platforms

| Provider | Status |
|----------|--------|
| HTML5 `<video>` | ✅ |
| Vimeo | ✅ |
| Streamable | ✅ |
| Generic HLS (.m3u8) | ✅ |
| Generic DASH (.mpd) | ✅ |
| Wistia | ✅ |
| JW Player | ✅ |
| Brightcove | ✅ |
| Dailymotion | ✅ |
| Cloudflare Stream | ✅ |

## Development

### Prerequisites

- Node.js 18+
- npm

### Setup

```bash
npm install
```

### Build

```bash
# Development build (with watch)
npm run dev

# Production build
npm run build

# Type check
npm run typecheck
```

### Load in Chrome

1. Run `npm run build`
2. Open `chrome://extensions/`
3. Enable "Developer mode"
4. Click "Load unpacked"
5. Select the `dist/` folder

## Architecture

```
src/
├── background/          # Service worker (central coordinator)
├── content/             # Content script (DOM detection, network interception)
├── core/                # Core modules (parsers, downloader, muxer)
├── popup/               # Popup UI (Preact)
├── providers/           # Platform-specific provider plugins
├── shared/              # Shared types and message definitions
└── manifest.json        # Chrome MV3 manifest
```

### Adding a New Provider

1. Create `src/providers/my-platform.ts` implementing `VideoProvider`
2. Register it in `src/providers/provider-registry.ts`
3. Rebuild

## Legal

This extension is for personal use only. It downloads content that the user already has legitimate access to in their browser. It does not circumvent DRM (Widevine/PlayReady) and does not support downloading copyrighted content without authorization.
