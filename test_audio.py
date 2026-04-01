import urllib.request
import re
import json
from urllib.parse import urljoin

req = urllib.request.Request('https://player.vimeo.com/video/1161723375')
req.add_header('Referer', 'https://course.komata.co.il/')
req.add_header('User-Agent', 'Mozilla/5.0')
resp = urllib.request.urlopen(req)
html = resp.read().decode('utf-8')
match = re.search(r'window\.playerConfig\s*=\s*(\{.*\})', html)
config = json.loads(match.group(1))
hls_url = config['request']['files']['hls']['cdns']['akfire_interconnect_quic']['url']

# Fetch and print full master playlist
master = urllib.request.urlopen(hls_url).read().decode('utf-8')
print("=== FULL MASTER PLAYLIST ===")
print(master)

# Now check: does the audio media playlist also have an init segment?
audio_match = re.search(r'#EXT-X-MEDIA:.*?TYPE=AUDIO.*?URI="([^"]+)"', master)
if audio_match:
    audio_url = urljoin(hls_url, audio_match.group(1))
    print("\n=== AUDIO MEDIA PLAYLIST ===")
    audio_media = urllib.request.urlopen(audio_url).read().decode('utf-8')
    print(audio_media[:1500])
    
    # Count segments
    audio_segs = [l for l in audio_media.split('\n') if l.strip() and not l.startswith('#')]
    print(f"\nAudio segments: {len(audio_segs)}")
