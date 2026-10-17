# Storici sintetici per i 10 nodi

Queste fixture derivano dalla rete di `topology.json` e dal contratto
`TelemetryEpisode` descritto in
`docs/qvac/features-1-and-2-implementation.md`. Non leggono wallet, credenziali,
database o log reali e non eseguono pagamenti.

| File | Transazioni uniche | Riuscite | Fallite |
| --- | ---: | ---: | ---: |
| `history-0020.json` | 20 | 20 | 0 |
| `history-0100.json` | 100 | 84 | 16 |
| `history-0500.json` | 500 | 404 | 96 |
| `history-2000.json` | 2000 | 1604 | 396 |

I file sono cumulativi: i primi 20 record di ciascun file sono identici;
quello da 500 contiene i primi 100 record del precedente e cosi via.
Le osservazioni per nodo conservano la stessa proprieta. La topologia e la
regola di generazione restano uguali; riepiloghi e saldi finali dipendono dalla
lunghezza dello storico. Il primo campione rappresenta un avvio con pochi dati
positivi; le versioni successive aggiungono anche anomalie.

## Contenuto dei JSON

- `topology.nodes`: i 10 id e alias fittizi, con pubkey sintetiche valide per i
  controlli secp256k1. Nessuna chiave privata e stata generata o raccolta.
- `topology.channels`: gli stessi 15 collegamenti, capacita RGB e fee della
  topologia, con identificativi sintetici. Per lo storico si assume una fee
  inversa uguale a quella diretta.
- `knownNodes`: il formato `{ alias, pubkey }[]` gia utilizzato dalle API.
- `transactions`: pagamenti unici con istante, mittente, destinatario, importi,
  asset, algoritmo, budget, esito, fee pagate e tempi simulati. Ogni percorso
  contiene i nodi attraversati e gli importi e le fee di ciascun hop.
- `nodeHistories.<nodeId>`: osservazioni `incoming` e `outgoing`, ciascuna con
  riferimento alla transazione, indice della parte MPP e un oggetto `episode`
  che rispetta esattamente `TelemetryEpisode`.
- `initialChannelStates` e `finalChannelStates`: saldi direzionali BTC/RGB per
  verificare la riproduzione dello storico.
- `currentChannelsByNode`: snapshot dei canali nel formato `LiveChannelInput[]`,
  utilizzabile come input dello scoring insieme a `knownNodes`.
- `summary`: conteggi globali e per nodo, inclusi i pagamenti inoltrati.
- `privacyReview` e `provenance`: origine sintetica, verifiche effettuate e hash
  del file di topologia sorgente. `manifest.json` include anche hash e dimensioni
  dei quattro dataset.

Ogni nodo ha almeno un pagamento in entrata e uno in uscita gia nel file da 20.
I nodi intermedi sono descritti nei percorsi; le loro operazioni di forwarding
non vengono contate come nuovi pagamenti inviati o ricevuti.

Un pagamento MPP produce un episodio per parte, quindi il numero di episodi puo
superare quello delle transazioni. Un tentativo fallito genera solo osservazioni
in uscita: non si inventa una ricezione riuscita al destinatario. Per i tentativi
falliti le fee pagate sono zero, mentre le fee del percorso tentato restano in
`paths[].plannedFeeMsat`. I fallimenti simulati comprendono
`TemporaryChannelFailure`, `HTLCTimeout`, `InsufficientLiquidity` e
`FeeBudgetExceeded`.

## Saldi e isolamento

Lo storico ha uno stato iniziale proprio: la liquidita RGB e inizialmente
ripartita a meta fra i due lati dei canali, mentre la liquidita BTC segue le
percentuali dichiarate. Questo consente pagamenti in entrambe le direzioni.
Non equivale allo stato di bootstrap di `topology.json`, che finanzia un solo
lato. I pagamenti riusciti aggiornano saldi e fee in modo coerente; quelli
falliti non spostano liquidita. Le transazioni sono datate fra gennaio e febbraio
2026, prima del riferimento comune `asOf` del 1 ottobre 2026.

I dati sono destinati a test offline dello storico, della ricerca RAG e dello
scoring. Per usarli contro nodi live occorre rimappare pubkey, channel id e
contract id ai corrispondenti identificativi del runner. L'asset
`rgb:synthetic-route-test` e un segnaposto e non un contratto RGB utilizzabile.

Per confrontare le dimensioni usare uno store vuoto per ogni coppia
(dataset, nodo): importare piu versioni cumulative nello stesso store comporta
la deduplicazione degli episodi e non misura campioni indipendenti.

## Utilizzo con lo store esistente

La API demo attuale genera cinque episodi propri: non importa questi file.
Un futuro loader puo selezionare un nodo e passare i suoi episodi allo store.
Da `wallet/`, il nucleo dell'importazione locale e:

```js
import { readFile } from 'node:fs/promises';
import { QvacRagStore } from './apps/local-service/channel-scoring.ts';

const data = JSON.parse(await readFile(
  'tests/fixtures/routing-history/history-0100.json', 'utf8'
));
const nodeId = 'alice';
const store = new QvacRagStore('native-data/synthetic-history-0100-alice');
try {
  for (const entry of data.nodeHistories[nodeId]) {
    store.saveEpisodeLocal(entry.episode);
  }
} finally {
  store.close();
}
```

Per caricare successivamente anche il RAG QVAC, un loader puo usare
`await store.ingestEpisode(entry.episode)`. Tale operazione non viene eseguita
dal generatore o dai controlli delle fixture. Per lo scoring offline, associare
`data.currentChannelsByNode[nodeId]` e `data.knownNodes` allo stesso nodo.

## Controllo dei dati e privacy

Tutti i timestamp, importi, esiti, testi e identificativi sono costruiti dal
generatore. Dalla topologia vengono selezionati solo struttura dei collegamenti,
capacita, fee e alias fittizi. Non vengono copiati percorsi dei wallet, endpoint,
porte o variabili di ambiente.

Il controllo automatico rifiuta campi per credenziali, chiavi private,
mnemoniche, preimage, invoice, payment hash, txid, indirizzi, IP, email e telefoni.
Controlla inoltre l'assenza di indirizzi Bitcoin, invoice e URL nei valori.
Le pubkey dei nodi sono punti di curva costruiti da etichette di test, non
identita osservate sulla rete. La qualifica di dati sintetici dipende da questa
provenienza: non assume che uno storico reale o una pubkey reale siano privi di
informazioni correlabili a persone.

## Rigenerazione e verifica

Dalla root del repository, con Node 24.19.0:

```bash
export PATH="$PWD/wallet/native-data/node-v24.19.0/bin:$PATH"
node wallet/scripts/generate-routing-history.mjs
node wallet/scripts/generate-routing-history.mjs --check
```

`--check` ricostruisce i dati in memoria e confronta tutti gli artefatti senza
scriverli. Verifica riferimenti ai nodi e ai canali, prefissi cumulativi, importi
MPP, fee, conservazione e disponibilita dei saldi, osservazioni in entrata e
uscita e controlli sui campi sensibili.
