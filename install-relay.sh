#!/usr/bin/env bash
# install-relay.sh - runs the SOCKS5 relay (server.js) on a server of your own, as a service that starts at boot.
#
# Run it as root on the server, from the folder you unzipped relay-kit.zip into (server.js is in it):
#
#   sudo bash install-relay.sh                              install (or update) and print the lines for the .env of v.sh
#   sudo bash install-relay.sh --port 8443                  listen on another port (default 1080)
#   sudo bash install-relay.sh --host relay.example.com     the address to print (default: the public IPv4 of this server)
#   sudo bash install-relay.sh --show                       print the lines again (the password stays the same)
#   sudo bash install-relay.sh --new-password               make a new password (then update .env and run ./v.sh relay on)
#   sudo bash install-relay.sh --uninstall                  stop the service and remove its files
#   sudo bash install-relay.sh --no-service                 only write the files: no service, no firewall, no check
#
# It needs systemd (Debian, Ubuntu, Fedora, Rocky, Arch ... all have it). The relay runs as a throw-away system user
# (DynamicUser) with the systemd sandbox switched on. Its user name and password are made at random and kept in
# /etc/socks-relay/relay.env, which only root can read. Running the script again keeps them.
# Node.js 18+ is used when the server has it; otherwise a private copy of Node.js 22 is downloaded from nodejs.org
# (checksum verified) into /opt/socks-relay/node. Nothing else on the server is touched.

set -euo pipefail
umask 022

SERVICE="${SOCKS_RELAY_SERVICE:-socks-relay}"
INSTALL_DIR="${SOCKS_RELAY_DIR:-/opt/socks-relay}"
CONFIG_DIR="${SOCKS_RELAY_CONFIG_DIR:-/etc/socks-relay}"
UNIT_DIR="${SOCKS_RELAY_UNIT_DIR:-/etc/systemd/system}"
NODE_MAJOR="${SOCKS_RELAY_NODE_MAJOR:-22}"
NODE_DIST="${SOCKS_RELAY_NODE_DIST:-https://nodejs.org/dist}"
WAIT_SECONDS="${SOCKS_RELAY_WAIT_SECONDS:-15}"
ENV_FILE="$CONFIG_DIR/relay.env"
DEFAULT_PORT=1080
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP_DIR=""
NODE_BIN=""
ORIG_ARGS=""

say()  { printf '%s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

cleanup() { if [ -n "$TMP_DIR" ]; then rm -rf "$TMP_DIR"; fi; }

usage() {
  awk 'NR > 1 { if ($0 ~ /^#/) { sub(/^# ?/, ""); print } else exit }' "${BASH_SOURCE[0]}"
}

# ---------------------------------------------------------------- small helpers

need_root() {
  [ "$(id -u)" -eq 0 ] || die "this has to run as root. Try:  sudo bash $0 $ORIG_ARGS"
}

need_systemd() {
  if ! command -v systemctl >/dev/null 2>&1 || [ ! -d "${SOCKS_RELAY_RUN_DIR:-/run/systemd/system}" ]; then
    die "this server does not run systemd, which this script needs. Use Docker instead (the Dockerfile next to this script), or start the relay by hand:  SOCKS_USER=name SOCKS_PASS=password node server.js"
  fi
  local version
  version="$(systemctl --version 2>/dev/null | awk 'NR == 1 { print $2; exit }')" || version=""
  case "$version" in
    '' | *[!0-9]*) ;;
    *) [ "$version" -ge 235 ] || die "systemd $version is too old (235 or newer is needed for the sandbox settings). Use Docker instead (the Dockerfile next to this script)." ;;
  esac
}

fetch() { # fetch URL  - prints the body, fails when it cannot
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --connect-timeout 10 --max-time 180 "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- --timeout=20 "$1"
  else
    return 127
  fi
}

random_alnum() { # random_alnum LENGTH
  local out=""
  while [ "${#out}" -lt "$1" ]; do
    out="$out$(head -c 96 /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9')"
  done
  printf '%s' "${out:0:$1}"
}

valid_port() { [[ "$1" =~ ^[0-9]{1,5}$ ]] && [ "$1" -ge 1 ] && [ "$1" -le 65535 ]; }

valid_host() { # an IPv4 address, an IPv6 address or a host name: nothing else (no scheme, no port, no user@)
  [[ "$1" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$ ]] || [[ "$1" =~ ^[0-9A-Fa-f]*:[0-9A-Fa-f:]*:[0-9A-Fa-f:.]*$ ]]
}

