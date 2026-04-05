param(
  [Parameter(Mandatory = $false)]
  [string]$DownloadDir = "$env:USERPROFILE\Downloads",

  [Parameter(Mandatory = $false)]
  [int]$IntervalSeconds = 5,

  [Parameter(Mandatory = $false)]
  [int]$MinAgeSeconds = 8,

  [Parameter(Mandatory = $false)]
  [switch]$Once,

  [Parameter(Mandatory = $false)]
  [switch]$KeepParts
)

$ErrorActionPreference = 'Stop'

function Ensure-Ffmpeg {
  $cmd = Get-Command ffmpeg -ErrorAction SilentlyContinue
  if (-not $cmd) {
    throw "ffmpeg is not installed or not on PATH. Install ffmpeg, then rerun this script."
  }
  return $cmd.Source
}

function Get-BaseNameFromPart {
  param([string]$Name)

  if ($Name -match '^(.*)_video\.[^.]+$') { return $Matches[1] }
  if ($Name -match '^(.*)_audio\.[^.]+$') { return $Matches[1] }
  return $null
}

function Get-PartGroups {
  param([string]$Directory)

  $files = Get-ChildItem -LiteralPath $Directory -File |
    Where-Object { $_.Name -match '_(video|audio)\.[^.]+$' }

  $groups = @{}
  foreach ($file in $files) {
    $baseName = Get-BaseNameFromPart -Name $file.Name
    if (-not $baseName) { continue }

    if (-not $groups.ContainsKey($baseName)) {
      $groups[$baseName] = @{
        BaseName = $baseName
        Video = $null
        Audio = $null
      }
    }

    if ($file.Name -match '_video\.[^.]+$') {
      $groups[$baseName].Video = $file
    } elseif ($file.Name -match '_audio\.[^.]+$') {
      $groups[$baseName].Audio = $file
    }
  }

  return $groups.Values
}

function Is-ReadyForMerge {
  param(
    [System.IO.FileInfo]$Video,
    [System.IO.FileInfo]$Audio,
    [int]$MinAge
  )

  if (-not $Video -or -not $Audio) { return $false }

  $now = Get-Date
  $videoAge = ($now - $Video.LastWriteTime).TotalSeconds
  $audioAge = ($now - $Audio.LastWriteTime).TotalSeconds

  return ($videoAge -ge $MinAge -and $audioAge -ge $MinAge)
}

function Merge-Parts {
  param(
    [string]$FfmpegPath,
    [System.IO.FileInfo]$Video,
    [System.IO.FileInfo]$Audio,
    [switch]$KeepSources
  )

  $baseName = Get-BaseNameFromPart -Name $Video.Name
  $outputPath = Join-Path -Path $Video.DirectoryName -ChildPath ($baseName + '.mp4')
  $tempOutputPath = $outputPath + '.tmp.mp4'

  if (Test-Path -LiteralPath $tempOutputPath) {
    Remove-Item -LiteralPath $tempOutputPath -Force
  }

  if ((Test-Path -LiteralPath $outputPath) -and (Get-Item -LiteralPath $outputPath).LastWriteTime -ge $Video.LastWriteTime -and (Get-Item -LiteralPath $outputPath).LastWriteTime -ge $Audio.LastWriteTime) {
    Write-Host "Skipping already-merged pair: $baseName"
    return
  }

  Write-Host "Merging: $($Video.Name) + $($Audio.Name)"
  & $FfmpegPath -y -i $Video.FullName -i $Audio.FullName -c copy -map 0:v:0 -map 1:a:0 $tempOutputPath | Out-Null

  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $tempOutputPath)) {
    throw "ffmpeg merge failed for $baseName"
  }

  Move-Item -LiteralPath $tempOutputPath -Destination $outputPath -Force
  Write-Host "Created: $outputPath"

  if (-not $KeepSources) {
    Remove-Item -LiteralPath $Video.FullName -Force
    Remove-Item -LiteralPath $Audio.FullName -Force
    Write-Host "Deleted parts for: $baseName"
  }
}

if (-not (Test-Path -LiteralPath $DownloadDir)) {
  throw "Download directory not found: $DownloadDir"
}

$ffmpeg = Ensure-Ffmpeg
Write-Host "Watching: $DownloadDir"
Write-Host "ffmpeg : $ffmpeg"
Write-Host "Mode   : $(if ($Once) { 'single scan' } else { 'continuous watch' })"

do {
  try {
    $groups = Get-PartGroups -Directory $DownloadDir
    foreach ($group in $groups) {
      if (Is-ReadyForMerge -Video $group.Video -Audio $group.Audio -MinAge $MinAgeSeconds) {
        Merge-Parts -FfmpegPath $ffmpeg -Video $group.Video -Audio $group.Audio -KeepSources:$KeepParts
      }
    }
  } catch {
    Write-Warning $_
  }

  if (-not $Once) {
    Start-Sleep -Seconds $IntervalSeconds
  }
} until ($Once)
