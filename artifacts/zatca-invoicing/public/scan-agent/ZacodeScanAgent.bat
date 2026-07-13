@echo off
title Zacode Scan Agent
echo ============================================
echo   Zacode Scan Agent  -  http://127.0.0.1:27345
echo   Keep this window OPEN while scanning.
echo   To auto-start with Windows run:
echo       ZacodeScanAgent.bat install
echo ============================================
if /I "%~1"=="install" (
  copy /Y "%~f0" "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\ZacodeScanAgent.bat" >nul
  echo Installed to Startup folder. It will run automatically on next login.
)
powershell -NoProfile -ExecutionPolicy Bypass -Command "$m = '#=ZSA' + '-PS=#'; iex (((Get-Content -Raw '%~f0') -split [regex]::Escape($m),2)[1])"
exit /b
#=ZSA-PS=#
$ErrorActionPreference = 'Stop'
$port = 27345
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://127.0.0.1:$port/")
try { $listener.Start() } catch {
  Write-Host "ERROR: port $port busy (agent already running?) - $($_.Exception.Message)"
  Start-Sleep -Seconds 8; exit 1
}
Write-Host "Zacode Scan Agent listening on http://127.0.0.1:$port"
$JPEG = '{B96B3CAE-0728-11D3-9D7B-0000F81EF32E}'
$VERSION = '1.0.1'

# ── Origin allow-list ─────────────────────────────────────────────────────
# Only the Zacode ERP web app (and its dev previews) may drive the scanner.
# Any other website in the same browser gets 403 and NO CORS headers, so the
# browser blocks it from reading anything.
$ALLOWED_ORIGIN_PATTERNS = @(
  '^https://([a-z0-9-]+\.)*zacoderp\.com$',
  '^https://[a-z0-9-]+([.-][a-z0-9-]+)*\.(replit\.dev|replit\.app|repl\.co)$',
  '^https?://localhost(:\d+)?$',
  '^https?://127\.0\.0\.1(:\d+)?$'
)
function Test-Origin($origin) {
  if (-not $origin) { return $false }   # browsers ALWAYS send Origin cross-origin
  foreach ($re in $ALLOWED_ORIGIN_PATTERNS) {
    if ($origin -imatch $re) { return $true }
  }
  return $false
}

function Send-Json($ctx, $code, $obj) {
  $json = $obj | ConvertTo-Json -Depth 5 -Compress
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  $r = $ctx.Response
  $r.StatusCode = $code
  $r.ContentType = 'application/json; charset=utf-8'
  $origin = $ctx.Request.Headers['Origin']
  if (Test-Origin $origin) {
    $r.Headers.Add('Access-Control-Allow-Origin', $origin)
    $r.Headers.Add('Vary', 'Origin')
    $r.Headers.Add('Access-Control-Allow-Private-Network', 'true')
  }
  $r.ContentLength64 = $bytes.Length
  $r.OutputStream.Write($bytes, 0, $bytes.Length)
  $r.OutputStream.Close()
}

function Get-Scanners {
  $dm = New-Object -ComObject WIA.DeviceManager
  $list = New-Object System.Collections.ArrayList
  foreach ($d in $dm.DeviceInfos) {
    if ($d.Type -eq 1) {
      $name = ''
      foreach ($p in $d.Properties) { if ($p.Name -eq 'Name') { $name = "$($p.Value)" } }
      [void]$list.Add(@{ id = "$($d.DeviceID)"; name = $name })
    }
  }
  return $list
}

