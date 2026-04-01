/**
 * Validation script for the Video Downloader Extension.
 *
 * Tests the Vimeo provider's extraction strategies against a real private embed.
 *
 * Usage:
 *   node tests/validate-vimeo.mjs
 *
 * This validates:
 * - Strategy 1: /config API (expected 403 for private videos)
 * - Strategy 2: Player page HTML parsing (works when Referer is accepted)
 * - Extracted metadata: title, duration, resolution, HLS/DASH streams
 *
 * NOTE: Strategy 3 (chrome.scripting into iframe) requires the browser extension
 * context and cannot be tested here. It is the primary fallback for private embeds.
 */

const VIDEO_ID = '1161723375';
const REFERER = 'https://course.komata.co.il/';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ❌ ${name}: ${err.message}`);
  }
}

async function main() {
  console.log('🧪 Video Downloader Extension — Vimeo Validation\n');
  console.log(`Target: Vimeo video ${VIDEO_ID}`);
  console.log(`Referer: ${REFERER}\n`);

  // Strategy 1: /config API
  console.log('--- Strategy 1: /config API ---');
  await test('Returns 403 for private video (expected)', async () => {
    const resp = await fetch(`https://player.vimeo.com/video/${VIDEO_ID}/config`, {
      headers: { Accept: 'application/json' },
    });
    assert(resp.status === 403, `Expected 403, got ${resp.status}`);
  });

  // Strategy 2: Player page HTML
  console.log('\n--- Strategy 2: Player page HTML ---');
  let config = null;

  await test('Player page loads with correct Referer', async () => {
    const resp = await fetch(`https://player.vimeo.com/video/${VIDEO_ID}`, {
      headers: { Referer: REFERER },
    });
    assert(resp.ok, `Failed: ${resp.status}`);
    const html = await resp.text();
    assert(html.length > 1000, `HTML too short: ${html.length}`);

    const match = html.match(/window\.playerConfig\s*=\s*(\{.*\})/);
    assert(!!match, 'window.playerConfig not found in HTML');
    config = JSON.parse(match[1]);
  });

  if (config) {
    console.log('\n--- Extracted Metadata ---');
    await test(`Title: "${config.video?.title}"`, () => {
      assert(!!config.video?.title, 'Missing title');
    });

    await test(`Duration: ${config.video?.duration}s`, () => {
      assert(config.video?.duration > 0, 'Missing or zero duration');
    });

    await test(`Resolution: ${config.video?.width}x${config.video?.height}`, () => {
      assert(config.video?.width > 0 && config.video?.height > 0, 'Missing');
    });

    console.log('\n--- Stream Availability ---');
    await test('HLS streams available', () => {
      const hls = config.request?.files?.hls;
      assert(!!hls?.cdns && Object.keys(hls.cdns).length > 0, 'No HLS');
      console.log(`    CDNs: ${Object.keys(hls.cdns).join(', ')}`);
    });

    await test('DASH streams available', () => {
      const dash = config.request?.files?.dash;
      assert(!!dash?.cdns && Object.keys(dash.cdns).length > 0, 'No DASH');
      console.log(`    CDNs: ${Object.keys(dash.cdns).join(', ')}`);
    });

    await test('HLS URL is valid vimeocdn.com URL', () => {
      const hls = config.request?.files?.hls;
      const cdn = hls?.default_cdn || Object.keys(hls?.cdns || {})[0];
      const url = hls?.cdns?.[cdn]?.url;
      assert(!!url && url.includes('vimeocdn.com'), 'Invalid HLS URL');
    });

    await test('DASH URL is valid vimeocdn.com URL', () => {
      const dash = config.request?.files?.dash;
      const cdn = dash?.default_cdn || Object.keys(dash?.cdns || {})[0];
      const data = dash?.cdns?.[cdn];
      const url = data?.avc_url || data?.url;
      assert(!!url && url.includes('vimeocdn.com'), 'Invalid DASH URL');
    });

    // Test progressive (expected empty for private)
    const progCount = config.request?.files?.progressive?.length || 0;
    await test(`Progressive MP4s: ${progCount} (expected 0 for private)`, () => {
      // Not an error if 0 — private videos often only have HLS/DASH
    });
  }

  // Summary
  console.log(`\n${'='.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    console.log('\n⚠️  Some tests failed. Strategy 3 (chrome.scripting into iframe)');
    console.log('   is the primary fallback and can only be tested in-browser.');
    process.exit(1);
  } else {
    console.log('\n✅ All validation tests passed!');
  }
}

main().catch(console.error);
