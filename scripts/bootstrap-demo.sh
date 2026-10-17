#!/usr/bin/env bash
# Alza il regtest, prepara Alice e Bob con l'asset DEMO e un canale RGB.
# Non crea invoice e non invia pagamenti.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WALLET="$ROOT/wallet"
ENV_FILE="$WALLET/native-data/regtest/wallet.env"
LOG_DIR="$WALLET/native-data/regtest"
COMPOSE=(docker compose -f "$ROOT/docker-compose.yml")
FUND_MIN_SAT=1000000

cli() {
  (
    cd "$WALLET"
    node --env-file=native-data/regtest/wallet.env --import tsx infra/regtest/cli.mjs "$@"
  )
}

field() {
  local label="$1"
  awk -v label="$label" '$1 == label { print $2; exit }'
}

demo_asset_id() {
  awk '$1 == "DEMO" { want = 1; next } want && $1 == "id" && $2 ~ /^rgb:/ { print $2; exit }'
}

issued_asset_id() {
  awk '$1 == "asset" && $2 ~ /^rgb:/ { print $2; exit }'
}

channel_usable() {
  local asset="$1"
  awk -v asset="$asset" '
    $1 == "asset" && $2 == asset { hit = 1; next }
    hit && $1 == "usable" { print $2; exit }
    hit && $1 == "id" { hit = 0 }
  '
}

ensure_newline() {
  [[ -s "$ENV_FILE" ]] || return 0
  local end
  end="$(tail -c 1 "$ENV_FILE"; printf x)"
  if [[ "$end" != $'\nx' ]]; then
    printf '\n' >> "$ENV_FILE"
  fi
}

ensure_password() {
  local key="$1"
  if grep -q "^${key}=" "$ENV_FILE"; then
    return 0
  fi
  ensure_newline
  printf '%s=%s\n' "$key" "$(openssl rand -hex 24)" >> "$ENV_FILE"
  echo "Aggiunta ${key} a wallet.env"
}

block_height() {
  "${COMPOSE[@]}" exec -T bitcoind bitcoin-cli -regtest -rpcuser=user -stdinrpcpass getblockcount <<EOF
$BITCOIND_RPC_PASSWORD
EOF
}

wait_http() {
  local url="$1"
  local attempt code
  for attempt in $(seq 1 60); do
    code="$(curl -s -o /dev/null -w '%{http_code}' -H 'origin: http://127.0.0.1:5173' "$url" || true)"
    if [[ "$code" == "200" ]]; then
      return 0
    fi
    sleep 2
  done
  echo "Timeout in attesa di ${url}" >&2
  return 1
}

port_open() {
  nc -z 127.0.0.1 "$1" >/dev/null 2>&1
}

node_status() {
  cli status "$1"
}

password_key() {
  case "$1" in
    alice) printf 'AIRGB_ALICE_PASSWORD' ;;
    bob) printf 'AIRGB_BOB_PASSWORD' ;;
    *) echo "Nodo sconosciuto: $1" >&2; return 1 ;;
  esac
}

ensure_node() {
  local name="$1"
  local status keystore state key
  key="$(password_key "$name")"
  status="$(node_status "$name")"
  keystore="$(printf '%s\n' "$status" | field keystore)"
  state="$(printf '%s\n' "$status" | field stato)"
  if [[ "$keystore" != "presente" ]]; then
    ensure_password "$key"
    echo "Creo il wallet ${name}"
    cli create "$name"
    status="$(node_status "$name")"
    state="$(printf '%s\n' "$status" | field stato)"
  else
    echo "Wallet ${name} già presente"
  fi
  if [[ "$state" != "ready" ]]; then
    if ! grep -q "^${key}=" "$ENV_FILE"; then
      echo "Wallet ${name} bloccato e manca ${key} in wallet.env. Aggiungi la password già usata, poi rilancia." >&2
      exit 1
    fi
    echo "Sblocco ${name}"
    cli unlock "$name"
  else
    echo "${name} già sbloccato"
  fi
}

fund_if_needed() {
  local name="$1"
  local status sat
  status="$(node_status "$name")"
  sat="$(printf '%s\n' "$status" | field btc)"
  if [[ -n "$sat" && "$sat" -ge "$FUND_MIN_SAT" ]]; then
    echo "${name} ha già ${sat} sat, salto fund"
    return 0
  fi
  echo "Finanzio ${name} con 0.02 BTC"
  cli fund "$name" 0.02
}

