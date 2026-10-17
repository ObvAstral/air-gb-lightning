#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/wallet/native-data/regtest/wallet.env"
COMPOSE=(docker compose -f "$ROOT/docker-compose.yml")

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

reset_regtest() {
  echo "Arresto i container e cancello chain, indice, wallet Alice/Bob (MPP e UTEXO), emittente e wallet.env."
  if [[ -z "${BITCOIND_RPC_PASSWORD:-}" ]]; then
    export BITCOIND_RPC_PASSWORD=reset
  fi
  "${COMPOSE[@]}" down --remove-orphans -v
  docker volume rm -f \
    airgb-regtest_bitcoin-data \
    airgb-regtest_electrs-data \
    airgb-regtest_alice-data \
    airgb-regtest_bob-data \
    airgb-regtest_alice-mpp-data \
    airgb-regtest_bob-mpp-data \
    airgb-regtest_carol-topology-data \
    airgb-regtest_dave-topology-data \
    airgb-regtest_erin-topology-data \
    airgb-regtest_frank-topology-data \
    airgb-regtest_grace-topology-data \
    airgb-regtest_heidi-topology-data \
    airgb-regtest_ivan-topology-data \
    airgb-regtest_judy-topology-data \
    airgb-regtest_karl-topology-data \
    airgb-regtest_leo-topology-data \
    airgb-regtest_mia-topology-data \
    airgb-regtest_nico-topology-data \
    airgb-regtest_olive-topology-data \
    airgb-regtest_paul-topology-data \
    airgb-regtest_quinn-topology-data \
    airgb-regtest_ruth-topology-data \
    airgb-regtest_saul-topology-data \
    airgb-regtest_tara-topology-data \
    airgb-regtest_user-wallet-data
  rm -rf \
    "$ROOT/wallet/native-data/regtest" \
    "$ROOT/wallet/native-data/wallet" \
    "$ROOT/wallet/native-data/peer-wallet" \
    "$ROOT/wallet/native-data/user-wallet" \
    "$ROOT/wallet/native-data"/e2e-mpp-*
  echo "Reset completato. Apri una shell nuova, poi da wallet/: node infra/regtest/setup.mjs"
}

if [[ "${1:-}" != "reset" && -z "${BITCOIND_RPC_PASSWORD:-}" ]]; then
  echo "Manca BITCOIND_RPC_PASSWORD. Da wallet/: node infra/regtest/setup.mjs" >&2
  exit 1
fi

btc() {
  "${COMPOSE[@]}" exec -T bitcoind bitcoin-cli -regtest -rpcuser=user -stdinrpcpass "$@" <<EOF
$BITCOIND_RPC_PASSWORD
EOF
}

miner_address() {
  btc -rpcwallet=miner getnewaddress
}

ensure_miner() {
  local wallets dir
  wallets="$(btc listwallets)"
  if printf '%s\n' "$wallets" | grep -q '"miner"'; then
    return 0
  fi
  dir="$(btc listwalletdir)"
  if printf '%s\n' "$dir" | grep -q '"name": "miner"'; then
    btc -named loadwallet filename=miner load_on_startup=true >/dev/null
    return 0
  fi
  btc -named createwallet wallet_name=miner load_on_startup=true >/dev/null
}

mine() {
  local blocks="${1:-1}"
  local address
  address="$(miner_address)"
  btc -rpcwallet=miner generatetoaddress "$blocks" "$address" >/dev/null
  btc getblockcount
}

init_chain() {
  ensure_miner
  mine 101
}

fund() {
  local address="${1:?address}"
  local amount="${2:?btc}"
  ensure_miner
  btc -rpcwallet=miner sendtoaddress "$address" "$amount"
  mine 1 >/dev/null
}

case "${1:-}" in
  init-chain) init_chain ;;
  mine) mine "${2:-1}" ;;
  fund) fund "${2:-}" "${3:-}" ;;
  reset) reset_regtest ;;
  *)
    echo "Uso: $0 init-chain | mine [blocchi] | fund <address> <btc> | reset" >&2
    exit 1
    ;;
esac
