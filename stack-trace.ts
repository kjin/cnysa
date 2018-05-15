/**
 * Creates a stack trace.
 */
export function createStackTrace(): NodeJS.CallSite[] {
  const prevLimit = Error.stackTraceLimit;
  Error.stackTraceLimit = Infinity;

  const prevPrepare = Error.prepareStackTrace;
  Error.prepareStackTrace = (error: Error, callSites: NodeJS.CallSite[]) => callSites;
  const e: {stack?: NodeJS.CallSite[]} = {};
  Error.captureStackTrace(e);

  try {
    return e.stack!;
  } finally {
    Error.stackTraceLimit = prevLimit;
    Error.prepareStackTrace = prevPrepare;
  }
}
