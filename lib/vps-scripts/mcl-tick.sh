#!/bin/sh
# Блокхост: фоновые задачи серверов Minecraft на VPS. Создано программой «Блокхост».
# cron запускает этот скрипт раз в минуту и после перезагрузки VPS. Для каждого сервера
# (настройки — в mcl.conf в папке сервера, их пишет лаунчер):
#   - запускает заново упавший сервер и сервер после перезагрузки VPS (auto=1);
#   - перезапускает по расписанию (restart=ЧЧ:ММ по UTC, warn — за сколько минут предупредить в чате);
#   - делает бэкапы по расписанию (backup=ЧЧ:ММ по UTC, keep — сколько хранить);
#   - записывает нагрузку в mcl-stats.log, события — в mcl-events.log;
#   - сообщает о событиях в Discord (discord=адрес вебхука).
# Вызовы: mcl-tick.sh tick | backup <имя> [manual] | restart <имя> | restore <имя> <файл>
# mcl-tick-version: __VERSION__

B="$HOME/mc-launcher"
S="$B/servers"
PATH="$PATH:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export PATH

cfg() { sed -n "s/^$2=//p" "$1/mcl.conf" 2>/dev/null | head -n 1; }
ev() { echo "$(date +%s) $1 $2 $3" >> "$D/mcl-events.log"; }
# Подчёркивание в нике Discord принял бы за курсив.
md() { printf %s "$1" | sed 's/_/\\\\_/g'; }

alive() {
  P=$(cat "$1/mcl.pid" 2>/dev/null)
  [ -n "$P" ] && kill -0 "$P" 2>/dev/null || return 1
  # После перезагрузки номер процесса мог достаться другой программе.
  if [ -r "/proc/$P/cmdline" ]; then tr '\000' ' ' < "/proc/$P/cmdline" | grep -q mcl-start || return 1; fi
  return 0
}

okt() { case "$1" in [0-2][0-9]:[0-5][0-9]) return 0 ;; esac; return 1; }
tom() { h=${1%%:*}; m=${1#*:}; h=${h#0}; m=${m#0}; echo $(( ${h:-0} * 60 + ${m:-0} )); }
nowm() { tom "$(date -u +%H:%M)"; }
ram() { r=$(sed -n 's/.*"ramGb": *\([0-9][0-9]*\).*/\1/p' "$D/mcl.json"); echo "${r:-2}"; }

detach() {
  if command -v setsid >/dev/null 2>&1; then setsid nohup "$@" >/dev/null 2>&1 </dev/null &
  else nohup "$@" >/dev/null 2>&1 </dev/null &
  fi
}

start_srv() {
  grep -q '^eula=true' "$D/eula.txt" 2>/dev/null || { ev noeula "$N"; return 1; }
  rm -f "$D/mcl.pid"
  (cd "$D" && detach sh "$D/mcl-start.sh" "$(ram)")
  i=0
  while [ $i -lt 10 ] && ! alive "$D"; do sleep 1; i=$((i + 1)); done
  : > "$D/mcl.want"
  alive "$D"
}

stop_srv() {
  alive "$D" || return 0
  P=$(cat "$D/mcl.pid")
  echo stop >> "$D/console.in"
  i=0
  while kill -0 "$P" 2>/dev/null && [ $i -lt 60 ]; do sleep 1; i=$((i + 1)); done
  if kill -0 "$P" 2>/dev/null; then
    kill -TERM -- "-$P" 2>/dev/null || kill "$P"
    sleep 3
    kill -KILL -- "-$P" 2>/dev/null
    rm -f "$D/mcl.pid"
    : > "$D/mcl.done"
  fi
}

say() { alive "$D" && echo "say $1" >> "$D/console.in"; }

dc() {
  U=$(cfg "$D" discord)
  [ -n "$U" ] && [ "$(cfg "$D" "$1")" = 1 ] || return 0
  case "$U" in
    https://discord.com/api/webhooks/*|https://discordapp.com/api/webhooks/*|https://ptb.discord.com/api/webhooks/*|https://canary.discord.com/api/webhooks/*) ;;
    *) return 0 ;;
  esac
  body="{\"content\":\"$2\",\"allowed_mentions\":{\"parse\":[]}}"
  if command -v curl >/dev/null 2>&1; then
    curl -fsS -m 15 -H 'Content-Type: application/json' -d "$body" "$U" >/dev/null 2>&1 &
  elif command -v wget >/dev/null 2>&1; then
    wget -q -T 15 -O /dev/null --header='Content-Type: application/json' --post-data="$body" "$U" >/dev/null 2>&1 &
  fi
}

# Что входит в бэкап: всё, кроме самих бэкапов, журналов и служебных файлов лаунчера.
skip() {
  case "$1" in
    backups|logs|crash-reports|cache|.cache|debug|console.log|console.old.log|console.in|exit.code|mcl.*|mcl-*|.mcl-*) return 0 ;;
  esac
  return 1
}

