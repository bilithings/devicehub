#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-$SCRIPT_DIR/docker-compose-macos.yaml}"
ENV_FILE="${ENV_FILE:-$SCRIPT_DIR/scripts/variables.env}"

dc() {
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
}

usage() {
  cat <<'EOF'
DeviceHub service manager

Usage:
  ./devicehub.sh <command>

Commands:
  up          Start all services in the background
  start       Alias for up
  down        Stop and remove all services (data volumes are preserved)
  stop        Stop all services without removing containers
  restart     Restart all existing services
  rebuild     Rebuild images without cache, then start services
  build       Build images
  ps          Show service status
  logs        Follow logs for all services
  logs NAME   Follow logs for one service
  config      Validate and print the Compose configuration
  check       Run one complete Docker/ADB/Provider health check
  diagnose    Correlate recent user/device/session failures
  proxy-status Show Nginx config, Docker DNS and resolved service IPs
  proxy-test  Test every proxied upstream and device worker port
  proxy-repair Validate and recreate Nginx (never touches data volumes)
  pull        Pull base/service images
  adb         Show connected Android devices
  adb-start   Start the local ADB server
  adb-stop    Stop the local ADB server
  adb-restart Restart the local ADB server and show devices
  adb-status  Show ADB version, server listener, and devices
  adb-connect Connect to a remote ADB endpoint
  adb-disconnect Disconnect from a remote ADB endpoint
  shell NAME  Open a shell in a running container
  help        Show this help

Examples:
  ./devicehub.sh up
  ./devicehub.sh restart
  ./devicehub.sh logs devicehub-app
  ./devicehub.sh ps
  ./devicehub.sh diagnose --device ab2de9d3 --since 15m
EOF
}

require_file() {
  if [[ ! -f "$1" ]]; then
    echo "文件不存在: $1" >&2
    exit 1
  fi
}

require_file "$COMPOSE_FILE"
require_file "$ENV_FILE"

proxy_status() {
  local services=(devicehub-app devicehub-api devicehub-auth devicehub-websocket
    devicehub-provider devicehub-storage-temp devicehub-storage-plugin-apk
    devicehub-storage-plugin-image)

  echo '== Nginx container =='
  dc ps nginx || true
  echo
  echo '== Nginx configuration test =='
  if dc exec -T nginx nginx -t; then
    echo 'PASS nginx-config'
  else
    echo 'FAIL nginx-config'
  fi
  echo
  echo '== Docker DNS resolver =='
  dc exec -T nginx cat /etc/resolv.conf 2>/dev/null || echo 'FAIL: nginx is not running'
  echo
  echo '== Service resolution (DNS vs container IP) =='
  for service in "${services[@]}"; do
    resolved="$(dc exec -T nginx getent hosts "$service" 2>/dev/null | awk '{print $1}' | paste -sd, - || true)"
    actual="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$service" 2>/dev/null | xargs || true)"
    printf '%-34s dns=%-22s container=%s\n' "$service" "${resolved:-NONE}" "${actual:-NONE}"
  done
  echo
  echo '== Nginx upstream resolution in recent errors =='
  dc logs --tail=80 --no-color nginx 2>/dev/null \
    | grep -E 'upstream|connect\(\) failed|no resolver|host not found' | tail -n 30 || true
}

proxy_probe() {
  local label="$1"
  local url="$2"
  local code
  code="$(docker exec devicehub-nginx curl -s -o /dev/null -w '%{http_code}' \
    --connect-timeout 3 --max-time 5 "$url" 2>/dev/null || true)"
  code="$(printf '%s' "$code" | tail -n1)"
  code="${code:-000}"
  case "$code" in
    000) echo "FAIL $label (unreachable)" ;;
    502|503|504) echo "FAIL $label ($code)" ;;
    *) echo "PASS $label ($code)" ;;
  esac
}

