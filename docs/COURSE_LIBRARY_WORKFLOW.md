# Course Library Workflow

This guide describes the reliable, working workflow for downloading an authenticated online course library with this repository's current toolchain.

It is optimized for the path that works today:

1. Use the Chrome extension to detect and download each lesson.
2. Let the local auto-merge helper combine separate video and audio parts with `ffmpeg`.
3. Store the final course files under `C:\Users\guni\Documents\Education` in a clean subject-first hierarchy.
4. Generate a course-local `_Summaries` library from subtitles and audio after export when you want structured study notes.

This workflow assumes you already have legitimate access to the course in your browser session.

## What This Workflow Solves

- Downloads lesson video at the best available quality supported by the extension.
- Downloads subtitles when available.
- Merges separate `_video` and `_audio` outputs into a single final MP4.
- Deletes temporary parts after a successful merge.
- Produces a repeatable library structure for a full course.
- Produces a parallel summary library under `_Summaries` with lesson, chapter, course, and reference docs.

## Current Limits

- DRM-protected lessons are out of scope.
- This repository does not currently include browser automation or an MCP browser-control server.
- For authenticated sites such as Komata, the reliable path depends on your existing logged-in Chrome session.
- The extension is not yet a true bulk course crawler. The proven workflow is chapter-by-chapter and lesson-by-lesson.

## Required Local Setup

Before downloading a full course library, make sure all of the following are ready.

### 1. Build and load the extension

From the repository root:

```powershell
cd C:\src\VideoDownloaderExtension
npm.cmd install
npm.cmd run build
```

Then load the unpacked extension in Chrome from:

`C:\src\VideoDownloaderExtension\dist`

### 2. Install `ffmpeg`

The merge helpers require `ffmpeg` on your `PATH`.

Quick check:

```powershell
ffmpeg -version
```

If that fails, install `ffmpeg` first and reopen PowerShell.

### 3. Know the helper entrypoints

- Start continuous auto-merge watcher:

```powershell
npm.cmd run merge:watch
```

- Start watcher via Windows launcher:

`tools\start-auto-merge.cmd`

- Merge one pair manually:

```powershell
npm.cmd run merge:download -- --video "C:\path\lesson_video.mp4" --audio "C:\path\lesson_audio.mp4"
```

- Build hierarchical summaries for an exported course:

```powershell
$env:OPENAI_API_KEY="your-key"
npm.cmd run course:summarize -- --course-root "C:\Users\guni\Documents\Education\Cooking\Komata\דונבורי"
```

## Canonical Library Root

The permanent home for educational course media is:

`C:\Users\guni\Documents\Education`

Treat `Downloads` as a staging area only when needed for retries or temporary export work.

For the current Komata cooking course, the canonical destination is:

`C:\Users\guni\Documents\Education\Cooking\Komata\דונבורי`

## Default Library Layout

Use this structure exactly unless you have a strong reason to change it:

```text
C:\Users\guni\Documents\Education\
  <Subject>\
    <Platform>\
      <Course Name>\
        01 - <Chapter Title>\
          01 - <Lesson Title>.mp4
          01 - <Lesson Title>.<language>.vtt
          02 - <Lesson Title>.mp4
        02 - <Chapter Title>\
          01 - <Lesson Title>.mp4
```

### Naming Rules

- Subject folder: use the learning domain such as `Cooking`, `Cocktails`, or `Tech`.
- Platform folder: use the source platform or source collection such as `Komata` or `Danon lectures`.
- Course folder: use the course display name.
- Chapter folders: prefix with two-digit display order.
- Lesson files: prefix with two-digit lesson order inside the chapter.
- Keep the lesson title as the canonical base name.
- Save subtitles next to the merged lesson file with the same base name.

Example:

```text
C:\Users\guni\Documents\Education\
  Cooking\
    Danon lectures\
      קונדיטוריה\
        <existing files>
    Komata\
      דונבורי\
        01 - פרק 1- ברוכים הבאים\
          01 - איך אני מציע לעבוד עם הקורס הזה_.mp4
          01 - איך אני מציע לעבוד עם הקורס הזה_.he.vtt
        02 - פרק 2- מה זה בכלל דונבורי\
          01 - מה זה בכלל דונבורי_.mp4
```

## Recommended Operating Procedure

This is the proven workflow for downloading a full course with the current repository.

### Step 1. Prepare the course folder

Create the full permanent course root first:

```text
C:\Users\guni\Documents\Education\<Subject>\<Platform>\<Course Name>\
```

