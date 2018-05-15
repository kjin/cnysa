import { Cnysa } from './index';
import * as fs from 'fs';

const expectedConfigPath = `${process.cwd()}/cnysa.json`;
let config = {};
try {
  fs.statSync(expectedConfigPath);
  const configJson = fs.readFileSync(expectedConfigPath, 'utf8');
  config = JSON.parse(configJson);
} catch (e) {} finally {
  const cnysa = new Cnysa(config);
  cnysa.enable();
  process.once('exit', () => {
    console.log(cnysa.createAsyncSnapshot());
  });
}
