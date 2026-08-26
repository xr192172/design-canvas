# 分步排查 loop --ledger
$ErrorActionPreference = 'Stop'
$proj = Join-Path $env:TEMP 'dc-dbg-proj'
if (Test-Path $proj) { Remove-Item -Recurse -Force $proj }
New-Item -ItemType Directory -Path (Join-Path $proj '.design-canvas\impact') -Force | Out-Null

$ledger = @'
{"version":1,"entries":[
{"id":"decl-1","created_at":"2026-08-17T10:00:00Z","declared_files":["src/a.ts"],"expected_files":["src/b.ts"],"status":"resolved","consumed_at":"2026-08-17T10:05:00Z","matched_seq":1,"unexpected_files":["src/c.ts","src/d.ts"],"actual_files":["src/b.ts","src/c.ts","src/d.ts"]},
{"id":"decl-2","created_at":"2026-08-17T11:00:00Z","declared_files":["src/a.ts"],"expected_files":["src/b.ts"],"status":"violated","consumed_at":"2026-08-17T11:05:00Z","matched_seq":2,"unexpected_files":["src/c.ts"],"actual_files":["src/b.ts","src/c.ts"]},
{"id":"decl-3","created_at":"2026-08-17T12:00:00Z","declared_files":["src/x.ts"],"expected_files":["src/y.ts"],"status":"ok","consumed_at":"2026-08-17T12:05:00Z","matched_seq":3}
]}
'@
Set-Content -Path (Join-Path $proj '.design-canvas\impact\ledger.json') -Value $ledger -Encoding UTF8
Set-Content -Path (Join-Path $proj 'events.jsonl') -Value '{"probe":"p1","time":"2026-08-17T00:00:00Z","source":"s","fields":{"x":1}}' -Encoding UTF8

Set-Location $here
go build -o (Join-Path $env:TEMP 'camera-dsl.exe') ./cmd/camera-dsl
Write-Host '=== seed ==='
& (Join-Path $env:TEMP 'camera-dsl.exe') --project-root $proj seed
Write-Host '=== loop（默认探测 ledger）==='
& (Join-Path $env:TEMP 'camera-dsl.exe') --project-root $proj loop "$proj\events.jsonl"
Write-Host '=== proposals ==='
& (Join-Path $env:TEMP 'camera-dsl.exe') --project-root $proj proposals
Write-Host '=== dsl.json ==='
Get-Content (Join-Path $proj '.agent\camera\dsl.json') -Raw
Write-Host "proj=$proj"
