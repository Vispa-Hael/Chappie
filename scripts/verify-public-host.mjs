import WebSocket from 'ws';
const host = new URL(process.argv[2] || '');
if (host.protocol !== 'https:') throw new Error('Provide the public HTTPS host address.');
const health = await fetch(new URL('/health', host), {signal: AbortSignal.timeout(10000)});
const body = await health.json();
if (!health.ok || body.service !== 'chappie-remote' || body.protocol !== 1) throw new Error('Public relay health check failed.');
const context = await fetch(new URL('/v1/context', host), {signal: AbortSignal.timeout(10000)});
if (context.status !== 401) throw new Error('Public context endpoint did not require pairing credentials.');
const socketURL = new URL('/v1/audio?leaseId=unauthorized-check', host);
socketURL.protocol = 'wss:';
await new Promise((resolve,reject) => {
  const socket = new WebSocket(socketURL, {handshakeTimeout:10000});
  socket.on('error', error => { if (!accepted) reject(error); });
  let accepted = false;
  const timer = setTimeout(() => { socket.terminate(); reject(new Error('Public WebSocket auth check timed out.')); }, 12000);
  socket.once('open', () => { clearTimeout(timer); socket.terminate(); reject(new Error('Unauthenticated public WebSocket was accepted.')); });
  socket.once('unexpected-response', (_request,response) => {
    clearTimeout(timer); accepted = [401,403].includes(response.statusCode);
    response.resume(); socket.terminate();
    if (accepted) resolve(); else reject(new Error(`Unexpected public WebSocket status ${response.statusCode}`));
  });
});
console.log('Public HTTPS health, required device authentication, and WSS upgrade/auth boundary: passed. Live paired audio still requires an authenticated companion.');