backup_do() {
  case "$1" in auto|manual|before-restore) ;; *) echo badtag; return 2 ;; esac
  # Брошенный замок (бэкап прервали) через 3 часа уже не мешает.
  find "$D" -maxdepth 1 -name .mcl-backup.lock -mmin +180 -exec rm -rf {} + 2>/dev/null
  mkdir "$D/.mcl-backup.lock" 2>/dev/null || { echo busy; return 3; }
  mkdir -p "$D/backups"
  F="$D/backups/$N-$(date -u +%Y%m%d-%H%M%S)-$1.tar.gz"
  on=0
  if alive "$D"; then
    # Сервер работает: просим сохранить мир и не трогать файлы, пока идёт архив.
    on=1
    pos=$(wc -c < "$D/console.log" 2>/dev/null || echo 0)
    printf 'save-off\nsave-all flush\n' >> "$D/console.in"
    i=0
    while [ $i -lt 90 ]; do
      sleep 1
      i=$((i + 1))
      tail -c +$((pos + 1)) "$D/console.log" 2>/dev/null | grep -qiE 'saved the (game|world)' && break
    done
  fi
  set --
  for f in "$D"/* "$D"/.[!.]*; do
    [ -e "$f" ] || continue
    b=${f##*/}
    skip "$b" && continue
    set -- "$@" "$b"
  done
  ok=0
  if [ $# -gt 0 ]; then
    tar -czf "$F.part" -C "$D" "$@" 2> "$D/.mcl-backup.lock/err"
    c=$?
    # Код 1 у GNU tar — «файл менялся во время чтения»: архив при этом цел.
    if [ $c -le 1 ] && [ -s "$F.part" ]; then mv -f "$F.part" "$F" && ok=1; fi
  fi
  rm -f "$F.part"
  [ $on = 1 ] && echo save-on >> "$D/console.in"
  err=$(tail -n 1 "$D/.mcl-backup.lock/err" 2>/dev/null)
  rm -rf "$D/.mcl-backup.lock"
  if [ $ok = 1 ]; then
    size=$(wc -c < "$F" | tr -d ' ')
    MB=$((size / 1048576))
    # Копия перед восстановлением — не повод для уведомления.
    if [ "$1" != before-restore ]; then
      ev backup "$N" "$MB"
      dc dbackup "__T_BACKUP__"
    fi
    keep=$(cfg "$D" keep)
    keep=${keep:-7}
    ls -1t "$D/backups/"*-auto.tar.gz 2>/dev/null | tail -n +$((keep + 1)) | while IFS= read -r old; do rm -f "$old"; done
    echo "file=${F##*/}"
    echo "size=$size"
    return 0
  fi
  ev backupfail "$N"
  dc dbackup "__T_BACKUPFAIL__"
  echo "error=${err:-нечего сохранять}"
  return 1
}

restore_do() {
  case "$1" in ''|*/*|*[!A-Za-z0-9._-]*) echo badname; return 2 ;; esac
  [ -f "$D/backups/$1" ] || { echo nofile; return 5; }
  alive "$D" && { echo running; return 4; }
  # Сначала — копия того, что есть сейчас: восстановление можно будет отменить.
  backup_do before-restore > /dev/null || { echo nosafety; return 6; }
  for f in "$D"/* "$D"/.[!.]*; do
    [ -e "$f" ] || continue
    b=${f##*/}
    skip "$b" && continue
    rm -rf -- "$f"
  done
  tar -xzf "$D/backups/$1" -C "$D" || { echo extractfail; return 7; }
  echo restored
}

restart_job() {
  mkdir "$D/.mcl-restart.lock" 2>/dev/null || return 0
  if alive "$D"; then
    say "__T_NOW__"
    sleep 5
    stop_srv
    sleep 2
    if start_srv; then
      ev sched "$N"
      dc dcrash "__T_SCHED__"
    fi
  fi
  rm -rf "$D/.mcl-restart.lock"
}

