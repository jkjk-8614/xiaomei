$path = Join-Path $PSScriptRoot 'static/js/smart-canvas.js'
$text = [IO.File]::ReadAllText($path)
$needles = @(
  'agent-output',
  'agentOutputExpanded',
  'agentUserPromptHeight'
)
$parts = foreach ($needle in $needles) {
  $start = 0
  $found = 0
  while (($index = $text.IndexOf($needle, $start, [StringComparison]::Ordinal)) -ge 0 -and $found -lt 8) {
    $from = [Math]::Max(0, $index - 320)
    $length = [Math]::Min(920, $text.Length - $from)
    "=== $needle @ $index ==="
    $text.Substring($from, $length)
    $start = $index + $needle.Length
    $found++
  }
}
[IO.File]::WriteAllText((Join-Path $PSScriptRoot '_inspect-agent.txt'), ($parts -join "`r`n"), [Text.UTF8Encoding]::new($false))