Example:

```text
C:\Users\guni\Documents\Education\Cooking\Komata\דונבורי\
```

### Step 2. Create chapter folders ahead of time

Before downloading, create chapter folders in the order they appear in the course UI.

Example:

```text
C:\Users\guni\Documents\Education\Cooking\Komata\דונבורי\01 - פרק 1- ברוכים הבאים\
C:\Users\guni\Documents\Education\Cooking\Komata\דונבורי\02 - פרק 2- מה זה בכלל דונבורי\
C:\Users\guni\Documents\Education\Cooking\Komata\דונבורי\03 - פרק 3- אורז לדונבורי\
```

### Step 3. Point Chrome downloads to the current chapter folder

For the chapter you are about to download:

1. Open Chrome settings.
2. Change the default download directory to the relevant chapter folder.
3. Keep all downloads for that chapter in that folder.

This is the simplest way to make the auto-merge watcher place the final merged file in the correct course hierarchy.

### Step 4. Start the auto-merge watcher

Start the watcher against the current chapter folder.

Recommended:

```powershell
cd C:\src\VideoDownloaderExtension
powershell -ExecutionPolicy Bypass -File .\tools\auto-merge-downloads.ps1 -DownloadDir "D:\Course Library\Donburi - One Bowl Japan\01 - Foundations"
```

For the Komata cooking library, the equivalent path looks like:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\auto-merge-downloads.ps1 -DownloadDir "C:\Users\guni\Documents\Education\Cooking\Komata\דונבורי\01 - פרק 1- ברוכים הבאים"
```

Alternative:

```powershell
npm.cmd run merge:watch
```

If you use `npm.cmd run merge:watch`, it watches your default Downloads folder. That is fine if Chrome is currently downloading into the chapter folder you want.

Leave the watcher window open while downloading lessons for that chapter.

### Step 5. Open the course in Chrome while logged in

Log in normally and navigate to the course.

For authenticated sites such as Komata, do not try to download from a logged-out browser or a browser profile that does not already have access.

### Step 6. Download each lesson in the chapter

For each lesson:

1. Open the lesson page.
2. Wait for the extension to detect the video.
3. Open the extension popup.
4. Confirm the lesson title, available quality, and subtitles.
5. Click download.

If the stream is served as separate video and audio:

- the extension may download `_video` and `_audio` parts first
- the watcher will merge them into a single final MP4
- the watcher will delete the temporary parts after a successful merge

### Step 7. Rename merged lessons into chapter order

After each lesson is merged successfully, rename it into the final chapter order:

```text
01 - <Lesson Title>.mp4
02 - <Lesson Title>.mp4
03 - <Lesson Title>.mp4
```

Do the same for subtitles if needed so they stay adjacent to the final lesson filename.

Example:

```text
01 - Intro to Donburi.mp4
01 - Intro to Donburi.he.vtt
```

### Step 8. Move to the next chapter

When a chapter is complete:

1. Stop the current watcher if it is pointed at a specific chapter folder.
2. Change Chrome's download directory to the next chapter folder.
3. Start the watcher again for that next chapter.
4. Repeat the same process.

## How To Tell It Worked

For a successfully merged lesson, you should see:

- one final `.mp4` file with the lesson title
- no leftover `_video` or `_audio` parts for that lesson
- subtitles next to the lesson file when available

### Quick validation options

- Open the merged lesson in a local media player and confirm both picture and sound.
- Use `ffprobe` if you want a technical check:

```powershell
ffprobe -hide_banner -show_streams "C:\Users\guni\Documents\Education\Cooking\Komata\דונבורי\01 - פרק 1- ברוכים הבאים\01 - איך אני מציע לעבוד עם הקורס הזה_.mp4"
```

You should see:

- one `video` stream
- one `audio` stream

## Failure Handling

### Case 1. Only `_video` and `_audio` remain

This usually means the watcher was not running, was pointed at the wrong folder, or `ffmpeg` was unavailable.

Recovery:

1. Confirm `ffmpeg -version` works.
2. Start the watcher in the correct folder.
3. Merge manually if needed:

```powershell
npm.cmd run merge:download -- --video "C:\path\lesson_video.mp4" --audio "C:\path\lesson_audio.mp4"
```

### Case 2. The extension detects the video but cannot download it

Possible causes:

- session expired
- unsupported provider edge case
- a lesson is DRM-protected

Recovery:

1. Refresh the lesson page and confirm you are still logged in.
2. Play a few seconds of the lesson in the browser.
3. Retry the extension download.
4. If it still fails and no usable streams are exposed, treat it as unsupported for the current toolchain.

### Case 3. The extension downloads a lesson but no subtitles appear

Possible causes:

- the lesson does not expose subtitles
- subtitles exist but were not published in the player config

Recovery:

1. Check whether the player itself shows captions.
2. Retry with subtitle download enabled.
3. If the extension still sees no subtitle tracks, note that lesson as having no extractable subtitles.

### Case 4. A lesson appears DRM-protected

If playback depends on DRM such as Widevine, this workflow does not support it.

Treat DRM as a hard stop and do not attempt to bypass it with this repository.

## Suggested Full-Course Routine

For a medium or large course:

1. Create the course folder.
2. Create all chapter folders in order.
3. Start with chapter 1.
4. Set Chrome downloads to that chapter folder.
5. Start the watcher for that folder.
6. Download every lesson in that chapter.
7. Validate the merged results quickly before moving on.
8. Repeat chapter by chapter until the course is complete.

This approach is manual, but it is reliable and keeps the final library tidy.

## Future Automation

The repository now includes an early Komata-first Playwright exporter that aims to build the hierarchy automatically from your authenticated Chrome profile.

Recommended Komata export command:

```powershell
cd C:\src\VideoDownloaderExtension
npm.cmd run course:export -- --course-url "https://course.komata.co.il/donburi/fMKNQUk" --output-root "C:\Users\guni\Documents\Education\Cooking\Komata" --user-data-dir "C:\Users\guni\AppData\Local\Google\Chrome\User Data" --profile "Profile 2"
```

Useful flags:

```powershell
--dry-run
--chapter 1
--lesson 2
--keep-temp
```

The long-term ideal is still a standalone local course crawler that accepts a course base URL and builds the entire hierarchy automatically.

The likely shape of that future tool is:

- input: course base URL
- browser automation engine: Playwright
- authentication: reuse your existing logged-in browser profile or exported browser state
- behavior:
  - enumerate chapters and lessons
  - open each lesson page
  - capture metadata such as course name, chapter title, lesson order, lesson title
  - trigger the current extension download flow or directly resolve the same media URLs
  - merge with local `ffmpeg`
  - write the final `Course/Chapter/Lesson` hierarchy

Why this is still not the primary workflow yet:

- Komata access still depends on your authenticated browser session
- course discovery heuristics may still need tuning against real course pages
- DRM-protected lessons remain unsupported

Treat the exporter as the new bulk-export path to validate and improve, while the extension plus auto-merge watcher remains the proven fallback workflow.

## Summary Workflow

Once a course is exported and merged successfully, you can build a parallel knowledge library inside the course folder.

Default summary output root:

```text
<Course>\_Summaries\
  Lessons\
    01-01 - <Lesson Title>.md
  Chapters\
    01 - <Chapter Title>.md
  Course Overview.md
  Reference\
    Ingredients.md
    Techniques.md
    Recipes.md
    Glossary.md
  Intermediate\
    Lessons\
      01-01 - <Lesson Title>.json
  manifest.json