# ---- раз в минуту ----

watch() {
  [ -d "$D/.mcl-restart.lock" ] && return 0
  alive "$D" && return 0
  [ -f "$D/mcl.want" ] || return 0
  # Только что запущен и ещё не успел записать mcl.pid.
  if [ ! -f "$D/exit.code" ] && [ -n "$(find "$D/mcl.want" -mmin -2 2>/dev/null)" ]; then return 0; fi
  code=$(cat "$D/exit.code" 2>/dev/null)
  rm -f "$D/mcl.pid"
  # Код 0 — остановили командой stop в игре: так и задумано.
  if [ "$code" = 0 ]; then rm -f "$D/mcl.want"; return 0; fi
  CODE=${code:-?}
  kind=crash
  if [ -z "$code" ] && [ "$UP" -lt 900 ]; then kind=boot; fi
  if [ "$(cfg "$D" auto)" != 1 ]; then
    rm -f "$D/mcl.want"
    if [ $kind = crash ]; then
      ev crashed "$N" "$CODE"
      dc dcrash "__T_CRASHED__"
    fi
    return 0
  fi
  now=$(date +%s)
  # Не больше трёх перезапусков за 15 минут: иначе сервер падает при каждом запуске.
  { [ -f "$D/mcl.crashes" ] && awk -v n="$now" 'n - $1 < 900' "$D/mcl.crashes"; echo "$now"; } > "$D/mcl.crashes.new"
  mv -f "$D/mcl.crashes.new" "$D/mcl.crashes"
  if [ $kind = crash ] && [ "$(wc -l < "$D/mcl.crashes")" -gt 3 ]; then
    rm -f "$D/mcl.want"
    ev gaveup "$N"
    dc dcrash "__T_GAVEUP__"
    return 0
  fi
  if start_srv; then
    if [ $kind = boot ]; then
      ev boot "$N"
      dc dcrash "__T_BOOT__"
    else
      ev crash "$N" "$CODE"
      dc dcrash "__T_CRASH__"
    fi
  fi
}

sched() {
  nm=$(nowm)
  today=$(date -u +%Y%m%d)
  r=$(cfg "$D" restart)
  if okt "$r" && alive "$D"; then
    d=$(( ($(tom "$r") - nm + 1440) % 1440 ))
    w=$(cfg "$D" warn)
    w=${w:-0}
    if [ "$w" -gt 0 ] && [ $d -eq "$w" ]; then MIN=$w; say "__T_WARN__"; fi
    if [ "$w" -gt 1 ] && [ $d -eq 1 ]; then MIN=1; say "__T_WARN__"; fi
    if [ $d -eq 0 ] && [ "$(cat "$D/mcl.lastrestart" 2>/dev/null)" != "$today" ]; then
      echo "$today" > "$D/mcl.lastrestart"
      detach sh "$B/mcl-tick.sh" restart "$N"
    fi
  fi
  b=$(cfg "$D" backup)
  if okt "$b"; then
    d=$(( ($(tom "$b") - nm + 1440) % 1440 ))
    if [ $d -eq 0 ] && [ "$(cat "$D/mcl.lastbackup" 2>/dev/null)" != "$today" ]; then
      echo "$today" > "$D/mcl.lastbackup"
      detach sh "$B/mcl-tick.sh" backup "$N" auto
    fi
  fi
}

# Кто зашёл и вышел — по новым строкам журнала с прошлой минуты.
joins() {
  L="$D/console.log"
  [ -f "$L" ] || return 0
  sz=$(wc -c < "$L" | tr -d ' ')
  pos=$(cat "$D/mcl.logpos" 2>/dev/null)
  echo "$sz" > "$D/mcl.logpos"
  [ -n "$pos" ] || return 0
  [ "$sz" -lt "$pos" ] && pos=0
  [ "$sz" -gt "$pos" ] || return 0
  tail -c +$((pos + 1)) "$L" | head -c 4000000 | grep -E '[]:] [.A-Za-z0-9_]{1,17} (joined|left) the game' | head -n 20 |
    sed -E 's/.*[]:] ([.A-Za-z0-9_]{1,17}) (joined|left) the game.*/\2 \1/' |
    while read -r what who; do
      W=$(md "$who")
      if [ "$what" = joined ]; then
        ev join "$N" "$who"
        dc djoin "__T_JOIN__"
      else
        ev leave "$N" "$who"
        dc djoin "__T_LEAVE__"
      fi
    done
}