is_ipv4() {
  local part
  [[ "$1" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]] || return 1
  local IFS=.
  for part in $1; do
    [ "$part" -le 255 ] || return 1
  done
}

is_private_ipv4() { # also true for this machine, link-local, carrier-grade NAT, multicast
  local a b
  [[ "$1" =~ ^([0-9]+)\.([0-9]+)\. ]] || return 1
  a="${BASH_REMATCH[1]}"
  b="${BASH_REMATCH[2]}"
  [ "$a" -eq 0 ] || [ "$a" -eq 10 ] || [ "$a" -eq 127 ] || [ "$a" -ge 224 ] && return 0
  [ "$a" -eq 100 ] && [ "$b" -ge 64 ] && [ "$b" -le 127 ] && return 0
  [ "$a" -eq 169 ] && [ "$b" -eq 254 ] && return 0
  [ "$a" -eq 172 ] && [ "$b" -ge 16 ] && [ "$b" -le 31 ] && return 0
  [ "$a" -eq 192 ] && [ "$b" -eq 168 ] && return 0
  return 1
}

detect_host() { # the public IPv4 address of this server; fails when it cannot be found
  local addr url
  if command -v ip >/dev/null 2>&1; then
    addr="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit } }')" || addr=""
    if is_ipv4 "$addr" && ! is_private_ipv4 "$addr"; then
      printf '%s' "$addr"
      return 0
    fi
  fi
  # Providers such as Oracle, AWS or Google give the machine a private address and translate the public one: ask the internet
  for url in https://api.ipify.org https://ipv4.icanhazip.com https://ifconfig.me/ip; do
    addr="$(fetch "$url" 2>/dev/null | tr -d '[:space:]')" || addr=""
    if is_ipv4 "$addr" && ! is_private_ipv4 "$addr"; then
      printf '%s' "$addr"
      return 0
    fi
  done
  return 1
}

env_value() { # env_value KEY  - the value in the env file, or nothing
  [ -f "$ENV_FILE" ] || return 0
  awk -v key="$1" 'index($0, key "=") == 1 { print substr($0, length(key) + 2); exit }' "$ENV_FILE"
}

stored_host() { # the address given or found by an earlier run (a comment line in the env file)
  [ -f "$ENV_FILE" ] || return 0
  awk 'index($0, "# PUBLIC_HOST=") == 1 { print substr($0, 15); exit }' "$ENV_FILE"
}

find_source_dir() { # the folder that holds server.js and package.json
  local d
  for d in "$SELF_DIR" "$SELF_DIR/.." "$PWD"; do
    if [ -f "$d/server.js" ] && [ -f "$d/package.json" ]; then
      (cd "$d" && pwd)
      return 0
    fi
  done
  return 1
}

copy_file() { # copy_file SRC DST  (a file that is already in place is left alone)
  if [ "$1" -ef "$2" ]; then return 0; fi
  install -m 644 "$1" "$2"
}

# ---------------------------------------------------------------- Node.js

node_ok() { # node_ok PATH  - Node.js 18 or newer?
  "$1" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' >/dev/null 2>&1
}

install_private_node() {
  local arch dist tmp line sum file
  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    armv7l) arch=armv7l ;;
    *) die "this server has no Node.js 18 or newer, and nodejs.org has no download for the processor '$(uname -m)'. Install Node.js yourself and run this script again." ;;
  esac
  say "This server has no Node.js 18 or newer: downloading Node.js $NODE_MAJOR from nodejs.org ..."
  dist="$NODE_DIST/latest-v$NODE_MAJOR.x"
  tmp="$(mktemp -d)"
  TMP_DIR="$tmp"
  fetch "$dist/SHASUMS256.txt" >"$tmp/SHASUMS256.txt" ||
    die "could not download the Node.js checksum list from $dist. Check that the server can reach nodejs.org, or install Node.js 18 or newer yourself (apt install nodejs / dnf install nodejs) and run this script again."
  line="$(awk -v arch="$arch" '$2 ~ ("^node-v[0-9]+[.][0-9]+[.][0-9]+-linux-" arch "[.]tar[.]gz$") { print; exit }' "$tmp/SHASUMS256.txt")"
  [ -n "$line" ] || die "the Node.js download list has no Linux $arch build"
  sum="$(printf '%s' "$line" | awk '{ print $1 }')"
  file="$(printf '%s' "$line" | awk '{ print $2 }')"
  fetch "$dist/$file" >"$tmp/$file" || die "could not download $dist/$file"
  if ! (cd "$tmp" && printf '%s  %s\n' "$sum" "$file" | sha256sum -c - >/dev/null 2>&1); then
    die "the checksum of the downloaded Node.js does not match; nothing was installed"
  fi
  install -d -m 755 "$INSTALL_DIR"
  rm -rf "$INSTALL_DIR/node.new"
  mkdir "$INSTALL_DIR/node.new"
  tar -xzf "$tmp/$file" -C "$INSTALL_DIR/node.new" --strip-components=1 --no-same-owner
  rm -rf "$INSTALL_DIR/node"
  mv "$INSTALL_DIR/node.new" "$INSTALL_DIR/node"
  node_ok "$INSTALL_DIR/node/bin/node" || die "the downloaded Node.js does not run on this server"
}

