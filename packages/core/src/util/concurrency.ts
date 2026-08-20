/**
 * 有上限的并行 map，结果保持输入顺序。
 * 用来把「逐文件 spawn git」的循环压成几路并行，同时不至于一次开几十个进程。
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  // NaN 会一路穿过 Math.min/max 变成 Array.from({ length: NaN })，静默产出空结果
  const width = Number.isFinite(limit) ? Math.max(1, Math.min(limit, items.length)) : 1;
  const workers = Array.from({ length: width }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) {
        return;
      }
      out[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return out;
}
