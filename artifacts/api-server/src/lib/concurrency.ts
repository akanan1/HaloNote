// Tiny p-limit-style concurrency cap. Used by the bulk-approve push to
// keep HaloNote within Athena's per-second rate budget (the Partner
// Tech Spec we filled out lists 100/sec prod / 15/sec preview).
//
// Why not a real dependency? p-limit pulls in additional code and the
// minimumReleaseAge gate would block fresh versions for 24 hours. This
// is 30 LOC and does exactly what we need — Promise.allSettled with a
// max-in-flight window.
//
// Usage:
//   const results = await mapWithLimit(rows, 8, async (row) => push(row));
//   // results: Array<{status:'fulfilled',value}|{status:'rejected',reason}>

export interface SettledResult<T> {
  status: "fulfilled" | "rejected";
  value?: T;
  reason?: unknown;
}

export async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<SettledResult<R>[]> {
  if (limit <= 0) throw new Error("mapWithLimit: limit must be > 0");
  const results: SettledResult<R>[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = nextIndex++;
      if (i >= items.length) return;
      try {
        const value = await fn(items[i]!, i);
        results[i] = { status: "fulfilled", value };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
