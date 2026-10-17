import net from 'node:net';
import { spawn } from 'node:child_process';

const targetHost = process.env.QVAC_BRIDGE_HOST ?? 'host.docker.internal';
const targetPort = Number(process.env.QVAC_BRIDGE_PORT ?? 11434);
const listenPort = Number(process.env.QVAC_BRIDGE_LISTEN ?? 11434);
const entry = process.argv[2] ?? 'apps/local-service/server.ts';

const proxy = net.createServer(socket => {
  const upstream = net.connect(targetPort, targetHost);
  const destroyBoth = () => {
    socket.destroy();
    upstream.destroy();
  };
  upstream.once('connect', () => {
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.once('error', destroyBoth);
  socket.once('error', destroyBoth);
  socket.once('close', () => upstream.destroy());
  upstream.once('close', () => socket.destroy());
});

proxy.listen(listenPort, '127.0.0.1', () => {
  const child = spawn(process.execPath, ['--import', 'tsx', entry], { stdio: 'inherit' });
  const stop = signal => {
    child.kill(signal);
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
  child.once('exit', (code, signal) => {
    process.exit(code ?? (signal ? 1 : 0));
  });
});

proxy.on('error', error => {
  process.stderr.write(`qvac bridge: ${error.message}\n`);
  process.exit(1);
});
