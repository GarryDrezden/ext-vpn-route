# Regenerates Chromium toolbar icons from the tracked brand master.
# Requires Windows PowerShell with System.Drawing (desktop .NET).
# Source: assets/branding/vpn-route-icon-source.png
# Output: src/extension/assets/icons/icon-{16,32,48,128}.png

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$SrcPath = Join-Path $Root "assets\branding\vpn-route-icon-source.png"
$OutDir = Join-Path $Root "src\extension\assets\icons"

if (-not (Test-Path $SrcPath)) {
  throw "Missing brand master: $SrcPath"
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
Add-Type -AssemblyName System.Drawing

$srcImg = [System.Drawing.Image]::FromFile($SrcPath)
try {
  $img = New-Object System.Drawing.Bitmap $srcImg.Width, $srcImg.Height, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g0 = [System.Drawing.Graphics]::FromImage($img)
  $g0.Clear([System.Drawing.Color]::Transparent)
  $g0.DrawImage($srcImg, 0, 0, $srcImg.Width, $srcImg.Height)
  $g0.Dispose()
  foreach ($size in @(16, 32, 48, 128)) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      try {
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $g.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
        $g.Clear([System.Drawing.Color]::Transparent)
        $g.DrawImage($img, 0, 0, $size, $size)
      } finally {
        $g.Dispose()
      }
      $out = Join-Path $OutDir "icon-$size.png"
      $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
      Write-Host "Wrote $out"
    } finally {
      $bmp.Dispose()
    }
  }
} finally {
  $img.Dispose()
  $srcImg.Dispose()
}
