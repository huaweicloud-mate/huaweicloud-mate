param()

$ErrorActionPreference = "Stop"

function Import-EnvironmentTarget {
  param([string] $Target)

  [Environment]::GetEnvironmentVariables($Target).GetEnumerator() | ForEach-Object {
    if (-not [Environment]::GetEnvironmentVariable($_.Key, "Process")) {
      [Environment]::SetEnvironmentVariable($_.Key, [string] $_.Value, "Process")
    }
  }
}

function Import-DotEnvFile {
  param([string] $Path)

  if (-not (Test-Path -LiteralPath $Path)) {
    return
  }

  Get-Content -LiteralPath $Path | ForEach-Object {
    $line = $_.Trim()
    if ($line.Length -eq 0 -or $line.StartsWith("#")) {
      return
    }

    $separator = $line.IndexOf("=")
    if ($separator -lt 1) {
      return
    }

    $name = $line.Substring(0, $separator).Trim()
    $value = $line.Substring($separator + 1).Trim()
    if ($value.Length -ge 2) {
      $first = $value.Substring(0, 1)
      $last = $value.Substring($value.Length - 1, 1)
      if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
        $value = $value.Substring(1, $value.Length - 2)
      }
    }

    if (-not [Environment]::GetEnvironmentVariable($name, "Process")) {
      [Environment]::SetEnvironmentVariable($name, $value, "Process")
    }
  }
}

$workspaceRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")

Import-EnvironmentTarget -Target "Machine"
Import-EnvironmentTarget -Target "User"
Import-DotEnvFile -Path (Join-Path $workspaceRoot ".env")

$serverPath = Join-Path $workspaceRoot "packages\obs-mcp-server\dist\index.js"
& node $serverPath
exit $LASTEXITCODE
