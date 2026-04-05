import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access, mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { chromium, type BrowserContext, type Page } from 'playwright';

import { getDefaultAudioRendition, isMasterPlaylist, parseMasterPlaylist, type HLSVariant } from '../src/core/hls-parser';

const INVALID_FILENAME_CHARS = /[<>:"/\\|?*\x00-\x1F]/g;
const MAX_NAME_LENGTH = 180;
const DEFAULT_CHAPTER_TITLE = 'Lessons';
const HLS_PROTOCOL_WHITELIST = 'file,http,https,tcp,tls,crypto,data';
const GENERIC_COURSE_TITLES = new Set(['schooler', 'course', 'online course', 'komata course']);

let ffmpegBinary = 'ffmpeg';

interface CliOptions {
  courseUrl: string;
  outputRoot: string;
  userDataDir: string;
  profile: string;
  dryRun: boolean;
  keepTemp: boolean;
  chapter?: number;
  lesson?: number;
}

interface LessonNode {
  order: number;
  title: string;
  url: string;
}

interface ChapterNode {
  order: number;
  title: string;
  lessons: LessonNode[];
}

interface CourseNode {
  title: string;
  url: string;
  chapters: ChapterNode[];
}

interface PlannedLesson extends LessonNode {
  chapterOrder: number;
  chapterTitle: string;
  chapterDir: string;
  baseName: string;
  outputPath: string;
}

interface PlannedChapter {
  order: number;
  title: string;
  outputDir: string;
  lessons: PlannedLesson[];
}

interface PlannedCourse {
  title: string;
  url: string;
  outputDir: string;
  reportPath: string;
  chapters: PlannedChapter[];
}

type LessonStatus = 'success' | 'skipped' | 'failed' | 'dry-run';

interface LessonReport {
  chapterIndex: number;
  chapterTitle: string;
  lessonIndex: number;
  lessonTitle: string;
  lessonUrl: string;
  outputPath: string;
  subtitlePaths: string[];
  status: LessonStatus;
  videoStatus: LessonStatus;
  subtitleStatus: 'success' | 'skipped' | 'failed';
  selectedVideoUrl?: string;
  selectedAudioUrl?: string;
  selectedQuality?: string;
  sourceKind?: 'hls' | 'progressive';
  tempPaths?: string[];
  warnings?: string[];
  error?: string;
}

interface ExportReport {
  generatedAt: string;
  courseUrl: string;
  courseTitle: string;
  outputRoot: string;
  courseDirectory: string;
  dryRun: boolean;
  filters: {
    chapter?: number;
    lesson?: number;
  };
  lessons: LessonReport[];
  summary: Record<LessonStatus, number>;
}

interface VimeoProgressive {
  url: string;
  quality?: string;
  width?: number;
  height?: number;
}

interface VimeoTextTrack {
  url: string;
  lang?: string;
  label?: string;
}

interface VimeoConfig {
  video?: {
    title?: string;
    duration?: number;
  };
  request?: {
    files?: {
      progressive?: VimeoProgressive[];
      hls?: {
        cdns?: Record<string, { url: string }>;
        default_cdn?: string;
      };
    };
    text_tracks?: VimeoTextTrack[];
  };
}

interface SelectedStreams {
  sourceKind: 'hls' | 'progressive';
  videoUrl: string;
  audioUrl?: string;
  qualityLabel: string;
  subtitles: VimeoTextTrack[];
}

interface SubtitleResult {
  paths: string[];
  downloaded: number;
  skipped: number;
  errors: string[];
}

interface MuxResult {
  tempPaths: string[];
}

function printUsage(): void {
  console.log(`Komata Course Exporter

Usage:
  npm.cmd run course:export -- --course-url <url> --output-root <dir> --user-data-dir <chrome-user-data-dir> --profile <profile-name> [options]

Recommended output root:
  C:\\Users\\guni\\Documents\\Education\\<Subject>\\<Platform>

Required:
  --course-url
  --output-root
  --user-data-dir
  --profile

Options:
  --dry-run
  --chapter <n>
  --lesson <n>
  --keep-temp
`);
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function sanitizePathSegment(value: string, fallback: string): string {
  const sanitized = normalizeText(value)
    .replace(INVALID_FILENAME_CHARS, '_')
    .substring(0, MAX_NAME_LENGTH);
  return sanitized || fallback;
}

function formatIndex(value: number): string {
  return String(value).padStart(2, '0');
}

function shortSlugFromUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const lastSegment = parsed.pathname.split('/').filter(Boolean).pop() || parsed.searchParams.toString() || 'lesson';
    return sanitizePathSegment(lastSegment.replace(/[-_]+/g, ' '), 'lesson').replace(/\s+/g, '-').slice(0, 24);
  } catch {
    return 'lesson';
  }
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatCourseSlug(slug: string | undefined): string {
  const cleaned = sanitizePathSegment((slug || '').replace(/[-_]+/g, ' '), 'Komata Course');
  if (!cleaned) return 'Komata Course';
  return cleaned.replace(/\b\w/g, (character) => character.toUpperCase());
}

function parsePositiveInteger(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`--${name} must be a positive integer.`);
  }
  return parsed;
}

