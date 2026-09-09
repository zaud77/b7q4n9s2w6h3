$ErrorActionPreference = "Stop"

$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$envFile = Join-Path $projectDir ".env"
$venvPython = Join-Path $projectDir ".venv\Scripts\python.exe"

if (-not (Test-Path -LiteralPath $envFile)) {
    throw "Missing $envFile. Copy .env.example to .env and fill in the secrets first."
}

Get-Content -LiteralPath $envFile | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#")) {
        return
    }
    $separator = $line.IndexOf("=")
    if ($separator -lt 1) {
        throw "Invalid .env line: $line"
    }
    $name = $line.Substring(0, $separator).Trim()
    $value = $line.Substring($separator + 1)
    [Environment]::SetEnvironmentVariable($name, $value, "Process")
}

if (-not (Test-Path -LiteralPath $venvPython)) {
    throw "Missing virtual environment. Run: py -3.12 -m venv .venv"
}

Set-Location -LiteralPath $projectDir
& $venvPython -m kernel_build_bot.bot
