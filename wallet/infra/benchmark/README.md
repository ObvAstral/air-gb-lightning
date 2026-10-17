# Benchmark QVAC / RGB Lightning standard

Suite di **20 pagamenti reali regtest**, dichiarati in `scenarios.json`, sui nodi di
`topology.json`. Il runner si collega ai servizi locali esistenti: non avvia Docker,
non compila Rust, non crea wallet, non finanzia canali e non cancella dati.
I comandi seguenti sono istruzioni per il computer su cui si eseguirà il benchmark.

## Cosa viene misurato

Per ogni pagamento: modello e proposta QVAC, scelta finale dopo i guardrail,
algoritmo/pesi/limite MPP, hash e identificativo del pagamento, risultato di mittente
e destinatario, tempo della selezione, tempo invio–conferma, tempo complessivo,
fee **pagate** in msat, percorsi regolati con hop e canali, numero di parti, tentativi
falliti osservati, snapshot di tutti i nodi prima e dopo e intervalli dei log.
Il tempo complessivo include preparazione e snapshot, esclude la raccolta dei log
successiva alla conferma; quello invio–conferma include il polling a intervalli di 1 s.

Il QVAC esistente decide algoritmo e `max_paths`. La suite non contiene la risposta
attesa e non sostituisce la decisione con l'algoritmo migliore noto a priori.
`selectionSource=qvac_with_guardrails` distingue la risposta del modello dalla
successiva applicazione delle regole del selettore. Un timeout o JSON non valido
del selettore diventa errore del benchmark: il fallback deterministico non passa
come risultato AI. Lo storico iniziale dei nodi viene registrato nel manifest;
le fixture sintetiche attive sono rifiutate. Non vengono caricati dati sintetici.

La decisione usa i canali **live del mittente**, come il servizio attuale: non viene
consegnato a QVAC il saldo privato degli altri nodi. Gli snapshot completi servono
all'osservatore per audit e confronto e rimangono nei file locali.

## Copertura e ordine

| Casi | Stimolo |
| --- | --- |
| 01 | BTC diretto piccolo |
| 02–05 | RGB da 100/80 unità e ritorni da Judy verso Alice; MPP e liquidità inversa |
| 06 | 101 unità RGB, oltre i 100 iniziali consegnabili a Judy |
| 07–08 | 60 unità, limite iniziale del ramo maggiore, e ritorno |
| 09–10 | Preferenza per fee basse, più hop, ritorno degli asset |
| 11–15 | Minimo HTLC RGB, mittenti intermedi, rami e fee diverse, affidabilità |
| 16–17 | BTC multihop e BTC maggiore della capacità di un singolo canale |
| 18 | Preferenza privacy/singolo percorso fra Heidi e Ivan |
| 19–20 | Raggiungibilità BTC/RGB fra nodi periferici |

`topology.json` attualmente contiene 20 nodi e 15 canali nel grafo `channels`, tutti
fra Alice e Judy. Karl–Tara non hanno collegamenti in quel grafo. `demoMesh` e il
bootstrap possono invece costruire la stella DEMO. I due casi periferici evidenziano
questa differenza; il runner salva i collegamenti realmente presenti. Il nome di
una categoria descrive lo stimolo e non garantisce un risultato sullo stato live.
Per esercitare lo split 60+40 occorre avere realmente i canali e l'asset del grafo
`channels`; la sola presenza del file topology non li crea.

L'esecuzione è **sequenziale con saldi che evolvono**, non 20 esperimenti isolati.
Gli MPP precedono i piccoli invii che consumano liquidità; i ritorni tentano di
ripristinare gli asset, ma possono fallire e pagano fee. Nessun reset viene fatto
automaticamente. Confrontare lo stesso workload partendo dalla stessa liquidità;
le divergenze successive fanno parte del risultato della strategia complessiva.
Non interpretare una differenza tardiva come effetto isolato del solo algoritmo.

## Preparazione AIR-GB sul computer di esecuzione

1. Usare Node 24.19.0, installare le dipendenze e preparare i nodi regtest con
   wallet sbloccati e invii abilitati, come nella documentazione principale.
