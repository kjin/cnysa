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

/**
 * Options for formatting the result of calling Cnysa#getAsyncSnapshot.
 */
export interface CnysaAsyncSnapshotOptions {
  /**
   * The maximum number of characters to print on a single line before wrapping.
   * Defaults to the current terminal width.
   */
  width: number;
  /**
   * A RegExp to filter out `AsyncResource` types.
   */
  ignoreTypes: RegExp;
  /**
   * A list of `AsyncResource` IDs that must be an ancestor of a given
   * `AsyncResource` for it to be displayed. The default value, an empty list,
   * is equivalent to specifying no constraint on ancestry.
   */
  roots: number[];
  /**
   * A number that represents the amount of space between each depicted event.
   */
  padding: number;
  /**
   * A string that represents how the output should be formatted. Currently,
   * the available options are `'default'` and `'svg'`.
   */
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

/**
 * A class that collects AsyncResource lifecycle events for visualization
 * purposes.
 */
export class Cnysa {
  private static markHighWater = 0;
  private static activeInstances: Cnysa[] = [];

  private currentScopes: number[];
  private resources: { [key: number]: CnysaResource };
  private events: Array<{ timestamp: number, uid: number, type: string }>;
  private hook: ah.AsyncHook;
  private globalContinuationEnded = false;

  /**
   * Default options for getAsyncSnapshot.
   */
  public static ASYNC_SNAPSHOT_DEFAULTS: CnysaAsyncSnapshotOptions = {
    width: process.stdout.columns || 80,
    ignoreTypes: / /,
    roots: [],
    padding: 1,
    format: 'default'
  };

  /**
   * Gets the most recently constructed `Cnysa` instance. If none were
   * constructed, one is constructed automatically and returned. Therefore,
   * this method is guaranteed to return a `Cnysa` instance.
   * This is useful when it is unknown whether `cnysa` has been used earlier in
   * the application, especially as a command-line require.
   */
  public static get(): Cnysa {
    if (Cnysa.activeInstances.length === 0) {
      Cnysa.activeInstances.push(new Cnysa());
    }
    return Cnysa.activeInstances[Cnysa.activeInstances.length - 1];
  }

  /**
   * Constructs a new `Cnysa` instance.
   */
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

  /**
   * Starts recording async events.
   */
  enable() {
    this.hook.enable();
  }

  /**
   * Stops recording async events.
   */
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

  /**
   * Generate a special `AsyncResource` with the given tag. If `tag` is not
   * specified, a monotonically increasing number is assigned to it.
   * The special `AsyncResource` will be displayed as a single event.
   * @param tag The tag to uniquely identify this mark.
   */
  mark(tag?: string|number): void {
    if (tag === undefined) {
      tag = Cnysa.markHighWater++;
    }
    new ah.AsyncResource(`cnysa(${tag})`).emitDestroy();
  }

  /**
   * Returns a formatted `AsyncResource` ancestry tree from the events
   * collected so far.
   * @param options Options for how the ancestry tree should be displayed.
   */
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
