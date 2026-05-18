/**
 * SIW-X signer adapter.
 *
 * wrapFetchWithSIWx (from @x402/extensions) needs a SIWxSigner. The
 * payment seam carries a WalletSet of wallet *objects*; this maps that
 * WalletSet to a SIWxSigner so the dispatcher can offer Sign-In-With-X
 * to every payAndFetch caller.
 *
 * EVM is preferred when present — most live SIW-X declarers are EVM.
 * Returns null when no wallet can produce a signer; the dispatcher then
 * skips SIW-X wrapping (a transparent no-op).
 *
 * MUST NOT import v1-strategy or v2-strategy.
 */
import * as nacl from 'tweetnacl';
import type { SIWxSigner } from '@x402/extensions/sign-in-with-x';
import type { WalletSet } from '../adapters/types';
import { KEYPAIR_SYMBOL } from '../client/keypair-wallet';

/**
 * Map a WalletSet to a SIWxSigner for wrapFetchWithSIWx, or null when
 * neither wallet can sign SIW-X proofs.
 */
export function toSiwxSigner(wallets: WalletSet): SIWxSigner | null {
  // EVM first. A wallet with both an address and a signMessage method is
  // a valid EVMSigner — keypair wallets get signMessage from
  // createEvmKeypairWallet; browser wallets already have it.
  const evm = wallets.evm as
    | { address?: string; signMessage?: (a: { message: string }) => Promise<string> }
    | undefined;
  if (evm && typeof evm.signMessage === 'function' && typeof evm.address === 'string') {
    return {
      address: evm.address,
      signMessage: evm.signMessage,
    } as SIWxSigner;
  }

  // Solana fallback. The keypair behind KEYPAIR_SYMBOL holds the 64-byte
  // secret key; tweetnacl signs the SIW-X message bytes (Ed25519).
  const solana = wallets.solana as
    | (Record<symbol, unknown> & { publicKey?: { toBase58?: () => string } })
    | undefined;
  if (solana) {
    const keypair = solana[KEYPAIR_SYMBOL] as
      | { secretKey: Uint8Array; publicKey: { toBase58: () => string } }
      | undefined;
    if (keypair && keypair.secretKey && keypair.publicKey) {
      return {
        publicKey: keypair.publicKey,
        signMessage: async (message: Uint8Array): Promise<Uint8Array> =>
          nacl.sign.detached(message, keypair.secretKey),
      } as SIWxSigner;
    }
  }

  return null;
}