2. Ricompilare il daemon con `npm run native:build` **sul computer di esecuzione**,
   oppure ricostruire l'immagine Docker. Il manifest ora verifica anche la patch
   `infra/native/benchmark-telemetry.patch`: i vecchi artifact devono essere aggiornati.
3. Avviare i servizi con `AIRGB_BENCHMARK_EVENTS=1`. La patch osserva eventi LDK
   senza modificare routing o retry e scrive `.ldk/benchmark-events.jsonl`.
   Per Docker è disponibile un overlay che abilita la variabile su tutti i nodi:

   ```bash
   # Dalla root, dopo aver caricato wallet.env come nel normale avvio:
   docker compose -f docker-compose.yml -f docker-compose.topology.yml \
     -f wallet/infra/benchmark/compose.observations.yml up -d --build
   ```

4. Avviare QVAC e verificare che il servizio di ciascun mittente raggiunga il modello
   configurato. Il runner usa l'endpoint QVAC del servizio, inclusa la configurazione
   del bridge già prevista da questa repo.
5. Copiare `config.example.json` in un file locale, per esempio
   `wallet/native-data/benchmark-ai.json`, e impostare `assets.TEST` al vero contract
   ID. L'alias TEST è comune alle due esecuzioni; i contract ID possono essere diversi.

Le API AIR-GB sono ricavate da `topology.nodes[].apiPort`. Per servizi su host
specificare `logDirectories` con la directory **rgb-lightning-node**, ad esempio:

```json
{
  "label": "workstation-a",
  "assets": { "TEST": "rgb:CONTRACT_ID_REALE" },
  "logDirectories": {
    "alice": "/percorso/alice/rgb-lightning-node",
    "bob": "/percorso/bob/rgb-lightning-node"
  }
}
```

Completare la mappa per tutti i nodi su host. Se una directory manca, il collector
cerca il container di quel nodo con `docker compose ps -q`, quindi legge soltanto
log tramite `docker exec`. Si possono impostare `containers` (`id nodo → container`),
`composeFiles` e `containerLogRoot`. I container devono contenere Node, come le
immagini della repo; per container stock senza Node usare directory locali montate.
I percorsi di configurazione sono risolti dalla directory da cui viene lanciato il
comando. Non viene aggiunto alcun endpoint HTTP per scaricare i log.

## Esecuzione

Da `wallet/`, soltanto quando l'ambiente sarà pronto:

```bash
npm run benchmark:run -- --mode ai \
  --config native-data/benchmark-ai.json --out native-data/benchmarks/ai-01
```

La directory `--out` deve essere nuova. Nessun invio viene ripetuto automaticamente.
Anche se la risposta HTTP all'invio si perde, il runner riconcilia il pagamento
tramite hash/intento. Un timeout è `timeout_unknown`, non un fallimento certo:
il run si interrompe per non propagare uno stato incerto ai pagamenti successivi.
SIGINT/SIGTERM fermano i nuovi invii e conservano quanto già raccolto; non annullano
HTLC eventualmente in volo. Un `failed` confermato permette di continuare.

Exit code 1 indica run incompleto, errore infrastrutturale, log mancanti, baseline
invalida o pagamento riuscito con misure incomplete. Un pagamento fallito confermato
è un risultato del benchmark e non, da solo, un errore del runner.

## Repo standard, senza MPP né algoritmi alternativi

L'adapter `createStockAdapter` in `adapters.mjs` usa REST RGB Lightning:
`nodeinfo`, `networkinfo`, `listchannels`, `lninvoice`, `decodelninvoice`,
`sendpayment`, `getpayment`, `invoicestatus`. **Non invia il campo `routing`** e non
usa il daemon modificato come sostituto della baseline. L'altra repo non è stata
fornita: la compatibilità delle sue versioni REST va verificata sul computer di esecuzione.

Configurare in un secondo JSON:

- `nodes`: tutti gli alias di topology, con `url` della API **nativa** standard,
  non la porta del servizio AIR-GB. Esempio: `"alice": {"url":"http://127.0.0.1:39001"}`.
- `assets.TEST`: il contract ID corrispondente nella baseline.
- `logDirectories` o `containers`: i log dei nodi della baseline, non quelli AIR-GB.
- `baseline.repositoryCommit`: commit reale completo (40 caratteri esadecimali).
- `baseline.mpp: false` e `baseline.routing: "stock"`: dichiarazione del deployment
  da verificare nella configurazione dell'altra repo, non una disattivazione remota.
