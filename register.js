const { Cnysa } = require('.');
const fs = require('fs');

const expectedConfigPath = `${process.cwd()}/cnysa.json`;
let config = {};
try {
  fs.statSync(expectedConfigPath);
  const configJson = fs.readFileSync(expectedConfigPath, 'utf8');
  config = JSON.parse(configJson);
} catch (e) {} finally {
  new Cnysa(config).enable();
}
