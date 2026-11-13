$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$port = 8765
$prefix = "http://localhost:$port/"
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add($prefix)
$listener.Start()
Write-Host "貨物明細櫃型試算：$prefix"

$types = @{
  ".html" = "text/html; charset=utf-8"
  ".js"   = "text/javascript; charset=utf-8"
  ".css"  = "text/css; charset=utf-8"
  ".pdf"  = "application/pdf"
  ".png"  = "image/png"
  ".jpg"  = "image/jpeg"
  ".jpeg" = "image/jpeg"
  ".webp" = "image/webp"
  ".wasm" = "application/wasm"
  ".csv"  = "text/csv; charset=utf-8"
  ".xlsx" = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  ".xls"  = "application/vnd.ms-excel"
  ".docx" = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
}

try {
  while ($listener.IsListening) {
    $context = $listener.GetContext()
    $requestPath = [Uri]::UnescapeDataString($context.Request.Url.AbsolutePath)
    if ($requestPath -eq "/") { $requestPath = "/index.html" }
    $relative = $requestPath.TrimStart("/").Replace("/", "\")
    $full = [System.IO.Path]::GetFullPath((Join-Path $root $relative))
    if (-not $full.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $full -PathType Leaf)) {
      $context.Response.StatusCode = 404
      $buffer = [Text.Encoding]::UTF8.GetBytes("Not found")
    } else {
      $ext = [System.IO.Path]::GetExtension($full).ToLowerInvariant()
      $context.Response.ContentType = $types[$ext]
      if (-not $context.Response.ContentType) { $context.Response.ContentType = "application/octet-stream" }
      $buffer = [System.IO.File]::ReadAllBytes($full)
      $context.Response.StatusCode = 200
    }
    $context.Response.Headers["Cache-Control"] = "no-store"
    $context.Response.ContentLength64 = $buffer.Length
    $context.Response.OutputStream.Write($buffer, 0, $buffer.Length)
    $context.Response.OutputStream.Close()
  }
} finally {
  $listener.Stop()
}
