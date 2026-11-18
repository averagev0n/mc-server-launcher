# Блокхост: фоновые задачи серверов Minecraft на VPS с Windows. Создано программой «Блокхост».
# Планировщик заданий запускает этот скрипт раз в минуту и при включении VPS. Делает то же,
# что mcl-tick.sh на Linux: автозапуск и перезапуск после падения, расписание, бэкапы, замеры, события, Discord.
# Вызовы: mcl-tick.ps1 -Mode tick | backup -Name <имя> [-Arg manual] | restart -Name <имя> | restore -Name <имя> -Arg <файл>
# mcl-tick-version: __VERSION__
param([string]$Mode = 'tick', [string]$Name = '', [string]$Arg = '')
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$B = $PSScriptRoot
$S = Join-Path $B 'servers'
$Self = $MyInvocation.MyCommand.Path
$utf8 = New-Object System.Text.UTF8Encoding($false)
$script:D = ''
$script:N = ''
$script:NM = ''

function Now { [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() }
function P($f) { Join-Path $script:D $f }
function Cfg($k) {
  $f = P 'mcl.conf'
  if (-not (Test-Path -LiteralPath $f)) { return '' }
  foreach ($l in [System.IO.File]::ReadAllLines($f, $utf8)) { if ($l.StartsWith("$k=")) { return $l.Substring($k.Length + 1).Trim() } }
  return ''
}
function Ev($kind, $a, $b) { [System.IO.File]::AppendAllText((P 'mcl-events.log'), "$(Now) $kind $a $b`n", $utf8) }
function EscMd($s) { "$s" -replace '_', '\_' }
function Touch($f) { [System.IO.File]::WriteAllText((P $f), '', $utf8) }
function ReadText($f) { $p = P $f; if (Test-Path -LiteralPath $p) { return ([System.IO.File]::ReadAllText($p, $utf8)).Trim() } return '' }

function Alive {
  $p = 0
  if (-not [int]::TryParse((ReadText 'mcl.pid'), [ref]$p) -or -not $p) { return $false }
  $pr = Get-CimInstance Win32_Process -Filter "ProcessId = $p"
  if (-not $pr) { return $false }
  return ("$($pr.CommandLine)" -like '*mcl-start*')
}

function Meta { try { return ([System.IO.File]::ReadAllText((P 'mcl.json'), $utf8) | ConvertFrom-Json) } catch { return $null } }

# Процесс вне задания Планировщика: он не завершится вместе с этим скриптом.
function Detach($cmd, $dir) { Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd; CurrentDirectory = $dir } | Out-Null }

function StartSrv {
  $eula = P 'eula.txt'
  if (-not ((Test-Path -LiteralPath $eula) -and (Select-String -LiteralPath $eula -Pattern '^eula=true' -Quiet))) { Ev 'noeula' $script:N; return $false }
  $ram = 2
  $m = Meta
  if ($m -and [int]$m.ramGb -ge 1) { $ram = [int]$m.ramGb }
  Remove-Item -LiteralPath (P 'mcl.pid') -Force
  Detach ('powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (P 'mcl-start.ps1') + '" -Ram ' + $ram) $script:D
  for ($i = 0; $i -lt 20; $i++) { Start-Sleep -Milliseconds 500; if (Alive) { break } }
  Touch 'mcl.want'
  return (Alive)
}

function StopSrv {
  if (-not (Alive)) { return }
  $p = [int](ReadText 'mcl.pid')
  [System.IO.File]::AppendAllText((P 'console.in'), "stop`r`n", $utf8)
  for ($i = 0; $i -lt 60; $i++) { if (-not (Get-Process -Id $p)) { break }; Start-Sleep -Seconds 1 }
  if (Get-Process -Id $p) {
    & taskkill.exe /PID $p /T /F | Out-Null
    Start-Sleep -Seconds 2
    Remove-Item -LiteralPath (P 'mcl.pid') -Force
  }
}

function Say($text) { if (Alive) { [System.IO.File]::AppendAllText((P 'console.in'), "say $text`r`n", $utf8) } }

function Dc($flag, $text) {
  $u = Cfg 'discord'
  if (-not $u -or (Cfg $flag) -ne '1') { return }
  if ($u -notmatch '^https://(ptb\.|canary\.)?discord(app)?\.com/api/webhooks/\d+/[\w-]+$') { return }
  $body = @{ content = $text; allowed_mentions = @{ parse = @() } } | ConvertTo-Json -Compress
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-RestMethod -Uri $u -Method Post -ContentType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 15 | Out-Null
  } catch {}
}

