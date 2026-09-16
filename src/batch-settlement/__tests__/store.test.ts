import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createFileChannelStore,
  createLocalStorageChannelStore,
  getDefaultChannelStore,
} from '../store';

/** A representative upstream channel context value. */
const channelId = `0x${'ab'.repeat(32)}`;
const missingChannelId = `0x${'cd'.repeat(32)}`;
const sampleContext = { balance: '300000', chargedCumulativeAmount: '160000' };

/** Minimal in-memory localStorage stand-in for tests. */
function fakeLocalStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    clear() { map.clear(); },
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    key: (i) => Array.from(map.keys())[i] ?? null,
    removeItem: (k) => { map.delete(k); },
    setItem: (k, v) => { map.set(k, v); },
  };
}

describe('createFileChannelStore', () => {
  it('rejects malformed channel paths before reading or writing files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bs-store-'));
    try {
      const store = createFileChannelStore(dir);
      for (const key of ['../outside', '0xchan', `0x${'zz'.repeat(32)}`]) {
        await expect(store.get(key)).rejects.toThrow('channel_id');
        await expect(store.set(key, sampleContext)).rejects.toThrow('channel_id');
        await expect(store.delete(key)).rejects.toThrow('channel_id');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('round-trips a channel context through get/set/delete', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bs-store-'));
    try {
      const store = createFileChannelStore(dir);
      await store.set(channelId, sampleContext);
      expect(await store.get(channelId)).toEqual(sampleContext);
      await store.delete(channelId);
      expect(await store.get(channelId)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('get of a missing key returns undefined', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bs-store-'));
    try {
      expect(await createFileChannelStore(dir).get(missingChannelId)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('delete of a missing key does not throw', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bs-store-'));
    try {
      await expect(createFileChannelStore(dir).delete(missingChannelId)).resolves.toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('createLocalStorageChannelStore', () => {
  it('round-trips a channel context via a Storage object', async () => {
    const store = createLocalStorageChannelStore(fakeLocalStorage());
    await store.set(channelId, sampleContext);
    expect(await store.get(channelId)).toEqual(sampleContext);
    await store.delete(channelId);
    expect(await store.get(channelId)).toBeUndefined();
  });

  it('get of a missing key returns undefined', async () => {
    expect(await createLocalStorageChannelStore(fakeLocalStorage()).get(missingChannelId))
      .toBeUndefined();
  });
});

describe('getDefaultChannelStore', () => {
  it('returns a ClientChannelStorage-shaped object in the node test environment', () => {
    const store = getDefaultChannelStore();
    expect(typeof store.get).toBe('function');
    expect(typeof store.set).toBe('function');
    expect(typeof store.delete).toBe('function');
  });
});
