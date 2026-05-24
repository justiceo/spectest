import type { SpectestConfig } from './types';

export default {
  startCmd: 'npm run start',
  baseUrl: 'https://localhost:8080',
  testDir: './test',
  filePattern: '\\.spectest\\.',
  rps: Infinity,
  timeout: 60000,
  randomize: false,
  happy: false,
  filter: '',
  testOutput: 'summary',
  runningServer: 'reuse',
  userAgent: 'chrome_windows',
  proxy: '',
  recording: 'off',
  recordingFile: '.spectest/cassette.json',
  missingRecordingBehavior: 'fail',
  recordingExcludeUrls: [],
} satisfies SpectestConfig;