# Что входит в бэкап: всё, кроме самих бэкапов, журналов и служебных файлов лаунчера.
function Skip($n) { return ($n -match '^(backups|logs|crash-reports|cache|\.cache|debug|console\.log|console\.old\.log|console\.in|exit\.code)$' -or $n -like 'mcl.*' -or $n -like 'mcl-*' -or $n -like '.mcl-*') }

function TarExe {
  $t = Join-Path $env:SystemRoot 'System32\tar.exe'
  if (Test-Path -LiteralPath $t) { return $t }
  $c = Get-Command tar.exe
  if ($c) { return $c.Source }
  return $null
}

function BackupDo($tag) {
  if ($tag -notin @('auto', 'manual', 'before-restore')) { 'badtag'; return 2 }
  $lock = P '.mcl-backup.lock'
  if ((Test-Path -LiteralPath $lock) -and ((Get-Item -LiteralPath $lock).LastWriteTime -lt (Get-Date).AddHours(-3))) { Remove-Item -LiteralPath $lock -Recurse -Force }
  try { New-Item -ItemType Directory -Path $lock -ErrorAction Stop | Out-Null } catch { 'busy'; return 3 }
  $bd = P 'backups'
  New-Item -ItemType Directory -Force $bd | Out-Null
  $F = Join-Path $bd ("$($script:N)-" + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + "-$tag.tar.gz")
  $on = Alive
  if ($on) {
    # Сервер работает: просим сохранить мир и не трогать файлы, пока идёт архив.
    $log = P 'console.log'
    $pos = 0
    if (Test-Path -LiteralPath $log) { $pos = (Get-Item -LiteralPath $log).Length }
    [System.IO.File]::AppendAllText((P 'console.in'), "save-off`r`nsave-all flush`r`n", $utf8)
    for ($i = 0; $i -lt 90; $i++) {
      Start-Sleep -Seconds 1
      if ((ReadFrom $log $pos 200000) -match '(?i)saved the (game|world)') { break }
    }
  }
  $items = @(Get-ChildItem -LiteralPath $script:D -Force | Where-Object { -not (Skip $_.Name) } | ForEach-Object { $_.Name })
  $ok = $false
  $err = ''
  $tar = TarExe
  if ($items.Count -gt 0 -and $tar) {
    $out = & $tar -czf "$F.part" -C $script:D @items 2>&1
    $code = $LASTEXITCODE
    $err = "$($out | Select-Object -Last 1)"
    if ($code -le 1 -and (Test-Path -LiteralPath "$F.part") -and (Get-Item -LiteralPath "$F.part").Length -gt 0) {
      Move-Item -LiteralPath "$F.part" -Destination $F -Force
      $ok = $true
    }
  } elseif (-not $tar) { $err = 'нет tar.exe' }
  Remove-Item -LiteralPath "$F.part" -Force
  if ($on) { [System.IO.File]::AppendAllText((P 'console.in'), "save-on`r`n", $utf8) }
  Remove-Item -LiteralPath $lock -Recurse -Force
  if ($ok) {
    $size = (Get-Item -LiteralPath $F).Length
    $Mb = [math]::Floor($size / 1048576)
    $NM = $script:NM
    # Копия перед восстановлением — не повод для уведомления.
    if ($tag -ne 'before-restore') {
      Ev 'backup' $script:N $Mb
      Dc 'dbackup' ("__T_BACKUP__")
    }
    $keep = 7
    [int]::TryParse((Cfg 'keep'), [ref]$keep) | Out-Null
    if ($keep -lt 1) { $keep = 7 }
    Get-ChildItem -LiteralPath $bd -Filter '*-auto.tar.gz' | Sort-Object LastWriteTime -Descending | Select-Object -Skip $keep | Remove-Item -Force
    "file=$(Split-Path -Leaf $F)"
    "size=$size"
    return 0
  }
  $NM = $script:NM
  Ev 'backupfail' $script:N
  Dc 'dbackup' ("__T_BACKUPFAIL__")
  if (-not $err) { $err = 'нечего сохранять' }
  "error=$err"
  return 1
}

