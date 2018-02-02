`cnysa` (unpronouncible) is a module that allows you to see information about what the `async_hooks` module is doing under the covers.

# Usage

Require `cynsa` in your application:

```bash
node --require cynsa app.js
```

# Understanding output

For each `init`, `before`, `promiseResolve`, and `destroy` event, a line will be printed.

Each of those lines start with a symbol:

* `+` Init
* `*` Before
* `-` Destroy
* `:` Promise Fulfillment

The number that follows is the current time in seconds, mod 1000.

A string after represents the async resource type.

After that, you get a list of numbers delimited by `:`. The first number is the `uid` passed in to the corresponding hook, and subsequent numbers follow its `triggerAsyncId` chain.

For `before` lines, you'll also see the current execution ID (ex), trigger ID (tr), and an opening brace.

`before`-`after` pairs are visualized as indents. A closing brace indicates an `after` event emission.

## Example

Let's say the following is `app.js`:

```js
const express = require('express');

const server = express()
  .get('/', (req, res) => res.send("i'm rooting for you"))
  .listen(8080);
setTimeout(() => server.close(), 5000);
```

Running the command in the "Usage" section gives you (in colors):

```
+ [  0] TCPWRAP 6:1
+ [  0] TickObject 7:6:1
+ [  0] Timeout 8:1
+ [  0] TIMERWRAP 9:1
* [  0] TickObject 7|ex 7|tr 6 {
}
- [  0] TickObject 7
* [  5] TIMERWRAP 9|ex 0|tr 0 {
  * [  5] Timeout 8|ex 8|tr 1 {
    + [  5] TickObject 10:8:1
  }
}
* [  5] TickObject 10|ex 10|tr 8 {
}
- [  5] Timeout 8
- [  5] TickObject 10
- [  5] TIMERWRAP 9
- [  5] TCPWRAP 6
```
