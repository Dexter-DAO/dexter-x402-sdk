import { describe, it, expect } from 'vitest';
import { createEvmKeypairWallet } from '../evm-wallet';

// A deterministic throwaway test key — not a real funded account.
const TEST_KEY =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

describe('createEvmKeypairWallet — signMessage', () => {
  it('signs a plain string message and returns a 0x hex signature', async () => {
    const wallet = await createEvmKeypairWallet(TEST_KEY);
    expect(typeof wallet.signMessage).toBe('function');
    const sig = await wallet.signMessage!({ message: 'hello siwx' });
    expect(sig).toMatch(/^0x[0-9a-f]+$/i);
    // EIP-191 personal_sign signatures are 65 bytes => 132 hex chars incl 0x.
    expect(sig.length).toBe(132);
  });
});