function parseArgs(argv: string[]): CliOptions {
  const flags = new Set<string>();
  const values = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) {
      throw new Error(`Unexpected argument: ${argument}`);
    }

    const [rawKey, inlineValue] = argument.slice(2).split('=', 2);
    if (rawKey === 'dry-run' || rawKey === 'keep-temp') {
      flags.add(rawKey);
      continue;
    }

    const value = inlineValue ?? argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for --${rawKey}.`);
    }

    values.set(rawKey, value);
    if (!inlineValue) {
      index += 1;
    }
  }

  const courseUrl = values.get('course-url');
  const outputRoot = values.get('output-root');
  const userDataDir = values.get('user-data-dir');
  const profile = values.get('profile');

  if (!courseUrl || !outputRoot || !userDataDir || !profile) {
    throw new Error('Missing required flags. Run with --help to see the expected command.');
  }

  const chapter = parsePositiveInteger('chapter', values.get('chapter'));
  const lesson = parsePositiveInteger('lesson', values.get('lesson'));
  if (lesson && !chapter) {
    throw new Error('--lesson can only be used together with --chapter.');
  }

  return {
    courseUrl,
    outputRoot: path.resolve(outputRoot),
    userDataDir: path.resolve(userDataDir),
    profile,
    dryRun: flags.has('dry-run'),
    keepTemp: flags.has('keep-temp'),
    chapter,
    lesson,
  };
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function pathHasContent(targetPath: string): Promise<boolean> {
  try {
    const fileStat = await stat(targetPath);
    return fileStat.isFile() && fileStat.size > 0;
  } catch {
    return false;
  }
}

function ensureFfmpegAvailable(): void {
  if (process.env.FFMPEG_PATH && existsSync(process.env.FFMPEG_PATH)) {
    ffmpegBinary = process.env.FFMPEG_PATH;
  } else {
    const locator = process.platform === 'win32'
      ? spawnSync('where.exe', ['ffmpeg.exe'], { encoding: 'utf8' })
      : spawnSync('which', ['ffmpeg'], { encoding: 'utf8' });

    const discoveredPath = locator.status === 0
      ? locator.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean)
      : undefined;

    if (discoveredPath) {
      ffmpegBinary = discoveredPath;
    } else {
      const candidates = [
        path.join(
          process.env.LOCALAPPDATA || '',
          'Microsoft',
          'WinGet',
          'Packages',
          'Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe',
          'ffmpeg-8.1-full_build',
          'bin',
          'ffmpeg.exe',
        ),
      ];

      const candidate = candidates.find((entry) => entry && existsSync(entry));
      if (candidate) {
        ffmpegBinary = candidate;
      }
    }
  }

  const result = spawnSync(ffmpegBinary, ['-version'], { stdio: 'ignore' });
  if (result.error || result.status !== 0) {
    throw new Error('ffmpeg is not installed or not on PATH. Install ffmpeg, then rerun the exporter.');
  }
}

async function launchChromeContext(options: CliOptions): Promise<BrowserContext> {
  try {
    return await chromium.launchPersistentContext(options.userDataDir, {
      channel: 'chrome',
      headless: false,
      viewport: null,
      args: [`--profile-directory=${options.profile}`],
    });
  } catch (error) {
    const message = stringifyError(error);
    if (/profile|lock|Singleton|already in use/i.test(message)) {
      throw new Error(
        `Could not open Chrome profile "${options.profile}". Close regular Chrome windows using ` +
        `"${options.userDataDir}" and rerun this command.`,
      );
    }
    throw new Error(`Could not launch Chrome with profile "${options.profile}": ${message}`);
  }
}

async function expandCollapsedSections(page: Page): Promise<void> {
  for (let pass = 0; pass < 3; pass += 1) {
    const clickedCount = await page.evaluate(() => {
      const selectors = [
        'button[aria-expanded="false"]',
        '[role="button"][aria-expanded="false"]',
        'a[data-toggle="collapse"]',
        '.accordion-button[aria-expanded="false"]',
        'summary',
      ];

      const candidates = Array.from(document.querySelectorAll<HTMLElement>(selectors.join(',')));
      let clicked = 0;

      for (const element of candidates) {
        const text = (element.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text || text.length > 160) continue;

        if (element.tagName.toLowerCase() === 'summary') {
          const details = element.parentElement as HTMLDetailsElement | null;
          if (details?.open) continue;
        }

        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        if (rect.width === 0 || rect.height === 0) continue;
        if (style.display === 'none' || style.visibility === 'hidden') continue;

        element.click();
        clicked += 1;
      }

      return clicked;
    });

    if (!clickedCount) break;
    await page.waitForTimeout(600);
  }
}

async function discoverCourse(page: Page, courseUrl: string): Promise<CourseNode> {
  await page.goto(courseUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(1_500);
  await expandCollapsedSections(page);
  await page.waitForTimeout(1_000);

  const discoveryScript = `
    (() => {
      const urlValue = ${JSON.stringify(courseUrl)};
      const fallbackChapterTitle = ${JSON.stringify(DEFAULT_CHAPTER_TITLE)};
      const courseUrlObject = new URL(urlValue);
      const baseSegments = courseUrlObject.pathname.split('/').filter(Boolean);
      const courseSlug = baseSegments[0] || 'course';
      const headingSelector = 'h1,h2,h3,h4,h5,h6,[role="heading"],summary,button[aria-controls],button[aria-expanded]';
      const lessonHints = /(lesson|lecture|class|unit|module|session|video|part)/i;
      const blockedHints = /(logout|login|signin|privacy|terms|support|contact|profile|settings)/i;
      const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();
      const isVisible = (element) => {
        if (!(element instanceof HTMLElement)) return true;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const courseTitle = normalize(document.querySelector('h1')?.textContent)
        || normalize(document.title.split(/[|\\-–—]/)[0])
        || courseSlug;
      const chapterLists = Array.from(document.querySelectorAll('ul.lesson--list'));
      const structuredChapters = chapterLists.map((list) => {
        const items = Array.from(list.querySelectorAll('li'));
        const header = items.find((item) => item.className.includes('toc-header'));
        const chapterTitle = normalize(header?.textContent).replace(/^\\d+\\/\\d+\\s*/, '') || fallbackChapterTitle;
        const lessons = items
          .filter((item) => item !== header)
          .map((item) => {
            const anchor = item.querySelector('a[href]');
            if (!(anchor instanceof HTMLAnchorElement)) return null;
            const itemText = normalize(item.textContent);
            if (!/(video|וידאו)/i.test(itemText)) return null;
            let href;
            try {
              href = new URL(anchor.href, window.location.href);
            } catch {
              return null;
            }
            if (href.origin !== courseUrlObject.origin) return null;
            return {
              title: normalize(anchor.textContent || anchor.getAttribute('aria-label') || anchor.getAttribute('title')) || 'Lesson',
              url: href.href,
            };
          })
          .filter(Boolean);
        return { title: chapterTitle, lessons };
      }).filter((chapter) => chapter.lessons.length > 0);
      if (structuredChapters.length > 0) {
        return {
          courseTitle,
          chapters: structuredChapters,
          lessonCount: structuredChapters.reduce((count, chapter) => count + chapter.lessons.length, 0),
          loginDetected: Boolean(document.querySelector('input[type="password"], form[action*="login"], form[action*="signin"]')),
        };
      }
      const scoreUrl = (candidateUrl) => {
        const candidateSegments = candidateUrl.pathname.split('/').filter(Boolean);
        return baseSegments.reduce((score, segment) => score + (candidateSegments.includes(segment) ? 1 : 0), 0);
      };
      const elements = Array.from(document.querySelectorAll(headingSelector + ', a[href]'));
      const candidates = [];
      let currentChapterTitle = '';
      const findAncestorHeading = (anchor, title) => {
        let current = anchor.parentElement;
        while (current) {
          const heading = current.querySelector(headingSelector);
          if (heading) {
            const headingText = normalize(heading.textContent);
            if (headingText && headingText !== title && headingText !== courseTitle && !blockedHints.test(headingText)) {
              return headingText;
            }
          }
          current = current.parentElement;
        }
        return '';
      };
      for (let domIndex = 0; domIndex < elements.length; domIndex += 1) {
        const element = elements[domIndex];
        if (element instanceof HTMLAnchorElement) {
          const title = normalize(element.innerText || element.textContent || element.getAttribute('aria-label') || element.getAttribute('title'));
          let href;
          try {
            href = new URL(element.href, window.location.href);
          } catch {
            continue;
          }
          const anchorIsVisible = isVisible(element);
          if (!anchorIsVisible && !/\\/ContentPage/i.test(href.pathname)) continue;
          if (href.origin !== courseUrlObject.origin) continue;
          if (element.getAttribute('data-toggle') === 'collapse') continue;
          if (href.hash && /^#collapse-/i.test(href.hash)) continue;
          if (/javascript:/i.test(href.href)) continue;
          if (href.pathname === courseUrlObject.pathname && !href.search && href.hash) continue;
          if (/\\/login$|\\/reset\\//i.test(href.pathname)) continue;
          let score = 0;
          if (title.length >= 2 && title.length <= 160) score += 1;
          const urlScore = scoreUrl(href);
          if (urlScore > 0) score += urlScore * 2;
          if (href.pathname !== courseUrlObject.pathname || href.search || href.hash) score += 2;
          if (/\\/ContentPage/i.test(href.pathname)) score += 5;
          if ((element.getAttribute('onclick') || '').includes('setWatchedLessonClass')) score += 3;
          if (lessonHints.test(title)) score += 2;
          if (blockedHints.test(title + ' ' + href.href)) score -= 10;
          if (element.closest('main, article, section, nav, aside')) score += 1;
          if (element.closest('header, footer')) score -= 4;
          if (score >= 5) {
            candidates.push({
              href: href.href,
              title: title || normalize(href.pathname.split('/').filter(Boolean).pop()) || 'Lesson',
              chapterTitle: findAncestorHeading(element, title) || currentChapterTitle,
              domIndex,
              score,
            });
          }
          continue;
        }
        if (!isVisible(element)) continue;
        const headingText = normalize(element.textContent);
        if (headingText && headingText !== courseTitle && !blockedHints.test(headingText) && headingText.length <= 160) {
          currentChapterTitle = headingText;
        }
      }
      const deduped = new Map();
      for (const candidate of candidates) {
        const existing = deduped.get(candidate.href);
        if (!existing || candidate.score > existing.score || candidate.title.length > existing.title.length) {
          deduped.set(candidate.href, candidate);
        }
      }
      const chapters = [];
      const chapterMap = new Map();
      const dedupedLessons = Array.from(deduped.values()).sort((left, right) => left.domIndex - right.domIndex);
      const contentPageLessons = dedupedLessons.filter((lesson) => {
        try {
          return /\\/ContentPage/i.test(new URL(lesson.href).pathname);
        } catch {
          return false;
        }
      });
      const finalLessons = contentPageLessons.length > 0 ? contentPageLessons : dedupedLessons;
      const genericFlatLessons = finalLessons.length > 0 && finalLessons.every((lesson) => {
        const title = normalize(lesson.title);
        return /^(lesson|lecture|module|part)\\s+\\d+\\b/i.test(title);
      });
      for (const lesson of finalLessons) {
        const chapterTitle = genericFlatLessons
          ? fallbackChapterTitle
          : normalize(lesson.chapterTitle) || fallbackChapterTitle;
        let chapter = chapterMap.get(chapterTitle);
        if (!chapter) {
          chapter = { title: chapterTitle, lessons: [] };
          chapterMap.set(chapterTitle, chapter);
          chapters.push(chapter);
        }
        chapter.lessons.push({ title: lesson.title, url: lesson.href });
      }
      return {
        courseTitle,
        chapters,
        lessonCount: Array.from(chapterMap.values()).reduce((count, chapter) => count + chapter.lessons.length, 0),
        loginDetected: Boolean(document.querySelector('input[type="password"], form[action*="login"], form[action*="signin"]')),
      };
    })()
  `;
  const discovery = await page.evaluate(discoveryScript) as {
    courseTitle: string;
    chapters: Array<{ title: string; lessons: Array<{ title: string; url: string }> }>;
    lessonCount: number;
    loginDetected: boolean;
  };

  if (!discovery.lessonCount) {
    if (discovery.loginDetected || /login|signin|auth/i.test(page.url())) {
      throw new Error('Could not enumerate lessons. The selected Chrome profile does not appear to have an active logged-in session for this course.');
    }
    throw new Error('Could not enumerate lessons from the course page. The current discovery heuristics did not find the lesson structure.');
  }

  return {
    title: sanitizePathSegment(
      GENERIC_COURSE_TITLES.has(normalizeText(discovery.courseTitle).toLowerCase())
        ? formatCourseSlug(new URL(courseUrl).pathname.split('/').filter(Boolean)[0])
        : discovery.courseTitle,
      formatCourseSlug(new URL(courseUrl).pathname.split('/').filter(Boolean)[0]),
    ),
    url: courseUrl,
    chapters: discovery.chapters.map((chapter, chapterIndex) => ({
      order: chapterIndex + 1,
      title: sanitizePathSegment(chapter.title, `Chapter ${chapterIndex + 1}`),
      lessons: chapter.lessons.map((lesson, lessonIndex) => ({
        order: lessonIndex + 1,
        title: sanitizePathSegment(lesson.title, `Lesson ${lessonIndex + 1}`),
        url: lesson.url,
      })),
    })),
  };
}

function buildExportPlan(course: CourseNode, options: CliOptions): PlannedCourse {
  const selectedChapters = options.chapter
    ? course.chapters.filter((chapter) => chapter.order === options.chapter)
    : course.chapters;

  if (options.chapter && !selectedChapters.length) {
    throw new Error(`Chapter ${options.chapter} does not exist in the discovered course structure.`);
  }

  const courseDir = path.join(options.outputRoot, sanitizePathSegment(course.title, 'Komata Course'));
  const chapters = selectedChapters.map((chapter) => {
    const selectedLessons = options.lesson
      ? chapter.lessons.filter((lesson) => lesson.order === options.lesson)
      : chapter.lessons;

    if (options.lesson && !selectedLessons.length) {
      throw new Error(`Lesson ${options.lesson} does not exist inside chapter ${chapter.order} (${chapter.title}).`);
    }

    const chapterDir = path.join(courseDir, `${formatIndex(chapter.order)} - ${chapter.title}`);
    const usedBaseNames = new Set<string>();

    const lessons = selectedLessons.map((lesson) => {
      let baseName = `${formatIndex(lesson.order)} - ${lesson.title}`;
      if (usedBaseNames.has(baseName.toLowerCase())) {
        baseName = `${baseName} - ${shortSlugFromUrl(lesson.url)}`;
      }
      usedBaseNames.add(baseName.toLowerCase());

      return {
        ...lesson,
        chapterOrder: chapter.order,
        chapterTitle: chapter.title,
        chapterDir,
        baseName,
        outputPath: path.join(chapterDir, `${baseName}.mp4`),
      };
    });

    return {
      order: chapter.order,
      title: chapter.title,
      outputDir: chapterDir,
      lessons,
    };
  });

  if (!chapters.some((chapter) => chapter.lessons.length > 0)) {
    throw new Error('No lessons matched the requested chapter/lesson filters.');
  }

  return {
    title: course.title,
    url: course.url,
    outputDir: courseDir,
    reportPath: path.join(courseDir, 'export-report.json'),
    chapters,
  };
}

function createInitialReport(plan: PlannedCourse, options: CliOptions): ExportReport {
  return {
    generatedAt: new Date().toISOString(),
    courseUrl: plan.url,
    courseTitle: plan.title,
    outputRoot: options.outputRoot,
    courseDirectory: plan.outputDir,
    dryRun: options.dryRun,
    filters: {
      chapter: options.chapter,
      lesson: options.lesson,
    },
    lessons: [],
    summary: {
      'success': 0,
      'skipped': 0,
      'failed': 0,
      'dry-run': 0,
    },
  };
}

function refreshSummary(report: ExportReport): void {
  report.summary = {
    'success': 0,
    'skipped': 0,
    'failed': 0,
    'dry-run': 0,
  };

  for (const lesson of report.lessons) {
    report.summary[lesson.status] += 1;
  }
}

async function writeReport(reportPath: string, report: ExportReport): Promise<void> {
  await mkdir(path.dirname(reportPath), { recursive: true });
  report.generatedAt = new Date().toISOString();
  await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
}

async function fetchWithContext(
  context: BrowserContext,
  url: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  const cookies = await context.cookies([url]);
  const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  const requestHeaders: Record<string, string> = { ...headers };

  if (cookieHeader) {
    requestHeaders.cookie = cookieHeader;
  }

  return fetch(url, {
    headers: requestHeaders,
    redirect: 'follow',
  });
}

async function fetchTextWithContext(
  context: BrowserContext,
  url: string,
  headers: Record<string, string> = {},
): Promise<string> {
  const response = await fetchWithContext(context, url, headers);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  return response.text();
}

function extractJsonObjectAfterAssignment(input: string, variableName: string): string | null {
  const markerIndex = input.indexOf(variableName);
  if (markerIndex === -1) return null;

  const assignmentIndex = input.indexOf('=', markerIndex + variableName.length);
  if (assignmentIndex === -1) return null;

  const objectStart = input.indexOf('{', assignmentIndex + 1);
  if (objectStart === -1) return null;

  let depth = 0;
  let delimiter: '"' | '\'' | '`' | null = null;
  let escaped = false;

  for (let index = objectStart; index < input.length; index += 1) {
    const character = input[index];

    if (delimiter) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (character === '\\') {
        escaped = true;
        continue;
      }

      if (character === delimiter) {
        delimiter = null;
      }
      continue;
    }

    if (character === '"' || character === '\'' || character === '`') {
      delimiter = character as '"' | '\'' | '`';
      continue;
    }

    if (character === '{') {
      depth += 1;
      continue;
    }

    if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        return input.slice(objectStart, index + 1);
      }
    }
  }

  return null;
}

