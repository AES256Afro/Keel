"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type SaveState = "saved" | "saving" | "error";

const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The autosave engine, kept free of React so its ordering guarantee can be
 * tested directly - see scripts/autosave-check.mjs.
 *
 * ORDERING GUARANTEE
 * ------------------
 * 1. **One request at a time.** At most one save is on the wire per runner.
 *    A flush() that arrives while a run is active joins that run instead of
 *    starting a second one, so two bodies for the same document can never be
 *    in flight together and an older body can never commit after a newer one.
 * 2. **Every send carries the newest content.** The body is read from the
 *    buffer at the instant of the send, never captured beforehand. A retry
 *    therefore re-sends whatever the user has typed *by then* - never the
 *    stale snapshot whose send failed. Content is only ever superseded by
 *    newer content; it is never overwritten by older content.
 * 3. **"saved" means the server has everything.** The buffer is cleared, and
 *    "saved" reported, only when the body the server just acknowledged is
 *    still the whole of what the user has typed. If anything was buffered
 *    while the request was in flight, the runner stays "saving" and sends the
 *    newer body before claiming anything - so the indicator (and the
 *    beforeunload warning, which reads the same buffer) can never say "Saved"
 *    over content that was never transmitted.
 *
 * The previous implementation broke (1), (2) and (3): flush() captured the
 * buffer once, before its retry loop, and only invalidated a run when a *newer
 * flush* had started. Keystrokes landing during the backoff left the retry
 * re-sending the old body while the debounce timer sent the new one - two
 * writes racing, last commit wins, and the loser was frequently the newer
 * text. The user watched it being typed and the indicator said "Saved".
 */
interface AutosaveDeps {
  save: (value: string) => Promise<Response>;
  /** Read per run, so a changed prop applies to the next save. */
  retries: () => number;
  report: (state: SaveState, error: string | null) => void;
  /** Injectable so tests don't wait out the backoff. */
  sleep?: (ms: number) => Promise<unknown>;
}

export class AutosaveRunner {
  /** The newest content the user has produced that the server has not ack'd. */
  private buffered: string | null = null;
  /** The run currently on the wire, if any. Enforces single-flight. */
  private active: Promise<void> | null = null;

  /** Written out rather than a parameter property: the unit tests import this
   *  file with Node's strip-only TypeScript support, which rejects those. */
  private readonly deps: AutosaveDeps;

  constructor(deps: AutosaveDeps) {
    this.deps = deps;
  }

  /** Buffer newer content. It supersedes anything not yet acknowledged. */
  buffer(value: string) {
    this.buffered = value;
  }

  /** True while content exists that the server has not acknowledged. */
  get unsaved(): boolean {
    return this.buffered !== null;
  }

  /**
   * Send the buffer, retrying with backoff.
   *
   * Returns the in-flight run if there is one: the caller's content is already
   * in the buffer, and the run re-reads the buffer before every send, so it
   * will carry that content. Starting a second run instead would put two
   * bodies on the wire - the race this whole class exists to prevent.
   */
  flush(): Promise<void> {
    if (this.active) return this.active;
    const run = this.drain().finally(() => {
      this.active = null;
    });
    this.active = run;
    return run;
  }

  private async drain(): Promise<void> {
    const sleep = this.deps.sleep ?? nap;
    const retries = Math.max(0, this.deps.retries());

    // Keep going while the buffer holds content the server hasn't taken. Each
    // pass sends the CURRENT buffer, so content typed mid-flight is picked up
    // by the next pass rather than lost or overtaken.
    while (this.buffered !== null) {
      const value = this.buffered;
      this.deps.report("saving", null);
      let acknowledged = false;

      for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt > 0) await sleep(500 * 2 ** (attempt - 1));
        // Superseded while we waited. Abandon this body - re-sending it would
        // be exactly the stale write we must never issue - and start over
        // with what the user has now.
        if (this.buffered !== value) break;

        try {
          const res = await this.deps.save(value);
          if (res.ok) {
            acknowledged = true;
            break;
          }
          const body = await res.json().catch(() => ({}));
          // 4xx will not fix itself - stop retrying and say so.
          if (res.status >= 400 && res.status < 500) {
            this.deps.report("error", body.error ?? `Save rejected (${res.status})`);
            return;
          }
          if (attempt === retries) {
            this.deps.report("error", body.error ?? `Save failed (${res.status})`);
          }
        } catch (err) {
          if (attempt === retries) {
            this.deps.report("error", err instanceof Error ? err.message : "Could not save");
          }
        }
      }

