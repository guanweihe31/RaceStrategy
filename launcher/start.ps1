# RaceStrategy launcher.
#
# Double-click "Start RaceStrategy.bat" (it runs this script). The first time it
# prepares everything; after that it just starts the app:
#   1. Python packages for the backend   -> backend\env (virtual environment)
#   2. Node.js, if it is not installed   -> tools\node (private copy, nothing installed on Windows)
#   3. Frontend packages                 -> frontend\node_modules
#   4. Starts the backend (port 8000) and the frontend (port 5173) in the background
#      and opens the browser. Logs go to logs\.
#
# "Stop RaceStrategy.bat" (or this script with -Stop) closes both.
# Every step is skipped when it is already done, so launching again is fast.

param(
    [switch]$Stop,   # only stop a running RaceStrategy
    [switch]$NoWait  # start and return immediately (for testing)
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Root = Split-Path -Parent $PSScriptRoot
$Backend = Join-Path $Root 'backend'
$Frontend = Join-Path $Root 'frontend'
$Tools = Join-Path $Root 'tools'
$Logs = Join-Path $Root 'logs'
$DataDir = Join-Path $Backend 'data\raw'
$ApiPort = 8000
$WebPort = 5173
$AppUrl = "http://localhost:$WebPort"
$NodeMajor = 22

function Write-Step($text) { Write-Host ''; Write-Host "==> $text" -ForegroundColor Cyan }
function Write-Ok($text) { Write-Host "    $text" -ForegroundColor Green }
function Write-Info($text) { Write-Host "    $text" -ForegroundColor Gray }
function Stop-WithError($text) {
    Write-Host ''
    Write-Host "PROBLEM: $text" -ForegroundColor Red
    Write-Host 'Send a screenshot of this window (and the files in the logs folder) to your teammate.' -ForegroundColor Yellow
    exit 1
}

# ---------------------------------------------------------------------------
# Processes listening on our ports
# ---------------------------------------------------------------------------
function Get-PortProcess([int]$port) {
    $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $conn) { return $null }
    return Get-CimInstance Win32_Process -Filter "ProcessId = $($conn.OwningProcess)" -ErrorAction SilentlyContinue
}

# Ours = the backend (uvicorn) or the frontend (vite) of RaceStrategy.
function Test-OurProcess($proc) {
    return $proc -and $proc.CommandLine -and ($proc.CommandLine -match 'uvicorn|vite')
}

function Stop-App {
    $stopped = $false
    foreach ($port in @($ApiPort, $WebPort)) {
        $proc = Get-PortProcess $port
        if (Test-OurProcess $proc) {
            Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
            Write-Ok "Stopped $($proc.Name) on port $port"
            $stopped = $true
        }
    }
    if (-not $stopped) { Write-Info 'RaceStrategy was not running.' }
}

if ($Stop) {
    Write-Step 'Stopping RaceStrategy'
    Stop-App
    exit 0
}

# ---------------------------------------------------------------------------
# 1. Python + backend packages
# ---------------------------------------------------------------------------
function Find-Python {
    # "py" is the official Python launcher; "python" can be a Microsoft Store shortcut
    # that does nothing, so every candidate is actually run and checked.
    foreach ($candidate in @(@('py', '-3'), @('python'))) {
        if (-not (Get-Command $candidate[0] -ErrorAction SilentlyContinue)) { continue }
        $pyArgs = @($candidate | Select-Object -Skip 1) + @('-c', 'import sys; print(sys.executable); print(sys.version_info >= (3, 10))')
        try { $out = & $candidate[0] @pyArgs 2>$null } catch { continue }
        if ($LASTEXITCODE -eq 0 -and $out.Count -ge 2 -and $out[1] -eq 'True') { return $out[0] }
    }
    return $null
}

