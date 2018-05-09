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

export type Flexible<T> = Partial<T | Serializable<T>>;

export interface CnysaAsyncSnapshotOptions {
  width: number;
  ignoreTypes: RegExp;
  roots: number[];
  padding: number;
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

type CnysaResource = {
  tid?: number,
  uid: number,
  type: string,
  internal: boolean,
  parents: number[]
};

export class Cnysa {
  private static markHighWater = 0;
  private static activeInstances: Cnysa[] = [];

  private currentScopes: number[];
  private resources: { [key: number]: CnysaResource };
  private events: Array<{ timestamp: number, uid: number, type: string }>;
  private hook: ah.AsyncHook;
  private globalContinuationEnded = false;

  public static ASYNC_SNAPSHOT_DEFAULTS: CnysaAsyncSnapshotOptions = {
    width: process.stdout.columns || 80,
    ignoreTypes: / /,
    roots: [],
    padding: 1,
    format: 'default'
  };

  public static get(): Cnysa {
    if (Cnysa.activeInstances.length === 0) {
      Cnysa.activeInstances.push(new Cnysa());
    }
    return Cnysa.activeInstances[Cnysa.activeInstances.length - 1];
  }

  constructor() {
    this.resources = {
      1: { uid: 1, type: '(initial)', parents: [], internal: false }
    };
    this.currentScopes = [1];
    this.events = [{
      timestamp: Date.now(),
      uid: 1,
      type: 'before'
    }];

    this.hook = ah.createHook({
      init: (uid, type, triggerId) => {
        const eid = ah.executionAsyncId();
        
        if (type.startsWith('cnysa')) {
          this.resources[uid] = { uid, type, parents: this.currentScopes.map(x => x), internal: true };
          this.events.push({ timestamp: Date.now(), uid, type: 'internal' });
        } else {
          this.resources[uid] = { uid, type, parents: this.currentScopes.map(x => x), internal: false };
          if (triggerId !== eid) {
            this.resources[uid].tid = triggerId;
          }
          this.events.push({ timestamp: Date.now(), uid, type: 'init' });
        }
      },
      before: (uid) => {
        if (this.resources[uid] && !this.resources[uid].internal) {
          if (!this.globalContinuationEnded) {
            this.globalContinuationEnded = true;
            this.events.push({
              timestamp: Date.now(),
              uid: 1,
              type: 'after'
            });
            this.currentScopes.pop();
          }
          this.events.push({ timestamp: Date.now(), uid, type: 'before' });
          this.currentScopes.push(uid);
        }
      },
      after: (uid) => {
        if (this.resources[uid] && !this.resources[uid].internal) {
          this.events.push({ timestamp: Date.now(), uid, type: 'after' });
          this.currentScopes.pop();
        }
      },
      destroy: (uid) => {
        if (this.resources[uid] && !this.resources[uid].internal) {
          this.events.push({ timestamp: Date.now(), uid, type: 'destroy' });
        }
      },
      promiseResolve: (uid) => {
        this.events.push({ timestamp: Date.now(), uid, type: 'promiseResolve' });
      }
    });

    Cnysa.activeInstances.push(this);
  }

  enable() {
    this.hook.enable();
  }

  disable() {
    this.hook.disable();
  }

  private hasAncestor(resource: CnysaResource, ancestor: RegExp|number[]): boolean {
    if (Array.isArray(ancestor) && ancestor.length === 0) {
      return true;
    }
    let predicate: (res: CnysaResource) => boolean;
    if (ancestor instanceof RegExp) {
      predicate = res => !!res.type.match(ancestor) || res.parents.some(parent => predicate(this.resources[parent]));
    } else {
      predicate = res => ancestor.indexOf(res.uid) !== -1 || res.parents.some(parent => predicate(this.resources[parent]));
    }
    return predicate(resource);
  }

  private canonicalizeAsyncSnapshotOptions(options: Flexible<CnysaAsyncSnapshotOptions> = {}): CnysaAsyncSnapshotOptions {
    const opts: CnysaAsyncSnapshotOptions | Serializable<CnysaAsyncSnapshotOptions> = Object.assign({}, Cnysa.ASYNC_SNAPSHOT_DEFAULTS, options);
    opts.ignoreTypes = typeof opts.ignoreTypes === 'string' ?
      new RegExp(opts.ignoreTypes) : opts.ignoreTypes;
    return opts as CnysaAsyncSnapshotOptions;
  }

  mark(tag?: string|number): void {
    if (tag === undefined) {
      tag = Cnysa.markHighWater++;
    }
    new ah.AsyncResource(`cnysa(${tag})`).emitDestroy();
  }