- `label`: stessa macchina/condizioni del run AI per confrontare anche le latenze.
- Se serve autenticazione nativa, `nodes.<id>.authorizationEnv` indica il nome di
  una variabile contenente l'intero header Authorization. Nessun token finisce nel manifest.

Le fee standard sono lette dal messaggio nativo `PaymentSent` (`successfully sent
payment ... (fee N msat) ... payment hash HASH`). Per gli hop, se mancano eventi
strutturati, la suite tenta una ricostruzione del percorso singolo dai saldi prima
e dopo: richiede un'unica catena senza rami, importi concordanti sui due estremi di
ogni canale e addebito del mittente uguale a importo più fee del log. In RGB verifica
anche gli spostamenti delle unità asset. È necessario **non eseguire altro traffico**
sui nodi durante il benchmark. Campi mancanti, rami o differenze non spiegabili
lasciano le misure incomplete. Questa fonte è etichettata nel risultato; non prova
il numero di HTLC/shard né i tentativi falliti, che rimangono `null`.

Per versioni con API diverse si può fornire `--adapter /percorso/adapter.mjs`:
la funzione esportata `createAdapter({topology, config, output, mode, runId})`
restituisce lo stesso contratto degli adapter inclusi. Il metodo opzionale
`observations(case, handle)` può importare eventi effettivi da un osservatore
esterno; il formato è quello di `.ldk/benchmark-events.jsonl`. Non fornire percorsi
pianificati come `path_succeeded`. Per la modalità AI è richiesto anche `history()`.

```bash
npm run benchmark:run -- --mode baseline \
  --config native-data/benchmark-stock.json --out native-data/benchmarks/stock-01

npm run benchmark:compare -- \
  --ai native-data/benchmarks/ai-01 \
  --baseline native-data/benchmarks/stock-01 \
  --out native-data/benchmarks/comparison-01.json
```

## Output e lettura del confronto

```text
RUN/
  manifest.json                versioni, hash, stato iniziale, storico AI, esito run
  suite.json, topology.json    input esatti
  results.jsonl               un record completo per ciascun caso eseguito
  events.jsonl, summary.json   avanzamento e riepilogo
  initial-state.json
  transactions/CASE/
    decision.json             proposta modello e scelta effettiva
    before.json, after.json   stato di tutti i nodi
    settled-state.json        quando usato per ricostruzione della baseline
    status.jsonl, result.json
  nodes/NODE/
    transactions.jsonl        ruolo e offset dei log per ogni pagamento
    daemon.log, logs/..., .ldk/logs/..., .ldk/benchmark-events.jsonl
```

Il confronto produce JSON e CSV. Verifica versione, stessi 20 casi, hash degli
scenari e della topologia, snapshot iniziale normalizzato per alias e liquidità,
timeout, completezza dei run e log. Identità delle chiavi, contract ID e channel ID
possono cambiare fra le due repo. Le fee pubblicate dei canali non sono esposte
nello snapshot delle API attuali: **devono essere configurate identiche a parte**;
questa condizione è riportata in `unverifiedControls`. Anche commit della baseline
e assenza MPP sono dichiarazioni di deployment, non attestazioni del binario remoto.

Le differenze sono **AI meno baseline**: fee, hop e tempi negativi indicano una
riduzione. Il tasso di successo usa tutti i 20 casi; il confronto dei costi usa
soltanto i casi riusciti in entrambe le esecuzioni e indica il numero di campioni.
Non vengono trasformati fallimenti o valori mancanti in fee zero. La latenza è
segnalata come confrontabile solo con label identiche e non nulle. Un unico run
non dimostra significatività statistica: usare più repliche ripristinando lo stato
iniziale e alternando l'ordine AI/baseline. I log sono locali e privati (directory
0700, file 0600); i log nativi possono contenere informazioni sensibili di regtest.

I controlli puri del formato, aggregazione e confronto sono in `benchmark.test.mjs`
e si potranno eseguire con `npm run benchmark:unit`. Non avviano nodi o QVAC.
