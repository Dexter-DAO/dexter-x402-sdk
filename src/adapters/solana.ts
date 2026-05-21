/**
 * Solana Chain Adapter
 *
 * Implements the ChainAdapter interface for Solana networks.
 * Handles transaction building, signing, and balance queries.
 */

import {
  PublicKey,
  Connection,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
  type TransactionInstruction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  getAccount,
  createTransferCheckedInstruction,
  getMint,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import type {
  ChainAdapter,
  AdapterConfig,
  SignedTransaction,
  SettlementProbe,
  SettlementConfirmation,
} from './types';
import type { PaymentAccept } from '../types';
import {
  SOLANA_MAINNET,
  SOLANA_DEVNET,
  SOLANA_TESTNET,
  SOLANA_RPC_URLS as DEFAULT_RPC_URLS,
} from '../constants';

// Re-export for backwards-compatible public API surface
export { SOLANA_MAINNET, SOLANA_DEVNET, SOLANA_TESTNET } from '../constants';

/**
 * Dexter policy-safe compute budget settings
 */
const DEFAULT_COMPUTE_UNIT_LIMIT = 12_000;
const DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS = 1;

/**
 * Solana wallet interface (compatible with @solana/wallet-adapter)
 */
export interface SolanaWallet {
  publicKey: { toBase58(): string } | null;
  signTransaction<T>(tx: T): Promise<T>;
}

/**
 * Check if an object is a valid Solana wallet
 */
export function isSolanaWallet(wallet: unknown): wallet is SolanaWallet {
  if (!wallet || typeof wallet !== 'object') return false;
  const w = wallet as Record<string, unknown>;
  return (
    'publicKey' in w &&
    'signTransaction' in w &&
    typeof w.signTransaction === 'function'
  );
}

/**
 * Solana Chain Adapter
 */
export class SolanaAdapter implements ChainAdapter {
  readonly name = 'Solana';
  readonly networks = [SOLANA_MAINNET, SOLANA_DEVNET, SOLANA_TESTNET];

  private config: AdapterConfig;
  private log: (...args: unknown[]) => void;

  constructor(config: AdapterConfig = {}) {
    this.config = config;
    this.log = config.verbose
      ? console.log.bind(console, '[x402:solana]')
      : () => {};
  }

  canHandle(network: string): boolean {
    // Handle both exact CAIP-2 and legacy formats
    if (this.networks.includes(network)) return true;
    // Legacy format support
    if (network === 'solana') return true;
    if (network === 'solana-devnet') return true;
    if (network === 'solana-testnet') return true;
    // Check if it starts with 'solana:'
    if (network.startsWith('solana:')) return true;
    return false;
  }

  getDefaultRpcUrl(network: string): string {
    // Check custom config first
    if (this.config.rpcUrls?.[network]) {
      return this.config.rpcUrls[network];
    }
    // Check defaults
    if (DEFAULT_RPC_URLS[network]) {
      return DEFAULT_RPC_URLS[network];
    }
    // Normalize legacy networks
    if (network === 'solana') return DEFAULT_RPC_URLS[SOLANA_MAINNET];
    if (network === 'solana-devnet') return DEFAULT_RPC_URLS[SOLANA_DEVNET];
    if (network === 'solana-testnet') return DEFAULT_RPC_URLS[SOLANA_TESTNET];
    // Default to mainnet
    return DEFAULT_RPC_URLS[SOLANA_MAINNET];
  }

  getAddress(wallet: unknown): string | null {
    if (!isSolanaWallet(wallet)) return null;
    return wallet.publicKey?.toBase58() ?? null;
  }

  isConnected(wallet: unknown): boolean {
    if (!isSolanaWallet(wallet)) return false;
    return wallet.publicKey !== null;
  }

  async getBalance(
    accept: PaymentAccept,
    wallet: unknown,
    rpcUrl?: string
  ): Promise<number> {
    if (!isSolanaWallet(wallet) || !wallet.publicKey) {
      return 0;
    }

    const url = rpcUrl || this.getDefaultRpcUrl(accept.network);
    const connection = new Connection(url, 'confirmed');
    const userPubkey = new PublicKey(wallet.publicKey.toBase58());
    const mintPubkey = new PublicKey(accept.asset);

    try {
      // Determine token program
      const mintInfo = await connection.getAccountInfo(mintPubkey, 'confirmed');
      const programId =
        mintInfo?.owner.toBase58() === TOKEN_2022_PROGRAM_ID.toBase58()
          ? TOKEN_2022_PROGRAM_ID
          : TOKEN_PROGRAM_ID;

      // allowOwnerOffCurve = false: the owner is the buyer's own wallet,
      // which is always a real account (never a PDA) — off-curve is
      // impossible here.
      const ata = await getAssociatedTokenAddress(
        mintPubkey,
        userPubkey,
        false,
        programId
      );

      const account = await getAccount(connection, ata, undefined, programId);
      const decimals = accept.extra?.decimals ?? 6;
      return Number(account.amount) / Math.pow(10, decimals);
    } catch (err) {
      // Token account doesn't exist = 0 balance (expected for new wallets)
      if (err && typeof err === 'object' && 'name' in err &&
          (err.name === 'TokenAccountNotFoundError' || err.name === 'TokenInvalidAccountOwnerError')) {
        return 0;
      }
      // RPC errors, network failures — throw so caller can distinguish from zero balance
      throw err;
    }
  }

  async buildTransaction(
    accept: PaymentAccept,
    wallet: unknown,
    rpcUrl?: string
  ): Promise<SignedTransaction> {
    if (!isSolanaWallet(wallet)) {
      throw new Error('Invalid Solana wallet');
    }
    if (!wallet.publicKey) {
      throw new Error('Wallet not connected');
    }

    const url = rpcUrl || this.getDefaultRpcUrl(accept.network);
    const connection = new Connection(url, 'confirmed');
    const userPubkey = new PublicKey(wallet.publicKey.toBase58());

    // Extract required fields — amount is the v2 spec field, maxAmountRequired is v1 fallback
    const { payTo, asset, extra } = accept;
    const amount = accept.amount ?? accept.maxAmountRequired;
    if (!amount) {
      throw new Error('Missing amount in payment requirements');
    }

    if (!extra?.feePayer) {
      throw new Error('Missing feePayer in payment requirements');
    }
    // Note: decimals is optional - we fetch from mint on-chain if not provided

    const feePayerPubkey = new PublicKey(extra.feePayer);
    const mintPubkey = new PublicKey(asset);
    const destinationPubkey = new PublicKey(payTo);

    this.log('Building transaction:', {
      from: userPubkey.toBase58(),
      to: payTo,
      amount,
      asset,
      feePayer: extra.feePayer,
    });

    // Build instructions
    const instructions: TransactionInstruction[] = [];

    // 1. ComputeBudget: Set compute unit limit
    instructions.push(
      ComputeBudgetProgram.setComputeUnitLimit({
        units: DEFAULT_COMPUTE_UNIT_LIMIT,
      })
    );

    // 2. ComputeBudget: Set compute unit price
    instructions.push(
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
      })
    );

    // 3. Determine token program
    const mintInfo = await connection.getAccountInfo(mintPubkey, 'confirmed');
    if (!mintInfo) {
      throw new Error(`Token mint ${asset} not found`);
    }

    const programId =
      mintInfo.owner.toBase58() === TOKEN_2022_PROGRAM_ID.toBase58()
        ? TOKEN_2022_PROGRAM_ID
        : TOKEN_PROGRAM_ID;

    // Fetch mint to get decimals (required for TransferChecked)
    const mint = await getMint(connection, mintPubkey, undefined, programId);
    if (typeof extra?.decimals === 'number' && mint.decimals !== extra.decimals) {
      this.log(
        `Decimals mismatch: requirements say ${extra.decimals}, mint says ${mint.decimals}`
      );
    }

    // Derive Associated Token Accounts.
    //
    // allowOwnerOffCurve — the third arg — controls whether
    // getAssociatedTokenAddress will derive an ATA for an OFF-CURVE owner
    // (a Program Derived Address). It throws TokenOwnerOffCurveError
    // otherwise.
    //
    // Source: the owner is `userPubkey`, the buyer's own wallet. A buyer is
    // always a real account (keypair or browser wallet) — never a PDA — so
    // off-curve is impossible here and the flag stays `false`.
    const sourceAta = await getAssociatedTokenAddress(
      mintPubkey,
      userPubkey,
      false,
      programId
    );
    // Destination: the owner is the merchant's `payTo`. Most merchants are a
    // normal wallet (on-curve), but some are a protocol whose `payTo` is a
    // PDA (an escrow / revenue-split / treasury controlled by a program).
    // `true` lets us derive the *standard* ATA for such a payTo instead of
    // throwing. This assumes a PDA merchant receives at its standard ATA —
    // which is the x402 convention. If a merchant instead used a
    // non-standard program-owned token account, this derivation would point
    // at the wrong account, but the facilitator independently re-derives the
    // payTo ATA the same way and rejects a mismatch — so a wrong assumption
    // fails the payment cleanly, it never misdirects funds.
    const destinationAta = await getAssociatedTokenAddress(
      mintPubkey,
      destinationPubkey,
      true,
      programId
    );

    // Verify source ATA exists
    const sourceAtaInfo = await connection.getAccountInfo(sourceAta, 'confirmed');
    if (!sourceAtaInfo) {
      throw new Error(
        `No token account found for ${asset}. Please ensure you have USDC in your wallet.`
      );
    }

    // Verify destination ATA exists
    const destAtaInfo = await connection.getAccountInfo(destinationAta, 'confirmed');
    if (!destAtaInfo) {
      throw new Error(
        `Seller token account not found. The seller (${payTo}) must have a USDC account.`
      );
    }

    // 4. TransferChecked instruction
    const amountBigInt = BigInt(amount);
    instructions.push(
      createTransferCheckedInstruction(
        sourceAta,
        mintPubkey,
        destinationAta,
        userPubkey,
        amountBigInt,
        mint.decimals,
        [],
        programId
      )
    );

    // Get recent blockhash
    const { blockhash } = await connection.getLatestBlockhash('confirmed');

    // Compile to V0 message (feePayer is facilitator)
    const message = new TransactionMessage({
      payerKey: feePayerPubkey,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message();

    // Create and sign transaction
    const transaction = new VersionedTransaction(message);
    const signedTx = await wallet.signTransaction(transaction);

    this.log('Transaction signed successfully');

    return {
      serialized: Buffer.from(signedTx.serialize()).toString('base64'),
      // Captured so a post-payment timeout can scan the destination ATA for
      // the settling transfer. Solana has no nonce-consumed view, so this
      // carries enough to identify the transfer: the ATAs, the amount, and
      // the blockhash (which bounds how far back the scan must look — a
      // transaction is only valid for ~150 slots after its blockhash).
      settlementProbe: {
        kind: 'solana',
        sourceAta: sourceAta.toBase58(),
        destinationAta: destinationAta.toBase58(),
        asset,
        amount,
        blockhash,
      },
    };
  }

  /**
   * Confirm a Solana payment settled on-chain, after a post-payment timeout.
   *
   * Solana has no EIP-3009-style "was this nonce consumed" view. Instead we
   * scan recent signatures on the merchant's destination ATA and look for a
   * transfer of exactly the expected amount. The window is naturally bounded:
   * the payment transaction is only valid for ~150 slots (~60s) after the
   * blockhash it was built against, so a settling transfer — if it happened —
   * is among the most recent signatures on that account. We cap the scan at
   * the 25 most recent signatures.
   *
   * This is strong but not surgical: it matches on (destination ATA, amount),
   * not a unique nonce. A same-amount transfer to the same merchant inside
   * the window from an unrelated payer could in principle match. In practice
   * the blockhash window makes that vanishingly unlikely, and a false
   * positive here only means we tell the caller "paid" when they were not —
   * which is the safe direction (it discourages a retry; the caller verifies
   * against their own wallet). A false negative maps to `payment_unconfirmed`.
   */
  async confirmSettlement(
    probe: SettlementProbe,
    rpcUrl: string,
  ): Promise<SettlementConfirmation> {
    if (probe.kind !== 'solana') {
      throw new Error(
        `SolanaAdapter.confirmSettlement cannot handle probe kind "${probe.kind}"`,
      );
    }

    const connection = new Connection(rpcUrl, 'confirmed');
    const destAta = new PublicKey(probe.destinationAta);

    // Most-recent signatures on the merchant's destination ATA.
    const sigs = await connection.getSignaturesForAddress(destAta, { limit: 25 });
    if (sigs.length === 0) {
      return { settled: false };
    }

    const want = BigInt(probe.amount);

    // Inspect each candidate transaction for an INCREASE on the destination
    // ATA equal to the expected payment amount.
    for (const sigInfo of sigs) {
      if (sigInfo.err) continue; // failed tx — never settled funds
      const tx = await connection.getTransaction(sigInfo.signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
      if (!tx?.meta) continue;

      // The full account key list, so a balance entry's accountIndex can be
      // resolved to an actual address and compared to the destination ATA.
      const accountKeys = tx.transaction.message
        .getAccountKeys()
        .keySegments()
        .flat();

      const pre = tx.meta.preTokenBalances ?? [];
      const post = tx.meta.postTokenBalances ?? [];

      for (const postBal of post) {
        if (postBal.mint !== probe.asset) continue;
        // Resolve the balance entry to a concrete account address and require
        // it to BE the merchant's destination ATA — not just any token
        // account the transaction touched.
        const acct = accountKeys[postBal.accountIndex];
        if (!acct || !acct.equals(destAta)) continue;

        const preBal = pre.find(p => p.accountIndex === postBal.accountIndex);
        const preAmt = BigInt(preBal?.uiTokenAmount.amount ?? '0');
        const postAmt = BigInt(postBal.uiTokenAmount.amount ?? '0');
        if (postAmt - preAmt === want) {
          return { settled: true, txSignature: sigInfo.signature };
        }
      }
    }

    return { settled: false };
  }
}

/**
 * Create a Solana adapter instance
 */
export function createSolanaAdapter(config?: AdapterConfig): SolanaAdapter {
  return new SolanaAdapter(config);
}