Write-Step 'Checking the backend (Python)'
$VenvPython = Join-Path $Backend 'env\Scripts\python.exe'
if (-not (Test-Path $VenvPython)) {
    $systemPython = Find-Python
    if (-not $systemPython) {
        Write-Host '    Python 3.10 or newer is not installed.' -ForegroundColor Yellow
        Write-Host '    Install it from https://www.python.org/downloads/ and TICK "Add python.exe to PATH",' -ForegroundColor Yellow
        Write-Host '    then double-click Start RaceStrategy.bat again.' -ForegroundColor Yellow
        Start-Process 'https://www.python.org/downloads/'
        Stop-WithError 'Python not found.'
    }
    Write-Info "Creating the Python environment (first time only) with $systemPython"
    & $systemPython -m venv (Join-Path $Backend 'env')
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $VenvPython)) { Stop-WithError 'Could not create backend\env.' }
}

$requirements = Join-Path $Backend 'requirements.txt'
$requirementsStamp = Join-Path $Backend 'env\requirements.installed.txt'
$needPackages = -not (Test-Path $requirementsStamp)
if (-not $needPackages) {
    $needPackages = (Get-FileHash $requirements).Hash -ne (Get-FileHash $requirementsStamp).Hash
}
if ($needPackages) {
    Write-Info 'Installing Python packages (first time or after an update, 1-3 minutes)...'
    & $VenvPython -m pip install --disable-pip-version-check --quiet -r $requirements
    if ($LASTEXITCODE -ne 0) { Stop-WithError 'Installing the Python packages failed (see the messages above).' }
    Copy-Item $requirements $requirementsStamp -Force
}
Write-Ok 'Backend ready'

# ---------------------------------------------------------------------------
# 2. Node.js (installed one if recent enough, otherwise a private copy in tools\node)
# ---------------------------------------------------------------------------
function Test-NodeVersion([string]$nodeExe) {
    try { $version = & $nodeExe --version } catch { return $false }
    if ($version -notmatch '^v(\d+)\.(\d+)') { return $false }
    $major = [int]$Matches[1]; $minor = [int]$Matches[2]
    return ($major -gt 22) -or ($major -eq 22 -and $minor -ge 12) -or ($major -eq 20 -and $minor -ge 19)
}

function Find-Node {
    $system = Get-Command node -ErrorAction SilentlyContinue
    if ($system -and (Test-NodeVersion $system.Source)) { return $system.Source }
    $local = Get-ChildItem (Join-Path $Tools 'node') -Filter node.exe -Recurse -Depth 1 -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($local -and (Test-NodeVersion $local.FullName)) { return $local.FullName }
    return $null
}

function Install-Node {
    New-Item -ItemType Directory -Force $Tools | Out-Null
    Write-Info 'Node.js not found: downloading a private copy from nodejs.org (about 30 MB, first time only)...'
    $index = Invoke-RestMethod 'https://nodejs.org/dist/index.json'
    $version = ($index | Where-Object { $_.lts -and $_.version -like "v$NodeMajor.*" } | Select-Object -First 1).version
    if (-not $version) { Stop-WithError 'Could not find the Node.js version to download.' }
    $name = "node-$version-win-x64"
    $zip = Join-Path $Tools "$name.zip"
    if (-not (Test-Path $zip)) {
        Invoke-WebRequest "https://nodejs.org/dist/$version/$name.zip" -OutFile $zip -UseBasicParsing
    }
    # The official checksum guarantees the file is the genuine, complete download.
    $sums = (Invoke-WebRequest "https://nodejs.org/dist/$version/SHASUMS256.txt" -UseBasicParsing).Content
    $line = ($sums -split "`n") | Where-Object { $_ -match "\s$([regex]::Escape("$name.zip"))\s*$" } | Select-Object -First 1
    $expected = ($line -split '\s+')[0]
    $actual = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
    if (-not $expected -or $expected -ne $actual) {
        Remove-Item $zip -Force -ErrorAction SilentlyContinue
        Stop-WithError 'The Node.js download is damaged (checksum mismatch). Try again.'
    }
    $target = Join-Path $Tools 'node'
    if (Test-Path $target) { Remove-Item $target -Recurse -Force }
    Expand-Archive $zip -DestinationPath $target -Force
    Remove-Item $zip -Force
    Write-Ok "Node.js $version ready in tools\node"
}