function parseVimeoConfigPayload(payload: string): VimeoConfig | null {
  const trimmed = payload.trim();
  const candidate = trimmed.startsWith('{')
    ? trimmed
    : extractJsonObjectAfterAssignment(payload, 'window.playerConfig');

  if (!candidate) return null;

  try {
    return JSON.parse(candidate) as VimeoConfig;
  } catch {
    return null;
  }
}

async function extractLiveFrameConfig(page: Page): Promise<VimeoConfig | null> {
  for (const frame of page.frames()) {
    if (!/player\.vimeo\.com\/video\//.test(frame.url())) continue;

    try {
      const payload = await frame.evaluate(() => {
        const config = (window as unknown as { playerConfig?: unknown }).playerConfig;
        if (config) {
          return JSON.stringify(config);
        }

        for (const script of Array.from(document.querySelectorAll('script'))) {
          const text = script.textContent || '';
          if (text.includes('window.playerConfig')) {
            return text;
          }
        }

        return null;
      });

      if (!payload) continue;

      const config = parseVimeoConfigPayload(payload);
      if (config?.request?.files) {
        return config;
      }
    } catch {
      continue;
    }
  }

  return null;
}

async function extractVimeoConfig(
  context: BrowserContext,
  page: Page,
  lessonUrl: string,
): Promise<VimeoConfig> {
  await page.waitForTimeout(1_000);

  try {
    await page.waitForSelector('iframe[src*="player.vimeo.com"], iframe[data-src*="player.vimeo.com"]', {
      timeout: 10_000,
    });
  } catch {
    // Some lessons lazily mount the player. The later HTML fetch fallback still covers those.
  }

  const liveConfig = await extractLiveFrameConfig(page);
  if (liveConfig?.request?.files) {
    return liveConfig;
  }

  const frameUrls = await page.locator('iframe').evaluateAll((frames) => {
    const urls: string[] = [];
    for (const frame of frames) {
      const src = frame.getAttribute('src');
      const dataSrc = frame.getAttribute('data-src');
      if (src) urls.push(src);
      if (dataSrc) urls.push(dataSrc);
    }
    return urls;
  });

  for (const rawFrameUrl of frameUrls) {
    const frameUrl = new URL(rawFrameUrl, lessonUrl).href;
    if (!/player\.vimeo\.com\/video\//.test(frameUrl)) continue;

    const html = await fetchTextWithContext(context, frameUrl, { referer: lessonUrl });
    const htmlConfig = parseVimeoConfigPayload(html);
    if (htmlConfig?.request?.files) {
      return htmlConfig;
    }

    const configUrl = `${frameUrl.replace(/\?.*$/, '')}/config`;
    const configResponse = await fetchWithContext(context, configUrl, {
      accept: 'application/json',
      referer: lessonUrl,
    });

    if (configResponse.ok) {
      return await configResponse.json() as VimeoConfig;
    }
  }

  throw new Error('Could not extract Vimeo player config from this lesson.');
}

function sortVariantsByQuality(left: HLSVariant, right: HLSVariant): number {
  const leftHeight = Number.parseInt(left.resolution?.split('x')[1] || '0', 10) || 0;
  const rightHeight = Number.parseInt(right.resolution?.split('x')[1] || '0', 10) || 0;
  return rightHeight - leftHeight || right.bandwidth - left.bandwidth;
}

async function selectStreams(context: BrowserContext, config: VimeoConfig): Promise<SelectedStreams> {
  const hls = config.request?.files?.hls;
  if (hls?.cdns) {
    const cdnName = hls.default_cdn || Object.keys(hls.cdns)[0];
    const masterUrl = hls.cdns[cdnName]?.url;
    if (masterUrl) {
      const masterText = await fetchTextWithContext(context, masterUrl);
      if (isMasterPlaylist(masterText)) {
        const master = parseMasterPlaylist(masterText, masterUrl);
        const bestVariant = master.variants.slice().sort(sortVariantsByQuality)[0];
        if (bestVariant) {
          const audioRendition = getDefaultAudioRendition(master, bestVariant.audio);
          return {
            sourceKind: 'hls',
            videoUrl: bestVariant.url,
            audioUrl: audioRendition?.uri,
            qualityLabel: bestVariant.resolution || `${Math.round(bestVariant.bandwidth / 1000)}kbps`,
            subtitles: config.request?.text_tracks || [],
          };
        }
      }

      return {
        sourceKind: 'hls',
        videoUrl: masterUrl,
        qualityLabel: 'auto',
        subtitles: config.request?.text_tracks || [],
      };
    }
  }

  const progressive = (config.request?.files?.progressive || []).slice().sort((left, right) => {
    const leftHeight = left.height || 0;
    const rightHeight = right.height || 0;
    const leftWidth = left.width || 0;
    const rightWidth = right.width || 0;
    return rightHeight - leftHeight || rightWidth - leftWidth;
  });

  const bestProgressive = progressive[0];
  if (bestProgressive?.url) {
    return {
      sourceKind: 'progressive',
      videoUrl: bestProgressive.url,
      qualityLabel: bestProgressive.quality || `${bestProgressive.height || bestProgressive.width || 0}p`,
      subtitles: config.request?.text_tracks || [],
    };
  }

  throw new Error(
    'No downloadable Vimeo HLS or progressive streams were found. The lesson may be DRM-protected or unsupported.',
  );
}

function resolveSubtitleUrl(rawUrl: string): string {
  return rawUrl.startsWith('http') ? rawUrl : new URL(rawUrl, 'https://player.vimeo.com').href;
}

async function downloadSubtitles(
  context: BrowserContext,
  tracks: VimeoTextTrack[],
  lessonBasePath: string,
): Promise<SubtitleResult> {
  const result: SubtitleResult = {
    paths: [],
    downloaded: 0,
    skipped: 0,
    errors: [],
  };

  const usedSuffixes = new Set<string>();

  for (let index = 0; index < tracks.length; index += 1) {
    const track = tracks[index];
    const language = sanitizePathSegment(track.lang || 'und', 'und').replace(/\s+/g, '-');
    let suffix = language;
    if (usedSuffixes.has(suffix.toLowerCase())) {
      const labelSuffix = sanitizePathSegment(track.label || `track-${index + 1}`, `track-${index + 1}`)
        .replace(/\s+/g, '-');
      suffix = `${language}.${labelSuffix}`;
    }
    usedSuffixes.add(suffix.toLowerCase());

    const subtitlePath = `${lessonBasePath}.${suffix}.vtt`;
    result.paths.push(subtitlePath);

    if (await pathExists(subtitlePath)) {
      result.skipped += 1;
      continue;
    }

    try {
      const response = await fetchWithContext(context, resolveSubtitleUrl(track.url), {
        referer: 'https://player.vimeo.com/',
      });
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      await writeFile(subtitlePath, buffer);
      result.downloaded += 1;
    } catch (error) {
      result.errors.push(`Subtitle ${language}: ${stringifyError(error)}`);
    }
  }

  return result;
}

function buildInputArgs(url: string): string[] {
  if (/\.m3u8($|\?)/i.test(url)) {
    return [
      '-protocol_whitelist', HLS_PROTOCOL_WHITELIST,
      '-allowed_extensions', 'ALL',
      '-i', url,
    ];
  }

  return ['-i', url];
}

async function runFfmpeg(args: string[], label: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpegBinary, ['-nostdin', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      reject(new Error(`ffmpeg ${label} failed to start: ${error.message}`));
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`ffmpeg ${label} failed with exit code ${code}: ${stderr.trim()}`));
    });
  });
}

