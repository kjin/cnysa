import * as ah from 'async_hooks';
import chalk, { Chalk } from 'chalk';
import * as fs from 'fs';
import leftPad = require('left-pad');
import { Writable } from 'stream';

export interface CnysaOptions {
  width: number;
  ignoreTypes: RegExp|string;
  highlightTypes: RegExp|string;
  ignoreUnhighlighted: boolean;
  padding: number;
  colors: Array<string>;
  svg: string;
}

const isRemovableLine = (str: string) => {
  while (str = str.trim()) {
    const firstSpace = str.indexOf(' ');
    if (str.slice(0, firstSpace).match(/[^\|]/)) {
      return false;
    }
    const lastSpace = str.lastIndexOf(' ');
    if (str.slice(lastSpace + 1).match(/[^\|]/)) {
      return false;
    }
    str = str.slice(firstSpace + 1, lastSpace);
  }
  return true;
}

/**
 * Flatten an array of arrays, but in "column-major" order
 */
const interleave = <T>(input: T[][], separator?: T): T[] => {
  const result: T[] = [];
  const maxLength = input.reduce((acc, next) => Math.max(next.length, acc), -Infinity);
  for (let i = 0; i < maxLength; i++) {
    if (separator !== undefined && i > 0) {
      result.push(separator);
    }
    for (let j = 0; j < input.length; j++) {
      input[j][i] !== undefined && result.push(input[j][i]);
    }
  }
  return result;
}

const until = <T>(array: T[], predicate: (input: T) => boolean): T[] => {
  return array.slice(0, array.findIndex(e => !predicate(e)));
}

interface StringData {
  str: string;
  dirty: boolean;
}

class StringRowsBuilder {
  private readonly maxLength: number;
  private data: Array<StringData> = [];
  private currentLength = 0;

  constructor(maxLength: number) {
    this.maxLength = maxLength;
  }

  // treats as if one char
  appendChar(char: string, ...styles: Array<keyof Chalk|undefined>) {
    if (this.currentLength === 0) {
      this.data.push({ str: '', dirty: false });
    }
    const top = this.data[this.data.length - 1];
    top.str += styles.reduce((acc, next) => next ? (chalk[next] as typeof chalk)(acc) : acc, char);
    top.dirty = top.dirty || !(char === ' ' || char === '|');
    if (++this.currentLength === this.maxLength) {
      this.currentLength = 0;
    }
  }

  getData() {
    return this.data;
  }
}

export class Cnysa {
  private width: number;
  private ignoreTypes: RegExp;
  private highlightTypes: RegExp;
  private ignoreUnhighlighted: boolean;
  private getColor: IterableIterator<keyof Chalk>;
  private padding: number;
  private svg: string;

  private resources: { [key: number]: { uid: number, type: string, color?: keyof Chalk } };
  private events: Array<{ timestamp: number, uid: number, type: string }>;
  private hook: ah.AsyncHook;
  private processOnExit: () => void;
  private globalContinuationEnded = false;

  public static DEFAULTS: CnysaOptions = {
    width: process.stdout.columns || 80,
    ignoreTypes: / /,
    highlightTypes: / /,
    ignoreUnhighlighted: false,
    padding: 1,
    colors: ['bgMagenta', 'bgYellow', 'bgCyan'],
    svg: ''
  };

