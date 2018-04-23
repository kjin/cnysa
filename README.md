`cnysa` (unpronouncible) is a module that allows you to see information about what the `async_hooks` module is doing under the covers.

__Note: This module currently uses the `colors` module.__

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

* `options.width`: Maximum number of characters to print on a single line before wrapping. Defaults to the current terminal width.
* `options.ignoreTypes`: String or RegExp to filter out `AsyncResource` types.
* `options.highlightTypes`: String or RegExp to highlight certain `AsyncResource` types and their descendants.

## `Cnysa#enable()`

Starts recording async events and registers a process exit hook.

## `Cnysa#disable()`

Stops recording async events and unregisters the process exit hook.

# Understanding output

For each `AsyncResource`, a time line will be printed, with a number of colored symbols:

* Green `*` represents the async resource creation.
* Red `*` represents its destruction.
* Blue `{...}` represent running in an async scope.
* Gray `-` indicates the lifetime of the resource creation, and is bookended by `*` symbols.

## Examples

```bash
node --require cnysa/register -e "fs.readFile('package.json', (err, contents) => { console.log('done reading') })"
```

![example-readfile.svg](./doc/images/example-readfile.svg)
