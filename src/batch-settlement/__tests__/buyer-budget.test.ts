import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAddress } from 'viem';
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { __test_buildClientStack, openBatchChannel, resumeBatchChannel } from '../channel';
import type { ChannelStore } from '../types';

const network = 'eip155:8453';
const usdc = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const salt = `0x${'22'.repeat(32)}` as const;

function offer(amount = '10000', changes: Partial<PaymentRequirements> = {}): PaymentRequired {
  return {
    x402Version: 2,
    resource: { url: 'https://example.invalid/paid' },
    accepts: [{
      scheme: 'batch-settlement', network, asset: usdc, amount,
      payTo: '0x2222222222222222222222222222222222222222',
      maxTimeoutSeconds: 60,
      extra: { name: 'USD Coin', version: '2', receiverAuthorizer: '0x3333333333333333333333333333333333333333' },
      ...changes,
    }],
  };
}

function challenge(paymentRequired = offer()): Response {
  return Response.json(paymentRequired, {
    status: 402,
    headers: { 'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(paymentRequired)).toString('base64') },
  });
}

function fixture(depositAtomic = '10000000', maxPaymentAtomic?: string) {
  let context: Awaited<ReturnType<ChannelStore['get']>> = {};
  const store: ChannelStore = {
    get: vi.fn(async () => context),
    set: vi.fn(async (_key, next) => { context = next; }),
    delete: vi.fn(async () => { context = {}; }),
  };
  const signTypedData = vi.fn(async () => `0x${'11'.repeat(65)}` as `0x${string}`);
  const wallet = { address: '0x1111111111111111111111111111111111111111' as const, connected: true, signTypedData };
  const stack = __test_buildClientStack({ wallet, network, rpcUrl: 'https://example.invalid/rpc', store, depositAtomic, maxPaymentAtomic, salt });
  return { stack, store, wallet, signTypedData, setContext: (next: typeof context) => { context = next; } };
}

afterEach(() => vi.unstubAllGlobals());

describe('batch buyer deposit authorization', () => {
  it('preserves an explicit $10 deposit and permits a $2 request within it', async () => {
    const { stack, signTypedData } = fixture();
    const payment = await stack.x402Cli.createPaymentPayload(offer('2000000'));
    expect(payment.payload).toMatchObject({ type: 'deposit', deposit: { amount: '10000000' }, voucher: { maxClaimableAmount: '2000000' } });
    expect(signTypedData).toHaveBeenCalledTimes(2);
  });

  it('rejects a request above the escrow budget before signing', async () => {
    const { stack, signTypedData } = fixture('300000');
    await expect(stack.x402Cli.createPaymentPayload(offer('300001'))).rejects.toThrow(/maxAmountPerPayment/);
    expect(signTypedData).not.toHaveBeenCalled();
  });

  it('rejects another asset even if upstream recognizes it as a default', async () => {
    const { stack, signTypedData } = fixture();
    const asset = '0x4444444444444444444444444444444444444444';
    vi.spyOn(stack.scheme, 'findDefaultAsset').mockReturnValue({ asset, decimals: 6, symbol: 'OTHER', name: 'Other Token', version: '1' });
    await expect(stack.x402Cli.createPaymentPayload(offer('10000', { asset }))).rejects.toThrow(/only USDC/);
    expect(signTypedData).not.toHaveBeenCalled();
  });

  it('refuses automatic top-ups on an exhausted channel', async () => {
    const f = fixture('300000');
    f.setContext({ balance: '300000', chargedCumulativeAmount: '300000' });
    await expect(f.stack.x402Cli.createPaymentPayload(offer())).rejects.toThrow(/automatic top-ups are disabled/);
    expect(f.signTypedData).not.toHaveBeenCalled();
  });

  it('keeps the cumulative budget when stored escrow is larger than this handle authorizes', async () => {
    const f = fixture('300000');
    f.setContext({ balance: '1000000', chargedCumulativeAmount: '290000' });
    await expect(f.stack.x402Cli.createPaymentPayload(offer('20000'))).rejects.toThrow(/voucher exceeds the authorized deposit budget/);
    expect(f.signTypedData).not.toHaveBeenCalled();
  });

  it.each([
    { payTo: '0x4444444444444444444444444444444444444444' },
    { extra: { ...offer().accepts[0].extra, receiverAuthorizer: '0x5555555555555555555555555555555555555555' } },
    { extra: { ...offer().accepts[0].extra, withdrawDelay: 999999 } },
  ])('binds one handle to its first channel configuration: %j', async (changes) => {
    const f = fixture();
    await f.stack.x402Cli.createPaymentPayload(offer());
    f.setContext({ balance: '10000000', chargedCumulativeAmount: '10000' });
    await expect(f.stack.x402Cli.createPaymentPayload(offer('10000', changes))).rejects.toThrow(/different channel configuration/);
    expect(f.signTypedData).toHaveBeenCalledTimes(2);
  });

  it('continues with vouchers after the original funding is confirmed', async () => {
    const f = fixture();
    await f.stack.x402Cli.createPaymentPayload(offer());
    f.setContext({ balance: '10000000', chargedCumulativeAmount: '10000' });
    const payment = await f.stack.x402Cli.createPaymentPayload(offer());
    expect(payment.payload).toMatchObject({ type: 'voucher', voucher: { maxClaimableAmount: '20000' } });
    expect(f.signTypedData).toHaveBeenCalledTimes(3);
  });

  it('treats address casing as the same channel configuration', async () => {
    const f = fixture();
    const payTo = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    await f.stack.x402Cli.createPaymentPayload(offer('10000', { payTo }));
    f.setContext({ balance: '10000000', chargedCumulativeAmount: '10000' });
    const payment = await f.stack.x402Cli.createPaymentPayload(offer('10000', { payTo: getAddress(payTo) }));
    expect(payment.payload).toMatchObject({ type: 'voucher' });
    expect(f.signTypedData).toHaveBeenCalledTimes(3);
  });

  it('refuses a second deposit authorization when the paid request outcome is unknown', async () => {
    const f = fixture();
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(challenge())
      .mockRejectedValueOnce(new Error('connection lost after submission'))
      .mockResolvedValueOnce(challenge()));
    const channel = await openBatchChannel({ wallet: f.wallet, network, store: f.store, deposit: '10', salt });
    await expect(channel.fetch('https://example.invalid/paid')).rejects.toThrow(/connection lost/);
    await expect(channel.fetch('https://example.invalid/paid')).rejects.toThrow(/initial funding was already attempted/);
    expect(f.signTypedData).toHaveBeenCalledTimes(2);
  });

  it('refuses a second deposit after the deposit signature succeeds but voucher signing fails', async () => {
    const f = fixture();
    f.signTypedData.mockResolvedValueOnce(`0x${'11'.repeat(65)}`).mockRejectedValueOnce(new Error('wallet disconnected'));
    await expect(f.stack.x402Cli.createPaymentPayload(offer())).rejects.toThrow(/wallet disconnected/);
    await expect(f.stack.x402Cli.createPaymentPayload(offer())).rejects.toThrow(/initial funding was already attempted/);
    expect(f.signTypedData).toHaveBeenCalledTimes(2);
  });

  it('allows only one initial deposit attempt across concurrent calls on a handle', async () => {
    const f = fixture();
    const results = await Promise.allSettled([
      f.stack.x402Cli.createPaymentPayload(offer()),
      f.stack.x402Cli.createPaymentPayload(offer()),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(f.signTypedData).toHaveBeenCalledTimes(2);
  });

  it('rejects a seller minimum above the budget before signing', async () => {
    const f = fixture('300000');
    await expect(f.stack.x402Cli.createPaymentPayload(offer('10000', {
      extra: { ...offer().accepts[0].extra, minDeposit: '400000' },
    }))).rejects.toThrow(/minimum deposit exceeds/);
    expect(f.signTypedData).not.toHaveBeenCalled();
  });

  it('rejects deposits that would require decimal rounding', async () => {
    const f = fixture();
    await expect(openBatchChannel({ wallet: f.wallet, network, store: f.store, deposit: '0.1234567' })).rejects.toThrow(/six decimal places/);
    expect(f.signTypedData).not.toHaveBeenCalled();
  });
});

describe('batch buyer resume authorization', () => {
  it('defaults to a $1 per-call limit', async () => {
    const f = fixture('0');
    f.setContext({ balance: '10000000', chargedCumulativeAmount: '0' });
    await expect(f.stack.x402Cli.createPaymentPayload(offer('1000001'))).rejects.toThrow(/maxAmountPerPayment/);
    expect(f.signTypedData).not.toHaveBeenCalled();
  });

  it.each([{}, { balance: '300000', chargedCumulativeAmount: '300000' }])('refuses new funding for channel state %j', async (context) => {
    const f = fixture('0');
    f.setContext(context);
    await expect(f.stack.x402Cli.createPaymentPayload(offer())).rejects.toThrow(/resume never authorizes a deposit/);
    expect(f.signTypedData).not.toHaveBeenCalled();
  });

  it('accepts an explicit higher per-call limit through the public resume API', async () => {
    const f = fixture('0');
    f.setContext({ balance: '10000000', chargedCumulativeAmount: '0' });
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(challenge(offer('2000000')))
      .mockResolvedValueOnce(new Response('paid')));
    const channel = await resumeBatchChannel({ wallet: f.wallet, network, store: f.store, salt, maxAmountPerPayment: '2' });
    expect((await channel.fetch('https://example.invalid/paid')).status).toBe(200);
    expect(f.signTypedData).toHaveBeenCalledTimes(1);
  });

  it.each(['0', '-1', 'NaN', '0.0000001'])('rejects an invalid resume limit %s', async (maxAmountPerPayment) => {
    const f = fixture('0');
    await expect(resumeBatchChannel({ wallet: f.wallet, network, store: f.store, salt, maxAmountPerPayment })).rejects.toThrow(/maxAmountPerPayment/);
    expect(f.signTypedData).not.toHaveBeenCalled();
  });
});
