# Builds a clean ARGB master from the brand mark (removes outer white screenshot canvas).
# Input default: design reference crop; output: assets/branding/vpn-route-icon-source.png

param(
  [string]$InputPath = "",
  [int]$WhiteTolerance = 36,
  [int]$FringeTolerance = 28,
  [int]$PaddingPx = 8
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$OutPath = Join-Path $Root "assets\branding\vpn-route-icon-source.png"
if (-not $InputPath) {
  $InputPath = Join-Path $Root "upload\VPN_Route_Design_Pack_RC19\references\03_logo_icon_reference_crop.png"
}

Add-Type -AssemblyName System.Drawing

function Test-OuterWhite([System.Drawing.Color]$c, [int]$tol) {
  return ($c.R -ge 255 - $tol -and $c.G -ge 255 - $tol -and $c.B -ge 255 - $tol)
}

function Test-Fringe([System.Drawing.Color]$c, [int]$tol) {
  $avg = ($c.R + $c.G + $c.B) / 3.0
  $max = [Math]::Max($c.R, [Math]::Max($c.G, $c.B))
  $min = [Math]::Min($c.R, [Math]::Min($c.G, $c.B))
  $sat = $max - $min
  return ($avg -ge 255 - $tol -and $sat -le 36)
}

function Load-ArgbBitmap([string]$path) {
  $src = [System.Drawing.Image]::FromFile($path)
  try {
    $bmp = New-Object System.Drawing.Bitmap $src.Width, $src.Height, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.DrawImage($src, 0, 0, $src.Width, $src.Height)
    $g.Dispose()
    return $bmp
  } finally {
    $src.Dispose()
  }
}

function Remove-EdgeConnectedBackground([System.Drawing.Bitmap]$bmp, [scriptblock]$TestFn, [int]$tol) {
  $w = $bmp.Width
  $h = $bmp.Height
  $visited = New-Object 'bool[]' ($w * $h)
  $queue = [System.Collections.Generic.Queue[int]]::new()

  function TryEnqueue([int]$x, [int]$y) {
    if ($x -lt 0 -or $y -lt 0 -or $x -ge $w -or $y -ge $h) { return }
    $i = $y * $w + $x
    if ($visited[$i]) { return }
    $c = $bmp.GetPixel($x, $y)
    if (-not (& $TestFn $c $tol)) { return }
    $visited[$i] = $true
    $queue.Enqueue($i)
  }

  for ($x = 0; $x -lt $w; $x++) {
    TryEnqueue $x 0
    TryEnqueue $x ($h - 1)
  }
  for ($y = 0; $y -lt $h; $y++) {
    TryEnqueue 0 $y
    TryEnqueue ($w - 1) $y
  }

  while ($queue.Count -gt 0) {
    $i = $queue.Dequeue()
    $x = $i % $w
    $y = [int][math]::Floor($i / $w)
    $bmp.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(0, 0, 0, 0))
    TryEnqueue ($x - 1) $y
    TryEnqueue ($x + 1) $y
    TryEnqueue $x ($y - 1)
    TryEnqueue $x ($y + 1)
  }
}

function Remove-FringeFromTransparency([System.Drawing.Bitmap]$bmp, [int]$tol) {
  $w = $bmp.Width
  $h = $bmp.Height
  $changed = $true
  while ($changed) {
    $changed = $false
    for ($y = 0; $y -lt $h; $y++) {
      for ($x = 0; $x -lt $w; $x++) {
        $c = $bmp.GetPixel($x, $y)
        if ($c.A -eq 0) { continue }
        if (-not (Test-Fringe $c $tol)) { continue }
        $touch = $false
        foreach ($d in @(@(-1,0), @(1,0), @(0,-1), @(0,1), @(-1,-1), @(1,-1), @(-1,1), @(1,1))) {
          $nx = $x + $d[0]; $ny = $y + $d[1]
          if ($nx -lt 0 -or $ny -lt 0 -or $nx -ge $w -or $ny -ge $h) { $touch = $true; break }
          if ($bmp.GetPixel($nx, $ny).A -eq 0) { $touch = $true; break }
        }
        if ($touch) {
          $bmp.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(0, 0, 0, 0))
          $changed = $true
        }
      }
    }
  }
}

function Get-ContentBounds([System.Drawing.Bitmap]$bmp) {
  $w = $bmp.Width
  $h = $bmp.Height
  $minX = $w; $minY = $h; $maxX = -1; $maxY = -1
  for ($y = 0; $y -lt $h; $y++) {
    for ($x = 0; $x -lt $w; $x++) {
      if ($bmp.GetPixel($x, $y).A -gt 0) {
        if ($x -lt $minX) { $minX = $x }
        if ($y -lt $minY) { $minY = $y }
        if ($x -gt $maxX) { $maxX = $x }
        if ($y -gt $maxY) { $maxY = $y }
      }
    }
  }
  if ($maxX -lt 0) { throw "No opaque pixels left after background removal." }
  return @{ MinX = $minX; MinY = $minY; MaxX = $maxX; MaxY = $maxY }
}

function Crop-SquareWithPadding([System.Drawing.Bitmap]$bmp, [int]$pad) {
  $b = Get-ContentBounds $bmp
  $cw = $b.MaxX - $b.MinX + 1
  $ch = $b.MaxY - $b.MinY + 1
  $side = [Math]::Max($cw, $ch) + 2 * $pad
  $out = New-Object System.Drawing.Bitmap $side, $side, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($out)
  $g.Clear([System.Drawing.Color]::Transparent)
  $offX = [int][math]::Floor(($side - $cw) / 2)
  $offY = [int][math]::Floor(($side - $ch) / 2)
  $srcRect = New-Object System.Drawing.Rectangle $b.MinX, $b.MinY, $cw, $ch
  $destRect = New-Object System.Drawing.Rectangle $offX, $offY, $cw, $ch
  $g.DrawImage($bmp, $destRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
  $g.Dispose()
  $bmp.Dispose()
  return $out
}

New-Item -ItemType Directory -Force -Path (Split-Path $OutPath) | Out-Null
$work = Load-ArgbBitmap $InputPath
Remove-EdgeConnectedBackground $work ${function:Test-OuterWhite} $WhiteTolerance
Remove-FringeFromTransparency $work $FringeTolerance
$master = Crop-SquareWithPadding $work $PaddingPx
try {
  $master.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Host "Wrote clean master: $OutPath ($($master.Width)x$($master.Height))"
} finally {
  $master.Dispose()
}
