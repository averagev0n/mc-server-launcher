// Скрипты PowerShell для VPS с Windows (Windows 10 / Server 2019 и новее, SSH-сервер OpenSSH).
// Все функции чистые: возвращают текст скрипта, ничего не выполняют. Скрипт vps.js загружает его
// на VPS по SFTP и запускает через `powershell -File`, поэтому кавычки и длина команды не мешают.
//
// Папки на VPS — как на Linux, но в профиле пользователя:
//   %USERPROFILE%\mc-launcher\java\<версия>\bin\java.exe
//   %USERPROFILE%\mc-launcher\servers\<имя>\   — сервер; mcl-start.ps1 запускает его в фоне,
//                                               console.log — журнал, console.in — команды серверу.

/** Строка в одинарных кавычках для PowerShell. */
const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;

// Берём tar.exe из System32 (bsdtar): если в PATH раньше стоит GNU tar из Git, он принимает «C:\\…» за имя хоста.
const TAR_PICK = `$tar = Join-Path $env:SystemRoot 'System32\\tar.exe'
if (-not (Test-Path -LiteralPath $tar)) { $c = Get-Command tar.exe; $tar = if ($c) { $c.Source } else { $null } }`;

const HEAD = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$B = Join-Path $env:USERPROFILE 'mc-launcher'
`;

/** Сведения о системе, Java и серверах в виде строк «ключ=значение» (как на Linux). */
function infoScript() {
  return `$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$H = $env:USERPROFILE
$B = Join-Path $H 'mc-launcher'
$arch = $env:PROCESSOR_ARCHITECTURE
if ($arch -eq 'AMD64') { $arch = 'x86_64' } elseif ($arch -eq 'ARM64') { $arch = 'aarch64' }
$os = Get-CimInstance Win32_OperatingSystem
"platform=windows"
"arch=$arch"
"os=$($os.Caption)"
"mem=$($os.TotalVisibleMemorySize)"
"memfree=$($os.FreePhysicalMemory)"
$drv = (Get-Item -LiteralPath $H).PSDrive
"disk=$([math]::Floor($drv.Free / 1024))"
"dl=ps"
"home=$H"
${TAR_PICK}
if ($tar) { "tar=1" } else { "tar=0" }
function JVer($j) { $o = cmd /c ('"' + $j + '" -version 2>&1') | Select-Object -First 1; "$o" }
$jd = Join-Path $B 'java'
if (Test-Path -LiteralPath $jd) {
  Get-ChildItem -LiteralPath $jd -Directory | ForEach-Object {
    $j = Join-Path $_.FullName 'bin\\java.exe'
    if (Test-Path -LiteralPath $j) { "java=$j|$(JVer $j)" }
  }
}
$c = Get-Command java.exe
if ($c) { "java=$($c.Source)|$(JVer $c.Source)" }
$sd = Join-Path $B 'servers'
if (Test-Path -LiteralPath $sd) {
  Get-ChildItem -LiteralPath $sd -Directory | ForEach-Object {
    $d = $_.FullName
    $m = Join-Path $d 'mcl.json'
    if (-not (Test-Path -LiteralPath $m)) { return }
    $st = 'stopped'
    $pf = Join-Path $d 'mcl.pid'
    if (Test-Path -LiteralPath $pf) {
      $p = [int](Get-Content -LiteralPath $pf -TotalCount 1)
      if ($p -and (Get-Process -Id $p -ErrorAction SilentlyContinue)) { $st = 'running' }
    }
    $j = (Get-Content -LiteralPath $m -Raw) -replace "[\\r\\n]", ''
    "server=$($_.Name)|$st|$j"
  }
}
`;
}

/** Скачать и распаковать Temurin JRE нужной версии. */
function javaInstallScript(major, arch) {
  const url = `https://api.adoptium.net/v3/binary/latest/${major}/ga/windows/${arch}/jre/hotspot/normal/eclipse`;
  return `${HEAD}[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$T = Join-Path $B 'java-${major}.zip'
$D = Join-Path $B 'java\\${major}'
$X = Join-Path $B 'java-${major}-tmp'
New-Item -ItemType Directory -Force (Join-Path $B 'java') | Out-Null
Invoke-WebRequest -UseBasicParsing -Uri ${psq(url)} -OutFile $T
Remove-Item -Recurse -Force $D, $X -ErrorAction SilentlyContinue
Expand-Archive -LiteralPath $T -DestinationPath $X -Force
$inner = Get-ChildItem -LiteralPath $X -Directory | Select-Object -First 1
Move-Item -LiteralPath $inner.FullName -Destination $D
Remove-Item -Recurse -Force $X, $T -ErrorAction SilentlyContinue
$out = cmd /c ('"' + (Join-Path $D 'bin\\java.exe') + '" -version 2>&1') | Select-Object -First 1
"$out"
`;
}