  getAsyncSnapshot(options: Flexible<CnysaAsyncSnapshotOptions> = {}): string {
    // Initialize options.
    const config = this.canonicalizeAsyncSnapshotOptions(options);

    if (!this.globalContinuationEnded) {
      this.globalContinuationEnded = true;
      this.events.push({
        timestamp: Date.now(),
        uid: 1,
        type: 'after'
      });
    }
    const ignoredResources = Object.keys(this.resources).filter(key => {
      const k = Number(key);
      return this.resources[k].type.match(config.ignoreTypes) || !this.hasAncestor(this.resources[k], config.roots);
    }).reduce((acc: Set<number>, key) => acc.add(Number(key)), new Set());
    const maxLength = Object.keys(this.resources).reduce((acc, key) => {
      const k = Number(key);
      if (ignoredResources.has(k)) {
        return acc;
      }
      const tidLength = this.resources[k].tid !== undefined ? (this.resources[k].uid.toString().length + 3) : 0;
      const uidLength = this.resources[k].uid.toString().length + 1;
      const typeLength = this.resources[k].type.length + 1;
      return Math.max(acc, tidLength + uidLength + typeLength);
    }, -Infinity);
    const stack: any[] = [];
    const paddedEvents = [];
    for (const event of this.events) {
      if (!ignoredResources.has(event.uid)) {
        paddedEvents.push(event);
        for (let i = 0; i < config.padding; i++) {
          paddedEvents.push({ uid: -1, timestamp: 0, type: 'pad' });
        }
      }
    }
    const adjustedWidth = config.width - maxLength;
    const eventStrings: { [k: number]: { alive: boolean, str: StringRowsBuilder } } = {};
    for (const event of paddedEvents) {
      Object.keys(this.resources).forEach(key => {
        const k = Number(key);
        if (!eventStrings[k]) {
          eventStrings[k] = { alive: false, str: new StringRowsBuilder(adjustedWidth) };
        }
        if (event.uid === k) {
          if (event.type === 'init') {
            eventStrings[k].str.appendChar('*', 'green');
            eventStrings[k].alive = true;
          } else if (event.type === 'before') {
            eventStrings[k].str.appendChar('{', 'blue');
            stack.push(k);
          } else if (event.type === 'after') {
            eventStrings[k].str.appendChar('}', 'blue');
            stack.pop();
          } else if (event.type === 'destroy') {
            eventStrings[k].str.appendChar('*', 'red');
            eventStrings[k].alive = false;
          } else if (event.type === 'promiseResolve') {
            eventStrings[k].str.appendChar('*', 'gray');
            eventStrings[k].alive = false;
          } else if (event.type === 'internal') {
            eventStrings[k].str.appendChar('*', 'cyan');
          } else {
            eventStrings[k].str.appendChar('?', 'gray');
          }
        } else {
          const maybeVertical = (color: keyof Chalk) => {
            if (stack.length > 0) {
              if (event.uid > k) {
                if (stack[stack.length - 1] < k) {
                  eventStrings[k].str.appendChar('|', color);
                  return true;
                } else if (stack[stack.length - 1] === k) {
                  eventStrings[k].str.appendChar('.', color);
                  return true;
                }
              } else if (event.uid < k) {
                if (stack[stack.length - 1] > k) {
                  eventStrings[k].str.appendChar('|', color);
                  return true;
                } else if (stack[stack.length - 1] === k) {
                  eventStrings[k].str.appendChar('.', color);
                  return true;
                }
              }
            }
            return false;
          };
          if (event.type === 'internal' && maybeVertical('cyan')) {
            return;
          } else if (event.type === 'init' && maybeVertical('green')) {
            return;
          }
          if (stack.indexOf(k) !== -1) {
            eventStrings[k].str.appendChar('.', 'blue');
          } else {
            if (eventStrings[k].alive) {
              eventStrings[k].str.appendChar('-', 'gray');
            } else {
              eventStrings[k].str.appendChar(' ');
            }
          }
        }
      });
    }
    const separator = new Array(config.width).fill(':').join('');
    const output = [
      separator,
      ...interleave(Object.keys(this.resources).map(key => {
        const k = Number(key);
        return eventStrings[k].str.getData().map(rhs => {
          if (!rhs.dirty) {
            return '';
          } else {
            const typeColor: keyof Chalk = this.resources[k].internal ? 'cyan' : 'yellow';
            if (this.resources[k].tid !== undefined) {
              return leftPad(`${chalk.magenta(`${this.resources[k].uid}`)} (${chalk.green(`${this.resources[k].tid!}`)}) ${chalk[typeColor](this.resources[k].type)} `, maxLength + (chalk.red(' ').length - 1) * 3) + rhs.str;
            } else {
              return leftPad(`${chalk.magenta(`${this.resources[k].uid}`)} ${chalk[typeColor](this.resources[k].type)} `, maxLength + (chalk.red(' ').length - 1) * 2) + rhs.str;
            }
          }
        });
      }), separator)
        // .map((line, idx) => idx % 2 === 0 ? chalk.bgBlackBright(line) : chalk.bgBlack(line))
        .filter(line => line.length > 0),
      separator
    ].join('\n');
    const format = options && options.format ? options.format : config.format;
    if (format === 'svg') {
      const ansiToSvg = require('ansi-to-svg');
      return ansiToSvg(output);
    } else {
      return output;
    }
  }
}
