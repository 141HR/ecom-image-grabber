<#
  在无法直连 github.com 的网络环境下发布更新。

  背景：本机到 github.com:443 的连接会被重置，`git push` 无法使用，
  但 api.github.com 正常。此脚本改用 GitHub 的 Git Data API 创建一次提交，
  效果等同于一次普通推送（保留远端历史，新提交以远端最新提交为父提交）。

  用法：
    powershell -File scripts/publish-via-api.ps1

  说明：脚本会先执行 `git add -A`，因此新增文件也会被包含；
  提交内容取自工作区当前状态，与本地 git 历史无关。
#>
$ErrorActionPreference = 'Stop'

$repoPath = Split-Path -Parent $PSScriptRoot
$remote = (git -C $repoPath remote get-url origin)
if ($remote -notmatch 'github\.com[:/](?<owner>[^/]+)/(?<repo>[^/.]+)') {
  throw "无法从 origin 解析仓库地址：$remote"
}
$owner = $Matches.owner
$repo = $Matches.repo
$api = "/repos/$owner/$repo"
$branch = (git -C $repoPath rev-parse --abbrev-ref HEAD)

Write-Host "仓库：$owner/$repo    分支：$branch" -ForegroundColor Cyan

Push-Location $repoPath
try {
  git add -A

  # 取远端当前 HEAD；空仓库时先做一个初始提交（Git Data API 在空仓库上会返回 409）
  $head = & gh api "$api/git/ref/heads/$branch" --jq '.object.sha' 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $head -or $head -eq 'null') {
    Write-Host "远端尚无提交，创建初始提交…"
    $seedBytes = [System.IO.File]::ReadAllBytes((Join-Path $repoPath '.gitignore'))
    $seedBody = @{
      message = 'chore: 初始化仓库'
      content = [Convert]::ToBase64String($seedBytes)
      branch  = $branch
    } | ConvertTo-Json -Compress
    $seed = $seedBody | gh api --method PUT "$api/contents/.gitignore" --input - | ConvertFrom-Json
    $head = $seed.commit.sha
  }
  Write-Host "父提交：$head"

  # 逐个文件上传为 blob
  $files = git -c core.quotepath=false ls-files
  Write-Host "文件数：$($files.Count)"
  $tree = New-Object System.Collections.ArrayList
  $i = 0
  foreach ($f in $files) {
    $i++
    $bytes = [System.IO.File]::ReadAllBytes((Join-Path $repoPath $f))
    $body = @{ content = [Convert]::ToBase64String($bytes); encoding = 'base64' } | ConvertTo-Json -Compress
    $blob = $body | gh api --method POST "$api/git/blobs" --input - | ConvertFrom-Json
    [void]$tree.Add(@{ path = $f; mode = '100644'; type = 'blob'; sha = $blob.sha })
  }

  # 构建 tree + commit，并把分支指向新提交
  $treeBody = @{ tree = $tree } | ConvertTo-Json -Compress -Depth 6
  $treeSha = ($treeBody | gh api --method POST "$api/git/trees" --input - | ConvertFrom-Json).sha

  $message = "chore: 更新项目内容（$(Get-Date -Format 'yyyy-MM-dd HH:mm')）"
  $commitBody = @{ message = $message; tree = $treeSha; parents = @($head) } | ConvertTo-Json -Compress -Depth 4
  $commitSha = ($commitBody | gh api --method POST "$api/git/commits" --input - | ConvertFrom-Json).sha

  $refBody = @{ sha = $commitSha; force = $false } | ConvertTo-Json -Compress
  $ref = $refBody | gh api --method PATCH "$api/git/refs/heads/$branch" --input - | ConvertFrom-Json

  Write-Host "已提交：$commitSha" -ForegroundColor Green
  Write-Host "提交总数：$(gh api "$api/commits?per_page=100" --jq 'length')"
  Write-Host "远程文件数：$(gh api "$api/git/trees/$branch?recursive=1" --jq '[.tree[] | select(.type=="blob")] | length')"
  Write-Host "站点地址：https://$($owner.ToLower()).github.io/$repo/"

  # 本地分支与远端历史无关时给出提示，避免后续 git 操作产生困惑
  $localHead = git rev-parse HEAD
  if ($localHead -ne $commitSha) {
    Write-Host "提示：本地 HEAD（$($localHead.Substring(0,7))）与远端（$($commitSha.Substring(0,7))）不同。" -ForegroundColor Yellow
    Write-Host "      本机无法 fetch，如需保持本地同步可执行：git reset --soft $commitSha" -ForegroundColor Yellow
  }
}
finally {
  Pop-Location
}
