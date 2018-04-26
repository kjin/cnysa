import * as ah from 'async_hooks';
import chalk, { Chalk } from 'chalk';
import * as fs from 'fs';
import leftPad = require('left-pad');
import { Writable } from 'stream';

export type Serializable<T> = {
  [P in keyof T]: T[P] extends string|number|boolean ? T[P] :
                  T[P] extends Array<infer S>|IterableIterator<infer S> ? Array<Serializable<S>> :
                  T[P] extends Function|RegExp ? string :
                  T[P] extends {} ? Serializable<T[P]> : string;
}

export type Flexible<T> = Partial<T & Serializable<T>>;

export interface CnysaOptions {
  width: number;
  ignoreTypes: RegExp;
  highlightTypes: RegExp;
  ignoreUnhighlighted: boolean;
  padding: number;
  colors: IterableIterator<keyof Chalk>;
  format: string;
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
  private padding: number;
  private colors: IterableIterator<keyof Chalk>;
  private format: string;

  private resources: { [key: number]: { tid?: number, uid: number, type: string, color?: keyof Chalk } };
  private events: Array<{ timestamp: number, uid: number, type: string }>;
  private hook: ah.AsyncHook;
  private globalContinuationEnded = false;

  public static DEFAULTS: CnysaOptions = {
    width: process.stdout.columns || 80,
    ignoreTypes: / /,
    highlightTypes: / /,
    ignoreUnhighlighted: false,
    padding: 1,
    colors: (function* () {
      const colors = ['bgMagenta', 'bgYellow', 'bgCyan'] as Array<keyof Chalk>;
      while (true) {
        for (const color of colors) {
          yield color;
        }
      }
    })(),
    format: 'default'
  };

  constructor(options: Flexible<CnysaOptions> = {}) {
    // Initialize options.
    const canonicalOpts: CnysaOptions = Object.assign({}, Cnysa.DEFAULTS, options);
    this.width = canonicalOpts.width;
    this.ignoreTypes = typeof canonicalOpts.ignoreTypes === 'string' ?
      new RegExp(canonicalOpts.ignoreTypes) : canonicalOpts.ignoreTypes;
    this.highlightTypes = typeof canonicalOpts.highlightTypes === 'string' ?
      new RegExp(canonicalOpts.highlightTypes) : canonicalOpts.highlightTypes;
    this.ignoreUnhighlighted = canonicalOpts.ignoreUnhighlighted;
    this.padding = canonicalOpts.padding;
    this.colors = canonicalOpts.colors;
    this.format = canonicalOpts.format;

    this.resources = {
      1: { uid: 1, type: '(initial)' }
    };
    this.events = [{
      timestamp: Date.now(),
      uid: 1,
      type: 'before'
    }];

    this.hook = ah.createHook({
      init: (uid, type, triggerId) => {
        if (!type.match(this.ignoreTypes)) {
          const eid = ah.executionAsyncId();
          const color = (this.resources[eid] && this.resources[eid].color) || (type.match(this.highlightTypes) ? this.colors.next().value : undefined);
          this.resources[uid] = { uid, type, color };
          if (triggerId !== eid) {
            this.resources[uid].tid = triggerId;
          }
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
  }

  enable() {
    this.hook.enable();
  }

  disable() {
    this.hook.disable();
  }

  getAsyncSnapshot(): string {
    if (!this.globalContinuationEnded) {
      this.globalContinuationEnded = true;
      this.events.push({
        timestamp: Date.now(),
        uid: 1,
        type: 'after'
      });
    }
    const maxLength = Object.keys(this.resources).reduce((acc, key) => {
      const k = Number(key);
      const tidLength = this.resources[k].tid !== undefined ? (this.resources[k].uid.toString().length + 3) : 0;
      const uidLength = this.resources[k].uid.toString().length + 1;
      const typeLength = this.resources[k].type.length + 1;
      return Math.max(acc, tidLength + uidLength + typeLength);
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
    const adjustedWidth = this.width - maxLength;
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
            if (this.resources[k].tid !== undefined) {
              return leftPad(`${chalk.magenta(`${this.resources[k].uid}`)} (${chalk.green(`${this.resources[k].tid!}`)}) ${chalk.yellow(this.resources[k].type)} `, maxLength + (chalk.magenta(' ').length - 1) * 3) + rhs.str;
            } else {
              return leftPad(`${chalk.magenta(`${this.resources[k].uid}`)} ${chalk.yellow(this.resources[k].type)} `, maxLength + (chalk.magenta(' ').length - 1) * 2) + rhs.str;
            }
          }
        });
      }), separator).filter(line => line.length > 0),
      separator
    ].join('\n');
    if (this.format === 'svg') {
      const ansiToSvg = require('ansi-to-svg');
      return ansiToSvg(output);
    } else {
      return output;
    }
  }
}