function Do-Scan($deviceId, $dpi, $color) {
  $dm = New-Object -ComObject WIA.DeviceManager
  $info = $null
  foreach ($d in $dm.DeviceInfos) {
    if ($d.Type -eq 1) {
      if (-not $deviceId -or $d.DeviceID -eq $deviceId) { $info = $d; break }
    }
  }
  if (-not $info) { throw 'NO_SCANNER' }
  $device = $info.Connect()
  $item = $device.Items.Item(1)
  foreach ($p in $item.Properties) {
    try {
      if ($p.PropertyID -eq 6146) { $p.Value = [int]$color }
      if ($p.PropertyID -eq 6147) { $p.Value = [int]$dpi }
      if ($p.PropertyID -eq 6148) { $p.Value = [int]$dpi }
    } catch { }
  }
  $img = $item.Transfer()
  if ($img.FormatID -ne $JPEG) {
    $ip = New-Object -ComObject WIA.ImageProcess
    [void]$ip.Filters.Add($ip.FilterInfos.Item('Convert').FilterID)
    $ip.Filters.Item(1).Properties.Item('FormatID').Value = $JPEG
    $ip.Filters.Item(1).Properties.Item('Quality').Value = 85
    $img = $ip.Apply($img)
  }
  $tmp = Join-Path $env:TEMP ("zsa_" + [guid]::NewGuid().ToString('N') + '.jpg')
  $img.SaveFile($tmp)
  $bytes = [System.IO.File]::ReadAllBytes($tmp)
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  return [Convert]::ToBase64String($bytes)
}

while ($listener.IsListening) {
  try {
    $ctx = $listener.GetContext()
    $path = $ctx.Request.Url.AbsolutePath.TrimEnd('/')
    $reqOrigin = $ctx.Request.Headers['Origin']
    if ($ctx.Request.HttpMethod -eq 'OPTIONS') {
      $r = $ctx.Response
      if (Test-Origin $reqOrigin) {
        $r.StatusCode = 204
        $r.Headers.Add('Access-Control-Allow-Origin', $reqOrigin)
        $r.Headers.Add('Vary', 'Origin')
        $r.Headers.Add('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        $r.Headers.Add('Access-Control-Allow-Headers', 'Content-Type')
        $r.Headers.Add('Access-Control-Allow-Private-Network', 'true')
        $r.Headers.Add('Access-Control-Max-Age', '600')
      } else {
        $r.StatusCode = 403
      }
      $r.OutputStream.Close()
      continue
    }
    # Cross-origin browser requests carry an Origin header — reject unknown sites.
    if ($reqOrigin -and -not (Test-Origin $reqOrigin)) {
      Write-Host "Blocked request from disallowed origin: $reqOrigin"
      Send-Json $ctx 403 @{ ok = $false; error = 'origin_not_allowed' }
      continue
    }
    switch ($path) {
      '/health' { Send-Json $ctx 200 @{ ok = $true; agent = 'zacode-scan'; version = $VERSION } }
      '/devices' {
        try { Send-Json $ctx 200 @{ ok = $true; devices = @(Get-Scanners) } }
        catch { Send-Json $ctx 500 @{ ok = $false; error = "$($_.Exception.Message)" } }
      }
      '/scan' {
        try {
          $body = ''
          if ($ctx.Request.HasEntityBody) {
            $reader = New-Object System.IO.StreamReader($ctx.Request.InputStream, $ctx.Request.ContentEncoding)
            $body = $reader.ReadToEnd(); $reader.Close()
          }
          $opts = if ($body) { $body | ConvertFrom-Json } else { $null }
          $deviceId = if ($opts -and $opts.deviceId) { "$($opts.deviceId)" } else { $null }
          $dpi = if ($opts -and $opts.dpi) { [int]$opts.dpi } else { 200 }
          $color = if ($opts -and $opts.color) { [int]$opts.color } else { 1 }
          if ($dpi -lt 75 -or $dpi -gt 600) { $dpi = 200 }
          Write-Host "Scanning... (dpi=$dpi color=$color)"
          $b64 = Do-Scan $deviceId $dpi $color
          Write-Host "Scan OK ($([math]::Round($b64.Length * 3 / 4 / 1024)) KB)"
          Send-Json $ctx 200 @{ ok = $true; imageBase64 = $b64; contentType = 'image/jpeg' }
        } catch {
          $msg = "$($_.Exception.Message)"
          Write-Host "Scan FAILED: $msg"
          Send-Json $ctx 500 @{ ok = $false; error = $msg }
        }
      }
      default { Send-Json $ctx 404 @{ ok = $false; error = 'not_found' } }
    }
  } catch {
    Write-Host "Request error: $($_.Exception.Message)"
  }
}
