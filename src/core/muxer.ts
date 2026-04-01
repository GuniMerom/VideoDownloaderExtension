// Audio/video muxer — ffmpeg.wasm integration (Phase 2)
// Current implementation provides segment concatenation and a fallback for muxing.

let ffmpegLoaded = false;

export function isFFmpegAvailable(): boolean {
  return ffmpegLoaded;
}

export function concatenateSegments(segments: ArrayBuffer[]): Blob {
  const totalLength = segments.reduce((sum, buf) => sum + buf.byteLength, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const buf of segments) {
    combined.set(new Uint8Array(buf), offset);
    offset += buf.byteLength;
  }
  return new Blob([combined], { type: 'video/mp2t' });
}

/**
 * Load ffmpeg.wasm. Call once before muxStreams.
 * TODO (Phase 2): Load @ffmpeg/ffmpeg and @ffmpeg/core.
 */
export async function loadFFmpeg(): Promise<boolean> {
  try {
    // Phase 2: Uncomment and implement when adding ffmpeg.wasm
    // const { FFmpeg } = await import('@ffmpeg/ffmpeg');
    // const ffmpeg = new FFmpeg();
    // await ffmpeg.load();
    // ffmpegLoaded = true;

    console.warn('[muxer] ffmpeg.wasm not yet integrated — using fallback');
    ffmpegLoaded = false;
    return false;
  } catch (err) {
    console.error('[muxer] Failed to load ffmpeg.wasm:', err);
    ffmpegLoaded = false;
    return false;
  }
}

/**
 * Mux video and audio blobs into a single container.
 * Phase 2: Will use ffmpeg.wasm for real muxing.
 * Current fallback: returns video blob as-is (audio will be downloaded separately).
 */
export async function muxStreams(
  videoBlob: Blob,
  audioBlob: Blob,
  outputFormat: string = 'mp4',
): Promise<Blob> {
  if (!ffmpegLoaded) {
    console.warn(
      '[muxer] ffmpeg.wasm not available — returning video blob without muxing.',
      `Audio blob (${audioBlob.size} bytes) will need separate download.`,
    );
    // Return video as-is; the caller (downloader.ts) handles the fallback
    return new Blob([videoBlob], {
      type: outputFormat === 'webm' ? 'video/webm' : 'video/mp4',
    });
  }

  // Phase 2: ffmpeg.wasm muxing implementation
  // const ffmpeg = new FFmpeg();
  // await ffmpeg.load();
  // await ffmpeg.writeFile('video.mp4', new Uint8Array(await videoBlob.arrayBuffer()));
  // await ffmpeg.writeFile('audio.mp4', new Uint8Array(await audioBlob.arrayBuffer()));
  // await ffmpeg.exec([
  //   '-i', 'video.mp4',
  //   '-i', 'audio.mp4',
  //   '-c', 'copy',
  //   '-movflags', '+faststart',
  //   `output.${outputFormat}`,
  // ]);
  // const data = await ffmpeg.readFile(`output.${outputFormat}`);
  // return new Blob([data], { type: `video/${outputFormat}` });

  throw new Error('ffmpeg.wasm muxing not yet implemented');
}
