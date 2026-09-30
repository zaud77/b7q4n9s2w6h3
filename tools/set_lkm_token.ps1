$ErrorActionPreference = 'Stop'
$nmBotRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$nmWranglerPath = Join-Path $nmBotRoot 'node_modules/wrangler/bin/wrangler.js'
if (!(Test-Path -LiteralPath $nmWranglerPath)) { throw 'Run pnpm install in the bot repository first.' }
$nmSecureToken = Read-Host 'Enter a zaominn token restricted to nomount-lkm (Actions read/write, Contents read)' -AsSecureString
$nmTokenPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($nmSecureToken)
try {
    $nmToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($nmTokenPointer)
    if (!$nmToken) { throw 'The token is empty.' }
    $nmHeaders = @{ Authorization = "Bearer $nmToken"; Accept = 'application/vnd.github+json'; 'X-GitHub-Api-Version' = '2022-11-28'; 'User-Agent' = 'nomount-lkm-setup' }
    $nmIdentity = Invoke-RestMethod -Uri 'https://api.github.com/user' -Headers $nmHeaders
    if ($nmIdentity.login -ne 'zaominn') { throw 'The token must belong to zaominn; nothing was stored.' }
    $nmWorkflow = Invoke-RestMethod -Uri 'https://api.github.com/repos/zaominn/nomount-lkm/actions/workflows/lkm.yml' -Headers $nmHeaders
    if ($nmWorkflow.state -ne 'active') { throw 'The NoMount workflow is not active; nothing was stored.' }
    Push-Location $nmBotRoot
    try {
        $nmToken | & node $nmWranglerPath secret put LKM_GITHUB_TOKEN --config worker/wrangler.jsonc
        if ($LASTEXITCODE -ne 0) { throw 'Cloudflare rejected the secret update.' }
    } finally { Pop-Location }
    $nmHealth = Invoke-RestMethod -Uri 'https://gki.zaomin.dpdns.org/health'
    if (!$nmHealth.nomountBuildsReady) { throw 'The deployed Worker is not ready; check the deployed version.' }
    Write-Host 'NoMount credential saved. Dispatch permission will be verified by the first /nomount build.'
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($nmTokenPointer)
    $nmSecureToken.Dispose()
    Remove-Variable nmToken,nmHeaders -ErrorAction SilentlyContinue
}
