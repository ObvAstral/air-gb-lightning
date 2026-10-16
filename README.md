# AIR-GB Lightning

Regtest locale: un bitcoind, electrs, il proxy RGB, e due nodi Lightning (Alice e Bob) che emettono un NIA e se lo scambiano su un canale.

## Requisiti

- Node `24.19.0`
- Docker
- GnuPG, solo se lanci i nodi sull'host invece che nei container

La prima build dell'immagine compila l'addon nativo con Rust `1.88.0`. Servono diversi minuti e qualche gigabyte di RAM per Docker.

## Avvio

```bash
cd wallet
node infra/regtest/setup.mjs
set -a && source native-data/regtest/wallet.env && set +a
export AIRGB_UID="$(id -u)" AIRGB_GID="$(id -g)"
cd ..
docker compose up -d --build
./scripts/regtest.sh init-chain
cd wallet && npm run dev:ui
```

UI su `http://127.0.0.1:5173`. Alice è `127.0.0.1:8787`, Bob è `127.0.0.1:8788`.

La CLI, da `wallet/`, fa le stesse operazioni e dopo ognuna stampa nodo, saldi, contract id, ticker, nome e canali. L'emissione NIA resta sull'emittente on-chain: i nodi Lightning la rifiutano finché usano il signer esterno. `channel` aspetta il `fundingTxid` esposto dal servizio, quindi l'immagine dei nodi va costruita da questo codice.

```bash
cd wallet
npm run cli -- issuer create
npm run cli -- fund issuer 0.02
npm run cli -- issuer utxos
npm run cli -- issuer issue --ticker DEMO --name "Demo asset" --amount 1000
npm run cli -- create alice
npm run cli -- create bob
npm run cli -- unlock alice
npm run cli -- unlock bob
npm run cli -- fund alice 0.02
npm run cli -- fund bob 0.02
npm run cli -- utxos alice
npm run cli -- mine 1
npm run cli -- send --from issuer --to alice --asset rgb:... --amount 800
npm run cli -- connect alice
npm run cli -- channel alice --capacity 200000 --asset rgb:... --amount 100
npm run cli -- invoice bob --asset rgb:... --amount 10
npm run cli -- pay alice --invoice lnbcrt...
```

Password in `AIRGB_ALICE_PASSWORD`, `AIRGB_BOB_PASSWORD`, `AIRGB_ISSUER_PASSWORD`, oppure al prompt. L'emittente vuole Node `24.19.0`: se il Node corrente è un altro, la CLI rilancia il binario scaricato da `npm run test:rgb`.

`npm run cli -- mine` mina a gruppi di 6, fino a 100 blocchi. `./scripts/regtest.sh mine` resta disponibile. Lo stesso pulsante è nella UI, sul wallet `miner`.

## Test

Da `wallet/`:

```bash
npm test
node --import tsx infra/regtest/smoke-api.mjs
```

`npm run test:rgb` emette il NIA con `@utexo/wdk-wallet-rgb` (wallet on-chain, `dataDir` separato) e lo consegna ad Alice con una invoice `rgb:`. Poi Alice apre il canale e paga Bob in Lightning. Il nodo Lightning continua a rifiutare `issueNia` perché usa il signer esterno. `rgb-lib` non compila su Node 26: se il Node corrente non è `24.19.0`, lo script scarica quel binario in `native-data/` e rilancia il test. Vuole la chain già inizializzata (`init-chain`) e non sostituisce `npm test`.

I nodi sull'host, senza i container Alice/Bob, restano `npm run dev:regtest` e `npm run dev:peer`.

## QVAC

Gli script restano nel workspace `wallet/`:

```bash
npm run qvac:doctor
npm run qvac:precache
npm run qvac:serve
npm run qvac:smoke
```

La sezione di interpretazione nella UI parla con Alice sulle porte `5173` e `8787`.