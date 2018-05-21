export type StackTrace = NodeJS.CallSite[];

/**
 * Creates a stack trace.
 */
export function createStackTrace(): StackTrace {
  const prevLimit = Error.stackTraceLimit;
  Error.stackTraceLimit = Infinity;

  const prevPrepare = Error.prepareStackTrace;
  Error.prepareStackTrace = (error: Error, callSites: StackTrace) => callSites;
  const e: {stack?: StackTrace} = {};
  Error.captureStackTrace(e);

  try {
    return e.stack!;
  } finally {
    Error.stackTraceLimit = prevLimit;
    Error.prepareStackTrace = prevPrepare;
  }
}

// function isEqual(a: NodeJS.CallSite, b: NodeJS.CallSite) {
//   return a.getFunctionName() === b.getFunctionName() &&
//     a.getFileName() === b.getFileName() &&
//     a.getLineNumber() === b.getLineNumber();
// }

// /**
//  * Determines the index at which frames in the short stack trace start appearing
//  * in the tall stack trace.
//  * @param tall A stack trace.
//  * @param short A stack trace.
//  */
// export function correlateStackTraces(tall: StackTrace, short: StackTrace): number {
//   if (tall.length < short.length) {
//     return correlateStackTraces(short, tall);
//   }
//   const stackDiff = tall.length - short.length;
//   for (let s = short.length - 1; s >= 0; s--) {
//     const t = s;
//     if (!isEqual(tall[t], short[s])) {
//       return t;
//     }
//   }
//   return -1;
// }
