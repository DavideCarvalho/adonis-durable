/** A step body that throws once, then returns `value` — drives a retry, or a crash-then-resume. */
export function failOnce<T>(
  value: T,
  error: Error = new Error('injected failure'),
): () => Promise<T> {
  return failTimes(1, value, error);
}

/** A step body that throws the first `n` times, then returns `value`. */
export function failTimes<T>(
  n: number,
  value: T,
  error: Error = new Error('injected failure'),
): () => Promise<T> {
  let calls = 0;
  return async () => {
    calls += 1;
    if (calls <= n) throw error;
    return value;
  };
}
