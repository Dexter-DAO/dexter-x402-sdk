/**
 * Voucher persistence for the seller side.
 *
 * The seller's middleware accepts a fresh voucher per chunk and overwrites
 * the previous one — only the latest cumulative voucher matters for
 * settlement. Persistence exists so a process crash mid-stream doesn't
 * lose the last few seconds of accrued revenue.
 *
 * Two implementations:
 *   - InMemoryVoucherStore — zero-config default. Loses state on restart.
 *   - FileVoucherStore — writes one JSON file per channel id. Survives
 *     restarts; cheap enough for low-concurrency sellers.
 *
 * Production sellers expecting high concurrency or atomic restart-recovery
 * can implement VoucherStore themselves (Redis, Postgres, etc) and pass it
 * into tabMiddleware. The interface is intentionally minimal.
 */

import { promises as fs } from 'node:fs';
import { join, dirname } from 'node:path';

import type { VoucherStore } from './types';
import type { SignedVoucher } from '../types';

// ── JSON serialization helpers ─────────────────────────────────────────
//
// SignedVoucher contains Uint8Arrays which JSON.stringify won't serialize
// usefully. We hex-encode on save, decode on load.

interface SerializedVoucher {
  payload: SignedVoucher['payload'];
  sessionPublicKey: string;
  sessionRegistration: string;
  sessionSignature: string;
}

function serialize(v: SignedVoucher): SerializedVoucher {
  return {
    payload: v.payload,
    sessionPublicKey: bytesToHex(v.sessionPublicKey),
    sessionRegistration: bytesToHex(v.sessionRegistration),
    sessionSignature: bytesToHex(v.sessionSignature),
  };
}

function deserialize(s: SerializedVoucher): SignedVoucher {
  return {
    payload: s.payload,
    sessionPublicKey: hexToBytes(s.sessionPublicKey),
    sessionRegistration: hexToBytes(s.sessionRegistration),
    sessionSignature: hexToBytes(s.sessionSignature),
  };
}

function bytesToHex(b: Uint8Array): string {
  let out = '';
  for (const x of b) out += x.toString(16).padStart(2, '0');
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error(`hex length must be even, got ${hex.length}`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

// ── In-memory store ────────────────────────────────────────────────────

export class InMemoryVoucherStore implements VoucherStore {
  private map = new Map<string, SignedVoucher>();

  async get(channelId: string): Promise<SignedVoucher | null> {
    return this.map.get(channelId) ?? null;
  }

  async set(channelId: string, voucher: SignedVoucher): Promise<void> {
    this.map.set(channelId, voucher);
  }

  async delete(channelId: string): Promise<void> {
    this.map.delete(channelId);
  }
}

// ── File-backed store ──────────────────────────────────────────────────
//
// One file per channel id, named `<channelId>.json` under the configured
// directory. Atomicity is not bulletproof on local fs (we write-then-rename
// for crash safety, but two concurrent writes for the same channel could
// still race). The middleware serializes voucher writes per channel
// anyway, so that's not a concern in practice.

export class FileVoucherStore implements VoucherStore {
  constructor(private readonly dir: string) {}

  private pathFor(channelId: string): string {
    // Sanitize: channelId is a hex string in the SDK's defaults, but
    // accept anything matching [a-z0-9_-]+ and reject the rest.
    if (!/^[a-z0-9_-]+$/i.test(channelId)) {
      throw new Error(`unsafe channelId for filesystem: ${channelId}`);
    }
    return join(this.dir, `${channelId}.json`);
  }

  async get(channelId: string): Promise<SignedVoucher | null> {
    try {
      const raw = await fs.readFile(this.pathFor(channelId), 'utf8');
      return deserialize(JSON.parse(raw) as SerializedVoucher);
    } catch (e: any) {
      if (e?.code === 'ENOENT') return null;
      throw e;
    }
  }

  async set(channelId: string, voucher: SignedVoucher): Promise<void> {
    const path = this.pathFor(channelId);
    await fs.mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(serialize(voucher)));
    await fs.rename(tmp, path);
  }

  async delete(channelId: string): Promise<void> {
    try {
      await fs.unlink(this.pathFor(channelId));
    } catch (e: any) {
      if (e?.code !== 'ENOENT') throw e;
    }
  }
}
