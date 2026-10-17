import { readFileSync, writeFileSync } from 'node:fs';

const topologyPath = new URL('../topology.json', import.meta.url);
const outputPath = new URL('../docker-compose.topology.yml', import.meta.url);
const topology = JSON.parse(readFileSync(topologyPath, 'utf8'));
const nodes = topology.nodes;

if (!Array.isArray(nodes) || nodes.length === 0) {
  throw new Error('topology.json non contiene nodi');
}

const seenPorts = new Set();
for (const node of nodes) {
  if (!node.id || !node.alias || !node.apiPort || !node.p2pPort) {
    throw new Error(`Nodo topology incompleto: ${JSON.stringify(node)}`);
  }
  for (const port of [node.apiPort, node.p2pPort]) {
    if (seenPorts.has(port)) throw new Error(`Porta topology duplicata: ${port}`);
    seenPorts.add(port);
  }
}

const volumeFor = id => (id === 'alice' ? 'alice-mpp-data' : id === 'bob' ? 'bob-mpp-data' : `${id}-topology-data`);

const renderService = (node, buildsImage) => `  ${node.id}:
    image: airgb-regtest-node-mpp
${buildsImage ? `    build:
      context: ./wallet
      dockerfile: Dockerfile
` : ''}    environment:
      <<: *topology-env
      PORT: "${node.apiPort}"
      AIRGB_LDK_PEER_PORT: "${node.p2pPort}"
      AIRGB_ANNOUNCE_HOST: ${node.id}
      AIRGB_NODE_ALIAS: ${JSON.stringify(node.alias)}
    depends_on:
      - bitcoind
      - electrs
      - proxy
    ports:
      - "127.0.0.1:${node.apiPort}:${node.apiPort}"
      - "127.0.0.1:${node.p2pPort}:${node.p2pPort}"
    command: ["node", "/qvac-bridge.mjs", "apps/local-service/server.ts"]
    volumes:
      - ${volumeFor(node.id)}:/data
      - ./wallet/infra/regtest/qvac-bridge.mjs:/qvac-bridge.mjs:ro
      - ./wallet/apps/local-service/interpret.ts:/app/apps/local-service/interpret.ts:ro`;

const volumes = nodes.map(node => `  ${volumeFor(node.id)}:`).join('\n');
const services = nodes.map((node, index) => renderService(node, index === 0)).join('\n');

const document = `# Generated from topology.json by scripts/render-topology-compose.mjs. Do not edit by hand.
x-topology-env: &topology-env
  BITCOIND_RPC_USER: user
  BITCOIND_RPC_PASSWORD: \${BITCOIND_RPC_PASSWORD:?Set BITCOIND_RPC_PASSWORD locally}
  BITCOIND_RPC_HOST: bitcoind
  BITCOIND_RPC_PORT: "18443"
  INDEXER_URL: tcp://electrs:50001
  RGB_PROXY_ENDPOINT: rpc://proxy:3000/json-rpc
  AIRGB_DATA_DIR: /data
  BIND_HOST: 0.0.0.0
  AIRGB_WEB_PORT: "5173"
  ENABLE_REGTEST_SEND: "1"
  QVAC_MODEL: my-llm

services:
${services}

volumes:
${volumes}
`;

writeFileSync(outputPath, document);
process.stdout.write(`Scritto docker-compose.topology.yml (${nodes.length} nodi)\n`);
