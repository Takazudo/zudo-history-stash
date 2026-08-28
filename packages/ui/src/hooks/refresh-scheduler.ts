export type RefreshTask = () => void | Promise<void>;

/**
 * Coalesces refresh work independently for each key. A busy key retains only the newest trailing
 * task, so bursts can produce one active refresh and at most one follow-up refresh.
 */
export interface RefreshScheduler<Key> {
  schedule(key: Key, task: RefreshTask): void;
  close(): void;
}

interface RefreshSlot {
  trailing: RefreshTask | null;
}

/** Creates a scheduler whose task failures release their key instead of wedging later refreshes. */
export function createRefreshScheduler<Key>(): RefreshScheduler<Key> {
  const slots = new Map<Key, RefreshSlot>();
  let closed = false;

  const run = (key: Key, slot: RefreshSlot, task: RefreshTask): void => {
    void Promise.resolve()
      .then(() => {
        if (closed || slots.get(key) !== slot) return;
        return task();
      })
      .catch(() => {
        // Refreshes are advisory. Their owner reports request errors; the scheduler only preserves
        // liveness and must always release the key for a later retry.
      })
      .finally(() => {
        if (closed || slots.get(key) !== slot) return;
        const trailing = slot.trailing;
        if (trailing === null) {
          slots.delete(key);
          return;
        }
        slot.trailing = null;
        run(key, slot, trailing);
      });
  };

  return {
    schedule(key, task) {
      if (closed) return;
      const active = slots.get(key);
      if (active !== undefined) {
        active.trailing = task;
        return;
      }

      const slot: RefreshSlot = { trailing: null };
      slots.set(key, slot);
      run(key, slot, task);
    },
    close() {
      if (closed) return;
      closed = true;
      slots.clear();
    },
  };
}