async function copySingleInputToFile(inputUrl: string, outputPath: string): Promise<void> {
  await runFfmpeg([
    '-y',
    '-loglevel', 'error',
    ...buildInputArgs(inputUrl),
    '-map', '0:v:0',
    '-map', '0:a?',
    '-c', 'copy',
    '-movflags', '+faststart',
    outputPath,
  ], `copy for ${path.basename(outputPath)}`);
}

async function mergeRemoteInputs(videoUrl: string, audioUrl: string, outputPath: string): Promise<void> {
  await runFfmpeg([
    '-y',
    '-loglevel', 'error',
    ...buildInputArgs(videoUrl),
    ...buildInputArgs(audioUrl),
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-c', 'copy',
    '-movflags', '+faststart',
    outputPath,
  ], `merge for ${path.basename(outputPath)}`);
}

async function mergeLocalFiles(videoPath: string, audioPath: string, outputPath: string): Promise<void> {
  await runFfmpeg([
    '-y',
    '-loglevel', 'error',
    '-i', videoPath,
    '-i', audioPath,
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-c', 'copy',
    '-movflags', '+faststart',
    outputPath,
  ], `local merge for ${path.basename(outputPath)}`);
}

async function safeDelete(targetPath: string): Promise<void> {
  try {
    await unlink(targetPath);
  } catch {
    // Ignore cleanup failures.
  }
}

