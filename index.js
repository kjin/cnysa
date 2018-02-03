const leftPad = require('left-pad');
const chalk = require('chalk').default;
const fs = require('fs');
const asyncHooks = require('async_hooks');

class Cnysa {
  constructor(options = {}) {
    if (options.typeFilter) {
      this.typeFilter = new RegExp(options.typeFilter);
    }

    this.start = Math.floor(Date.now() / 1000) % 1000;
    this.typesTable = {};
    this.triggerTable = {};
    this.promiseTable = new Map();
    this.indent = '';
  }

  _createTriggerChain(id) {
    let result = chalk.yellow(id);
    while (this.triggerTable[id] !== undefined) {
      id = this.triggerTable[id];
      result += `:${chalk.magenta(id)}`;
    }
    return result;
  }

  _init(id, type, trigger, resource) {
    if (this.typeFilter && !this.typeFilter.exec(type)) {
      return;
    }
    this.typesTable[id] = type;
    this.triggerTable[id] = trigger;
    if (type === 'PROMISE') {
      this.promiseTable.set(resource.promise, id);
    }
    this._write(this.indent);
    this._write('+ [', 'green');
    this._write(leftPad(this._getTime(), 3));
    this._write(`] ${this.typesTable[id]} `, 'green');
    this._write(this._createTriggerChain(id));
    if (resource.parentId) {
      this._write(' [', 'green');
      this._write(resource.parentId, 'yellow');
      this._write(']', 'green');
    }
    this._write('\n');
  }

  _before(id) {
    if (!this.typesTable[id]) return;
    this._write(this.indent);
    this._write('* [', 'blue');
    this._write(leftPad(this._getTime(), 3));
    this._write(`] ${this.typesTable[id]} `, 'blue');
    this._write(`${id}`, 'yellow');
    this._write('|ex ');
    this._write(asyncHooks.executionAsyncId(), 'yellow');
    this._write('|tr ');
    this._write(asyncHooks.triggerAsyncId(), 'yellow');
    this._write(' {\n', 'blue');
    this.indent += '  ';
  }

  _after(id) {
    if (!this.typesTable[id]) return;
    this.indent = this.indent.slice(2);
    this._write(this.indent);
    this._write('}', 'blue');
    this._write('\n');
  }

  _destroy(id) {
    if (!this.typesTable[id]) return;
    this._write(this.indent);
    this._write('- [', 'red');
    this._write(leftPad(this._getTime(), 3));
    this._write(`] ${this.typesTable[id]} `, 'red');
    this._write(`${id}`, 'yellow');
    this._write('\n');
  }

  _promiseResolve(id) {
    if (!this.typesTable[id]) return;
    this._write(this.indent);
    this._write(': [', 'gray');
    this._write(leftPad(this._getTime(), 3));
    this._write(`] ${this.typesTable[id]} `, 'gray');
    this._write(`${id}`, 'yellow');
    this._write('\n');
  }

  _getTime() {
    const s = (Math.floor(Date.now() / 1000) % 1000) - this.start;
    if (s < 0) s += 1000;
    return s;
  }

  _write(str, color) {
    if (color) {
      fs.writeSync(1, chalk[color]('' + str));
    } else {
      fs.writeSync(1, '' + str);
    }
  }

  enable() {
    this.hook = asyncHooks.createHook({
      init: this._init.bind(this),
      before: this._before.bind(this),
      after: this._after.bind(this),
      destroy: this._destroy.bind(this),
      promiseResolve: this._promiseResolve.bind(this)
    }).enable();
    return this;
  }

  disable() {
    this.hook.disable();
    return this;
  }

  print(p, alias) {
    this._write(this.indent);
    this._write('> [', 'white');
    this._write(leftPad(this._getTime(), 3));
    this._write(`] PROMISE `, 'white');
    this._write(`${this.promiseTable.get(p)||'?'}`, 'yellow');
    if (alias) {
      this._write(' aka ', 'white');
      this._write(alias, 'cyan');
    }
    this._write('\n');
    return p;
  }
}

module.exports.Cnysa = Cnysa;
