$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$toolsRoot = if ($env:B2_CHAIN_TOOLS) { $env:B2_CHAIN_TOOLS } else { Join-Path ([System.IO.Path]::GetTempPath()) 'b2-anvil-win-171' }
$anvilExe = Join-Path $toolsRoot 'node_modules\@foundry-rs\anvil-win32-amd64\bin\anvil.exe'
$nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
$npmCmd = (Get-Command npm.cmd -ErrorAction Stop).Source
$artifacts = Join-Path $repoRoot 'artifacts'
$null = New-Item -ItemType Directory -Force -Path $artifacts

if (-not (Test-Path -LiteralPath $anvilExe)) { throw "Anvil 1.7.1 was not found at $anvilExe. Install the pinned toolchain from B2-DESIGN.md." }
if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'web\node_modules\next'))) { throw 'Web dependencies are missing. Run npm.cmd install --prefix web first.' }

$rpcUrl = 'http://127.0.0.1:8545'
$statePath = Join-Path $artifacts 'demo-state.json'
$rpcBody = '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
$chainReady = $false
try {
  $reply = Invoke-RestMethod -Method Post -Uri $rpcUrl -ContentType 'application/json' -Body $rpcBody -TimeoutSec 2
  $chainReady = ($reply.result -eq '0x7a69')
} catch { }

if (-not $chainReady) {
  $anvilArgs = '--host 127.0.0.1 --port 8545 --chain-id 31337 --hardfork shanghai --gas-limit 30000000 --block-time 1 --mnemonic-random --accounts 10 --balance 10000 --silent'
  Start-Process -FilePath $anvilExe -ArgumentList $anvilArgs -WorkingDirectory $repoRoot -WindowStyle Hidden
  $deadline = (Get-Date).AddSeconds(20)
  do {
    Start-Sleep -Milliseconds 250
    try {
      $reply = Invoke-RestMethod -Method Post -Uri $rpcUrl -ContentType 'application/json' -Body $rpcBody -TimeoutSec 2
      $chainReady = ($reply.result -eq '0x7a69')
    } catch { }
  } while (-not $chainReady -and (Get-Date) -lt $deadline)
  if (-not $chainReady) { throw 'Anvil did not become ready on 127.0.0.1:8545.' }
}

Push-Location $repoRoot
try {
  & $nodeExe 'src/compile.cjs'
  if ($LASTEXITCODE -ne 0) { throw 'Contract compilation failed.' }
  if (Test-Path -LiteralPath $statePath) {
    $savedState = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
    $codeRequest = @{ jsonrpc = '2.0'; id = 2; method = 'eth_getCode'; params = @($savedState.contract, 'latest') } | ConvertTo-Json -Compress
    $savedCode = Invoke-RestMethod -Method Post -Uri $rpcUrl -ContentType 'application/json' -Body $codeRequest -TimeoutSec 3
    if ($savedState.chainId -ne 31337 -or -not $savedCode.result -or $savedCode.result -eq '0x') {
      throw 'Saved demo state does not match the running Anvil chain. Run reset-demo, then start a fresh demo deployment.'
    }
  } else {
    & $nodeExe 'src/cli.cjs' 'init-demo'
    if ($LASTEXITCODE -ne 0) { throw 'Demo deployment failed.' }
  }
} finally { Pop-Location }

$webDir = Join-Path $repoRoot 'web'
$webSocket = [System.Net.Sockets.TcpClient]::new()
try {
  $connect = $webSocket.BeginConnect('127.0.0.1', 3000, $null, $null)
  $webAlreadyRunning = $connect.AsyncWaitHandle.WaitOne(300)
  if ($webAlreadyRunning) { $webSocket.EndConnect($connect) }
} catch { $webAlreadyRunning = $false } finally { $webSocket.Dispose() }
if ($webAlreadyRunning) {
  Write-Output "FairTickets is available at http://localhost:3000. Anvil is on $rpcUrl."
} else {
  $startWeb = '/d /s /c "npm.cmd run dev"'
  $webProcess = Start-Process -FilePath $env:ComSpec -ArgumentList $startWeb -WorkingDirectory $webDir -WindowStyle Hidden -PassThru
  Write-Output "FairTickets is starting at http://localhost:3000 (web PID $($webProcess.Id)). Anvil is on $rpcUrl."
}