function RestoreDo($file) {
  if ($file -notmatch '^[A-Za-z0-9._-]+$') { 'badname'; return 2 }
  $src = Join-Path (P 'backups') $file
  if (-not (Test-Path -LiteralPath $src)) { 'nofile'; return 5 }
  if (Alive) { 'running'; return 4 }
  # Сначала — копия того, что есть сейчас: восстановление можно будет отменить.
  $r = BackupDo 'before-restore'
  if (@($r)[-1] -ne 0) { 'nosafety'; return 6 }
  Get-ChildItem -LiteralPath $script:D -Force | Where-Object { -not (Skip $_.Name) } | Remove-Item -Recurse -Force
  $tar = TarExe
  & $tar -xzf $src -C $script:D 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { 'extractfail'; return 7 }
  'restored'
  return 0
}

function RestartJob {
  $lock = P '.mcl-restart.lock'
  try { New-Item -ItemType Directory -Path $lock -ErrorAction Stop | Out-Null } catch { return }
  if (Alive) {
    Say "__T_NOW__"
    Start-Sleep -Seconds 5
    StopSrv
    Start-Sleep -Seconds 2
    if (StartSrv) {
      $NM = $script:NM
      Ev 'sched' $script:N
      Dc 'dcrash' ("__T_SCHED__")
    }
  }
  Remove-Item -LiteralPath $lock -Recurse -Force
}

# Новые байты файла начиная с pos (файл может быть открыт сервером на запись).
function ReadFrom($file, $pos, $max) {
  try {
    $fs = [System.IO.File]::Open($file, 'Open', 'Read', 'ReadWrite')
    $len = $fs.Length
    if ($pos -gt $len) { $pos = 0 }
    $n = [math]::Min($max, $len - $pos)
    if ($n -le 0) { $fs.Close(); return '' }
    $buf = New-Object byte[] $n
    $fs.Position = $pos
    $read = $fs.Read($buf, 0, $n)
    $fs.Close()
    return $utf8.GetString($buf, 0, $read)
  } catch { return '' }
}

# ---- раз в минуту ----

function Watch {
  if (Test-Path -LiteralPath (P '.mcl-restart.lock')) { return }
  if (Alive) { return }
  $want = P 'mcl.want'
  if (-not (Test-Path -LiteralPath $want)) { return }
  $codeFile = P 'exit.code'
  # Только что запущен и ещё не успел записать mcl.pid.
  if (-not (Test-Path -LiteralPath $codeFile) -and (Get-Item -LiteralPath $want).LastWriteTime -gt (Get-Date).AddMinutes(-2)) { return }
  $code = ReadText 'exit.code'
  Remove-Item -LiteralPath (P 'mcl.pid') -Force
  # Код 0 — остановили командой stop в игре: так и задумано.
  if ($code -eq '0') { Remove-Item -LiteralPath $want -Force; return }
  # Имена переменных в PowerShell не различают регистр: $CodeT — не то же, что $code.
  $kind = 'crash'
  if (-not $code -and $script:Up -lt 900) { $kind = 'boot' }
  $CodeT = if ($code) { $code } else { '?' }
  $NM = $script:NM
  if ((Cfg 'auto') -ne '1') {
    Remove-Item -LiteralPath $want -Force
    if ($kind -eq 'crash') {
      Ev 'crashed' $script:N $CodeT
      Dc 'dcrash' ("__T_CRASHED__")
    }
    return
  }
  # Не больше трёх перезапусков за 15 минут: иначе сервер падает при каждом запуске.
  $now = Now
  $cf = P 'mcl.crashes'
  $list = @()
  if (Test-Path -LiteralPath $cf) { $list = @([System.IO.File]::ReadAllLines($cf) | Where-Object { $_ -match '^\d+$' -and ($now - [long]$_) -lt 900 }) }
  $list += "$now"
  [System.IO.File]::WriteAllLines($cf, [string[]]$list)
  if ($kind -eq 'crash' -and $list.Count -gt 3) {
    Remove-Item -LiteralPath $want -Force
    Ev 'gaveup' $script:N
    Dc 'dcrash' ("__T_GAVEUP__")
    return
  }
  if (StartSrv) {
    if ($kind -eq 'boot') {
      Ev 'boot' $script:N
      Dc 'dcrash' ("__T_BOOT__")
    } else {
      Ev 'crash' $script:N $CodeT
      Dc 'dcrash' ("__T_CRASH__")
    }
  }
}

