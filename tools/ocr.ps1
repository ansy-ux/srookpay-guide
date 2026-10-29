# Windows 내장 OCR(한국어)로 이미지 글자를 읽는다. 개인정보 점검(tools/privacy-scan.mjs)에서 사용.
#   powershell -File tools/ocr.ps1 -List 목록.txt -Out 결과.json
# 목록.txt: 이미지 경로 한 줄에 하나. 결과: { "경로": "읽은 글자", ... }
param([string]$List, [string]$Out)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, [Type]$t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }
$lang = New-Object Windows.Globalization.Language 'ko'
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
$result = [ordered]@{}
foreach ($p in Get-Content -Encoding UTF8 $List) {
  if (-not $p.Trim()) { continue }
  try {
    $full = (Resolve-Path $p).Path
    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($full)) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bmp = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $ocr = Await ($engine.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])
    $result[$p] = ($ocr.Lines | ForEach-Object { $_.Text }) -join "`n"
    $stream.Dispose()
  } catch { $result[$p] = "__ERROR__ " + $_.Exception.Message }
}
[System.IO.File]::WriteAllText($Out, ($result | ConvertTo-Json -Depth 3), (New-Object System.Text.UTF8Encoding $false))
