param([Parameter(ValueFromRemainingArguments=$true)][string[]]$GradleArgs)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
$jdkCandidates = @($env:JAVA_HOME) + @(Get-ChildItem -LiteralPath "$env:USERPROFILE/.jdks" -Directory -ErrorAction SilentlyContinue | Where-Object Name -Match '21' | ForEach-Object FullName)
$taskJdk = $jdkCandidates | Where-Object { $_ -and (Test-Path -LiteralPath "$_/bin/java.exe") -and (Get-Content -LiteralPath "$_/release" -ErrorAction SilentlyContinue | Select-String 'JAVA_VERSION="21\.') } | Select-Object -First 1
if (-not $taskJdk) { throw 'JDK 21이 필요합니다. 설치 후 JAVA_HOME을 해당 JDK 경로로 설정하세요.' }
$previousJava = $env:JAVA_HOME
try {
    $env:JAVA_HOME = $taskJdk
    Push-Location $taskRoot
    & ./gradlew.bat @GradleArgs
    $result = $LASTEXITCODE
} finally { Pop-Location; $env:JAVA_HOME = $previousJava }
exit $result
