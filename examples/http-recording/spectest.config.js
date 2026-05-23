import { fileURLToPath } from 'node:url';

const serverPath = fileURLToPath(new URL('./server.mjs', import.meta.url));

export default {
  baseUrl: 'http://127.0.0.1:8080',
  startCmd: `node ${serverPath}`,
  runningServer: 'kill',
  testDir: '.',
  filePattern: 'recording-test\\.spectest\\.json$',
  recording: 'record',
  recordingFile: '.spectest/cassette.json',
  recordingExcludeUrls: [
    'https://1.1.1.1/cdn-cgi/trace',
  ],
  missingRecordingBehavior: 'fail',
  testOutput: 'errors',
};