```

The summarizer prefers existing `.vtt` / `.srt` sidecar files first, then falls back to audio transcription when subtitles are missing or too weak.

Recommended usage:

```powershell
$env:OPENAI_API_KEY="your-key"
cd C:\src\VideoDownloaderExtension
npm.cmd run course:summarize -- --course-root "C:\Users\guni\Documents\Education\Cooking\Komata\דונבורי"
```

Useful flags:

```powershell
--chapter 1
--lesson 2
--force
--dry-run
--language bilingual
--with-visuals
```

Notes:

- `--dry-run` validates lesson discovery and output targets without calling the API.
- `--with-visuals` is accepted now but still falls back to subtitles/audio only in v1.
- Summaries are resumable and will skip lesson outputs whose source video/subtitle inputs have not changed unless you pass `--force`.

## Current Storage Decision

Use this hierarchy going forward:

```text
C:\Users\guni\Documents\Education\
  Cooking\
    Danon lectures\
      קונדיטוריה\
      רב תחומי\
    Komata\
      דונבורי\
        01 - <Chapter Title>\
          01 - <Lesson Title>.mp4
          01 - <Lesson Title>.<language>.vtt
  Cocktails\
    <Platform>\
      <Course>\
  Tech\
    <Platform>\
      <Course>\
```

This keeps platform identity visible, preserves existing Danon content as-is, and gives Komata exports a permanent home alongside your other education files.
