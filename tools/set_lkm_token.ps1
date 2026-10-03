param(
    [ValidateSet('lkm', 'kernel')]
    [string]$BuildKind = 'lkm'
)

$ErrorActionPreference = 'Stop'
$nmBotRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$nmWranglerPath = Join-Path $nmBotRoot 'node_modules/wrangler/bin/wrangler.js'
if (!(Test-Path -LiteralPath $nmWranglerPath)) { throw 'Run pnpm install in the bot repository first.' }
$nmConfig = Get-Content -LiteralPath (Join-Path $nmBotRoot 'worker/wrangler.jsonc') -Raw | ConvertFrom-Json
$nmRepo = if ($BuildKind -eq 'lkm') { $nmConfig.vars.LKM_GITHUB_REPO } else { $nmConfig.vars.GITHUB_REPO }
$nmSecret = if ($BuildKind -eq 'lkm') { 'LKM_GITHUB_TOKEN' } else { 'KERNEL_GITHUB_TOKEN' }
$nmWorkflowFile = if ($BuildKind -eq 'lkm') { 'lkm.yml' } else { 'fastbuild_6.12.23_oneplus_15_hmbird_gold.yml' }
if ($nmRepo -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { throw 'Invalid repository binding; nothing was stored.' }
$nmOwner = $nmRepo.Split('/')[0]
$nmSecureToken = Read-Host "Enter a $nmOwner token restricted to $nmRepo (Actions read/write, Contents read)" -AsSecureString
$nmTokenPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($nmSecureToken)
try {
    $nmToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($nmTokenPointer)
    if (!$nmToken) { throw 'The token is empty.' }
    $nmHeaders = @{ Authorization = "Bearer $nmToken"; Accept = 'application/vnd.github+json'; 'X-GitHub-Api-Version' = '2022-11-28'; 'User-Agent' = 'nomount-lkm-setup' }
    $nmIdentity = Invoke-RestMethod -Uri 'https://api.github.com/user' -Headers $nmHeaders
    if ($nmIdentity.login -ne $nmOwner) { throw "The token must belong to $nmOwner; nothing was stored." }
    $nmWorkflow = Invoke-RestMethod -Uri "https://api.github.com/repos/$nmRepo/actions/workflows/$nmWorkflowFile" -Headers $nmHeaders
    if ($nmWorkflow.state -ne 'active') { throw 'The build workflow is not active; nothing was stored.' }
    Push-Location $nmBotRoot
    try {
        $nmToken | & node $nmWranglerPath secret put $nmSecret --config worker/wrangler.jsonc
        if ($LASTEXITCODE -ne 0) { throw 'Cloudflare rejected the secret update.' }
    } finally { Pop-Location }
    $nmHealth = Invoke-RestMethod -Uri 'https://gki.zaomin.dpdns.org/health'
    $nmReady = if ($BuildKind -eq 'lkm') { $nmHealth.nomountBuildsReady } else { $nmHealth.kernelBuildsReady }
    $nmDeployedRepo = if ($BuildKind -eq 'lkm') { $nmHealth.nomountRepository } else { $nmHealth.kernelRepository }
    if (!$nmReady -or $nmDeployedRepo -ne $nmRepo) { throw 'The deployed Worker binding differs; deploy the updated Worker.' }
    Write-Host "$nmSecret saved for $nmRepo. Dispatch permission will be verified by the first build."
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($nmTokenPointer)
    $nmSecureToken.Dispose()
    Remove-Variable nmToken,nmHeaders -ErrorAction SilentlyContinue
}
