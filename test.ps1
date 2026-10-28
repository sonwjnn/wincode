$ErrorActionPreference = "Stop"

$repositoryRoot = $PSScriptRoot
$callerDirectory = (Get-Location).Path
$testArguments = @($args)
$bunCommand = Get-Command bun -CommandType Application -ErrorAction SilentlyContinue
if ($null -eq $bunCommand) {
	[Console]::Error.WriteLine("bun is required. Install dependencies before running test.ps1.")
	exit 127
}
$bunPath = $bunCommand.Source

$originalEnvironment = @{}
Get-ChildItem Env: | ForEach-Object {
	$originalEnvironment[$_.Name] = $_.Value
}
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("wincode-tests." + [Guid]::NewGuid().ToString("N"))
$exitCode = 1
$locationPushed = $false

try {
	New-Item -ItemType Directory -Path $testRoot | Out-Null
	$homeRoot = Join-Path $testRoot "home"
	$configRoot = Join-Path $testRoot "config"
	$dataRoot = Join-Path $testRoot "data"
	$cacheRoot = Join-Path $testRoot "cache"
	$tempRoot = Join-Path $testRoot "tmp"
	New-Item -ItemType Directory -Path $homeRoot, $configRoot, $dataRoot, $cacheRoot, $tempRoot | Out-Null

	$normalizedPath = @(
		$originalEnvironment["PATH"] -split [System.IO.Path]::PathSeparator | ForEach-Object {
			if ([string]::IsNullOrEmpty($_)) {
				$callerDirectory
			} elseif ([System.IO.Path]::IsPathRooted($_)) {
				$_
			} else {
				Join-Path $callerDirectory $_
			}
		}
	) -join [System.IO.Path]::PathSeparator

	$environmentNames = @(Get-ChildItem Env: | ForEach-Object { $_.Name })
	foreach ($name in $environmentNames) {
		Remove-Item -LiteralPath ("Env:" + $name) -ErrorAction SilentlyContinue
	}
	$env:PATH = $normalizedPath
	foreach ($name in @("SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS")) {
		if ($originalEnvironment.ContainsKey($name)) {
			Set-Item -Path ("Env:" + $name) -Value $originalEnvironment[$name]
		}
	}

	$osUsername = $originalEnvironment["USERNAME"]
	if ([string]::IsNullOrEmpty($osUsername)) {
		$osUsername = $originalEnvironment["USER"]
	}
	if ([string]::IsNullOrEmpty($osUsername)) {
		$osUsername = "unknown"
	}
	$env:HOME = $homeRoot
	$env:USERPROFILE = $homeRoot
	$env:USER = $osUsername
	$env:USERNAME = $osUsername
	$env:LOGNAME = $osUsername
	$env:NODE_ENV = "test"
	$env:WINCODE_TEST_SESSION_INDEX_DIR = Join-Path $testRoot "session-indexes"
	$env:XDG_CONFIG_HOME = $configRoot
	$env:XDG_DATA_HOME = $dataRoot
	$env:XDG_CACHE_HOME = $cacheRoot
	$env:APPDATA = $dataRoot
	$env:LOCALAPPDATA = $cacheRoot
	$env:TMPDIR = $tempRoot
	$env:TMP = $tempRoot
	$env:TEMP = $tempRoot
	if ($originalEnvironment.ContainsKey("LANG")) {
		$env:LANG = $originalEnvironment["LANG"]
	} else {
		$env:LANG = "C.UTF-8"
	}
	if ($originalEnvironment.ContainsKey("TERM")) {
		$env:TERM = $originalEnvironment["TERM"]
	} else {
		$env:TERM = "dumb"
	}
	if ($originalEnvironment.ContainsKey("CI")) {
		$env:CI = $originalEnvironment["CI"]
	}

	Set-Location $repositoryRoot
	$locationPushed = $true
	& $bunPath --no-env-file run test @testArguments
	$exitCode = $LASTEXITCODE
	if ($null -eq $exitCode) {
		$exitCode = 1
	}
} catch {
	[Console]::Error.WriteLine($_.ToString())
	$exitCode = 1
} finally {
	if ($locationPushed) {
		Set-Location $callerDirectory
	}
	$environmentNames = @(Get-ChildItem Env: | ForEach-Object { $_.Name })
	foreach ($name in $environmentNames) {
		Remove-Item -LiteralPath ("Env:" + $name) -ErrorAction SilentlyContinue
	}
	foreach ($entry in $originalEnvironment.GetEnumerator()) {
		Set-Item -Path ("Env:" + $entry.Key) -Value $entry.Value
	}
	Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}

if ($exitCode -ne 0) {
	exit $exitCode
}
