import { Cnysa } from "./index";

const a = new Cnysa();
a.enable();

setImmediate(() => {
  console.log(a.createAsyncStackTrace());
});
