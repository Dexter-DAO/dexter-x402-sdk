/**
 * Solana Transaction Builder for x402 v2 Payments
 *
 * Builds TransferChecked transactions that pass Dexter's security validation:
 * - ComputeBudget instructions (limit + price) within policy limits
 * - Single TransferChecked instruction for USDC transfer
 * - Uses facilitator as feePayer (fee sponsorship)
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
  createTransferCheckedInstruction,
  getMint,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import type { PaymentAccept } from '../types';
import type { X402Wallet } from './x402-client';

/**
 * Dexter policy-safe defaults
 * These are well within Dexter's facilitator security limits:
 * - MAX_COMPUTE_UNITS: 200,000
 * - MAX_PRIORITY_FEE_MICROLAMPORTS: 50,000
 */
const DEFAULT_COMPUTE_UNIT_LIMIT = 12_000; // Per SPEC.md
const DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS = 1; // Minimal priority fee

/**
 * Build and sign a Solana transaction for x402 payment
 *
 * Transaction structure (3 instructions):
 * 1. SetComputeUnitLimit (12,000 units)
 * 2. SetComputeUnitPrice (1 microlamport)
 * 3. TransferChecked (USDC transfer to seller)
 *
 * @param wallet - Wallet adapter for signing
 * @param accept - Payment requirements from PAYMENT-REQUIRED header
 * @param rpcUrl - Solana RPC URL
 * @returns Signed VersionedTransaction ready to be serialized
 */
export async function buildPaymentTransaction(
  wallet: X402Wallet,
  accept: PaymentAccept,
  rpcUrl: string
): Promise<VersionedTransaction> {
  const connection = new Connection(rpcUrl, 'confirmed');

  // Validate wallet
  if (!wallet.publicKey) {
    throw new Error('Wallet not connected');
  }
  const userPubkey = new PublicKey(wallet.publicKey.toBase58());

  // Extract required fields from payment requirements
  const { payTo, asset, amount, extra } = accept;

  if (!extra?.feePayer) {
    throw new Error('Missing feePayer in payment requirements');
  }
  if (typeof extra?.decimals !== 'number') {
    throw new Error('Missing decimals in payment requirements');
  }

  const feePayerPubkey = new PublicKey(extra.feePayer);
  const mintPubkey = new PublicKey(asset);
  const destinationPubkey = new PublicKey(payTo);

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

  // 3. Determine token program (TOKEN_PROGRAM or TOKEN_2022)
  const mintInfo = await connection.getAccountInfo(mintPubkey, 'confirmed');
  if (!mintInfo) {
    throw new Error(`Token mint ${asset} not found`);
  }

  const programId =
    mintInfo.owner.toBase58() === TOKEN_2022_PROGRAM_ID.toBase58()
      ? TOKEN_2022_PROGRAM_ID
      : TOKEN_PROGRAM_ID;

  // Fetch mint to verify decimals
  const mint = await getMint(connection, mintPubkey, undefined, programId);
  if (mint.decimals !== extra.decimals) {
    console.warn(
      `[x402] Decimals mismatch: requirements say ${extra.decimals}, mint says ${mint.decimals}`
    );
  }

  // Derive Associated Token Accounts
  const sourceAta = await getAssociatedTokenAddress(
    mintPubkey,
    userPubkey,
    false,
    programId
  );
  const destinationAta = await getAssociatedTokenAddress(
    mintPubkey,
    destinationPubkey,
    false,
    programId
  );

  // Verify source ATA exists (user must have tokens)
  const sourceAtaInfo = await connection.getAccountInfo(sourceAta, 'confirmed');
  if (!sourceAtaInfo) {
    throw new Error(
      `No token account found for ${asset}. Please ensure you have USDC in your wallet.`
    );
  }

  // Verify destination ATA exists (seller must have account)
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
      sourceAta,      // source
      mintPubkey,     // mint
      destinationAta, // destination
      userPubkey,     // owner (user signs)
      amountBigInt,   // amount in atomic units
      mint.decimals,  // decimals from on-chain mint
      [],             // no multisig
      programId
    )
  );

  // Get recent blockhash
  const { blockhash } = await connection.getLatestBlockhash('confirmed');

  // Compile to V0 message
  // IMPORTANT: feePayer is the facilitator, not the user
  const message = new TransactionMessage({
    payerKey: feePayerPubkey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  // Create versioned transaction
  const transaction = new VersionedTransaction(message);

  // User signs the transaction
  if (typeof wallet.signTransaction !== 'function') {
    throw new Error('Wallet does not support signTransaction');
  }

  const signedTx = await wallet.signTransaction(transaction);

  return signedTx;
}

/**
 * Serialize a signed transaction to base64 for the PAYMENT-SIGNATURE header
 */
export function serializeTransaction(tx: VersionedTransaction): string {
  return Buffer.from(tx.serialize()).toString('base64');
}