proxy_test() {
  echo '== Direct upstream health =='
  local failed=0
  local probes=(
    "app|http://devicehub-app:3000/health/live"
    "api|http://devicehub-api:3000/health/ready"
    "auth|http://devicehub-auth:3000/health/ready"
    "websocket|http://devicehub-websocket:3000/health/ready"
  )
  local item label url result
  for item in "${probes[@]}"; do
    label="${item%%|*}"
    url="${item#*|}"
    result="$(proxy_probe "$label" "$url")"
    echo "$result"
    [[ "$result" == PASS* ]] || failed=$((failed + 1))
  done

  echo
  echo '== Through Nginx =='
  for item in "app-root|http://127.0.0.1/health/live" "api-root|http://127.0.0.1/api/v1/user"; do
    label="${item%%|*}"
    url="${item#*|}"
    result="$(proxy_probe "$label" "$url")"
    echo "$result"
    [[ "$result" == PASS* ]] || failed=$((failed + 1))
  done

  echo
  echo '== Device workers registered in MongoDB =='
  local workers
  workers="$(dc exec -T devicehub-mongo mongosh --quiet --host devicehub-mongo:27017 --eval \
    'db = db.getSiblingDB("stf"); db.devices.find({"display.url": {$exists: true, $ne: null}}, {serial: 1, present: 1, "display.url": 1}).toArray().forEach(d => print(d.serial + " " + (d.present ? "present" : "absent") + " " + d.display.url))' 2>/dev/null | tr -d '\r' || true)"
  if [[ -z "$workers" ]]; then
    echo 'SKIP provider-worker (no registered display.url)'
  else
    while IFS=' ' read -r serial present url; do
      [[ -z "$serial" ]] && continue
      port="$(printf '%s' "$url" | sed -nE 's#^.*/([0-9]+)/?$#\1#p')"
      if [[ -z "$port" ]]; then
        echo "FAIL provider-worker $serial (unparseable url $url)"
        failed=$((failed + 1))
        continue
      fi
      if [[ "$present" == "absent" ]]; then
        echo "SKIP provider-worker $serial port $port (device absent)"
        continue
      fi
      result="$(proxy_probe "provider-worker $serial port $port" "http://devicehub-provider:$port/")"
      echo "$result ($present)"
      [[ "$result" == PASS* ]] || failed=$((failed + 1))
    done <<< "$workers"
  fi

  echo
  if [[ "$failed" -eq 0 ]]; then
    echo 'RESULT: all proxy checks passed'
  else
    echo "RESULT: $failed proxy check(s) failed"
    return 1
  fi
}

proxy_repair() {
  echo '[1/3] Validate Nginx configuration'
  if ! dc exec -T nginx nginx -t; then
    echo 'FAIL: configuration is invalid; not recreating Nginx'
    return 1
  fi

  echo
  echo '[2/3] Check dependencies'
  local service state
  for service in devicehub-app devicehub-api devicehub-auth devicehub-websocket; do
    state="$(docker inspect -f '{{if .State.Running}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$service" 2>/dev/null || echo missing)"
    echo "$service: $state"
  done

  echo
  echo '[3/3] Recreate Nginx (data volumes are preserved)'
  dc up -d --force-recreate --no-deps nginx
  echo
  proxy_test
}

command_name="${1:-help}"
shift || true

