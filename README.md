`cnysa` (unpronouncible) is a module that allows you to see information about what the `async_hooks` module is doing under the covers.

# Pre-Require Hook

Pre-require `cynsa/register` in your application:

```bash
node --require cynsa/register app.js
```

If `cnysa.json` exists in the current working directory, it will be used as the configuration passed to the `Cnysa` constructor as described below.

# API

```js
const { Cnysa } = require('cnysa');
```

## `new Cnysa(options)`

All options are optional.

* `options.typeFilter`: String or RegExp to use as a filter for `AsyncResource` types.

## `Cnysa#enable()`

Starts emitting output.

## `Cnysa#disable()`

Stops emitting output.

# Understanding output

For each `init`, `before`, `promiseResolve`, and `destroy` event, a line will be printed.

Each of those lines start with a symbol:

* `+` Init
* `*` Before
* `-` Destroy
* `:` Promise Fulfillment

The number that follows is the current time in seconds, mod 1000. This number might be useful in distinguishing "clusters" of async events.

A string after represents the async resource type.

The async resource's execution ID follows. For `init` events, if the trigger ID is different than the current execution ID, it is displayed as well.

`before`-`after` pairs are visualized as indents.

## Examples

```bash
node --require cnysa/register -e "fs.readFile('package.json', (err, contents) => { console.log('done reading') })"
```

```bash
(sleep 2 && curl localhost:8080) & node --require cnysa/register -e "http.createServer((req, res) => res.send('hi')).listen(8080)"
```

https://gist.github.com/kjin/a499bfcb7c5e12a80f8c6ad66a30b740