/** Распаковать загруженный архив; прежнюю папку сервера — в резервную копию. */
function extractScript(name, stamp) {
  const backup = `${name}.backup-${stamp}`;
  return `${HEAD}$S = Join-Path $B 'servers'
$D = Join-Path $S ${psq(name)}
$U = Join-Path $B ${psq(`upload-${name}.tar.gz`)}
if (Test-Path -LiteralPath $D) { Rename-Item -LiteralPath $D -NewName ${psq(backup)}; "backup=${backup}" }
New-Item -ItemType Directory -Force $D | Out-Null
${TAR_PICK}
& $tar -xzf $U -C $D
if ($LASTEXITCODE -ne 0) { throw "tar завершился с кодом $LASTEXITCODE" }
Remove-Item -LiteralPath $U -Force
# IP компьютера на VPS не существует — слушаем все адреса.
$sp = Join-Path $D 'server.properties'
if (Test-Path -LiteralPath $sp) {
  $enc = [System.Text.Encoding]::GetEncoding(28591)
  $t = [System.IO.File]::ReadAllText($sp, $enc)
  $t = [regex]::Replace($t, '(?m)^server-ip=[^\\r\\n]*', 'server-ip=')
  [System.IO.File]::WriteAllText($sp, $t, $enc)
}
Remove-Item -LiteralPath (Join-Path $D 'mcl.pid') -Force -ErrorAction SilentlyContinue
"ok"
`;
}

/**
 * mcl-start.ps1: запускает Java, пишет вывод в console.log и раз в полсекунды передаёт серверу
 * новые строки из console.in. Работает, пока работает сервер; pid этого скрипта лежит в mcl.pid.
 */
function startScript(javaPath, args) {
  const jvm = ['-Xms1G', '-Xmx__RAM__G', '-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8'];
  const quoted = args.map((a) => `"${String(a).replace(/["']/g, '')}"`).join(' ');
  return `# Запуск сервера Minecraft в фоне. Создано программой «Блокхост».
param([int]$Ram = 2)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$utf8 = New-Object System.Text.UTF8Encoding($false)
if (Test-Path mcl.pid) {
  $old = [int](Get-Content mcl.pid -TotalCount 1)
  if ($old -and (Get-Process -Id $old -ErrorAction SilentlyContinue)) { 'already running'; exit 0 }
}
[System.IO.File]::WriteAllText((Join-Path $PSScriptRoot 'mcl.pid'), "$PID", $utf8)
# Старый журнал не даём разрастись больше 20 МБ.
if ((Test-Path console.log) -and ((Get-Item console.log).Length -gt 20000000)) { Move-Item -Force console.log console.old.log }
[System.IO.File]::WriteAllText((Join-Path $PSScriptRoot 'console.in'), '', $utf8)
Remove-Item exit.code, mcl.done -Force -ErrorAction SilentlyContinue
$log = Join-Path $PSScriptRoot 'console.log'
[System.IO.File]::AppendAllText($log, ("=== Запуск " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ", память $Ram ГБ ===" + [Environment]::NewLine), $utf8)
$java = ${psq(javaPath)}
$line = '"' + $java + '" ${jvm.join(' ')} ${quoted} nogui >> "console.log" 2>&1'
$line = $line.Replace('__RAM__', "$Ram")
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = 'cmd.exe'
$psi.Arguments = '/c "' + $line + '"'
$psi.WorkingDirectory = $PSScriptRoot
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.RedirectStandardInput = $true
try { $psi.StandardInputEncoding = $utf8 } catch {}
$p = [System.Diagnostics.Process]::Start($psi)
$n = 0
$inFile = Join-Path $PSScriptRoot 'console.in'
while (-not $p.HasExited) {
  try {
    $fs = [System.IO.File]::Open($inFile, 'Open', 'Read', 'ReadWrite')
    $sr = New-Object System.IO.StreamReader($fs, $utf8)
    $all = $sr.ReadToEnd()
    $sr.Close(); $fs.Close()
    $lines = @($all -split "\`r?\`n" | Where-Object { $_ -ne '' })
    while ($n -lt $lines.Count) { $p.StandardInput.WriteLine($lines[$n]); $p.StandardInput.Flush(); $n++ }
  } catch {}
  Start-Sleep -Milliseconds 500
}
$code = $p.ExitCode
[System.IO.File]::WriteAllText((Join-Path $PSScriptRoot 'exit.code'), "$code", $utf8)
[System.IO.File]::WriteAllText((Join-Path $PSScriptRoot 'mcl.done'), '', $utf8)
[System.IO.File]::AppendAllText($log, ("=== Сервер остановлен (код $code) ===" + [Environment]::NewLine), $utf8)
Remove-Item mcl.pid, mcl.done -Force -ErrorAction SilentlyContinue
`;
}

