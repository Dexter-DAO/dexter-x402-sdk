import { homedir } from 'node:os';
import { join } from 'node:path';
import { FileClientChannelStorage } from '@x402/evm/batch-settlement/client';
import type { ChannelStore } from './types';

/**
 * File-backed ChannelStore for Node. This is the upstream FileClientChannelStorage,
 * which persists each channel context as a JSON file under `{root}/client/`.
 */
export function createFileChannelStore(root: string): ChannelStore {
  return new FileClientChannelStorage({ directory: root });
}

const LS_PREFIX = 'dexter-x402-channel:';

/**
 * localStorage-backed ChannelStore for browsers. Channel contexts are stored
 * under a prefixed key so they never collide with other localStorage entries.
 * Implements the upstream ClientChannelStorage interface (get / set / delete).
 */
export function createLocalStorageChannelStore(storage: Storage): ChannelStore {
  return {
    async get(key) {
      const raw = storage.getItem(LS_PREFIX + key);
      return raw ? JSON.parse(raw) : undefined;
    },
    async set(key, context) {
      storage.setItem(LS_PREFIX + key, JSON.stringify(context));
    },
    async delete(key) {
      storage.removeItem(LS_PREFIX + key);
    },
  };
}

/**
 * Returns the environment-appropriate default ChannelStore: localStorage in a
 * browser, a file store at ~/.dexter-x402/channels in Node.
 */
export function getDefaultChannelStore(): ChannelStore {
  const ls = (globalThis as { localStorage?: Storage }).localStorage;
  if (ls) return createLocalStorageChannelStore(ls);
  return createFileChannelStore(join(homedir(), '.dexter-x402', 'channels'));
}