  constructor(options: Partial<CnysaOptions>) {
    // Initialize options.
    const canonicalOpts: CnysaOptions = Object.assign({}, Cnysa.DEFAULTS, options);
    this.width = canonicalOpts.width;
    this.ignoreTypes = typeof canonicalOpts.ignoreTypes === 'string' ?
      new RegExp(canonicalOpts.ignoreTypes) : canonicalOpts.ignoreTypes;
    this.highlightTypes = typeof canonicalOpts.highlightTypes === 'string' ?
      new RegExp(canonicalOpts.highlightTypes) : canonicalOpts.highlightTypes;
    this.getColor = (function* () {
      const colors = canonicalOpts.colors as Array<keyof Chalk>;
      while (true) {
        for (const color of colors) {
          yield color;
        }
      }
    })();
    this.ignoreUnhighlighted = canonicalOpts.ignoreUnhighlighted;
    this.padding = canonicalOpts.padding;
    this.svg = canonicalOpts.svg;

    this.resources = {
      1: { uid: 1, type: '(initial)' }
    };
    this.events = [{
      timestamp: Date.now(),
      uid: 1,
      type: 'before'
    }];

    this.hook = ah.createHook({
      init: (uid, type) => {
        if (!type.match(this.ignoreTypes)) {
          const eid = ah.executionAsyncId();
          const color = (this.resources[eid] && this.resources[eid].color) || (type.match(this.highlightTypes) ? this.getColor.next().value : undefined);
          this.resources[uid] = { uid, type, color };
          this.events.push({ timestamp: Date.now(), uid, type: 'init' });
        }
      },
      before: (uid) => {
        if (this.resources[uid] && !this.resources[uid].type.match(this.ignoreTypes)) {
          if (!this.globalContinuationEnded) {
            this.globalContinuationEnded = true;
            this.events.push({
              timestamp: Date.now(),
              uid: 1,
              type: 'after'
            });
          }
          this.events.push({ timestamp: Date.now(), uid, type: 'before' });
        }
      },
      after: (uid) => {
        if (this.resources[uid] && !this.resources[uid].type.match(this.ignoreTypes)) {
          this.events.push({ timestamp: Date.now(), uid, type: 'after' });
        }
      },
      destroy: (uid) => {
        if (this.resources[uid] && !this.resources[uid].type.match(this.ignoreTypes)) {
          this.events.push({ timestamp: Date.now(), uid, type: 'destroy' });
        }
      },
      promiseResolve: (uid) => {
        this.events.push({ timestamp: Date.now(), uid, type: 'promiseResolve' });
      }
    });

    this.processOnExit = () => {
      this.hook.disable();
      const uncoloredLength = Object.keys(this.resources).reduce((acc, key) => {
        const k = Number(key);
        return Math.max(acc, `${this.resources[k].uid.toString()} ${this.resources[k].type} `.length);
      }, -Infinity);
      const maxLength = Object.keys(this.resources).reduce((acc, key) => {
        const k = Number(key);
        return Math.max(acc, `${chalk.magenta(this.resources[k].uid.toString())} ${chalk.yellow(this.resources[k].type)} `.length);
      }, -Infinity);
      const stack: any[] = [];
      const paddedEvents = [];
      for (const event of this.events) {
        if (event.uid === 1 || !this.ignoreUnhighlighted || this.resources[event.uid].color) {
          paddedEvents.push(event);
          for (let i = 0; i < this.padding; i++) {
            paddedEvents.push({ uid: -1, timestamp: 0, type: 'pad' });
          }
        }
      }
      const adjustedWidth = this.width - uncoloredLength;
      const eventStrings: { [k: number]: { alive: boolean, str: StringRowsBuilder } } = {};
      for (const event of paddedEvents) {
        Object.keys(this.resources).forEach(key => {
          const k = Number(key);
          if (!eventStrings[k]) {
            eventStrings[k] = { alive: false, str: new StringRowsBuilder(adjustedWidth) };
          }
          if (event.uid === k) {
            if (event.type === 'init') {
              eventStrings[k].str.appendChar('*', 'green', this.resources[k].color);
              eventStrings[k].alive = true;
            } else if (event.type === 'before') {
              eventStrings[k].str.appendChar('{', 'blue', this.resources[k].color);
              stack.push(k);
            } else if (event.type === 'after') {
              eventStrings[k].str.appendChar('}', 'blue', this.resources[k].color);
              stack.pop();
            } else if (event.type === 'destroy') {
              eventStrings[k].str.appendChar('*', 'red', this.resources[k].color);
              eventStrings[k].alive = false;
            } else if (event.type === 'promiseResolve') {
              eventStrings[k].str.appendChar('*', 'gray', this.resources[k].color);
              eventStrings[k].alive = false;
            } else {
              eventStrings[k].str.appendChar('?', 'gray', this.resources[k].color);
            }
          } else {
            if (event.type === 'init' && stack.length > 0) {
              if (event.uid > k) {
                if (stack[stack.length - 1] < k) {
                  eventStrings[k].str.appendChar('|', 'green', this.resources[event.uid].color);
                  return;
                } else if (stack[stack.length - 1] === k) {
                  eventStrings[k].str.appendChar('.', 'green', this.resources[event.uid].color);
                  return;
                }
              } else if (event.uid < k) {
                if (stack[stack.length - 1] > k) {
                  eventStrings[k].str.appendChar('|', 'green', this.resources[k].color);
                  return;
                } else if (stack[stack.length - 1] === k) {
                  eventStrings[k].str.appendChar('.', 'green', this.resources[k].color);
                  return;
                }
              }
            }
            if (stack.indexOf(k) !== -1) {
              eventStrings[k].str.appendChar('.', 'blue', this.resources[k].color);
            } else {
              if (eventStrings[k].alive) {
                eventStrings[k].str.appendChar('-', 'gray', this.resources[k].color);
              } else {
                eventStrings[k].str.appendChar(' ');
              }
            }
          }
        });
      }
      const separator = new Array(this.width).fill(':').join('');
      const output = [
        separator,
        ...interleave(Object.keys(this.resources).map(key => {
          const k = Number(key);
          return eventStrings[k].str.getData().map(rhs => {
            if (!rhs.dirty) {
              return '';
            } else {
              return leftPad(`${chalk.magenta(this.resources[k].uid.toString())} ${chalk.yellow(this.resources[k].type)} `, maxLength) + rhs.str;
            }
          });
        }), separator).filter(line => line.length > 0),
        separator
      ].join('\n');
      if (this.svg) {
        const ats = require('ansi-to-svg');
        fs.writeFileSync(this.svg, ats(output));
      } else {
        console.log(output);
      }
    };
  }

  enable() {
    this.hook.enable();
    process.on('exit', this.processOnExit);
  }

  disable() {
    this.hook.disable();
    process.removeListener('exit', this.processOnExit);
  }
}
