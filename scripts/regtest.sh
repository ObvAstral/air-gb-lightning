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

if [[ -z "${BITCOIND_RPC_PASSWORD:-}" ]]; then
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
  *)
    echo "Uso: $0 init-chain | mine [blocchi] | fund <address> <btc>" >&2
    exit 1
    ;;
esac
