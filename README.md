# AIR-GB Lightning

**AIR-GB Lightning** is a full-stack development, orchestration, and benchmarking environment for issuing and transferring **RGB smart-contract assets** over the **Bitcoin Lightning Network** with native **Multi-Path Payment (MPP)** support and **local QVAC AI routing optimization**.

It integrates Bitcoin Core (`bitcoind`), an Electrum indexer (`electrs`), an RGB proxy, a Node.js orchestration service, an interactive React web UI, a CLI, and custom Rust Lightning daemon forks (`rgb-lightning-node` and `rust-lightning`):

- [`rgb-lightning-node`, `feat/rgb-mpp`](https://github.com/ObvAstral/rgb-lightning-node/tree/feat/rgb-mpp), commit `7106edd0fa3dd0a8bc0f35e54cefac844495a068`.
- [`rust-lightning`, `feat/rgb-mpp`](https://github.com/ObvAstral/rust-lightning/tree/feat/rgb-mpp), commit `2f19847fc65a16294abcc26188ba8443804662be`.

> **Deep-Dive Technical Documentation**:
> - [**Architecture, Native RGB MPP Implementation & 20-Node Benchmark Evaluation (`docs/ARCHITECTURE_AND_BENCHMARK.md`)**](docs/ARCHITECTURE_AND_BENCHMARK.md)
> - [**QVAC AI Features 1, 2 & 3 Specification & API Contracts (`docs/qvac/features-1-and-2-implementation.md`)**](docs/qvac/features-1-and-2-implementation.md)
> - [**20-Payment Regtest Benchmark Runner Guide (`wallet/infra/benchmark/README.md`)**](wallet/infra/benchmark/README.md)

---

## Architecture & AI-Driven Multi-Path Routing

Standard `rgb-lightning-node` deployments route RGB assets along a single channel path (`max_path_count = 1`) using static Dijkstra pathfinding. When liquidity is split across parallel channels, transfers larger than a single channel fail and liquidity gets stranded at leaf nodes.

**AIR-GB Lightning** combines **local QVAC AI inference** (`Qwen3.5-0.8B` + `TurboVec` RAG over node-scoped SQLite telemetry), **deterministic physical liquidity guardrails**, and **four native Rust graph planners** (`min_cost_flow`, `multi_objective`, `yen`, and `ldk_dijkstra`):

![Routing Architecture Pipeline](docs/assets/architecture-pipeline.svg)

### Core Capabilities

1. **Natural Language Constraint Compilation (`interpret.ts` $\rightarrow$ `compile.ts`)**: Translates plain-language payment preferences (maximum fee budgets, node alias exclusions, fee vs. reliability priority, or single-path privacy requests) into a cryptographically fingerprinted `CompiledPolicy`.
2. **First-Party RAG Channel Scoring (`channel-scoring.ts`)**: Queries the node's own historical payment telemetry indexed in **QVAC TurboVec** (`/v1/vector_stores`) to classify local channels (`optimal`, `good`, `congested`, `unreliable`, `insufficient_liquidity`, `avoid`) and tune `ObjectiveWeights`. Deterministic physical balance guards prevent the LLM from hallucinating liquidity failures on valid partial MPP channels.
3. **Dynamic Strategy & MPP Selection (`routing-selector.ts`)**: Evaluates single-path vs. multi-path feasibility in an ephemeral RAM context (`EphemeralRoutingContext`, wiped immediately after selection). Automatically engages **`min_cost_flow`** when an RGB transfer requires splitting across multiple channels, or **`multi_objective`** / **`yen`** / **`ldk_dijkstra`** for single-corridor optimization.
4. **Native 4-Layer RGB Multi-Path Payments (`routes.rs` & `channel.rs`)**:
   - Decomposes RGB flows via successive shortest augmenting paths (`MinCostFlow`) and allocates the Bitcoin carrier (`>= 3,000,000` msat per HTLC) proportionally across shards.
   - Aggregates multi-part BTC + RGB shards atomically at the recipient (`InboundPayment`) before releasing the preimage.
   - Fixes upstream `rust-lightning` multi-HTLC commitment coloring (`color_commitment`) by reserving in-flight RGB liquidity (`available_outbound_rgb` / `available_inbound_rgb`) and computing exact claimed-preimage RGB deltas.

---

## Benchmark Summary: AIR-GB vs. Stock Single-Path RGB Lightning

We evaluated AIR-GB against stock single-path `rgb-lightning-node` across 20 sequential live regtest scenarios on a 20-node, 15-channel topology (`topology-mpp.json`), starting from the exact same normalized channel state hash (`fc59bc78...8b45`):

![Sequential Regtest Benchmark Results](docs/assets/benchmark-results.svg)

| Metric | Stock Baseline (No AI, Single-Path) | AIR-GB (QVAC AI + Native MPP) | Improvement |
| :--- | :---: | :---: | :---: |
| **Overall Success Rate (20 Scenarios)** | `7 / 20` (**35.0%**) | `13 / 20` (**65.0%**) | **+30.0 pp (+85.7% more payments)** |
| **Feasible Scenario Success Rate (16 Reachable)** | `7 / 16` (**43.75%**) | `13 / 16` (**81.25%**) | **+37.5 pp** |
| **Multi-Path RGB Splits (`02`, `03`, `04`)** | `0 / 3` | **`3 / 3` (`100%`)** | Unlocks `100` RGB (`60+40`) & `80` RGB (`40+40`) splits |
| **Return Rebalance Flows (`Judy -> Alice`)** | `0 / 3` (`0` RGB returned) | **`3 / 3` (`190` RGB returned)** | Prevents liquidity stranding at leaf nodes |
| **Routing Fees on Matched Successes** | `5,700` msat | **`1,200` msat** | **-78.95% routing fees paid** |
| **On-Node Rust Planner Execution Time** | Built-in Dijkstra | **`0.66 – 1.35` ms** | Sub-millisecond graph optimization |

For the full 20-scenario breakdown, topology design (`topology.json` vs. `topology-mpp.json`), and protocol fixes, see [**`docs/ARCHITECTURE_AND_BENCHMARK.md`**](docs/ARCHITECTURE_AND_BENCHMARK.md).

---

## Native Build & Security Model

Commits, toolchain, and the `Cargo.lock` hash are pinned in
[`wallet/infra/native/source-lock.json`](wallet/infra/native/source-lock.json).
The build downloads both forks over HTTPS, explicitly selects the LDK commit,
and compiles with `--locked`. It does not follow the `rgb` branch or the SSH URL present in
the fork's `.gitmodules`. To update the forks, update this file and use a clean build
directory in `wallet/native-data/runtime/source`.

The Node service starts an RLN daemon per wallet and translates its REST APIs for
the UI and CLI. The UTEXO Lightning addon and external VLS signer have been
replaced. A local patch restricts the internal REST API to `127.0.0.1` and requires
a private token generated by the service for each daemon; the only
daemon port exposed by the containers is the Lightning P2P port. The
`wallet/native-data/runtime/bin/build.json` manifest verifies sources, patches, platform,
and binary hash, including at startup. MPP splitting is handled by the daemon.

## Requirements

- Node `24.19.0` and npm.
- Docker with Compose.
- For nodes on the host: GnuPG, Git, rustup, Rust toolchain `1.94.0`, C/C++ compiler,
  pkg-config, OpenSSL, CMake, and Clang/libclang.

The initial build compiles Rust and can take several dozen minutes and a few gigabytes
of RAM. The compiler and toolchain are also installed inside the container.

## Previous Data

Compose uses the new `alice-mpp-data` and `bob-mpp-data` volumes, keeping them separate
from the previous `alice-data` and `bob-data`. Old passwords, identities, keys, and
UTEXO channels are not migrated: new wallets must be created and funded.
`./scripts/regtest.sh reset` deletes both pairs, together with the chain and `wallet.env`.

On the host, choose a new `AIRGB_DATA_DIR` if it already contains UTEXO data.
The service refuses to open a directory with existing `wdk-rgb-lightning` state.
Keep that content and the old backend for recovery.
The mnemonic alone does not reconstruct channels and RGB state.

## Startup

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

`./scripts/bootstrap-demo.sh` from the repository root does this startup, then creates and unlocks Alice and Bob, funds them, issues the DEMO asset, and opens the RGB channel. It does not create invoices or send payments; those stay in the UI at `http://127.0.0.1:5173`. The script also starts the UI and `qvac:serve` when ports `5173` and `11434` are free. A second run skips steps that are already done.

UI at `http://127.0.0.1:5173`. The topology nodes listen on the API and P2P ports in `topology.json` (`8801`/`9801` for Alice through `8810`/`9810` for Judy). Bob is `127.0.0.1:8802`.
Daemons start when a wallet is unlocked and stop together with the service; logs are in `rgb-lightning-node/daemon.log` in
each wallet's directory. An abnormal shutdown preserves the `.owner` file:
verify first that the daemon has terminated and the state is intact.

From `wallet/`, the CLI issues a NIA on the fork node and moves it over Lightning.
Replace `rgb:...` and `lnbcrt...` with the asset id and the `invoice` line just printed, not the on-chain address.
Passwords come from `AIRGB_ALICE_PASSWORD` and `AIRGB_BOB_PASSWORD`, or from the prompt.
The UI exposes the same operations.

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
npm run cli -- pay alice --invoice lnbcrt... --algorithm ldk_dijkstra
```

- `create` creates the wallet and prints the mnemonic once.
- `unlock` unlocks the wallet and starts the daemon.
- `fund` sends BTC from the miner and mines one block.
- `utxos` prepares RGB UTXOs; the next block confirms them.
- `mine` mines up to 100 blocks, in batches of 6, and syncs the nodes.
- `issue` issues a NIA and prints its `rgb:` id.
- `connect` opens the Lightning connection to the other node.
- `channel` opens the channel, waits for the funding transaction, mines, and checks that it is usable.
- `invoice` creates a Lightning invoice to receive the asset.
- `pay` pays that invoice. `--algorithm` is required: `ldk_dijkstra`, `yen`, `min_cost_flow`, or `multi_objective`.
- `status` prints state, balance, assets, and channels. `sync` realigns the chain and RGB transfers.

For `multi_objective`, also pass `--weights '{"fee":1,"reliability":2,"cltv":1,"hops":10}'`.
Each weight is an integer from 0 to 1000000 and at least one must be positive.
The other planners are experimental and may fail where another algorithm succeeds;
the selected algorithm is never changed automatically.

`POST /api/payments/prepare` requires `routing`, for example
`{"id":"payment-0001","invoice":"lnbcrt...","routing":{"algorithm":"yen"}}`.
For `multi_objective`, include `weights` inside `routing`. The selected algorithm
and weights are saved with the intent and cannot be changed for the same ID.
Existing intents retain the previous daemon's `ldk_dijkstra` selection.

The optional on-chain issuer (`issuer`, `send --from issuer`) retains
`@utexo/wdk-wallet-rgb` and `AIRGB_ISSUER_PASSWORD`; this library does not manage
Lightning nodes and requires Node `24.19.0`.

To run the nodes on the host, without the Alice/Bob containers:

```bash
cd wallet
npm run dev:regtest
# Second shell:
npm run dev:peer
```

Both services use the single UI at `http://127.0.0.1:5173`; `dev:peer` starts
only Bob's API on port `8788`. In each shell, make sure `node --version` is
`v24.19.0`. If the local runtime is already present, from `wallet/` use:

```bash
export PATH="$PWD/native-data/node-v24.19.0/bin:$PATH"
```

For the host setup, start the dependencies from the repository root with
`docker compose --env-file wallet/native-data/regtest/wallet.env up -d bitcoind electrs proxy`.
Run `./scripts/regtest.sh init-chain` on the first startup only. To enable
regtest payments, export `ENABLE_REGTEST_SEND=1` before starting each host service.
For AI interpretation, start `npm run qvac:serve` in a separate shell and export
`QVAC_MODEL=my-llm` before starting Alice.

## Reset

```bash
./scripts/regtest.sh reset
```

Stops the containers and deletes the chain, the Electrs index, every Alice and Bob
volume (`alice-data`, `bob-data`, `alice-mpp-data`, `bob-mpp-data`), the on-chain
issuer, the host wallet directories, and `wallet.env`.
The node image stays, so the next startup does not recompile Rust.
`reset` also deletes the `user-wallet-data` volume and `wallet/native-data/user-wallet`.
Open a new shell so exported passwords and `BITCOIND_RPC_PASSWORD` are gone,
then repeat Startup from `node infra/regtest/setup.mjs`.

The user wallet is a third container, `user`, image `airgb-regtest-user`.
It does not compile the fork. The image only installs Node, GnuPG, and the Linux
build of `@utexo/wdk-rgb-lightning`. `docker compose up -d` builds it once;
later starts reuse the image. It listens on `http://127.0.0.1:8789` and announces
`user:9739` on the Compose network, so Alice and Bob can open a channel to it.
Payments from this wallet do not take `--algorithm`. MPP planners stay on Alice and Bob.

To run the same wallet on the host instead of the container:

```bash
bash node_modules/@utexo/rgb-lightning-node-nodejs/scripts/download-libs.sh
npm run dev:user
```

## Testing

From `wallet/`:

```bash
npm test
npm run test:fixtures
npm run typecheck
npm run build
node --import tsx infra/regtest/smoke-api.mjs
npm run native:build
node --env-file=native-data/regtest/wallet.env --import tsx infra/regtest/smoke-service.mjs
node --env-file=native-data/regtest/wallet.env --import tsx infra/regtest/e2e-lightning.mjs
npm run test:mpp
```

The default suite loads `topology.json` and all four synthetic history datasets.
`test:fixtures` runs their integrity, storage, scoring and payment-policy contract
tests. See [fixture coverage and live QVAC commands](wallet/tests/fixtures/routing-history/README.md#suite-automatica-collegata-ai-json)
for the exact boundary between mocked services, reference-route checks and live tests.

Regtest tests require bitcoind, electrs, and proxy to already be running and `init-chain`
to be executed. `test:mpp` starts four daemons on P2P ports `9765–9768`, issues
a NIA using the fork, and sets up two paths: Alice → Bob → Dave and Alice →
Carol → Dave with RGB liquidity of 60 and 40 respectively. It pays an invoice of
100 units, which requires both paths, and verifies success on both sender
and receiver as well as the eight balances across all four channels. Each run preserves
data and passwords in a new `native-data/e2e-mpp-*` directory.

`npm run test:rgb` maintains the interoperability test with the WDK on-chain issuer.
If necessary, it downloads Node `24.19.0` into `native-data/` and recompiles its
`rgb-lib` addon, fixing the wrapper for Node 24's V8 APIs. It requires Python,
make, and a C++ compiler on the host. `npm ci --ignore-scripts` preserves the sources
of this optional addon for explicit compilation; Lightning nodes use
the Rust daemon and do not require the addon. It does not replace the MPP test.

## QVAC

```bash
cd wallet
npm run qvac:doctor
npm run qvac:precache
npm run qvac:serve
npm run qvac:smoke
```

UI interpretation communicates with Alice on ports `5173` and `8801`.

## Routing Benchmark: QVAC vs. Stock RGB Lightning

The [20-payment benchmark runner](wallet/infra/benchmark/README.md) and [architecture & benchmark evaluation report](docs/ARCHITECTURE_AND_BENCHMARK.md) evaluate the 20-node regtest network under both `topology.json` and `topology-mpp.json`, asking QVAC to score local channels and select the routing algorithm and MPP split limit before each payment, while recording settled fees, paths, LDK telemetry events, and pre/post channel balance snapshots.
