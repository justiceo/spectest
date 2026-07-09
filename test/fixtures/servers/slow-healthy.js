import http from 'node:http';

const delayMs = Number(process.env.FIXTURE_DELAY_MS || '1500');
const port = Number(process.env.PORT || '8080');

setTimeout(() => {
  const server = http.createServer((_req, res) => res.end('ok'));
  server.listen(port, '127.0.0.1');
}, delayMs);
