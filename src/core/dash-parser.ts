// DASH/MPD manifest parser

export interface DASHRepresentation {
  id: string;
  bandwidth: number;
  width?: number;
  height?: number;
  codecs?: string;
  baseUrl?: string;
  segmentTemplate?: {
    media?: string;
    initialization?: string;
    startNumber?: number;
    timescale?: number;
    duration?: number;
    timeline?: Array<{ t?: number; d: number; r?: number }>;
  };
  segmentList?: {
    initialization?: string;
    segments: Array<{ url: string; range?: string }>;
  };
}

export interface DASHAdaptationSet {
  contentType: 'video' | 'audio' | 'text';
  mimeType: string;
  lang?: string;
  representations: DASHRepresentation[];
}

export interface DASHPeriod {
  duration?: number;
  adaptationSets: DASHAdaptationSet[];
}

export interface DASHManifest {
  periods: DASHPeriod[];
}

function resolveUrl(relative: string, baseUrl: string): string {
  try {
    return new URL(relative, baseUrl).href;
  } catch {
    return relative;
  }
}

function parseDuration(iso8601: string | null): number | undefined {
  if (!iso8601) return undefined;
  const match = iso8601.match(
    /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/,
  );
  if (!match) return undefined;
  const hours = parseFloat(match[1] || '0');
  const minutes = parseFloat(match[2] || '0');
  const seconds = parseFloat(match[3] || '0');
  return hours * 3600 + minutes * 60 + seconds;
}

function getAttr(el: Element, name: string): string | null {
  return el.getAttribute(name);
}

function inferContentType(
  mimeType: string,
  explicitType: string | null,
): 'video' | 'audio' | 'text' {
  if (explicitType) {
    const lower = explicitType.toLowerCase();
    if (lower === 'video') return 'video';
    if (lower === 'audio') return 'audio';
    if (lower === 'text') return 'text';
  }
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('text/') || mimeType.includes('subtitle') || mimeType.includes('ttml'))
    return 'text';
  return 'video';
}

function parseSegmentTemplate(
  el: Element | null,
): DASHRepresentation['segmentTemplate'] | undefined {
  if (!el) return undefined;

  const template: NonNullable<DASHRepresentation['segmentTemplate']> = {
    media: getAttr(el, 'media') ?? undefined,
    initialization: getAttr(el, 'initialization') ?? undefined,
    startNumber: getAttr(el, 'startNumber')
      ? parseInt(getAttr(el, 'startNumber')!, 10)
      : undefined,
    timescale: getAttr(el, 'timescale')
      ? parseInt(getAttr(el, 'timescale')!, 10)
      : undefined,
    duration: getAttr(el, 'duration')
      ? parseInt(getAttr(el, 'duration')!, 10)
      : undefined,
  };

  const timelineEl = el.querySelector('SegmentTimeline');
  if (timelineEl) {
    template.timeline = [];
    const sElements = timelineEl.querySelectorAll('S');
    sElements.forEach((s) => {
      template.timeline!.push({
        t: getAttr(s, 't') ? parseInt(getAttr(s, 't')!, 10) : undefined,
        d: parseInt(getAttr(s, 'd')!, 10),
        r: getAttr(s, 'r') ? parseInt(getAttr(s, 'r')!, 10) : undefined,
      });
    });
  }

  return template;
}

function parseSegmentList(
  el: Element | null,
  repBaseUrl: string,
): DASHRepresentation['segmentList'] | undefined {
  if (!el) return undefined;

  const initEl = el.querySelector('Initialization');
  const segmentUrls = el.querySelectorAll('SegmentURL');

  const segments: Array<{ url: string; range?: string }> = [];
  segmentUrls.forEach((seg) => {
    const media = getAttr(seg, 'media');
    if (media) {
      segments.push({
        url: resolveUrl(media, repBaseUrl),
        range: getAttr(seg, 'mediaRange') ?? undefined,
      });
    }
  });

  return {
    initialization: initEl
      ? resolveUrl(
          getAttr(initEl, 'sourceURL') ?? getAttr(initEl, 'range') ?? '',
          repBaseUrl,
        )
      : undefined,
    segments,
  };
}

