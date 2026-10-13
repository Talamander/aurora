// In-sandbox launcher: the sandbox has no network, only the egress proxy's unix socket.
// Bridge 127.0.0.1:<port> to that socket, point the proxy variables at it, run the actor.
// Usage: node launch.mjs <proxy.sock> <command> [args...]
import net from 'node:net';
import { spawn } from 'node:child_process';

const [sock, cmd, ...args] = process.argv.slice(2);
const server = net.createServer((client) => {
  const up = net.connect(sock);
  client.pipe(up).pipe(client);
  const done = () => {
    client.destroy();
    up.destroy();
  };
  client.on('error', done);
  up.on('error', done);
  client.on('close', done);
  up.on('close', done);
});
server.listen(0, '127.0.0.1', () => {
  const proxy = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env };
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) env[k] = proxy;
  env.NO_PROXY = env.no_proxy = '';
  // The actor gets its own stdout pipe. Inheriting ours would hand it a file description that
  // Node has switched to non-blocking (same for stderr), and Python (and others) then silently lose output on
  // EAGAIN when they write big lines faster than the host reads them.
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => child.kill(sig));
  child.on('error', (e) => {
    process.stdout.write(JSON.stringify({ type: 'error', msg: `launch failed: ${e.message}` }) + '\n');
    process.exit(127);
  });
  // 'close' fires after the child exited and its stdout ended; then let our stdout drain.
  child.on('close', (code, signal) => {
    process.exitCode = code ?? (signal ? 128 : 1);
    server.close();
    process.stdout.end(() => process.exit());
  });
});
