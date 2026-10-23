import {createAdaptiveChunkSizer, createTransferBudget, TRANSFER_MIN_CHUNK_BYTES as MIN, TRANSFER_MAX_CHUNK_BYTES as MAX} from '../src/remote/adaptiveTransfer';

it('starts at 512 KiB and only probes larger chunks after stable measured samples', () => {
  const sizing = createAdaptiveChunkSizer();
  expect(sizing.next(MAX * 10)).toBe(MIN);
  sizing.observe(MIN, 100);
  expect(sizing.next(MAX * 10)).toBe(MIN);
  sizing.observe(MIN, 100);
  expect(sizing.next(MAX * 10)).toBe(MIN * 2);
  // Twice the bytes taking twice as long produces no throughput benefit.
  sizing.observe(MIN * 2, 200);
  expect(sizing.next(MAX * 10)).toBe(MIN);
});

it('can reach 8 MiB when measured throughput improves, never exceeds it and sends short tails as-is', () => {
  const sizing = createAdaptiveChunkSizer();
  const seen = new Set<number>();
  for (let i = 0; i < 20; i++) {
    const size = sizing.next(MAX * 10); seen.add(size);
    sizing.observe(size, 100, 10);
    expect(size).toBeLessThanOrEqual(MAX);
  }
  expect([...seen]).toEqual([MIN, MIN * 2, MIN * 4, MIN * 8, MAX]);
  expect(sizing.next(MAX * 10)).toBe(MAX);
  expect(sizing.next(17)).toBe(17);
  sizing.observe(17, 10000, 9000); // A tail is not a full-size rate sample.
  expect(sizing.next(MAX * 10)).toBe(MAX);
});

it.each(['network', 'processing', 'timeout'] as const)('backs off for %s pressure without falling below 512 KiB', kind => {
  const sizing = createAdaptiveChunkSizer();
  for (let i = 0; i < 20; i++) sizing.observe(sizing.next(MAX), 100, 1);
  expect(sizing.next(MAX)).toBe(MAX);
  if (kind === 'timeout') sizing.slow();
  else sizing.observe(MAX, kind === 'network' ? 2000 : 100, kind === 'processing' ? 200 : 1);
  expect(sizing.next(MAX)).toBe(MAX / 2);
  for (let i = 0; i < 20; i++) sizing.slow();
  expect(sizing.next(MAX)).toBe(MIN);
});

it('can cautiously probe higher again after a backoff and a stable cooldown', () => {
  const sizing = createAdaptiveChunkSizer();
  sizing.observe(MIN, 100); sizing.observe(MIN, 100); sizing.observe(2 * MIN, 200);
  expect(sizing.next(MAX)).toBe(MIN);
  for (let i = 0; i < 4; i++) sizing.observe(MIN, 100);
  expect(sizing.next(MAX)).toBe(MIN);
  for (let i = 0; i < 4; i++) sizing.observe(sizing.next(MAX), 100);
  expect(sizing.next(MAX)).toBe(2 * MIN);
});


it('does not treat queued older/smaller samples as evidence for the new chunk size', () => {
  const sizing = createAdaptiveChunkSizer();
  sizing.observe(MIN, 100); sizing.observe(MIN, 100);
  expect(sizing.next(MAX)).toBe(2 * MIN);
  sizing.observe(MIN, 10000, 10000);
  expect(sizing.next(MAX)).toBe(2 * MIN);
});

it('shares an 8 MiB raw in-flight budget, stays FIFO and releases idempotently', async () => {
  const budget = createTransferBudget();
  const releaseA = await budget.acquire(4 * MIN);
  const releaseB = await budget.acquire(4 * MIN);
  let full = false, small = false;
  const large = budget.acquire(MAX).then(release => {full = true; return release;});
  const short = budget.acquire(MIN).then(release => {small = true; return release;});
  await Promise.resolve(); expect(full).toBe(false); expect(small).toBe(false);
  releaseA(); releaseA(); await Promise.resolve(); expect(full).toBe(false);
  releaseB(); const releaseLarge = await large;
  expect(full).toBe(true); expect(small).toBe(false);
  releaseLarge(); const releaseSmall = await short; expect(small).toBe(true); releaseSmall();
  const again = await budget.acquire(MAX); again();
  await expect(budget.acquire(MAX + 1)).rejects.toMatchObject({code: 'remote_transfer_capacity'});
});