function ToMin($t) { if ($t -match '^([0-2]\d):([0-5]\d)$') { return [int]$Matches[1] * 60 + [int]$Matches[2] } return -1 }

function Sched {
  $u = [DateTime]::UtcNow
  $nm = $u.Hour * 60 + $u.Minute
  $today = $u.ToString('yyyyMMdd')
  $r = ToMin (Cfg 'restart')
  if ($r -ge 0 -and (Alive)) {
    $d = ($r - $nm + 1440) % 1440
    $w = 0
    [int]::TryParse((Cfg 'warn'), [ref]$w) | Out-Null
    if ($w -gt 0 -and $d -eq $w) { $Min = $w; Say "__T_WARN__" }
    if ($w -gt 1 -and $d -eq 1) { $Min = 1; Say "__T_WARN__" }
    if ($d -eq 0 -and (ReadText 'mcl.lastrestart') -ne $today) {
      [System.IO.File]::WriteAllText((P 'mcl.lastrestart'), $today, $utf8)
      Detach ('powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $Self + '" -Mode restart -Name ' + $script:N) $B
    }
  }
  # Не $b: имена без учёта регистра, $b закрыло бы $B (папку лаунчера).
  $bk = ToMin (Cfg 'backup')
  if ($bk -ge 0) {
    $d = ($bk - $nm + 1440) % 1440
    if ($d -eq 0 -and (ReadText 'mcl.lastbackup') -ne $today) {
      [System.IO.File]::WriteAllText((P 'mcl.lastbackup'), $today, $utf8)
      Detach ('powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $Self + '" -Mode backup -Name ' + $script:N + ' -Arg auto') $B
    }
  }
}

# Кто зашёл и вышел — по новым строкам журнала с прошлой минуты.
function Joins {
  $L = P 'console.log'
  if (-not (Test-Path -LiteralPath $L)) { return }
  $sz = (Get-Item -LiteralPath $L).Length
  $pos = ReadText 'mcl.logpos'
  [System.IO.File]::WriteAllText((P 'mcl.logpos'), "$sz", $utf8)
  if ($pos -notmatch '^\d+$') { return }
  $pos = [long]$pos
  if ($sz -lt $pos) { $pos = 0 }
  if ($sz -le $pos) { return }
  $text = ReadFrom $L $pos 4000000
  $NM = $script:NM
  $n = 0
  foreach ($m in [regex]::Matches($text, '[\]:] ([.A-Za-z0-9_]{1,17}) (joined|left) the game')) {
    if ($n++ -ge 20) { break }
    $who = $m.Groups[1].Value
    $W = EscMd $who
    if ($m.Groups[2].Value -eq 'joined') {
      Ev 'join' $script:N $who
      Dc 'djoin' ("__T_JOIN__")
    } else {
      Ev 'leave' $script:N $who
      Dc 'djoin' ("__T_LEAVE__")
    }
  }
}

function Stats {
  $pc = '-'; $pr = '-'; $cn = '-'
  if (Alive) {
    $root = [int](ReadText 'mcl.pid')
    $ids = @{ $root = $true }
    $added = $true
    while ($added) {
      $added = $false
      foreach ($p in $script:Procs) { if ($ids.ContainsKey([int]$p.ParentProcessId) -and -not $ids.ContainsKey([int]$p.ProcessId)) { $ids[[int]$p.ProcessId] = $true; $added = $true } }
    }
    [decimal]$t = 0; [decimal]$b = 0
    foreach ($p in $script:Procs) { if ($ids.ContainsKey([int]$p.ProcessId)) { $t += [decimal]$p.KernelModeTime + [decimal]$p.UserModeTime; $b += [decimal]$p.WorkingSetSize } }
    # Время процессора — в сотых долях секунды, как на Linux.
    $pc = [math]::Floor($t / 100000)
    $pr = $b
    $port = 25565
    $m = Meta
    if ($m -and $m.port) { [int]::TryParse("$($m.port)", [ref]$port) | Out-Null }
    $cn = @(Get-NetTCPConnection -LocalPort $port -State Established).Count
  }
  # Загрузка всего VPS приходит готовыми процентами; -1 вместо «всего» — признак этого.
  [System.IO.File]::AppendAllText((P 'mcl-stats.log'), "$(Now) $pc $pr $($script:SysCpu) -1 $($script:MemT) $($script:MemF) $cn $([Environment]::ProcessorCount)`n", $utf8)
}

function Disk {
  $free = [math]::Floor((Get-Item -LiteralPath $script:D).PSDrive.Free / 1024)
  if (-not $free -or $free -ge 1048576) { return }
  $now = Now
  $last = 0
  [long]::TryParse((ReadText 'mcl.disklow'), [ref]$last) | Out-Null
  if ($now - $last -le 21600) { return }
  [System.IO.File]::WriteAllText((P 'mcl.disklow'), "$now", $utf8)
  $Free = [math]::Floor($free / 1024)
  $NM = $script:NM
  Ev 'disk' $script:N $Free
  Dc 'ddisk' ("__T_DISK__")
}

function TrimLog($f, $max, $keep) {
  $p = P $f
  if (-not (Test-Path -LiteralPath $p)) { return }
  $lines = [System.IO.File]::ReadAllLines($p, $utf8)
  if ($lines.Count -gt $max) { [System.IO.File]::WriteAllLines($p, [string[]]($lines | Select-Object -Last $keep), $utf8) }
}

function Pick($n) {
  if ($n -notmatch '^[A-Za-z0-9._-]{1,64}$' -or $n -match '^\.+$') { 'badname'; exit 2 }
  $script:N = $n
  $script:D = Join-Path $S $n
  $script:NM = EscMd $n
  if (-not (Test-Path -LiteralPath (P 'mcl.json'))) { 'notfound'; exit 5 }
}

function Tick {
  $lock = Join-Path $B '.mcl-tick.lock'
  if (Test-Path -LiteralPath $lock) {
    if ((Get-Item -LiteralPath $lock).LastWriteTime -gt (Get-Date).AddMinutes(-10)) { return }
    Remove-Item -LiteralPath $lock -Recurse -Force
  }
  try { New-Item -ItemType Directory -Path $lock -ErrorAction Stop | Out-Null } catch { return }
  try {
    $os = Get-CimInstance Win32_OperatingSystem
    $script:Up = ((Get-Date) - $os.LastBootUpTime).TotalSeconds
    $script:MemT = $os.TotalVisibleMemorySize
    $script:MemF = $os.FreePhysicalMemory
    $script:SysCpu = [math]::Round((Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average)
    $script:Procs = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, KernelModeTime, UserModeTime, WorkingSetSize)
    if (Test-Path -LiteralPath $S) {
      foreach ($dir in Get-ChildItem -LiteralPath $S -Directory) {
        $script:D = $dir.FullName
        if (-not (Test-Path -LiteralPath (P 'mcl.json'))) { continue }
        $script:N = $dir.Name
        $script:NM = EscMd $dir.Name
        Watch
        Sched
        Joins
        Stats
        Disk
        TrimLog 'mcl-stats.log' 10300 10080
        TrimLog 'mcl-events.log' 700 500
      }
    }
  } finally {
    Remove-Item -LiteralPath $lock -Recurse -Force
  }
}

switch ($Mode) {
  'tick' { Tick; exit 0 }
  'backup' { Pick $Name; $a = if ($Arg) { $Arg } else { 'manual' }; $r = BackupDo $a; $code = @($r)[-1]; @($r) | Select-Object -SkipLast 1; exit $code }
  'restart' { Pick $Name; RestartJob; exit 0 }
  'restore' { Pick $Name; $r = RestoreDo $Arg; $code = @($r)[-1]; @($r) | Select-Object -SkipLast 1; exit $code }
  default { 'unknown'; exit 2 }
}
