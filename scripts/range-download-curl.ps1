param(
  [Parameter(Mandatory = $true)][string]$Url,
  [Parameter(Mandatory = $true)][string]$Target,
  [Parameter(Mandatory = $true)][Int64]$TotalBytes,
  [Int64]$ChunkBytes = 268435456,
  [int]$Concurrency = 6
)

$ErrorActionPreference = "Stop"

$targetPath = [System.IO.Path]::GetFullPath((Join-Path (Get-Location) $Target))
$targetDir = Split-Path -Parent $targetPath
$partsDir = "$targetPath.parts"
New-Item -ItemType Directory -Force $targetDir | Out-Null
New-Item -ItemType Directory -Force $partsDir | Out-Null

$existing = 0L
if (Test-Path -LiteralPath $targetPath) {
  $existing = (Get-Item -LiteralPath $targetPath).Length
}

$ranges = New-Object System.Collections.Generic.List[object]
for ($start = $existing; $start -lt $TotalBytes; $start += $ChunkBytes) {
  $end = [Math]::Min($TotalBytes - 1, $start + $ChunkBytes - 1)
  $ranges.Add([PSCustomObject]@{
    Start = [Int64]$start
    End = [Int64]$end
    File = Join-Path $partsDir "$start-$end.part"
  })
}

Write-Host "target=$targetPath"
Write-Host "existing=$existing total=$TotalBytes chunks=$($ranges.Count) concurrency=$Concurrency"

$scriptBlock = {
  param($Range, $Url, $WorkerId)
  $expected = [Int64]($Range.End - $Range.Start + 1)
  if (Test-Path -LiteralPath $Range.File) {
    $current = (Get-Item -LiteralPath $Range.File).Length
    if ($current -eq $expected) {
      Write-Host "worker=$WorkerId reuse $($Range.Start)-$($Range.End)"
      return
    }
    Remove-Item -LiteralPath $Range.File -Force
  }

  Get-ChildItem -LiteralPath (Split-Path -Parent $Range.File) -Filter "$(Split-Path -Leaf $Range.File).tmp-*" -ErrorAction SilentlyContinue |
    Remove-Item -Force

  $temp = "$($Range.File).tmp-$PID-$WorkerId"
  Write-Host "worker=$WorkerId download $($Range.Start)-$($Range.End)"
  $output = & curl.exe --silent --show-error -L --fail --retry 10 --retry-delay 3 --range "$($Range.Start)-$($Range.End)" -o $temp $Url 2>&1
  if ($LASTEXITCODE -ne 0) {
    if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force }
    throw "curl failed worker=$WorkerId range=$($Range.Start)-$($Range.End) exit=$LASTEXITCODE output=$output"
  }
  $size = (Get-Item -LiteralPath $temp).Length
  if ($size -ne $expected) {
    Remove-Item -LiteralPath $temp -Force
    throw "bad chunk size worker=$WorkerId range=$($Range.Start)-$($Range.End) got=$size expected=$expected"
  }
  Move-Item -LiteralPath $temp -Destination $Range.File -Force
  Write-Host "worker=$WorkerId done $($Range.Start)-$($Range.End)"
}

$jobs = @()
$nextIndex = 0
$workerId = 1
$failures = New-Object System.Collections.Generic.List[string]
$maxConcurrency = [Math]::Max(1, $Concurrency)
while ($nextIndex -lt $ranges.Count -or $jobs.Count -gt 0) {
  while ($nextIndex -lt $ranges.Count -and $jobs.Count -lt $maxConcurrency) {
    $range = $ranges[$nextIndex]
    $jobs += Start-Job -ScriptBlock $scriptBlock -ArgumentList $range, $Url, $workerId
    $nextIndex += 1
    $workerId += 1
  }

  $finished = @($jobs | Where-Object { $_.State -ne "Running" })
  foreach ($job in $finished) {
    try {
      Receive-Job -Job $job -ErrorAction Stop
    } catch {
      $failures.Add($_.Exception.Message)
    }
    if ($job.State -eq "Failed") {
      $reason = $job.ChildJobs[0].JobStateInfo.Reason
      if ($reason) { $failures.Add($reason.ToString()) }
    }
    Remove-Job -Job $job -Force
  }
  $jobs = @($jobs | Where-Object { $_.State -eq "Running" })

  if ($failures.Count -gt 0) {
    foreach ($job in $jobs) { Stop-Job -Job $job; Remove-Job -Job $job -Force }
    throw "range download failed: $($failures -join ' | ')"
  }

  Start-Sleep -Seconds 1
}

$tempTarget = "$targetPath.complete-$PID"
if (Test-Path -LiteralPath $tempTarget) { Remove-Item -LiteralPath $tempTarget -Force }
$output = [System.IO.File]::Open($tempTarget, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write)
try {
  if ($existing -gt 0) {
    $input = [System.IO.File]::Open($targetPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read)
    try {
      $buffer = New-Object byte[] 1048576
      $remaining = $existing
      while ($remaining -gt 0) {
        $readTarget = [Math]::Min($buffer.Length, $remaining)
        $read = $input.Read($buffer, 0, $readTarget)
        if ($read -le 0) { throw "unexpected EOF while copying existing prefix" }
        $output.Write($buffer, 0, $read)
        $remaining -= $read
      }
    } finally {
      $input.Dispose()
    }
  }

  foreach ($range in $ranges) {
    $input = [System.IO.File]::Open($range.File, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read)
    try {
      $input.CopyTo($output)
    } finally {
      $input.Dispose()
    }
  }
} finally {
  $output.Dispose()
}

$finalSize = (Get-Item -LiteralPath $tempTarget).Length
if ($finalSize -ne $TotalBytes) {
  throw "final size mismatch got=$finalSize expected=$TotalBytes"
}
Move-Item -LiteralPath $tempTarget -Destination $targetPath -Force
Remove-Item -LiteralPath $partsDir -Recurse -Force
Write-Host "complete $targetPath $finalSize"
