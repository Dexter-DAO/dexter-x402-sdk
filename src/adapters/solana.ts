/**
 * Solana Chain Adapter
 *
 * Implements the ChainAdapter interface for Solana networks.
 * Handles transaction building, signing, and balance queries.
 */

import { exactPaymentCapabilityError } from '../payment/exact-capability';
import {
  PublicKey,
  Connection,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
  TransactionInstruction,
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
 * Compute budget for a transfer plus Memo.
 */
const DEFAULT_COMPUTE_UNIT_LIMIT = 25_000;
// Allow complex UTF-8 memos during simulation; measure the signed limit below.
const MAX_SIMULATION_COMPUTE_UNIT_LIMIT = 1_400_000;
const DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS = 1;
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

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
    const unsupported = exactPaymentCapabilityError(accept, 'svm');
    if (unsupported) throw new Error(unsupported);
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
    let memo: Buffer;
    let recoveryNonce: string | undefined;
    if (extra.memo !== undefined) {
      if (typeof extra.memo !== 'string' || Buffer.byteLength(extra.memo, 'utf8') > 256) {
        throw new Error('Payment memo must be a UTF-8 string of at most 256 bytes');
      }
      memo = Buffer.from(extra.memo, 'utf8');
    } else {
      const nonceBytes = new Uint8Array(16);
      (globalThis.crypto ?? (await import('crypto')).webcrypto).getRandomValues(nonceBytes);
      recoveryNonce = [...nonceBytes].map(b => b.toString(16).padStart(2, '0')).join('');
      memo = Buffer.from(recoveryNonce, 'utf8');
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
        units: extra.memo === undefined
          ? DEFAULT_COMPUTE_UNIT_LIMIT
          : MAX_SIMULATION_COMPUTE_UNIT_LIMIT,
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

    // 5. Preserve the seller's reference, or add a fresh nonce for recovery.
    instructions.push(new TransactionInstruction({
      programId: MEMO_PROGRAM_ID,
      keys: [],
      data: memo,
    }));

    // Get recent blockhash
    const { blockhash } = await connection.getLatestBlockhash('confirmed');

    // Compile to V0 message (feePayer is facilitator)
    const message = new TransactionMessage({
      payerKey: feePayerPubkey,
      recentBlockhash: blockhash,
      instructions,
    });

    let transaction = new VersionedTransaction(message.compileToV0Message());
    if (extra.memo !== undefined) {
      const simulation = await connection.simulateTransaction(transaction, {
        sigVerify: false,
        replaceRecentBlockhash: true,
      });
      if (simulation.value.err !== null) {
        throw new Error(`Solana payment simulation failed: ${JSON.stringify(simulation.value.err)}`);
      }
      const units = simulation.value.unitsConsumed;
      if (typeof units !== 'number' || !Number.isSafeInteger(units) ||
          units <= 0 || units > MAX_SIMULATION_COMPUTE_UNIT_LIMIT) {
        throw new Error('Solana payment simulation returned invalid compute units');
      }
      // Reserve 10% above measured execution, capped at the runtime maximum.
      instructions[0] = ComputeBudgetProgram.setComputeUnitLimit({
        units: Math.min(MAX_SIMULATION_COMPUTE_UNIT_LIMIT, Math.ceil(units * 1.1)),
      });
      transaction = new VersionedTransaction(message.compileToV0Message());
    }

    // Create and sign transaction
    const signedTx = await wallet.signTransaction(transaction);

    this.log('Transaction signed successfully');

    return {
      serialized: Buffer.from(signedTx.serialize()).toString('base64'),
      // Compare the signed message, not the transaction bytes: the sponsor
      // adds its fee-payer signature before submitting the same message.
      settlementProbe: {
        kind: 'solana',
        sourceAta: sourceAta.toBase58(),
        destinationAta: destinationAta.toBase58(),
        asset,
        amount,
        blockhash,
        signedMessage: Buffer.from(signedTx.message.serialize()).toString('base64'),
        ...(recoveryNonce ? { recoveryNonce } : {}),
      },
    };
  }

  /**
   * Confirm a Solana payment settled on-chain, after a post-payment timeout.
   *
   * Solana has no EIP-3009-style "was this nonce consumed" view. Instead we
   * scan the 25 most recent signatures on the merchant's destination ATA.
   * Recovery requires the exact signed message and its SDK-generated Memo
   * nonce, plus a matching token balance increase. Seller Memo references
   * may be reused, so those payments remain unconfirmed after a timeout.
   * A busy account can push the payment outside this scan, also leaving it
   * unconfirmed.
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
    if (!probe.signedMessage) {
      throw new Error('Solana settlement probe is missing the signed message');
    }
    if (!probe.sourceAta || !probe.destinationAta || !probe.asset || !probe.amount || !probe.blockhash) {
      throw new Error('Solana settlement probe is missing transfer details');
    }
    if (!probe.recoveryNonce || !/^[0-9a-f]{32}$/.test(probe.recoveryNonce)) {
      throw new Error('Solana settlement probe has no unique recovery nonce');
    }
    const recoveryMemo = Buffer.from(probe.recoveryNonce, 'utf8');

    const connection = new Connection(rpcUrl, 'confirmed');
    const destAta = new PublicKey(probe.destinationAta);

    // Most-recent signatures on the merchant's destination ATA.
    const sigs = await connection.getSignaturesForAddress(destAta, { limit: 25 });
    if (sigs.length === 0) {
      return { settled: false };
    }

    const want = BigInt(probe.amount);

    // Inspect only the exact signed message, then verify the payment outcome.
    for (const sigInfo of sigs) {
      if (sigInfo.err) continue; // failed tx — never settled funds
      const tx = await connection.getTransaction(sigInfo.signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
      if (!tx?.meta || tx.meta.err) continue;
      if (Buffer.from(tx.transaction.message.serialize()).toString('base64') !== probe.signedMessage) continue;

      // The full account key list, so a balance entry's accountIndex can be
      // resolved to an actual address and compared to the destination ATA.
      const accountKeys = tx.transaction.message
        .getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses })
        .keySegments()
        .flat();

      // A wallet may remove or replace the Memo before returning its signed
      // transaction. Only recover if our fresh nonce survived in a Memo.
      const hasRecoveryMemo = tx.transaction.message.compiledInstructions.some(ix =>
        accountKeys[ix.programIdIndex]?.equals(MEMO_PROGRAM_ID) &&
        Buffer.from(ix.data).equals(recoveryMemo)
      );
      if (!hasRecoveryMemo) continue;

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
        if (preBal && preBal.mint !== probe.asset) continue;
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


