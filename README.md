# AIR-GB Lightning

Regtest locale con bitcoind, electrs, proxy RGB e due nodi Lightning (Alice e Bob).
Il backend Lightning usa le fork personali di ObvAstral con supporto RGB MPP:

- [`rgb-lightning-node`, `feat/rgb-mpp`](https://github.com/ObvAstral/rgb-lightning-node/tree/feat/rgb-mpp), commit `dbee4aabd519917f604911832828775d8da10e00`.
- [`rust-lightning`, `feat/rgb-mpp`](https://github.com/ObvAstral/rust-lightning/tree/feat/rgb-mpp), commit `02dc5d2aac909ce6747597cb3346b126a5617f9d`.

I commit, la toolchain e l'hash del `Cargo.lock` sono fissati in
[`wallet/infra/native/source-lock.json`](wallet/infra/native/source-lock.json).
La build scarica entrambe le fork via HTTPS, seleziona esplicitamente il commit
LDK e compila con `--locked`. Non segue il branch `rgb` né l'URL SSH presenti nel
`.gitmodules` della fork. Per aggiornare le fork, aggiornare questo file e usare
una directory di build pulita in `wallet/native-data/runtime/source`.

Il servizio Node avvia un daemon RLN per wallet e traduce le sue API REST per
la UI e la CLI. L'addon Lightning UTEXO e il signer esterno VLS sono stati
sostituiti. Una patch locale limita l'API REST interna a `127.0.0.1` e richiede
un token privato generato dal servizio per ogni daemon; l'unica
porta del daemon esposta dai container è quella Lightning P2P. Il manifest
`wallet/native-data/runtime/bin/build.json` verifica sorgenti, patch, piattaforma
e hash del binario, anche all'avvio. Lo splitting MPP è gestito dal daemon.

## Requisiti

- Node `24.19.0` e npm.
- Docker con Compose.
- Per i nodi sull'host: GnuPG, Git, rustup, toolchain Rust `1.94.0`, compilatore
  C/C++, pkg-config, OpenSSL, CMake e Clang/libclang.

La prima build compila Rust e può richiedere alcune decine di minuti e qualche gigabyte
di RAM. Nel container vengono installati anche compilatore e toolchain.

## Dati precedenti

Compose usa i nuovi volumi `alice-mpp-data` e `bob-mpp-data`, mantenendo separati
i precedenti `alice-data` e `bob-data`. Le vecchie password, identità, chiavi e i
canali UTEXO non vengono migrati: i nuovi wallet vanno creati e finanziati.
Non eseguire `docker compose down -v` per passare alla fork.

Sull'host, scegliere una nuova `AIRGB_DATA_DIR` se contiene già dati UTEXO.
Il servizio rifiuta di aprire una directory con stato `wdk-rgb-lightning`
esistente. Conservare quel contenuto e il vecchio backend per il recupero.
La sola mnemonic non ricostruisce canali e stato RGB.

## Avvio

```bash
cd wallet
npm ci --ignore-scripts
node infra/regtest/setup.mjs
set -a && source native-data/regtest/wallet.env && set +a
export AIRGB_UID="$(id -u)" AIRGB_GID="$(id -g)"
cd ..
docker compose up -d --build
./scripts/regtest.sh init-chain
cd wallet && npm run dev:ui
```

UI su `http://127.0.0.1:5173`. Alice è `127.0.0.1:8787`, Bob è
`127.0.0.1:8788`. I daemon vengono avviati allo sblocco dei wallet e arrestati
insieme al servizio; i log sono in `rgb-lightning-node/daemon.log` nella
directory di ciascun wallet. Un arresto anomalo conserva il file `.owner`:
verificare prima che il daemon sia terminato e lo stato sia integro.

Da `wallet/`, la CLI può emettere direttamente un NIA sul nodo della fork:

```bash
npm run cli -- create alice
npm run cli -- create bob
npm run cli -- unlock alice
npm run cli -- unlock bob
npm run cli -- fund alice 0.02
npm run cli -- fund bob 0.02
npm run cli -- utxos alice
npm run cli -- mine 1
npm run cli -- issue alice --ticker DEMO --name "Demo asset" --amount 1000
npm run cli -- connect alice
npm run cli -- channel alice --capacity 200000 --asset rgb:... --amount 100
npm run cli -- invoice bob --asset rgb:... --amount 10
npm run cli -- pay alice --invoice lnbcrt...
```

Password in `AIRGB_ALICE_PASSWORD` e `AIRGB_BOB_PASSWORD`, oppure al prompt.
`channel` attende la transazione di funding, mina e verifica il canale.
`mine` mina a gruppi di 6 fino a 100 blocchi. La UI espone le stesse operazioni.
L'emittente on-chain opzionale (`issuer`, `send --from issuer`) conserva
`@utexo/wdk-wallet-rgb` e `AIRGB_ISSUER_PASSWORD`; questa libreria non gestisce
i nodi Lightning e richiede Node `24.19.0`.

Per eseguire i nodi sull'host, senza i container Alice/Bob:

```bash
cd wallet
npm run dev:regtest
# Seconda shell:
npm run dev:peer
```

## Test

Da `wallet/`:

```bash
npm test
npm run typecheck
npm run build
node --import tsx infra/regtest/smoke-api.mjs
npm run native:build
node --env-file=native-data/regtest/wallet.env --import tsx infra/regtest/smoke-service.mjs
node --env-file=native-data/regtest/wallet.env --import tsx infra/regtest/e2e-lightning.mjs
npm run test:mpp
```

I test regtest richiedono bitcoind, electrs e proxy già avviati e `init-chain`
eseguito. `test:mpp` avvia quattro daemon su porte P2P `9765–9768`, emette
un NIA con la fork e costruisce due percorsi Alice → Bob → Dave e Alice →
Carol → Dave con liquidità RGB rispettivamente 60 e 40. Paga una invoice da
100 unità, che richiede entrambi i percorsi, e controlla il successo su mittente
e destinatario e gli otto saldi dei quattro canali. Ogni esecuzione conserva
dati e password in una nuova directory `native-data/e2e-mpp-*`.

`npm run test:rgb` mantiene il test d'interoperabilità con l'emittente on-chain
WDK. Se necessario scarica Node `24.19.0` in `native-data/` e ricompila il suo
addon `rgb-lib`, correggendo il wrapper per le API V8 di Node 24. Richiede Python,
make e un compilatore C++ sull'host. `npm ci --ignore-scripts` conserva i sorgenti
di questo addon opzionale per la compilazione esplicita; i nodi Lightning usano
il daemon Rust e non richiedono l'addon. Non sostituisce il test MPP.

Il supporto MPP non implica supporto ai vincoli di routing dell'anteprima:
budget fee ed esclusioni restano disabilitati finché non verificati nel backend.

## QVAC

```bash
cd wallet
npm run qvac:doctor
npm run qvac:precache
npm run qvac:serve
npm run qvac:smoke
```

L'interpretazione nella UI parla con Alice sulle porte `5173` e `8787`.
