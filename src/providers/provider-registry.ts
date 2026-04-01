// Provider registry — central lookup for all video providers

import type { VideoProvider } from './provider-interface';

import html5DirectProvider from './html5-direct';
import vimeoProvider from './vimeo';
import streamableProvider from './streamable';
import wistiaProvider from './wistia';
import jwplayerProvider from './jwplayer';
import brightcoveProvider from './brightcove';
import dailymotionProvider from './dailymotion';
import cloudflareStreamProvider from './cloudflare-stream';
import hlsGenericProvider from './hls-generic';
import dashGenericProvider from './dash-generic';

class ProviderRegistry {
  private providers: Map<string, VideoProvider> = new Map();

  registerProvider(provider: VideoProvider): void {
    this.providers.set(provider.name, provider);
  }

  getProviderForUrl(url: string): VideoProvider | null {
    // Check site-specific providers first (before generic ones)
    for (const provider of this.providers.values()) {
      if (provider.name === 'hls-generic' || provider.name === 'dash-generic') continue;
      if (provider.canHandleUrl(url)) return provider;
    }
    // Fall back to generic stream handlers
    for (const name of ['hls-generic', 'dash-generic'] as const) {
      const provider = this.providers.get(name);
      if (provider?.canHandleUrl(url)) return provider;
    }
    return null;
  }

  getProviderForEmbed(iframeSrc: string): VideoProvider | null {
    for (const provider of this.providers.values()) {
      const patterns = provider.getEmbedPatterns();
      if (patterns.some((re) => re.test(iframeSrc))) return provider;
    }
    return null;
  }

  getAllProviders(): VideoProvider[] {
    return Array.from(this.providers.values());
  }

  detectProvidersOnPage(document: Document): VideoProvider[] {
    const matched: VideoProvider[] = [];
    for (const provider of this.providers.values()) {
      if (provider.canHandlePage?.(document)) {
        matched.push(provider);
      }
    }
    return matched;
  }
}

// Singleton registry with all providers pre-registered
const registry = new ProviderRegistry();

// Site-specific providers
registry.registerProvider(vimeoProvider);
registry.registerProvider(streamableProvider);
registry.registerProvider(wistiaProvider);
registry.registerProvider(jwplayerProvider);
registry.registerProvider(brightcoveProvider);
registry.registerProvider(dailymotionProvider);
registry.registerProvider(cloudflareStreamProvider);

// Page-level detection providers
registry.registerProvider(html5DirectProvider);

// Generic stream handlers (lowest priority)
registry.registerProvider(hlsGenericProvider);
registry.registerProvider(dashGenericProvider);

export { ProviderRegistry };
export { registry as providerRegistry };
export default registry;
