import {createConversationMessageRefresh} from '../src/hooks/conversationMessageRefresh';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return {promise, resolve};
}
async function flush() { for (let index = 0; index < 6; index += 1) await Promise.resolve(); }

it('catalog invalidations during an active read cause one fresh trailing scan', async () => {
 const first = deferred(); const read = jest.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
 const refresh = createConversationMessageRefresh(read);
 const initial = refresh.request('desktop-fixture');
 const invalidations = Array.from({length: 40}, () => refresh.request('desktop-fixture'));
 expect(read).toHaveBeenCalledTimes(1);
 first.resolve(); await initial; await Promise.all(invalidations);
 expect(read).toHaveBeenCalledTimes(2);
 refresh.cancel();
});

describe('message-page reads are coalesced, never concurrent', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('collapses a burst to one trailing read and terminal forces fresh data after the active read', async () => {
    const first = deferred();
    const final = deferred();
    const read = jest.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(final.promise).mockResolvedValue(undefined);
    const refresh = createConversationMessageRefresh(read);
    const initial = refresh.request('conversation-A');
    const burst = Array.from({length: 100}, () => refresh.request('conversation-A', false));
    expect(read).toHaveBeenCalledTimes(1);
    first.resolve(); await initial; await flush();
    expect(read).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(799);
    expect(read).toHaveBeenCalledTimes(1);
    const terminal = refresh.request('conversation-A');
    expect(read).toHaveBeenCalledTimes(2);
    final.resolve(); await terminal; await Promise.all(burst); await flush();
    expect(read).toHaveBeenCalledTimes(2);
    refresh.cancel();
  });

  it('never runs two requests at once even when a slow read exceeds its interval', async () => {
    const pending = deferred();
    const read = jest.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(undefined);
    const refresh = createConversationMessageRefresh(read);
    const first = refresh.request('conversation-A');
    const second = refresh.request('conversation-A', false);
    await jest.advanceTimersByTimeAsync(3000);
    expect(read).toHaveBeenCalledTimes(1);
    pending.resolve(); await first; await second; await flush();
    expect(read).toHaveBeenCalledTimes(2);
    refresh.cancel();
  });

  it('cancels a pending trailing read and does not refresh an old conversation after a switch', async () => {
    const read = jest.fn().mockResolvedValue(undefined);
    const refresh = createConversationMessageRefresh(read);
    await refresh.request('conversation-A'); await flush();
    const old = refresh.request('conversation-A', false);
    refresh.cancel(); await old;
    await jest.advanceTimersByTimeAsync(2000);
    expect(read).toHaveBeenCalledTimes(1);
    await refresh.request('conversation-B'); await flush();
    expect(read.mock.calls.map(([id]) => id)).toEqual(['conversation-A', 'conversation-B']);
    refresh.cancel();
  });

  it('keeps the scheduler usable after a failed read', async () => {
    const read = jest.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    const refresh = createConversationMessageRefresh(read);
    await expect(refresh.request('conversation-A')).rejects.toThrow('offline'); await flush();
    await refresh.request('conversation-A'); await flush();
    expect(read).toHaveBeenCalledTimes(2);
    refresh.cancel();
  });
});
