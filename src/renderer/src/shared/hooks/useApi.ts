/**
 * Small helpers for calling `window.api` with loading/error/data state.
 * Every call is guarded so a missing or partially-implemented backend never
 * white-screens the UI.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { IpcApi } from '@shared/contracts/ipc';

/** Safe accessor for the (possibly undefined) injected api. */
export function getApi(): IpcApi | undefined {
  return typeof window !== 'undefined' ? window.api : undefined;
}

export interface AsyncState<T> {
  data: T | undefined;
  loading: boolean;
  error: string | undefined;
  /** Re-run the fetcher. */
  reload: () => void;
  /** Imperatively replace the cached data (e.g. for live merges). */
  setData: (updater: T | ((prev: T | undefined) => T)) => void;
}

/**
 * Runs an async fetcher on mount and whenever a dependency in `deps` changes.
 * Returns data/loading/error plus a manual reload + setData.
 */
export function useApi<T>(
  fetcher: () => Promise<T>,
  deps: ReadonlyArray<unknown>,
  options: { enabled?: boolean } = {},
): AsyncState<T> {
  const enabled = options.enabled ?? true;
  const [data, setDataState] = useState<T | undefined>(undefined);
  const [loading, setLoading] = useState<boolean>(enabled);
  const [error, setError] = useState<string | undefined>(undefined);
  const [nonce, setNonce] = useState(0);

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    void (async () => {
      try {
        const result = await fetcherRef.current();
        if (!cancelled) setDataState(result);
      } catch (err) {
        if (!cancelled) setError(toMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, nonce, ...deps]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const setData = useCallback(
    (updater: T | ((prev: T | undefined) => T)) => {
      setDataState((prev) =>
        typeof updater === 'function'
          ? (updater as (p: T | undefined) => T)(prev)
          : updater,
      );
    },
    [],
  );

  return { data, loading, error, reload, setData };
}

export interface MutationState {
  run: <T>(fn: () => Promise<T>) => Promise<T | undefined>;
  loading: boolean;
  error: string | undefined;
  reset: () => void;
}

/** For imperative one-off calls (save, delete, test, dismiss, …). */
export function useMutation(): MutationState {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const run = useCallback(async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
    setLoading(true);
    setError(undefined);
    try {
      return await fn();
    } catch (err) {
      setError(toMessage(err));
      return undefined;
    } finally {
      setLoading(false);
    }
  }, []);

  const reset = useCallback(() => setError(undefined), []);
  return { run, loading, error, reset };
}

function toMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'Unexpected error';
}
