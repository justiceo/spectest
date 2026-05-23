# HTTP Recording Sample

This sample server exposes local endpoints that make outbound requests to `https://jsonplaceholder.typicode.com`.

Record a cassette:

```bash
npm run build
node dist/cli.js --dir examples/http-recording --recording=record
```

Replay from the cassette:

```bash
node dist/cli.js --dir examples/http-recording --recording=replay
```

The cassette is written to `examples/http-recording/.spectest/cassette.json`.
