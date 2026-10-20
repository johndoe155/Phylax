import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { AccountError, type AccountMeta, type AccountProfile } from "@/lib/account";
import { useToast } from "./toasts";

export type ActState = "idle" | "busy" | "done";

export interface RunOptions<T> {
  /** Toast shown when the call succeeds. Return undefined to stay quiet. */
  success?: string | ((value: T) => string | undefined);
  /** Don't toast a failure: the caller pins it under the input itself (it still gets `error` back). */
  quiet?: boolean;
}
export type RunResult<T> = { ok: true; value: T } | { ok: false; error: unknown };

export interface AccountContextValue {
  profile: AccountProfile;
  meta: AccountMeta;
  /** Replace the profile with what the server just returned. */
  applyProfile: (profile: AccountProfile) => void;
  /** Fetch the profile again without any loading UI (a link opened elsewhere, a tab coming back). */
  refreshProfile: () => void;
  /** Keep refreshing the profile every few seconds for `ms` (waiting for an emailed link to be opened). */
  watchProfile: (ms: number) => void;
  /** Run an async action with busy / done button state and a result toast. Ignored while the same key is already busy. */
  run: <T,>(key: string, task: (signal: AbortSignal) => Promise<T>, options?: RunOptions<T>) => Promise<RunResult<T>>;
  stateOf: (key: string) => ActState;
  /** Scroll to and focus the "Confirm it's you" section. */
  goToReauth: () => void;
  /** Milliseconds of re-authentication left (ticks once a second while there is some). */
  reauthLeft: number;
}

const AccountContext = createContext<AccountContextValue | null>(null);
export const AccountProvider = AccountContext.Provider;

export function useAccount(): AccountContextValue {
  const value = useContext(AccountContext);
  if (!value) throw new Error("useAccount must be used inside the account page");
  return value;
}

/** The message a person should read for any failure. A network error never shows its raw text. */
export function messageFor(error: unknown): string {
  if (error instanceof AccountError) return error.message;
  return "Couldn't reach Phylax. Check your connection and try again.";
}

export const isAbort = (error: unknown) => error instanceof DOMException && error.name === "AbortError";

/** What `run` hands back when the same action is already in flight. Nothing to show for it. */
export class BusyError extends Error {
  constructor() { super("busy"); this.name = "BusyError"; }
}

/**
 * The text to pin under an input after a `quiet` run failed, or null when there is nothing to say: the person left
 * (abort), the press was a duplicate (busy), or it was a re-authentication prompt (the runner already toasted that).
 */
export function inlineMessage(error: unknown): string | null {
  if (isAbort(error) || error instanceof BusyError) return null;
  if (error instanceof AccountError && error.code === "reauth-required") return null;
  return messageFor(error);
}

const DONE_MS = 1700;

/** Busy / done state per action key, plus the runner that toasts the result. One controller aborts everything on unmount. */
export function useActionRunner(goToReauth: () => void) {
  const toast = useToast();
  const [states, setStates] = useState<Record<string, ActState>>({});
  const busy = useRef(new Set<string>());
  const timers = useRef<Record<string, number>>({});
  const life = useRef<AbortController>(new AbortController());
  const alive = useRef(true);
  const reauthRef = useRef(goToReauth);
  reauthRef.current = goToReauth;

  useEffect(() => {
    alive.current = true;
    // A fresh controller each mount: React's strict mode runs mount, unmount, mount, and the second pass must not inherit an aborted signal.
    life.current = new AbortController();
    const pending = timers.current;
    return () => {
      alive.current = false;
      life.current.abort();
      Object.values(pending).forEach((timer) => window.clearTimeout(timer));
    };
  }, []);

  const set = useCallback((key: string, state: ActState) => {
    if (alive.current) setStates((all) => (all[key] === state ? all : { ...all, [key]: state }));
  }, []);

  const run = useCallback(async function runAction<T>(key: string, task: (signal: AbortSignal) => Promise<T>, options: RunOptions<T> = {}): Promise<RunResult<T>> {
    if (busy.current.has(key)) return { ok: false, error: new BusyError() };
    busy.current.add(key);
    window.clearTimeout(timers.current[key]);
    set(key, "busy");
    try {
      const value = await task(life.current.signal);
      busy.current.delete(key);
      set(key, "done");
      timers.current[key] = window.setTimeout(() => set(key, "idle"), DONE_MS);
      const message = typeof options.success === "function" ? options.success(value) : options.success;
      if (message && alive.current) toast({ tone: "success", message });
      return { ok: true, value };
    } catch (error) {
      busy.current.delete(key);
      set(key, "idle");
      if (isAbort(error)) return { ok: false, error };
      if (alive.current) {
        if (error instanceof AccountError && error.code === "reauth-required") {
          toast({ tone: "error", message: error.message, action: { label: "Confirm it's you", onClick: () => reauthRef.current() } });
        } else if (!options.quiet) {
          toast({ tone: "error", message: messageFor(error) });
        }
      }
      return { ok: false, error };
    }
  }, [set, toast]);

  const stateOf = useCallback((key: string): ActState => states[key] ?? "idle", [states]);
  return { run, stateOf };
}

/** A copy of `source` the person can edit. It starts over whenever the server's value changes, and says whether it differs. */
export function useDraft<T>(source: T) {
  const key = JSON.stringify(source);
  const [draft, setDraft] = useState<T>(source);
  const lastKey = useRef(key);
  if (lastKey.current !== key) {
    lastKey.current = key;
    setDraft(source);
  }
  const dirty = JSON.stringify(draft) !== key;
  const reset = useCallback(() => setDraft(source), [source]);
  return { draft, setDraft, dirty, reset } as const;
}
