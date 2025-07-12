export default {
  startCmd: 'npm run start',
  baseUrl: 'https://localhost:8080',
  testDir: './test',
  filePattern: '\\.spectest\\.js$',
  rps: Infinity,
  timeout: 30000,
  randomize: false,
  bail: false,
  happy: false,
  filter: '',
  runningServer: 'reuse',
  userAgent: 'chrome_windows',
};
