param(
  [Parameter(Mandatory = $false)]
  [string]$VideoPath,

  [Parameter(Mandatory = $false)]
  [string]$AudioPath,

  [Parameter(Mandatory = $false)]
  [string]$OutputPath,

  [Parameter(Mandatory = $false)]
  [string]$DownloadDir = "$env:USERPROFILE\Downloads",

  [Parameter(Mandatory = $false)]
  [string]$BaseName
)

$ErrorActionPreference = 'Stop'

function Resolve-ExistingPath {
  param([string]$PathValue)
  if (-not $PathValue) { return $null }
  return (Resolve-Path -LiteralPath $PathValue -ErrorAction Stop).Path
}

function Get-LatestMatchingFile {
  param(
    [string]$Directory,
    [string]$Pattern
  )

  return Get-ChildItem -LiteralPath $Directory -File |
    Where-Object { $_.Name -like $Pattern } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
}

function Ensure-Ffmpeg {
  $cmd = Get-Command ffmpeg -ErrorAction SilentlyContinue
  if (-not $cmd) {
    throw "ffmpeg is not installed or not on PATH. Install ffmpeg, then rerun this script."
  }
  return $cmd.Source
}

$ffmpeg = Ensure-Ffmpeg

if ($VideoPath) { $VideoPath = Resolve-ExistingPath $VideoPath }
if ($AudioPath) { $AudioPath = Resolve-ExistingPath $AudioPath }

if (-not $VideoPath -or -not $AudioPath) {
  if (-not (Test-Path -LiteralPath $DownloadDir)) {
    throw "Download directory not found: $DownloadDir"
  }

  if ($BaseName) {
    $videoFile = Get-LatestMatchingFile -Directory $DownloadDir -Pattern "$BaseName*_video.*"
    $audioFile = Get-LatestMatchingFile -Directory $DownloadDir -Pattern "$BaseName*_audio.*"
  } else {
    $videoFile = Get-LatestMatchingFile -Directory $DownloadDir -Pattern "*_video.*"
    $audioFile = Get-LatestMatchingFile -Directory $DownloadDir -Pattern "*_audio.*"
  }

  if (-not $VideoPath) {
    if (-not $videoFile) { throw "Could not find a matching *_video file in $DownloadDir" }
    $VideoPath = $videoFile.FullName
  }

  if (-not $AudioPath) {
    if (-not $audioFile) { throw "Could not find a matching *_audio file in $DownloadDir" }
    $AudioPath = $audioFile.FullName
  }
}

if (-not $OutputPath) {
  $videoItem = Get-Item -LiteralPath $VideoPath
  $baseOutput = if ($videoItem.BaseName -match '^(.*)_video$') { $Matches[1] } else { $videoItem.BaseName }
  $OutputPath = Join-Path -Path $videoItem.DirectoryName -ChildPath ($baseOutput + '.mp4')
}

$tempOutput = "$OutputPath.tmp.mp4"
if (Test-Path -LiteralPath $tempOutput) {
  Remove-Item -LiteralPath $tempOutput -Force
}

Write-Host "Video : $VideoPath"
Write-Host "Audio : $AudioPath"
Write-Host "Output: $OutputPath"

& $ffmpeg -y -i $VideoPath -i $AudioPath -c copy -map 0:v:0 -map 1:a:0 $tempOutput

if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $tempOutput)) {
  throw "ffmpeg merge failed."
}

Move-Item -LiteralPath $tempOutput -Destination $OutputPath -Force
Write-Host "Merged file created: $OutputPath"
