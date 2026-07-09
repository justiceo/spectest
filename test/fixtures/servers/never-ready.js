import http from 'node:http';

const port = Number(process.env.PORT || '8080');

const server = http.createServer((_req, res) => {
  res.statusCode = 500;
  res.end('not ready');
});
server.listen(port, '127.0.0.1');