/** Проверить EULA, обновить память в mcl.json и запустить mcl-start.ps1 вне сессии SSH. */
function launchScript(name, ram) {
  return `${HEAD}$d = Join-Path $B (Join-Path 'servers' ${psq(name)})
$eula = Join-Path $d 'eula.txt'
if (-not ((Test-Path -LiteralPath $eula) -and (Select-String -LiteralPath $eula -Pattern '^eula=true' -Quiet))) { 'noeula'; exit 3 }
$m = Join-Path $d 'mcl.json'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$j = [System.IO.File]::ReadAllText($m, $utf8) -replace '"ramGb":\\s*\\d+', '"ramGb":${Number(ram)}'
[System.IO.File]::WriteAllText($m, $j, $utf8)
# Win32_Process создаёт процесс вне сессии SSH: он не умирает, когда лаунчер отключается.
$cmd = 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $d 'mcl-start.ps1') + '" -Ram ${Number(ram)}'
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd; CurrentDirectory = $d }
if ($r.ReturnValue -ne 0) { "failed:$($r.ReturnValue)"; exit 1 }
for ($i = 0; $i -lt 12; $i++) {
  Start-Sleep -Milliseconds 500
  if (Test-Path -LiteralPath (Join-Path $d 'mcl.pid')) {
    # mcl.want — «сервер должен работать»: по нему фоновый скрипт поднимает упавший сервер.
    [System.IO.File]::WriteAllText((Join-Path $d 'mcl.want'), '', $utf8)
    'started'; exit 0
  }
}
'notstarted'
`;
}

/** Передать команду серверу (текст приходит в base64, с переводом строки в конце). */
function commandScript(name, b64) {
  return `${HEAD}$d = Join-Path $B (Join-Path 'servers' ${psq(name)})
$pf = Join-Path $d 'mcl.pid'
$p = 0
if (Test-Path -LiteralPath $pf) { $p = [int](Get-Content -LiteralPath $pf -TotalCount 1) }
if (-not $p -or -not (Get-Process -Id $p -ErrorAction SilentlyContinue)) { exit 4 }
$t = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${psq(b64)}))
[System.IO.File]::AppendAllText((Join-Path $d 'console.in'), $t, (New-Object System.Text.UTF8Encoding($false)))
`;
}

/** Остановить: команда stop, а если через минуту не остановился — завершить дерево процессов. */
function stopScript(name) {
  return `${HEAD}$d = Join-Path $B (Join-Path 'servers' ${psq(name)})
Remove-Item -LiteralPath (Join-Path $d 'mcl.want') -Force -ErrorAction SilentlyContinue
$pf = Join-Path $d 'mcl.pid'
if (-not (Test-Path -LiteralPath $pf)) { 'stopped'; exit 0 }
$p = [int](Get-Content -LiteralPath $pf -TotalCount 1)
if (-not $p -or -not (Get-Process -Id $p -ErrorAction SilentlyContinue)) { Remove-Item -LiteralPath $pf -Force -ErrorAction SilentlyContinue; 'stopped'; exit 0 }
[System.IO.File]::AppendAllText((Join-Path $d 'console.in'), "stop" + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
for ($i = 0; $i -lt 60; $i++) {
  if (-not (Get-Process -Id $p -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Seconds 1
}
if (Get-Process -Id $p -ErrorAction SilentlyContinue) {
  & taskkill.exe /PID $p /T /F | Out-Null
  Start-Sleep -Seconds 2
  Remove-Item -LiteralPath $pf -Force -ErrorAction SilentlyContinue
  'killed'
} else { 'stopped' }
`;
}

