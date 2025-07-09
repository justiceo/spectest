export default {
  envFile: '.env',
  startCmd: 'npm run start',
  baseUrl: 'https://jsonplaceholder.typicode.com',
  suitesDir: './spec',
  testMatch: '\\.(suite|suites)\\.js$',
  rps: 5,
  timeout: 30000,
  randomize: false,
  bail: false,
  happy: false,
  runningServer: 'reuse',
};