      if (!acknowledged) {
        // Out of attempts. If newer content arrived meanwhile it deserves its
        // own attempt - loop. Otherwise the error stands until Try again or
        // the next keystroke, with the buffer intact so nothing is lost.
        if (this.buffered === value) return;
        continue;
      }

      if (this.buffered === value) {
        // The server has everything. This is the only place the buffer is
        // cleared and the only place "saved" is claimed.
        this.buffered = null;
        this.deps.report("saved", null);
        return;
      }
      // Newer keystrokes landed while this was in flight: stay "saving" and
      // send them before claiming anything.
    }
  }
}

/**
 * Debounced autosave that tells the truth.
 *
 * The first implementation flipped the indicator to "Saved" as soon as the
 * request settled, whatever the response said - so a 413, a 403 or a dropped
 * connection looked identical to success, and the page you thought you'd
 * written was gone on reload. It also let you close the tab mid-save.
 *
 * This one:
 *   • reports failure, and keeps reporting it until a save succeeds,
 *   • retries with backoff, because the usual cause is a momentary blip,
 *   • never lets a retry re-send content older than what you have typed
 *     (see AutosaveRunner's ordering guarantee above),
 *   • warns before unload while anything is unsaved,
 *   • flushes on unmount, so navigating away doesn't drop the last keystrokes.
 */
export function useAutosave(
  save: (value: string) => Promise<Response>,
  { delay = 700, retries = 3 }: { delay?: number; retries?: number } = {}
) {
  const [state, setState] = useState<SaveState>("saved");
  const [error, setError] = useState<string | null>(null);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveRef = useRef(save);
  const retriesRef = useRef(retries);

  useEffect(() => {
    saveRef.current = save;
  }, [save]);
  useEffect(() => {
    retriesRef.current = retries;
  }, [retries]);

  // One runner for the life of the component. Single-flight is per runner, so
  // it must survive a changed `save` identity (the callers rebuild that
  // closure on every render) - the current callback is read through a ref.
  const [runner] = useState(
    // The runner stores these closures and only ever calls them from a timer,
    // an event handler or an effect - never during render - so reading the
    // refs inside them is the legal use the lint rule cannot see. (The
    // alternative, rebuilding the runner when `save` changes identity, would
    // hand out a fresh buffer per render and destroy the single-flight
    // guarantee this class exists for.)
    // eslint-disable-next-line react-hooks/refs
    () =>
      new AutosaveRunner({
        save: (value) => saveRef.current(value),
        retries: () => retriesRef.current,
        report: (next, message) => {
          setState(next);
          setError(message);
        },
      })
  );

  const schedule = useCallback(
    (value: string) => {
      runner.buffer(value);
      setState("saving");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void runner.flush(), delay);
    },
    [delay, runner]
  );

  // Don't let the tab close over unsaved work.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!runner.unsaved && state !== "error") return;
      e.preventDefault();
      // Browsers show their own wording; a non-empty return is the signal.
      e.returnValue = "";
      return "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [runner, state]);

  // Navigating within the app unmounts the editor; flush rather than drop.
  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
      void runner.flush();
    };
  }, [runner]);

  /** Retry now, for the "Try again" affordance. */
  const retry = useCallback(() => void runner.flush(), [runner]);

  return { state, error, schedule, retry };
}
