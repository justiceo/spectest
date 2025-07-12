export default {
  envFile: '.env',
  startCmd: 'npm run start',
  baseUrl: 'https://localhost:8080',
  testDir: './test',
  filePattern: '\\.spectest\\.js$',
  rps: Infinity,
  timeout: 30000,
  randomize: false,
  bail: false,
  happy: false,
  runningServer: 'reuse',
  userAgent: 'chrome_windows',
};
