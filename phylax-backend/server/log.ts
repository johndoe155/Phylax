/**
 * A very small structured logger.
 *
 * One JSON object per line, on stdout, so `journalctl -u phylax` reads well and a log shipper can parse it. The
 * alternative — pretty console output — is nicer while developing and useless at 3 a.m. on a VM with no console.
 *
 * Error detail is KEPT. An earlier revision replaced every `error` field with the string "operation_failed",
 * which made startup failures, migration failures, OAuth failures and unhandled errors indistinguishable in the
 * log — exactly the lines an operator needs at 3 a.m. What is redacted is SECRET material: values whose key looks
 * like a credential, and anything an Error carries that might embed one (a connection string in a pg error, for
 * instance). Everything else — message, name, code, stack — is written.
 */

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

let threshold: number = ORDER.info;

export function setLogLevel(level: LogLevel) {
  threshold = ORDER[level] ?? ORDER.info;
}

const SECRET_KEY =
  /password|passwd|secret|token|cookie|authorization|api[-_]?key|private[-_]?key|credential|session[-_]?id|\bto\b|\brecipient\b|\bemail\b|\bphone\b|\bbody\b|\bquery\b|\bconnectionstring\b/i;

/** A value that must never reach the log, whatever it is. */
function redact(value: unknown): unknown {
  return typeof value === "string" ? "[redacted]" : "[redacted]";
}

/** Connection strings carry passwords; they are reduced to a shape description. Public URLs are kept. */
function scrubSecrets(text: string): string {
  return text
    // A URL with credentials in it (postgres://user:pass@host, https://user:pass@host) loses them.
    .replace(/\b([a-z][a-z0-9+.-]*):\/\/[^\s/:_"']+:[^\s/@"']+@/gi, "$1://[redacted]@")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[redacted-email]")
    .replace(/\+\d[\d\s-]{6,}\d/g, "[redacted-phone]");
}

/**
 * Turn an unknown thrown value into something loggable.
 *
 * The point of this function is that `{ error: err }` used to become "operation_failed". Now an Error keeps its
 * message, its name, its code and its stack, with secret-looking substrings scrubbed; a non-Error keeps its
 * string form. Callers that want to log a plain reason string (`{ error: sent.error }`) still work.
 */
export function describeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const out: Record<string, unknown> = {
      name: err.name,
      message: scrubSecrets(err.message).slice(0, 1000),
    };
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" || typeof code === "number") out.code = code;
    const constraint = (err as { constraint?: unknown }).constraint;
    if (typeof constraint === "string") out.constraint = constraint;
    const table = (err as { table?: unknown }).table;
    if (typeof table === "string") out.table = table;
    if (err.stack) out.stack = scrubSecrets(err.stack).slice(0, 4000);
    return out;
  }
  if (typeof err === "string") return { message: scrubSecrets(err).slice(0, 1000) };
  if (err && typeof err === "object") {
    try {
      return { message: scrubSecrets(JSON.stringify(err)).slice(0, 1000) };
    } catch {
      return { message: "[unserializable error object]" };
    }
  }
  return { message: String(err) };
}

function sanitize(fields: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SECRET_KEY.test(key)) {
      safe[key] = redact(value);
      continue;
    }
    if (key === "error" || key === "reason" || key === "err") {
      safe[key] = value instanceof Error || (value && typeof value === "object") ? describeError(value) : scrubSecrets(String(value)).slice(0, 1000);
      continue;
    }
    if (value instanceof Error) {
      safe[key] = describeError(value);
      continue;
    }
    safe[key] = typeof value === "string" ? scrubSecrets(value).slice(0, 500) : value;
  }
  return safe;
}

function emit(level: Exclude<LogLevel, "silent">, msg: string, fields?: Record<string, unknown>) {
  if (ORDER[level] < threshold) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...sanitize(fields ?? {}),
  });
  if (level === "error" || level === "warn") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
};

/** A child logger that stamps every line with the same fields (a request id, an account id...). */
export function childLogger(bound: Record<string, unknown>) {
  return {
    debug: (msg: string, fields?: Record<string, unknown>) => emit("debug", msg, { ...bound, ...fields }),
    info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, { ...bound, ...fields }),
    warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, { ...bound, ...fields }),
    error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, { ...bound, ...fields }),
  };
}

export type Logger = ReturnType<typeof childLogger>;