async function mergeWithTempFiles(
  lesson: PlannedLesson,
  selection: SelectedStreams,
  keepTemp: boolean,
): Promise<MuxResult> {
  if (!selection.audioUrl) {
    await copySingleInputToFile(selection.videoUrl, lesson.outputPath);
    return { tempPaths: [] };
  }

  const tempVideoPath = path.join(lesson.chapterDir, `${lesson.baseName}_video.mp4`);
  const tempAudioPath = path.join(lesson.chapterDir, `${lesson.baseName}_audio.m4a`);

  await copySingleInputToFile(selection.videoUrl, tempVideoPath);
  await runFfmpeg([
    '-y',
    '-loglevel', 'error',
    ...buildInputArgs(selection.audioUrl),
    '-map', '0:a:0',
    '-c', 'copy',
    tempAudioPath,
  ], `audio copy for ${path.basename(tempAudioPath)}`);

  await mergeLocalFiles(tempVideoPath, tempAudioPath, lesson.outputPath);

  if (!keepTemp) {
    await safeDelete(tempVideoPath);
    await safeDelete(tempAudioPath);
    return { tempPaths: [] };
  }

  return { tempPaths: [tempVideoPath, tempAudioPath] };
}

async function exportLesson(
  context: BrowserContext,
  page: Page,
  lesson: PlannedLesson,
  options: CliOptions,
): Promise<LessonReport> {
  const report: LessonReport = {
    chapterIndex: lesson.chapterOrder,
    chapterTitle: lesson.chapterTitle,
    lessonIndex: lesson.order,
    lessonTitle: lesson.title,
    lessonUrl: lesson.url,
    outputPath: lesson.outputPath,
    subtitlePaths: [],
    status: 'skipped',
    videoStatus: 'skipped',
    subtitleStatus: 'skipped',
    tempPaths: [],
    warnings: [],
  };

  const outputExists = await pathHasContent(lesson.outputPath);

  try {
    await page.goto(lesson.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(1_500);

    const loginDetected = await page.locator('input[type="password"], form[action*="login"], form[action*="signin"]').count();
    if (loginDetected > 0) {
      throw new Error(
        'The selected Chrome profile is not logged into this lesson. Open the course in the profile that has access, then rerun the exporter.',
      );
    }

    const config = await extractVimeoConfig(context, page, lesson.url);
    const selection = await selectStreams(context, config);
    report.selectedVideoUrl = selection.videoUrl;
    report.selectedAudioUrl = selection.audioUrl;
    report.selectedQuality = selection.qualityLabel;
    report.sourceKind = selection.sourceKind;

    await mkdir(lesson.chapterDir, { recursive: true });

    if (!outputExists) {
      if (selection.audioUrl && !options.keepTemp) {
        try {
          await mergeRemoteInputs(selection.videoUrl, selection.audioUrl, lesson.outputPath);
        } catch (error) {
          report.warnings?.push(`Direct merge failed, falling back to temp files: ${stringifyError(error)}`);
          const muxResult = await mergeWithTempFiles(lesson, selection, options.keepTemp);
          report.tempPaths = muxResult.tempPaths;
        }
      } else {
        const muxResult = await mergeWithTempFiles(lesson, selection, options.keepTemp);
        report.tempPaths = muxResult.tempPaths;
      }

      report.videoStatus = 'success';
    }

    const lessonBasePath = lesson.outputPath.replace(/\.mp4$/i, '');
    const subtitleResult = await downloadSubtitles(context, selection.subtitles, lessonBasePath);
    report.subtitlePaths = subtitleResult.paths;

    if (subtitleResult.errors.length) {
      report.warnings?.push(...subtitleResult.errors);
    }

    if (subtitleResult.downloaded > 0) {
      report.subtitleStatus = 'success';
    } else if (subtitleResult.errors.length > 0 && subtitleResult.skipped === 0) {
      report.subtitleStatus = 'failed';
    } else {
      report.subtitleStatus = 'skipped';
    }

    if (report.videoStatus === 'success' || report.subtitleStatus === 'success') {
      report.status = 'success';
    } else {
      report.status = 'skipped';
    }

    return report;
  } catch (error) {
    report.status = outputExists ? 'skipped' : 'failed';
    report.videoStatus = outputExists ? 'skipped' : 'failed';
    report.subtitleStatus = report.subtitlePaths.length > 0 ? report.subtitleStatus : 'failed';
    report.error = stringifyError(error);
    return report;
  }
}

async function runExport(options: CliOptions): Promise<void> {
  if (!options.dryRun) {
    ensureFfmpegAvailable();
  }

  const context = await launchChromeContext(options);
  const page = context.pages()[0] ?? await context.newPage();

  try {
    console.log(`Discovering course structure from ${options.courseUrl}`);
    const discoveredCourse = await discoverCourse(page, options.courseUrl);
    const plan = buildExportPlan(discoveredCourse, options);
    const report = createInitialReport(plan, options);

    await mkdir(plan.outputDir, { recursive: true });
    await writeReport(plan.reportPath, report);

    const lessonCount = plan.chapters.reduce((count, chapter) => count + chapter.lessons.length, 0);
    console.log(`Course: ${plan.title}`);
    console.log(`Output: ${plan.outputDir}`);
    console.log(`Chapters selected: ${plan.chapters.length}`);
    console.log(`Lessons selected: ${lessonCount}`);

    if (options.dryRun) {
      for (const chapter of plan.chapters) {
        for (const lesson of chapter.lessons) {
          report.lessons.push({
            chapterIndex: chapter.order,
            chapterTitle: chapter.title,
            lessonIndex: lesson.order,
            lessonTitle: lesson.title,
            lessonUrl: lesson.url,
            outputPath: lesson.outputPath,
            subtitlePaths: [],
            status: 'dry-run',
            videoStatus: 'dry-run',
            subtitleStatus: 'skipped',
          });
        }
      }

      refreshSummary(report);
      await writeReport(plan.reportPath, report);
      console.log(`Dry run complete. Report written to ${plan.reportPath}`);
      return;
    }

    for (const chapter of plan.chapters) {
      await mkdir(chapter.outputDir, { recursive: true });
      console.log(`\nChapter ${formatIndex(chapter.order)} - ${chapter.title}`);

      for (const lesson of chapter.lessons) {
        console.log(`  Exporting ${formatIndex(chapter.order)}.${formatIndex(lesson.order)} ${lesson.title}`);
        const lessonReport = await exportLesson(context, page, lesson, options);
        report.lessons.push(lessonReport);
        refreshSummary(report);
        await writeReport(plan.reportPath, report);

        if (lessonReport.status === 'failed') {
          console.error(`    Failed: ${lessonReport.error}`);
        } else if (lessonReport.status === 'skipped') {
          console.log('    Skipped: output already exists and no new subtitles were needed.');
        } else {
          console.log(`    Done: ${lesson.outputPath}`);
        }
      }
    }

    console.log('\nExport finished.');
    console.log(`Report: ${plan.reportPath}`);
    console.log(`Summary: ${JSON.stringify(report.summary)}`);
  } finally {
    await context.close();
  }
}

async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    printUsage();
    return;
  }

  const options = parseArgs(process.argv.slice(2));
  const hostname = new URL(options.courseUrl).hostname;
  if (!/komata/i.test(hostname)) {
    console.warn('This exporter is tuned for Komata first. Other sites may need provider-specific follow-up.');
  }

  await runExport(options);
}

void main().catch((error) => {
  console.error(stringifyError(error));
  process.exitCode = 1;
});