usable_location() { # a Node.js inside a home folder (nvm ...) cannot be used by the service: it is not allowed to go in there
  case "$1" in
    /root/* | /home/*) return 1 ;;
  esac
  return 0
}

pick_node() { # sets NODE_BIN; downloads a private copy of Node.js when the server has none that fits
  local found path
  if [ -x "$INSTALL_DIR/node/bin/node" ] && node_ok "$INSTALL_DIR/node/bin/node"; then
    NODE_BIN="$INSTALL_DIR/node/bin/node"
    return 0
  fi
  if found="$(command -v node 2>/dev/null)" && path="$(readlink -f "$found" 2>/dev/null)" && [ -x "$path" ]; then
    if usable_location "$path" && node_ok "$path"; then
      NODE_BIN="$path"
      return 0
    fi
  fi
  install_private_node
  NODE_BIN="$INSTALL_DIR/node/bin/node"
}

# ---------------------------------------------------------------- files

write_env_file() { # write_env_file PORT USER PASS HOST  - keeps extra settings that were added by hand
  local tmp
  install -d -m 755 "$CONFIG_DIR"
  tmp="$(mktemp "$CONFIG_DIR/.relay.env.XXXXXX")"
  chmod 600 "$tmp"
  {
    printf '# Settings of the SOCKS5 relay. Read by systemd; after a change run:  systemctl restart %s\n' "$SERVICE"
    printf '# More settings of server.js can be added below (for example BLOCKED_PORTS= or MAX_CONNECTIONS=).\n'
    if [ -n "$4" ]; then printf '# PUBLIC_HOST=%s\n' "$4"; fi
    printf 'SOCKS_PORT=%s\nSOCKS_USER=%s\nSOCKS_PASS=%s\n' "$1" "$2" "$3"
    if [ -f "$ENV_FILE" ]; then
      grep -Ev '^(#|SOCKS_PORT=|SOCKS_USER=|SOCKS_PASS=|[[:space:]]*$)' "$ENV_FILE" || true
    fi
  } >"$tmp"
  mv "$tmp" "$ENV_FILE"
}

write_unit() { # write_unit NODE PORT
  local caps="CapabilityBoundingSet="
  if [ "$2" -lt 1024 ]; then
    caps="AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE"
  fi
  install -d -m 755 "$UNIT_DIR"
  cat >"$UNIT_DIR/$SERVICE.service" <<EOF
[Unit]
Description=SOCKS5 relay ($SERVICE)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart="$1" "$INSTALL_DIR/server.js"
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$ENV_FILE
DynamicUser=yes
Restart=always
RestartSec=3
LimitNOFILE=65536
NoNewPrivileges=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
ProtectHome=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
$caps

[Install]
WantedBy=multi-user.target
EOF
  chmod 644 "$UNIT_DIR/$SERVICE.service"
}

# ---------------------------------------------------------------- firewall, start, check

open_firewall() { # open_firewall PORT
  local status
  if command -v ufw >/dev/null 2>&1; then
    status="$(LC_ALL=C ufw status 2>/dev/null || true)"
    case "$status" in
      "Status: active"*)
        if ufw allow "$1/tcp" >/dev/null 2>&1; then
          say "Firewall (ufw): TCP port $1 is open."
        else
          warn "could not open TCP port $1 in ufw. Run:  ufw allow $1/tcp"
        fi
        ;;
    esac
  fi
  if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
    if firewall-cmd --permanent --add-port="$1/tcp" >/dev/null 2>&1 && firewall-cmd --reload >/dev/null 2>&1; then
      say "Firewall (firewalld): TCP port $1 is open."
    else
      warn "could not open TCP port $1 in firewalld. Run:  firewall-cmd --permanent --add-port=$1/tcp && firewall-cmd --reload"
    fi
  fi
}

start_service() {
  systemctl daemon-reload
  systemctl enable "$SERVICE" >/dev/null 2>&1 || warn "could not enable $SERVICE at boot (systemctl enable $SERVICE)"
  systemctl restart "$SERVICE" || die "systemctl could not start $SERVICE. See:  journalctl -u $SERVICE -n 30 --no-pager"
}

check_relay() { # check_relay NODE CHECK PORT USER PASS  - waits for the relay, then logs in and opens a test connection
  local node="$1" check="$2" port="$3" user="$4" pass="$5" waited=0 out=""
  while :; do
    if out="$(RELAY_EXTERNAL_HOST=127.0.0.1 RELAY_EXTERNAL_PORT="$port" RELAY_EXTERNAL_USER="$user" RELAY_EXTERNAL_PASS="$pass" "$node" "$check" --login-only 2>&1)"; then
      break
    fi
    waited=$((waited + 1))
    if [ "$waited" -ge "$WAIT_SECONDS" ]; then
      printf '%s\n' "The relay did not answer on port $port: $out" >&2
      journalctl -u "$SERVICE" -n 15 --no-pager 2>/dev/null >&2 || true
      echo "(Hint: 'EADDRINUSE' in those lines means that another program already uses port $port: choose another with --port.)" >&2
      return 1
    fi
    sleep 1
  done
  if out="$(RELAY_EXTERNAL_HOST=127.0.0.1 RELAY_EXTERNAL_PORT="$port" RELAY_EXTERNAL_USER="$user" RELAY_EXTERNAL_PASS="$pass" "$node" "$check" 2>&1)"; then
    say "Check: the relay is running, the login works and it can open connections to the internet."
  else
    warn "the relay is running and the login works, but it could not open a test connection to the internet from this server: ${out#FAILED }"
    warn "A relay that cannot reach the internet is of no use: check the outgoing traffic / DNS of this server."
  fi
}

print_settings() { # print_settings HOST PORT USER PASS
  local host="$1"
  if [ -z "$host" ]; then
    warn "the public address of this server could not be found: write it yourself on the first line below (or run this script again with --host ADDRESS)"
    host="PUT-THE-PUBLIC-ADDRESS-OF-THIS-SERVER-HERE"
  fi
  cat <<EOF

Put these lines in the .env file of v.sh (replace the RELAY_EXTERNAL_* lines that are already there):

RELAY_EXTERNAL_HOST=$host
RELAY_EXTERNAL_PORT=$2
RELAY_EXTERNAL_USER=$3
RELAY_EXTERNAL_PASS=$4

Then turn the relay on, where v.sh is:   ./v.sh relay on
(Keep the password private. This script prints the lines again with --show.)
EOF
}

# ---------------------------------------------------------------- the three actions

do_install() {
  local port user pass host check candidate
  if [ "$NO_SERVICE" -eq 0 ]; then
    need_root
    need_systemd
  fi
  SRC="$(find_source_dir)" || die "server.js and package.json were not found. Run this script from the folder you unzipped relay-kit.zip into (the one with server.js in it):  sudo bash install-relay.sh"
  check=""
  for candidate in "$SELF_DIR/check-relay.mjs" "$SRC/check-relay.mjs"; do
    if [ -f "$candidate" ]; then
      check="$candidate"
      break
    fi
  done

  port="${PORT:-$(env_value SOCKS_PORT)}"
  port="${port:-$DEFAULT_PORT}"
  valid_port "$port" || die "'$port' is not a port number (1-65535)"
  port=$((10#$port))
  user="$(env_value SOCKS_USER)"
  if [ -z "$user" ]; then user="$(random_alnum 10)"; fi
  pass="$(env_value SOCKS_PASS)"
  if [ -z "$pass" ] || [ "$NEW_PASSWORD" -eq 1 ]; then pass="$(random_alnum 32)"; fi
  host="${WANT_HOST:-$(stored_host)}"
  if [ -z "$host" ] && [ "$NO_SERVICE" -eq 0 ]; then host="$(detect_host)" || host=""; fi

  pick_node
  install -d -m 755 "$INSTALL_DIR"
  copy_file "$SRC/server.js" "$INSTALL_DIR/server.js"
  copy_file "$SRC/package.json" "$INSTALL_DIR/package.json" # it says "type": "module", which server.js needs
  if [ -n "$check" ]; then copy_file "$check" "$INSTALL_DIR/check-relay.mjs"; fi
  write_env_file "$port" "$user" "$pass" "$host"
  write_unit "$NODE_BIN" "$port"

  if [ "$NO_SERVICE" -eq 1 ]; then
    say "Files written (no service was started, because of --no-service):"
    say "  $INSTALL_DIR/server.js   $ENV_FILE   $UNIT_DIR/$SERVICE.service"
    print_settings "$host" "$port" "$user" "$pass"
    return 0
  fi

  start_service
  say "The service '$SERVICE' is started (it starts again by itself after a reboot or a crash)."
  open_firewall "$port"
  if [ -n "$check" ]; then
    check_relay "$NODE_BIN" "$check" "$port" "$user" "$pass" || die "the relay does not work; see the lines above"
  else
    warn "check-relay.mjs was not found next to this script: the relay was not checked"
  fi
  say "If your provider has its own firewall (a 'Firewall' or 'Security group' page in its dashboard), open TCP port $port there too."
  print_settings "$host" "$port" "$user" "$pass"
}

do_show() {
  local host
  [ -f "$ENV_FILE" ] || die "$ENV_FILE does not exist: the relay is not installed here (run this script without --show first)"
  [ -r "$ENV_FILE" ] || die "cannot read $ENV_FILE: run this as root (sudo)"
  host="${WANT_HOST:-$(stored_host)}"
  if [ -z "$host" ]; then host="$(detect_host)" || host=""; fi
  print_settings "$host" "$(env_value SOCKS_PORT)" "$(env_value SOCKS_USER)" "$(env_value SOCKS_PASS)"
}

safe_to_remove() { # a folder this script made: not a system folder, and it has the marker file inside
  case "$1" in
    "" | / | /bin | /boot | /dev | /etc | /home | /lib | /lib64 | /opt | /proc | /root | /run | /sbin | /srv | /sys | /tmp | /usr | /var) return 1 ;;
  esac
  [ -f "$1/$2" ]
}

do_uninstall() {
  if [ "$NO_SERVICE" -eq 0 ]; then need_root; fi
  if [ "$NO_SERVICE" -eq 0 ] && command -v systemctl >/dev/null 2>&1; then
    systemctl disable --now "$SERVICE" >/dev/null 2>&1 || true
  fi
  rm -f "$UNIT_DIR/$SERVICE.service"
  if [ "$NO_SERVICE" -eq 0 ] && command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload >/dev/null 2>&1 || true
  fi
  if safe_to_remove "$INSTALL_DIR" server.js; then rm -rf "$INSTALL_DIR"; else warn "$INSTALL_DIR was left alone (it is not a folder made by this script)"; fi
  if safe_to_remove "$CONFIG_DIR" relay.env; then rm -rf "$CONFIG_DIR"; else warn "$CONFIG_DIR was left alone (it is not a folder made by this script)"; fi
  say "The relay '$SERVICE' is removed. A firewall rule that was opened for it stays (remove it yourself if you want: ufw delete allow PORT/tcp)."
}

main() {
  ACTION=install
  PORT=""
  WANT_HOST=""
  NEW_PASSWORD=0
  NO_SERVICE=0
  ORIG_ARGS="$*"
  while [ $# -gt 0 ]; do
    case "$1" in
      --port | --host)
        [ $# -ge 2 ] && [ -n "$2" ] || die "$1 needs a value (see --help)"
        if [ "$1" = "--port" ]; then PORT="$2"; else WANT_HOST="$2"; fi
        shift 2
        ;;
      --new-password) NEW_PASSWORD=1; shift ;;
      --no-service) NO_SERVICE=1; shift ;;
      --show) ACTION=show; shift ;;
      --uninstall) ACTION=uninstall; shift ;;
      -h | --help) usage; exit 0 ;;
      *) die "unknown option '$1' (see --help)" ;;
    esac
  done
  if [ -n "$PORT" ]; then valid_port "$PORT" || die "'$PORT' is not a port number (1-65535)"; fi
  if [ -n "$WANT_HOST" ]; then valid_host "$WANT_HOST" || die "'$WANT_HOST' is not an address: write only the IP address or the host name (no http://, no port, no user@)"; fi
  trap cleanup EXIT
  case "$ACTION" in
    install) do_install ;;
    show) do_show ;;
    uninstall) do_uninstall ;;
  esac
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
