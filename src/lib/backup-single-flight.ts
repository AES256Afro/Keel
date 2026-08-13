const runtime = globalThis as unknown as {
  __keelBackupTickPromise?: Promise<void>;
};

/** Run at most one backup scheduler tick at a time. Returning the existing
 * promise lets callers await completion without starting a duplicate loop. */
export function singleFlightBackupTick(work: () => Promise<void>): Promise<void> {
  if (runtime.__keelBackupTickPromise) return runtime.__keelBackupTickPromise;
  const current = work();
  runtime.__keelBackupTickPromise = current;
  const clear = () => {
    if (runtime.__keelBackupTickPromise === current) {
      delete runtime.__keelBackupTickPromise;
    }
  };
  void current.then(clear, clear);
  return current;
}
