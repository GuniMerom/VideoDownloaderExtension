import assert from 'node:assert/strict';

const masterPlaylist = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-aac",NAME="Hebrew",LANGUAGE="he",DEFAULT=YES,AUTOSELECT=YES,URI="audio/he/prog_index.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=8123123,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="audio-aac"
video/1080p/prog_index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=4123123,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="audio-aac"
video/720p/prog_index.m3u8
`;

function parseMasterPlaylist(content, baseUrl) {
  const variants = [];
  const renditions = [];
  const lines = content.trim().split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('#EXT-X-MEDIA:')) {
      const attrs = line.substring('#EXT-X-MEDIA:'.length);
      renditions.push({
        type: attrs.match(/TYPE=([^,]+)/)?.[1],
        groupId: attrs.match(/GROUP-ID="([^"]+)"/)?.[1],
        name: attrs.match(/NAME="([^"]+)"/)?.[1],
        uri: new URL(attrs.match(/URI="([^"]+)"/)?.[1] ?? '', baseUrl).href,
      });
      continue;
    }

    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
    const attrs = line.substring('#EXT-X-STREAM-INF:'.length);
    variants.push({
      url: new URL(lines[i + 1], baseUrl).href,
      audio: attrs.match(/AUDIO="([^"]+)"/)?.[1],
      resolution: attrs.match(/RESOLUTION=([\dx]+)/)?.[1],
      bandwidth: parseInt(attrs.match(/BANDWIDTH=(\d+)/)?.[1] ?? '0', 10),
    });
  }

  return { variants, renditions };
}

const parsed = parseMasterPlaylist(masterPlaylist, 'https://example.com/master.m3u8');

assert.equal(parsed.variants.length, 2);
assert.equal(parsed.renditions.length, 1);
assert.equal(parsed.variants[0].audio, 'audio-aac');
assert.equal(parsed.renditions[0].uri, 'https://example.com/audio/he/prog_index.m3u8');

console.log('HLS fixture validation passed');
