"use client";

import { useCallback, useEffect, useRef } from "react";

/**
 * Debounce a callback; the latest invocation wins. Flushes nothing on unmount.
 *
 * The callback is kept in a ref so the returned function is stable even when
 * the caller passes a fresh closure each render - but the ref is written in an
 * effect, never during render. Mutating a ref while rendering is unsafe under
 * concurrent rendering: a render that React throws away would still have
 * changed the ref, so a later committed render can call a callback that was
 * never committed.
 */
export function useDebounced<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  const fnRef = useRef(fn);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    fnRef.current = fn;
  }, [fn]);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  return useCallback(
    (...args: A) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => fnRef.current(...args), ms);
    },
    [ms]
  );
}