stats() {
  pc=-
  pr=-
  cn=-
  if alive "$D"; then
    P=$(cat "$D/mcl.pid")
    t=0
    r=0
    for f in /proc/[0-9]*/stat; do
      read -r l < "$f" 2>/dev/null || continue
      set -- ${l##*") "}
      [ "$3" = "$P" ] || continue
      t=$((t + ${12} + ${13}))
      r=$((r + ${22}))
    done
    pc=$((t * 100 / CLK))
    pr=$((r * PAGE))
    port=$(sed -n 's/.*"port": *"\{0,1\}\([0-9][0-9]*\).*/\1/p' "$D/mcl.json")
    hex=$(printf %04X "${port:-25565}")
    cn=$(for f in /proc/net/tcp /proc/net/tcp6; do [ -r "$f" ] && cat "$f"; done | awk -v p="$hex" '$4 == "01" { split($2, a, ":"); if (a[2] == p) n++ } END { print n + 0 }')
  fi
  echo "$(date +%s) $pc $pr $BUSY $TOTAL $MT $MF $cn $NCPU" >> "$D/mcl-stats.log"
}

disk() {
  FREE=$(df -Pk "$D" 2>/dev/null | awk 'NR==2 {print $4}')
  [ -n "$FREE" ] && [ "$FREE" -lt 1048576 ] || return 0
  now=$(date +%s)
  last=$(cat "$D/mcl.disklow" 2>/dev/null || echo 0)
  [ $((now - last)) -gt 21600 ] || return 0
  echo "$now" > "$D/mcl.disklow"
  FREE=$((FREE / 1024))
  ev disk "$N" "$FREE"
  dc ddisk "__T_DISK__"
}

trim() {
  f="$D/mcl-stats.log"
  # Неделя замеров раз в минуту.
  if [ -f "$f" ] && [ "$(wc -l < "$f")" -gt 10300 ]; then tail -n 10080 "$f" > "$f.new" && mv -f "$f.new" "$f"; fi
  f="$D/mcl-events.log"
  if [ -f "$f" ] && [ "$(wc -l < "$f")" -gt 700 ]; then tail -n 500 "$f" > "$f.new" && mv -f "$f.new" "$f"; fi
}

tick() {
  if ! mkdir "$B/.mcl-tick.lock" 2>/dev/null; then
    [ -n "$(find "$B/.mcl-tick.lock" -maxdepth 0 -mmin +10 2>/dev/null)" ] || exit 0
    rm -rf "$B/.mcl-tick.lock"
    mkdir "$B/.mcl-tick.lock" 2>/dev/null || exit 0
  fi
  trap 'rm -rf "$B/.mcl-tick.lock"' EXIT
  read -r UP _ < /proc/uptime
  UP=${UP%%.*}
  CLK=$(getconf CLK_TCK 2>/dev/null || echo 100)
  PAGE=$(getconf PAGESIZE 2>/dev/null || echo 4096)
  NCPU=$(nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo 2>/dev/null || echo 1)
  set -- $(head -n 1 /proc/stat)
  shift
  BUSY=$((${1:-0} + ${2:-0} + ${3:-0} + ${6:-0} + ${7:-0} + ${8:-0}))
  TOTAL=$((BUSY + ${4:-0} + ${5:-0}))
  MT=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)
  MF=$(awk '/^MemAvailable:/ {a=$2} /^MemFree:/ {f=$2} /^Buffers:/ {b=$2} /^Cached:/ {c=$2} END {print (a != "" ? a : f + b + c)}' /proc/meminfo)
  for D in "$S"/*; do
    [ -f "$D/mcl.json" ] || continue
    N=${D##*/}
    NM=$(md "$N")
    watch
    sched
    joins
    stats
    disk
    trim
  done
}

pick() {
  case "$1" in ''|.|..|*[!A-Za-z0-9._-]*) echo badname; exit 2 ;; esac
  N=$1
  D="$S/$1"
  NM=$(md "$N")
  [ -f "$D/mcl.json" ] || { echo notfound; exit 5; }
}

case "${1:-tick}" in
  tick) tick ;;
  backup) pick "$2"; backup_do "${3:-manual}" ;;
  restart) pick "$2"; restart_job ;;
  restore) pick "$2"; restore_do "$3" ;;
  *) echo "unknown"; exit 2 ;;
esac