/**
 * Замер нагрузки: система целиком и всё дерево процессов сервера (mcl-start.ps1 → cmd → java).
 * Время — в тиках по 100 нс, память процессов — в байтах, системная память — в КБ (как на Linux).
 */
function statsScript(name, withSize) {
  return `$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$d = Join-Path $env:USERPROFILE (Join-Path 'mc-launcher\\servers' ${psq(name)})
if (-not (Test-Path -LiteralPath $d)) { 'nodir=1'; exit 0 }
$os = Get-CimInstance Win32_OperatingSystem
"now=$([DateTime]::UtcNow.Ticks)"
"ncpu=$([Environment]::ProcessorCount)"
"syscpu=$([math]::Round((Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average))"
"mem=$($os.TotalVisibleMemorySize)"
"memfree=$($os.FreePhysicalMemory)"
"disk=$([math]::Floor((Get-Item -LiteralPath $d).PSDrive.Free / 1024))"
${withSize ? `"size=$([math]::Floor(((Get-ChildItem -LiteralPath $d -Recurse -File -Force | Measure-Object -Property Length -Sum).Sum) / 1024))"` : ''}
$pf = Join-Path $d 'mcl.pid'
if (Test-Path -LiteralPath $pf) {
  $root = [int](Get-Content -LiteralPath $pf -TotalCount 1)
  $rp = if ($root) { Get-Process -Id $root } else { $null }
  if ($rp) {
    $all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, KernelModeTime, UserModeTime, WorkingSetSize)
    $ids = @{ $root = $true }
    $added = $true
    while ($added) {
      $added = $false
      foreach ($p in $all) { if ($ids.ContainsKey([int]$p.ParentProcessId) -and -not $ids.ContainsKey([int]$p.ProcessId)) { $ids[[int]$p.ProcessId] = $true; $added = $true } }
    }
    [decimal]$t = 0; [decimal]$b = 0
    foreach ($p in $all) { if ($ids.ContainsKey([int]$p.ProcessId)) { $t += [decimal]$p.KernelModeTime + [decimal]$p.UserModeTime; $b += [decimal]$p.WorkingSetSize } }
    $age = [math]::Floor(((Get-Date) - $rp.StartTime).TotalSeconds)
    "wproc=$t $b $age"
  }
}
`;
}

/** Удалить папку сервера: только с mcl.json и только когда сервер остановлен. */
function deleteScript(name) {
  return `${HEAD}$d = Join-Path $B (Join-Path 'servers' ${psq(name)})
if (-not (Test-Path -LiteralPath (Join-Path $d 'mcl.json'))) { 'notfound'; exit 5 }
$pf = Join-Path $d 'mcl.pid'
if (Test-Path -LiteralPath $pf) {
  $p = [int](Get-Content -LiteralPath $pf -TotalCount 1)
  if ($p -and (Get-Process -Id $p -ErrorAction SilentlyContinue)) { 'running'; exit 4 }
}
Remove-Item -LiteralPath $d -Recurse -Force
'deleted'
`;
}

/** Команда для потока журнала (exec): последние 300 строк и всё новое. */
function tailCommand(name) {
  const file = `mc-launcher\\servers\\${name}\\console.log`;
  const ps =
    `try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}; ` +
    `Get-Content -LiteralPath '${file}' -Tail 300 -Wait -Encoding UTF8`;
  return `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "${ps}"`;
}

module.exports = { psq, infoScript, javaInstallScript, extractScript, startScript, launchScript, commandScript, stopScript, statsScript, deleteScript, tailCommand };