prepare_utxos() {
  local out
  out="$(cli utxos alice)"
  printf '%s\n' "$out"
  if printf '%s\n' "$out" | grep -q 'UTXO richiesti'; then
    echo "Confermo gli UTXO RGB"
    cli mine 1
  else
    echo "UTXO RGB di Alice già pronti"
  fi
}

ensure_demo_asset() {
  local status asset out
  status="$(node_status alice)"
  asset="$(printf '%s\n' "$status" | demo_asset_id)"
  if [[ "$asset" == rgb:* ]]; then
    echo "Asset DEMO già emesso: ${asset}" >&2
    printf '%s\n' "$asset"
    return 0
  fi
  echo "Emetto DEMO" >&2
  out="$(cli issue alice --ticker DEMO --name "Demo asset" --amount 1000)"
  printf '%s\n' "$out" >&2
  asset="$(printf '%s\n' "$out" | issued_asset_id)"
  if [[ "$asset" != rgb:* ]]; then
    echo "Emissione DEMO senza contract id" >&2
    return 1
  fi
  printf '%s\n' "$asset"
}

connect_alice() {
  local out
  if out="$(cli connect alice 2>&1)"; then
    printf '%s\n' "$out"
    return 0
  fi
  printf '%s\n' "$out" >&2
  if printf '%s\n' "$out" | grep -Eiq 'already|già|duplicate|AlreadyConnected|peer.*exist'; then
    echo "Alice è già collegata a Bob, continuo"
    return 0
  fi
  return 1
}

ensure_channel() {
  local asset="$1"
  local status usable
  status="$(node_status alice)"
  usable="$(printf '%s\n' "$status" | channel_usable "$asset")"
  if [[ "$usable" == "sì" || "$usable" == "si" ]]; then
    echo "Canale DEMO già usabile"
    return 0
  fi
  connect_alice
  echo "Apro il canale DEMO (200000 sat, 100 unità)"
  cli channel alice --capacity 200000 --asset "$asset" --amount 100
}

start_background() {
  local name="$1"
  local port="$2"
  shift 2
  local logfile="$LOG_DIR/${name}.log"
  local pidfile="$LOG_DIR/${name}.pid"
  if port_open "$port"; then
    echo "${name} già in ascolto su :${port}"
    return 0
  fi
  (
    cd "$WALLET"
    nohup "$@" >> "$logfile" 2>&1 &
    echo $! > "$pidfile"
  )
  echo "${name} avviato, log in ${logfile}"
}

main() {
  if [[ ! -d "$WALLET/node_modules" ]]; then
    echo "Installo le dipendenze"
    (cd "$WALLET" && npm ci --ignore-scripts)
  fi

  (cd "$WALLET" && node infra/regtest/setup.mjs)

  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
  export AIRGB_UID="$(id -u)" AIRGB_GID="$(id -g)"

  echo "Avvio i container"
  "${COMPOSE[@]}" up -d

  local attempt height
  height=""
  for attempt in $(seq 1 30); do
    if height="$(block_height 2>/dev/null | tr -dc '0-9')" && [[ -n "$height" ]]; then
      break
    fi
    sleep 2
  done
  if [[ -z "$height" ]]; then
    echo "bitcoind non risponde" >&2
    exit 1
  fi
  if [[ "$height" -lt 101 ]]; then
    echo "Inizializzo la chain (altezza ${height})"
    "$ROOT/scripts/regtest.sh" init-chain
  else
    echo "Chain già inizializzata (altezza ${height})"
  fi

  echo "Attendo Alice e Bob"
  wait_http "http://127.0.0.1:8787/api/session"
  wait_http "http://127.0.0.1:8788/api/session"

  ensure_node alice
  ensure_node bob
  fund_if_needed alice
  fund_if_needed bob
  prepare_utxos

  local asset
  asset="$(ensure_demo_asset)"
  ensure_channel "$asset"

  mkdir -p "$LOG_DIR"
  start_background ui 5173 npm run dev:ui
  if command -v qvac >/dev/null 2>&1 || [[ -x "$WALLET/node_modules/.bin/qvac" ]]; then
    start_background qvac 11434 npm run qvac:serve
  else
    echo "qvac non è nel PATH: salto npm run qvac:serve" >&2
  fi

  echo
  echo "DEMO pronto: ${asset}"
  echo "UI: http://127.0.0.1:5173"
  echo "Invoice e pagamenti si fanno dalla UI."
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