case "$command_name" in
  up|start)
    dc up -d "$@"
    ;;
  down)
    dc down "$@"
    ;;
  stop)
    dc stop "$@"
    ;;
  restart)
    dc restart "$@"
    ;;
  rebuild)
    dc build --no-cache
    dc up -d "$@"
    ;;
  build)
    dc build "$@"
    ;;
  ps|status)
    dc ps "$@"
    ;;
  logs|log)
    dc logs -f "$@"
    ;;
  config)
    dc config "$@"
    ;;
  check)
    echo '== DeviceHub health check =='
    echo
    echo '[1/4] Docker services'
    dc ps -a
    echo
    echo '[2/4] Host ADB devices'
    if ! command -v adb >/dev/null 2>&1; then
      echo 'FAIL: adb not found'
    else
      adb devices -l
    fi
    echo
    echo '[3/4] Provider -> host ADB (host.docker.internal:5037)'
    if dc exec -T devicehub-provider node -e 'const net=require("net");const s=net.connect({host:"host.docker.internal",port:5037,timeout:3000},()=>{console.log("PASS: ADB reachable");s.end()});s.on("timeout",()=>{console.error("FAIL: ADB connection timeout");s.destroy();process.exit(1)});s.on("error",e=>{console.error("FAIL: "+e.message);process.exit(1)})'; then
      :
    else
      echo 'Provider container is not running or cannot execute the check.'
    fi
    echo
    echo '[4/5] Recent logs for registration and device worker'
    for service in devicehub-mongosetup devicehub-migrate devicehub-processor devicehub-api-groups-engine devicehub-provider; do
      echo
      echo "--- $service ---"
      dc logs --tail=60 "$service" || true
    done
    echo
    echo '[5/5] Android touch service (minitouch)'
    if command -v adb >/dev/null 2>&1; then
      serial="$(adb devices | awk '$2 == "device" { print $1; exit }')"
      if [[ -n "$serial" ]]; then
        echo "Device: $serial"
        echo 'ABI:'
        adb -s "$serial" shell getprop ro.product.cpu.abilist | tr -d '\r'
        echo 'minitouch files:'
        adb -s "$serial" shell 'ls -l /data/local/tmp/minitouch /data/data/com.android.shell/minitouch 2>&1' | tr -d '\r' || true
        echo 'minitouch process:'
        adb -s "$serial" shell 'pidof minitouch 2>&1' | tr -d '\r' || true
        echo 'Provider touch/worker log lines:'
        dc logs --tail=240 devicehub-provider 2>/dev/null | grep -Ei 'minitouch|device process|ready|touch|error|fatal' | tail -n 100 || true
        echo 'Provider screen/stream/VNC lines:'
        dc logs --tail=240 devicehub-provider 2>/dev/null | grep -Ei 'minicap|screen|stream|vnc|frame|socket|error|fatal' | tail -n 100 || true
        echo 'WebSocket input/error log lines:'
        dc logs --tail=240 devicehub-websocket 2>/dev/null | grep -Ei 'input\.touch|touch|socket|error|fatal|connect' | tail -n 100 || true
        echo 'Nginx device WebSocket lines:'
        dc logs --tail=160 nginx 2>/dev/null | grep -Ei 'upstream|websocket|devicehub-provider|120[0-9][0-9]|error|warn' | tail -n 100 || true
        echo 'Registered screen URL and worker ports:'
        dc exec -T devicehub-mongo mongosh --quiet --host devicehub-mongo:27017 --eval 'db = db.getSiblingDB("stf"); const d = db.devices.findOne({serial: "'"$serial"'"}, {serial:1, present:1, ready:1, "display.url":1, "display.screenPort":1, "display.connectPort":1}); printjson(d)' 2>/dev/null || true
        echo 'Provider worker ports listening:'
        dc exec -T devicehub-provider node -e 'const net=require("net");let pending=91, found=[];for(let p=12010;p<=12100;p++){const s=net.connect({host:"127.0.0.1",port:p,timeout:250},()=>{found.push(p);s.destroy();done()});s.on("error",()=>done());s.on("timeout",()=>{s.destroy();done()})}function done(){if(--pending===0){console.log(found.length?found.join(" "):"none")}}' 2>/dev/null || true
      else
        echo 'FAIL: no online Android device found'
      fi
    else
      echo 'FAIL: adb not found'
    fi
    ;;
  diagnose)
    since='15m'
    device_filter=''
    user_filter=''
    user_key_filter=''
    trace_filter=''
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --since)
          since="${2:?--since requires a duration such as 15m}"
          shift 2
          ;;
        --device)
          device_filter="${2:?--device requires a serial}"
          shift 2
          ;;
        --user)
          user_filter="${2:?--user requires a user key or email fragment}"
          shift 2
          ;;
        --trace)
          trace_filter="${2:?--trace requires a trace id}"
          shift 2
          ;;
        *)
          echo "未知 diagnose 参数: $1" >&2
          exit 2
          ;;
      esac
    done

    if [[ "$user_filter" == *@* ]] && command -v shasum >/dev/null 2>&1; then
      user_hash_salt="${OBS_USER_HASH_SALT:-devicehub-observability}"
      user_digest="$(printf '%s:%s' "$user_hash_salt" "$user_filter" | tr '[:upper:]' '[:lower:]' | shasum -a 256 | awk '{print $1}')"
      user_key_filter="u-${user_digest:0:16}"
    fi

    echo '== DeviceHub correlated diagnosis =='
    echo "Since: $since"
    [[ -n "$device_filter" ]] && echo "Device filter: $device_filter"
    [[ -n "$user_filter" ]] && echo "User filter: $user_filter"
    [[ -n "$user_key_filter" ]] && echo "User key filter: $user_key_filter"
    [[ -n "$trace_filter" ]] && echo "Trace filter: $trace_filter"
    echo

    echo '[1/5] Service status'
    dc ps -a
    echo

    echo '[2/5] Host ADB status'
    if command -v adb >/dev/null 2>&1; then
      adb devices -l
    else
      echo 'FAIL: adb not found'
    fi
    echo

    echo '[3/5] Registered device state'
    if [[ -n "$device_filter" ]]; then
      dc exec -T devicehub-mongo mongosh --quiet --host devicehub-mongo:27017 --eval \
        'db = db.getSiblingDB("stf"); printjson(db.devices.findOne({serial: "'"$device_filter"'"}, {serial:1,present:1,ready:1,owner:1,group:1,display:1,adbPort:1,provider:1}))' 2>/dev/null || true
    else
      dc exec -T devicehub-mongo mongosh --quiet --host devicehub-mongo:27017 --eval \
        'db = db.getSiblingDB("stf"); printjson(db.devices.find({present:true}, {serial:1,present:1,ready:1,owner:1,"display.url":1,"display.screenPort":1,"display.connectPort":1}).toArray())' 2>/dev/null || true
    fi
    echo

    echo '[4/5] Recent correlated events'
    diagnosis_logs="$(dc logs --since "$since" --no-color devicehub-api devicehub-websocket devicehub-provider devicehub-processor nginx 2>&1 || true)"
    filtered_logs="$(printf '%s\n' "$diagnosis_logs" | awk \
      -v device="$device_filter" -v user="$user_filter" -v user_key="$user_key_filter" -v trace="$trace_filter" \
      'BEGIN {device=tolower(device); user=tolower(user); trace=tolower(trace)} {
        line=tolower($0);
        if (device != "" && index(line, device) == 0) next;
        if (user != "" && index(line, user) == 0 && (user_key == "" || index(line, tolower(user_key)) == 0)) next;
        if (trace != "" && index(line, trace) == 0) next;
        print
      }' | grep -Ei 'trace=|request=|socket=|session=|device=|user=|offline|unauthorized|forbidden|auth|screen|stream|minicap|minitouch|websocket|device.lifecycle|workerPort|12010|12011|502|error|failed|disconnect|timeout|session_conflict' | tail -n 240 || true)"
    printf '%s\n' "$filtered_logs"
    echo

    echo '[5/5] First likely cause'
    if printf '%s\n' "$filtered_logs" | grep -Eqi 'device offline|no transport|adb.*offline'; then
      echo 'ROOT CAUSE: host ADB reports the Android device offline/no transport.'
    elif printf '%s\n' "$filtered_logs" | grep -Eqi 'not a member of any group|authentication failed|auth.*forbidden|unauthorized'; then
      echo 'ROOT CAUSE: user/device authorization or group ownership failed.'
    elif printf '%s\n' "$filtered_logs" | grep -Eqi 'minicap.*(error|failed)|frame producer.*error'; then
      echo 'ROOT CAUSE: Android screen frame producer/minicap failed.'
    elif printf '%s\n' "$filtered_logs" | grep -Eqi '502|connection refused.*12010'; then
      echo 'ROOT CAUSE: browser screen WebSocket could not reach the Provider worker port.'
    else
      echo 'ROOT CAUSE: not determined from recent logs; inspect the correlated events above by trace/session.'
    fi
    ;;
  proxy-status)
    proxy_status
    ;;
  proxy-test)
    proxy_test
    ;;
  proxy-repair)
    proxy_repair
    ;;
  pull)
    dc pull "$@"
    ;;
  adb)
    if ! command -v adb >/dev/null 2>&1; then
      echo "未找到 adb。请先安装 Android Platform Tools。" >&2
      exit 127
    fi
    adb devices -l "$@"
    ;;
  adb-start)
    if ! command -v adb >/dev/null 2>&1; then
      echo "未找到 adb。请先安装 Android Platform Tools。" >&2
      exit 127
    fi
    adb -a start-server
    ;;
  adb-stop)
    if ! command -v adb >/dev/null 2>&1; then
      echo "未找到 adb。请先安装 Android Platform Tools。" >&2
      exit 127
    fi
    adb kill-server
    ;;
  adb-restart)
    if ! command -v adb >/dev/null 2>&1; then
      echo "未找到 adb。请先安装 Android Platform Tools。" >&2
      exit 127
    fi
    echo 'Stopping ADB server...'
    adb kill-server || true
    sleep 1
    echo 'Starting ADB server...'
    adb -a start-server
    echo
    adb devices -l
    ;;
  adb-status)
    if ! command -v adb >/dev/null 2>&1; then
      echo "未找到 adb。请先安装 Android Platform Tools。" >&2
      exit 127
    fi
    echo '== ADB binary =='
    command -v adb
    adb version
    echo
    echo '== ADB listener =='
    lsof -nP -iTCP:5037 -sTCP:LISTEN 2>/dev/null || echo 'No ADB listener found'
    echo
    echo '== Devices =='
    adb devices -l
    ;;
  adb-connect)
    if ! command -v adb >/dev/null 2>&1; then
      echo "未找到 adb。请先安装 Android Platform Tools。" >&2
      exit 127
    fi
    if [[ -z "${1:-}" ]]; then
      echo "用法: $0 adb-connect <host:port>" >&2
      exit 2
    fi
    adb connect "$1"
    adb devices -l
    ;;
  adb-disconnect)
    if ! command -v adb >/dev/null 2>&1; then
      echo "未找到 adb。请先安装 Android Platform Tools。" >&2
      exit 127
    fi
    if [[ -n "${1:-}" ]]; then
      adb disconnect "$1"
    else
      adb disconnect
    fi
    adb devices -l
    ;;
  shell)
    if [[ -z "${1:-}" ]]; then
      echo "用法: $0 shell <service>" >&2
      exit 2
    fi
    service="$1"
    shift
    dc exec "$service" sh "$@"
    ;;
  help|-h|--help)
    usage
    ;;
  *)
    echo "未知命令: $command_name" >&2
    usage >&2
    exit 2
    ;;
esac