Write-Step 'Checking the frontend (Node.js)'
$Node = Find-Node
if (-not $Node) {
    Install-Node
    $Node = Find-Node
    if (-not $Node) { Stop-WithError 'Node.js could not be prepared.' }
}
$NpmCli = Join-Path (Split-Path $Node) 'node_modules\npm\bin\npm-cli.js'
# npm runs helper scripts with "node": make sure it finds this copy
$env:Path = "$(Split-Path $Node);$env:Path"

$lock = Join-Path $Frontend 'package-lock.json'
$lockStamp = Join-Path $Frontend 'node_modules\.lock-installed.json'
$needModules = -not (Test-Path $lockStamp)
if (-not $needModules) { $needModules = (Get-FileHash $lock).Hash -ne (Get-FileHash $lockStamp).Hash }
if ($needModules) {
    Write-Info 'Installing frontend packages (first time or after an update, about 1 minute)...'
    Push-Location $Frontend
    try { & $Node $NpmCli ci --no-audit --no-fund --loglevel=error } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { Stop-WithError 'Installing the frontend packages failed (see the messages above).' }
    Copy-Item $lock $lockStamp -Force
}
Write-Ok 'Frontend ready'

# ---------------------------------------------------------------------------
# 3. Start (or reuse) both servers
# ---------------------------------------------------------------------------
function Wait-Url([string]$url, [int]$seconds) {
    $deadline = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $deadline) {
        try {
            Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 5 | Out-Null
            return $true
        } catch {
            Start-Sleep -Milliseconds 700
        }
    }
    return $false
}

function Show-LogTail([string]$file) {
    if (Test-Path $file) {
        Write-Host "    --- last lines of $file ---" -ForegroundColor DarkGray
        Get-Content $file -Tail 15 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    }
}

function Start-Server([string]$label, [int]$port, [string]$exe, [string[]]$arguments, [string]$workDir, [string]$logName) {
    $proc = Get-PortProcess $port
    if ($proc) {
        if (Test-OurProcess $proc) { Write-Ok "$label already running (port $port)"; return }
        Stop-WithError "Port $port is used by another program ($($proc.Name)). Close it and try again."
    }
    Start-Process -FilePath $exe -ArgumentList $arguments -WorkingDirectory $workDir -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $Logs "$logName.log") `
        -RedirectStandardError (Join-Path $Logs "$logName-errors.log") | Out-Null
    Write-Info "$label starting (port $port)..."
}

Write-Step 'Starting RaceStrategy'
New-Item -ItemType Directory -Force $Logs | Out-Null
New-Item -ItemType Directory -Force $DataDir | Out-Null

Start-Server 'Backend' $ApiPort $VenvPython @('-m', 'uvicorn', 'api:app', '--host', '127.0.0.1', '--port', "$ApiPort") `
    (Join-Path $Backend 'src') 'backend'
Start-Server 'Frontend' $WebPort $Node @('node_modules/vite/bin/vite.js', '--port', "$WebPort", '--strictPort') `
    $Frontend 'frontend'

if (-not (Wait-Url "http://127.0.0.1:$ApiPort/api/sessions" 90)) {
    Show-LogTail (Join-Path $Logs 'backend-errors.log')
    Stop-WithError 'The backend did not start.'
}
Write-Ok 'Backend running'
if (-not (Wait-Url $AppUrl 90)) {
    Show-LogTail (Join-Path $Logs 'frontend-errors.log')
    Stop-WithError 'The frontend did not start.'
}
Write-Ok 'Frontend running'

Start-Process $AppUrl

Write-Host ''
Write-Host '  RaceStrategy is running at ' -NoNewline -ForegroundColor White
Write-Host $AppUrl -ForegroundColor Green
Write-Host "  Timing files (CSV) go in: $DataDir" -ForegroundColor Gray
Write-Host '  One folder per event, e.g. WEC\2026\Barcelona. Refresh the page after adding files.' -ForegroundColor Gray
if ($NoWait) { exit 0 }
Write-Host ''
Write-Host '  Press ENTER in this window to stop RaceStrategy.' -ForegroundColor Yellow
Write-Host '  (If you just close the window it keeps running; use Stop RaceStrategy.bat.)' -ForegroundColor DarkGray
[void](Read-Host)
Stop-App
