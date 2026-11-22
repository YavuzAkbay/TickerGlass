/** Errors of the script host (re-exported by `host.ts`). */

export type FaultKind = 'timeout' | 'memory' | 'crash' | 'cpu' | 'capacity';

/**
 * The script cannot run now. `reason` is what an alert's status says.
 * `transient`: the cause goes away by itself (a fault's back-off window), so
 * its alerts wait instead of ending in `error`; false for deterministic
 * problems (compile error, deleted, manifest mismatch, no runtime).
 */
export class ScriptUnavailable extends Error {
  constructor(
    readonly scriptId: string,
    readonly reason: string,
    readonly transient = false,
  ) {
    super(reason);
    this.name = 'ScriptUnavailable';
  }
}

/**
 * The isolate was just disposed because of a fault or a counted tick timeout.
 * `retryAt` (clock ms) is when the script may run again; `final` = escalated:
 * its alerts end in `error`.
 */
export class ScriptFault extends ScriptUnavailable {
  constructor(
    scriptId: string,
    readonly kind: FaultKind,
    reason: string,
    readonly retryAt: number,
    readonly final: boolean,
  ) {
    super(scriptId, reason, !final);
    this.name = 'ScriptFault';
  }
}

/** The isolate was replaced or disposed on purpose (script edited, deleted, host stopping) while a call ran. */
export class ScriptSuperseded extends ScriptUnavailable {
  constructor(scriptId: string) {
    super(scriptId, 'script restarted', true);
    this.name = 'ScriptSuperseded';
  }
}

/** A call failed without killing the isolate (script error outside the runtime, or a malformed result). */
export class ScriptCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScriptCallError';
  }
}

/**
 * A live update timed out, but not often enough yet for a fault: the isolate stays up
 * and only the series that timed out must start over (its state inside may be half-updated).
 */
export class ScriptStrike extends ScriptCallError {
  constructor(
    readonly scriptId: string,
    readonly strikes: number,
    message: string,
  ) {
    super(message);
    this.name = 'ScriptStrike';
  }
}

/** What is known about one death of the process the isolates live in. */
export interface CrashInfo {
  /** Counts crashes of this process manager. */
  id: number;
  /** Scripts that had a request (call or isolate creation) in flight when it died. */
  scripts: ReadonlySet<string>;
  /** The script the service holds responsible (the largest isolate when the process was killed for memory). */
  blame: string | null;
  cause: 'exit' | 'memory' | 'ping' | 'protocol' | 'stopping';
}

/** The process the isolates live in stopped (aborted, was killed, or stopped answering) while a call was in flight. */
export class ScriptCrashed extends Error {
  constructor(
    message: string,
    readonly crash: CrashInfo | null = null,
  ) {
    super(message);
    this.name = 'ScriptCrashed';
  }
}

/** The script process has no room for another isolate (and none to give up): nothing crashed, the alerts wait. */
export class ScriptCapacity extends Error {
  constructor() {
    super('too many scripts in use — raise ALERTS_SCRIPT_PROCESS_MB (and the container mem_limit)');
    this.name = 'ScriptCapacity';
  }
}