export function parseMPD(xmlContent: string, baseUrl: string): DASHManifest {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlContent, 'application/xml');

  const parseError = doc.querySelector('parsererror');
  if (parseError) {
    throw new Error(`Invalid MPD XML: ${parseError.textContent}`);
  }

  // Check for a BaseURL at MPD level
  const mpdBaseUrlEl = doc.querySelector('MPD > BaseURL');
  const mpdBaseUrl = mpdBaseUrlEl
    ? resolveUrl(mpdBaseUrlEl.textContent?.trim() ?? '', baseUrl)
    : baseUrl;

  const periods: DASHPeriod[] = [];
  const periodEls = doc.querySelectorAll('Period');

  periodEls.forEach((periodEl) => {
    const periodDuration = parseDuration(getAttr(periodEl, 'duration'));

    const periodBaseUrlEl = periodEl.querySelector(':scope > BaseURL');
    const periodBaseUrl = periodBaseUrlEl
      ? resolveUrl(periodBaseUrlEl.textContent?.trim() ?? '', mpdBaseUrl)
      : mpdBaseUrl;

    const adaptationSets: DASHAdaptationSet[] = [];
    const asEls = periodEl.querySelectorAll('AdaptationSet');

    asEls.forEach((asEl) => {
      const mimeType = getAttr(asEl, 'mimeType') ?? '';
      const contentType = inferContentType(
        mimeType,
        getAttr(asEl, 'contentType'),
      );
      const lang = getAttr(asEl, 'lang') ?? undefined;

      // SegmentTemplate at AdaptationSet level
      const asSegTemplate = parseSegmentTemplate(
        asEl.querySelector(':scope > SegmentTemplate'),
      );

      const representations: DASHRepresentation[] = [];
      const repEls = asEl.querySelectorAll('Representation');

      repEls.forEach((repEl) => {
        const repBaseUrlEl = repEl.querySelector(':scope > BaseURL');
        const repBaseUrl = repBaseUrlEl
          ? resolveUrl(repBaseUrlEl.textContent?.trim() ?? '', periodBaseUrl)
          : undefined;

        const effectiveBaseUrl = repBaseUrl ?? periodBaseUrl;

        // SegmentTemplate at Representation level overrides AdaptationSet level
        const repSegTemplate =
          parseSegmentTemplate(
            repEl.querySelector(':scope > SegmentTemplate'),
          ) ?? asSegTemplate;

        const repSegList = parseSegmentList(
          repEl.querySelector(':scope > SegmentList'),
          effectiveBaseUrl,
        );

        representations.push({
          id: getAttr(repEl, 'id') ?? '',
          bandwidth: parseInt(getAttr(repEl, 'bandwidth') ?? '0', 10),
          width: getAttr(repEl, 'width')
            ? parseInt(getAttr(repEl, 'width')!, 10)
            : undefined,
          height: getAttr(repEl, 'height')
            ? parseInt(getAttr(repEl, 'height')!, 10)
            : undefined,
          codecs: getAttr(repEl, 'codecs') ?? getAttr(asEl, 'codecs') ?? undefined,
          baseUrl: repBaseUrl,
          segmentTemplate: repSegTemplate,
          segmentList: repSegList,
        });
      });

      adaptationSets.push({ contentType, mimeType, lang, representations });
    });

    periods.push({ duration: periodDuration, adaptationSets });
  });

  return { periods };
}

export function getVideoRepresentations(parsed: DASHManifest): DASHRepresentation[] {
  const reps: DASHRepresentation[] = [];
  for (const period of parsed.periods) {
    for (const as of period.adaptationSets) {
      if (as.contentType === 'video') {
        reps.push(...as.representations);
      }
    }
  }
  return reps.sort((a, b) => b.bandwidth - a.bandwidth);
}

export function getAudioRepresentations(parsed: DASHManifest): DASHRepresentation[] {
  const reps: DASHRepresentation[] = [];
  for (const period of parsed.periods) {
    for (const as of period.adaptationSets) {
      if (as.contentType === 'audio') {
        reps.push(...as.representations);
      }
    }
  }
  return reps.sort((a, b) => b.bandwidth - a.bandwidth);
}

export function getSubtitleRepresentations(
  parsed: DASHManifest,
): Array<DASHRepresentation & { lang?: string }> {
  const reps: Array<DASHRepresentation & { lang?: string }> = [];
  for (const period of parsed.periods) {
    for (const as of period.adaptationSets) {
      if (as.contentType === 'text') {
        for (const rep of as.representations) {
          reps.push({ ...rep, lang: as.lang });
        }
      }
    }
  }
  return reps;
}

export function resolveSegmentUrls(
  representation: DASHRepresentation,
  baseUrl: string,
): string[] {
  const urls: string[] = [];
  const effectiveBaseUrl = representation.baseUrl
    ? resolveUrl(representation.baseUrl, baseUrl)
    : baseUrl;

  // SegmentList
  if (representation.segmentList) {
    if (representation.segmentList.initialization) {
      urls.push(resolveUrl(representation.segmentList.initialization, effectiveBaseUrl));
    }
    for (const seg of representation.segmentList.segments) {
      urls.push(resolveUrl(seg.url, effectiveBaseUrl));
    }
    return urls;
  }

  // SegmentTemplate
  const template = representation.segmentTemplate;
  if (!template?.media) {
    // Single segment — just the baseUrl
    if (representation.baseUrl) {
      return [resolveUrl(representation.baseUrl, baseUrl)];
    }
    return [];
  }

  const expand = (pattern: string, number: number): string => {
    return pattern
      .replace(/\$Number(?:%(\d+)d)?\$/g, (_match, pad) => {
        const s = String(number);
        return pad ? s.padStart(parseInt(pad, 10), '0') : s;
      })
      .replace(/\$RepresentationID\$/g, representation.id)
      .replace(/\$Bandwidth\$/g, String(representation.bandwidth));
  };

  // Add initialization segment
  if (template.initialization) {
    urls.push(
      resolveUrl(expand(template.initialization, 0), effectiveBaseUrl),
    );
  }

  // SegmentTimeline
  if (template.timeline && template.timeline.length > 0) {
    let time = 0;
    let segNumber = template.startNumber ?? 1;

    for (const s of template.timeline) {
      if (s.t !== undefined) time = s.t;
      const repeat = (s.r ?? 0) + 1;
      for (let r = 0; r < repeat; r++) {
        const segUrl = expand(template.media, segNumber)
          .replace(/\$Time\$/g, String(time));
        urls.push(resolveUrl(segUrl, effectiveBaseUrl));
        time += s.d;
        segNumber++;
      }
    }
  } else if (template.duration && template.timescale) {
    // Fixed-duration segments: estimate total count from period duration
    // Without knowing total duration, generate a reasonable range
    const startNum = template.startNumber ?? 1;
    const segDuration = template.duration / template.timescale;
    // Generate up to 10000 segments max (caller should limit if needed)
    const maxSegments = 10000;
    for (let i = 0; i < maxSegments; i++) {
      const segUrl = expand(template.media, startNum + i);
      urls.push(resolveUrl(segUrl, effectiveBaseUrl));
      // If we don't know the total, we generate a reasonable batch
      // The caller should use period duration to limit
      if (segDuration > 0 && i > 0) {
        break; // Return first two as sample; caller should compute count
      }
    }
  }

  return urls;
}
