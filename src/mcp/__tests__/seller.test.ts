import { describe, expect, it, vi } from 'vitest';
import { createPaidMcpTool } from '../seller';
import { getMcpPaymentRequired } from '../wire';
import { fixture, output, paidRequest, payment, receipt, request, requirements } from './fixtures';

describe('portable MCP seller', () => {
  it('emits identical structured and text payment requirements without executing', async () => {
    const f = fixture();
    const result = await createPaidMcpTool(f.options)(request, f.context);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual(requirements);
    expect(JSON.parse(result.content[0].text as string)).toEqual(result.structuredContent);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.payments.verify).not.toHaveBeenCalled();
  });

  it('accepts object proof and preserves the entire result with its settlement receipt', async () => {
    const f = fixture();
    const result = await createPaidMcpTool(f.options)(paidRequest, f.context);
    expect(result).toEqual({ ...output, _meta: { ...output._meta, 'x402/payment-response': receipt } });
    expect(f.payments.verify).toHaveBeenCalledWith(payment, payment.accepted);
    const record = [...f.store.records.values()][0];
    expect(record.phase).toBe('complete');
    expect(record.result).toEqual(result);
    expect(record.receipt).toEqual(receipt);
  });

  it('accepts a v2 proof without resource and durably binds the authoritative server resource', async () => {
    const f = fixture();
    const noResource = { ...payment };
    delete noResource.resource;
    const result = await createPaidMcpTool(f.options)({ ...request, _meta: { 'x402/payment': noResource } }, f.context);
    expect(result.isError).not.toBe(true);
    expect([...f.store.records.values()][0].resource).toEqual(requirements.resource);
  });

  it('rejects base64 vendor encoding and mismatched tool names', async () => {
    const f = fixture();
    const tool = createPaidMcpTool(f.options);
    const result = await tool({ ...request, _meta: { 'x402/payment': btoa(JSON.stringify(payment)) } }, f.context);
    expect(getMcpPaymentRequired(result)?.error).toContain('must be an x402 v2 object');
    expect((await tool({ ...paidRequest, name: 'other' }, f.context)).isError).toBe(true);
    expect(f.execute).not.toHaveBeenCalled();
  });

  it.each(['amount', 'payTo', 'asset', 'network', 'scheme'] as const)('rejects changed %s before verification', async field => {
    const f = fixture();
    const changed = structuredClone(payment);
    changed.accepted[field] = field === 'amount' ? '1' : 'changed';
    const result = await createPaidMcpTool(f.options)({ ...request, _meta: { 'x402/payment': changed } }, f.context);
    expect(result.isError).toBe(true);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.payments.verify).not.toHaveBeenCalled();
  });

  it('rejects stale quote, resource changes, invalid verification and unsupported advertised schemes', async () => {
    const f = fixture();
    f.options.requirements = { ...requirements, accepts: [{ ...payment.accepted, amount: '20000' }] };
    expect((await createPaidMcpTool(f.options)(paidRequest, f.context)).isError).toBe(true);
    f.options.requirements = requirements;
    const changed = { ...payment, resource: { url: 'mcp://elsewhere/report' } };
    expect((await createPaidMcpTool(f.options)({ ...request, _meta: { 'x402/payment': changed } }, f.context)).isError).toBe(true);
    vi.mocked(f.payments.verify).mockResolvedValue({ isValid: false });
    expect((await createPaidMcpTool(f.options)(paidRequest, f.context)).isError).toBe(true);
    expect(f.execute).not.toHaveBeenCalled();
    f.options.requirements = { ...requirements, accepts: [{ ...payment.accepted, scheme: 'tab' }] };
    await expect(createPaidMcpTool(f.options)(request, f.context)).rejects.toThrow('unsupported');
  });

  it('uses an atomic admission across concurrent requests and returns stored results after restart', async () => {
    const f = fixture();
    const tool = createPaidMcpTool(f.options);
    const responses = await Promise.all(Array.from({ length: 8 }, () => tool(paidRequest, f.context)));
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.payments.settle).toHaveBeenCalledTimes(1);
    expect(responses.some(r => r.isError !== true)).toBe(true);
    // Simulate a different worker and changed current pricing over the same persisted data.
    const restarted = createPaidMcpTool({ ...f.options,
      requirements: { ...requirements, accepts: [{ ...payment.accepted, amount: '30000' }] } });
    const replay = await restarted(paidRequest, f.context);
    expect(replay).toEqual({ ...output, _meta: { ...output._meta, 'x402/payment-response': receipt } });
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.payments.settle).toHaveBeenCalledTimes(1);
  });

  it('binds admitted proof to caller, exact arguments and service', async () => {
    const f = fixture();
    const tool = createPaidMcpTool(f.options);
    await tool(paidRequest, f.context);
    expect((await tool(paidRequest, { account: 'attacker' })).isError).toBe(true);
    expect((await tool({ ...paidRequest, arguments: { ticker: 'OTHER' } }, f.context)).isError).toBe(true);
    expect((await createPaidMcpTool({ ...f.options, serviceScope: 'other-service' })(paidRequest, f.context)).isError).toBe(true);
    const forged = structuredClone(payment);
    forged.payload.signature = 'forged';
    expect((await tool({ ...request, _meta: { 'x402/payment': forged } }, f.context)).isError).toBe(true);
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it('checks revoked authorization even for a stored result', async () => {
    const f = fixture();
    const tool = createPaidMcpTool(f.options);
    await tool(paidRequest, f.context);
    f.authorize.mockRejectedValue(new Error('revoked'));
    expect(await tool(paidRequest, f.context)).toEqual({ isError: true, content: [{ type: 'text', text: 'Access denied' }] });
  });

  it('cannot admit the same Permit2 authorization again through injected EIP-3009 metadata', async () => {
    const f = fixture();
    const permit = { ...payment, accepted: { ...payment.accepted, extra: { assetTransferMethod: 'permit2' } },
      payload: { signature: payment.payload.signature,
        permit2Authorization: { from: receipt.payer, nonce: '42' } } };
    f.options.requirements = { ...requirements, accepts: [permit.accepted] };
    const tool = createPaidMcpTool(f.options);
    await tool({ ...request, _meta: { 'x402/payment': permit } }, f.context);
    for (const nonce of ['01', '02']) {
      const mixed = { ...permit, payload: { ...permit.payload, authorization: {
        from: receipt.payer, nonce: `0x${nonce.repeat(32)}`,
      } } };
      expect((await tool({ ...request, _meta: { 'x402/payment': mixed } }, f.context)).isError).toBe(true);
    }
    expect(f.store.records.size).toBe(1);
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.payments.settle).toHaveBeenCalledTimes(1);
  });

  it('does not release output or repeat payment after settlement uncertainty', async () => {
    const f = fixture();
    vi.mocked(f.payments.settle).mockRejectedValue(new Error('timeout after broadcast'));
    const tool = createPaidMcpTool(f.options);
    const result = await tool(paidRequest, f.context);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).not.toEqual(output.structuredContent);
    expect(getMcpPaymentRequired(result)).toBeUndefined();
    expect(result.content[0].text).toContain('unknown');
    expect([...f.store.records.values()][0]).toMatchObject({ phase: 'settlement_unknown', result: output });
    await createPaidMcpTool(f.options)(paidRequest, f.context);
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.payments.settle).toHaveBeenCalledTimes(1);
  });

  it('returns a payment error after definite settlement rejection without releasing service data', async () => {
    const f = fixture();
    const failed = { ...receipt, success: false as const, errorReason: 'declined' };
    vi.mocked(f.payments.settle).mockResolvedValue({ status: 'failed', receipt: failed });
    const result = await createPaidMcpTool(f.options)(paidRequest, f.context);
    expect(result._meta?.['x402/payment-response']).toEqual(failed);
    expect(getMcpPaymentRequired(result)).toBeUndefined();
    expect(result.content).not.toEqual(output.content);
    expect([...f.store.records.values()][0].phase).toBe('settlement_failed');
  });

  it('retains pending settlement evidence durably without a fresh challenge', async () => {
    const f = fixture();
    const pending = { ...receipt, success: false as const, errorReason: 'settlement_pending',
      extensions: { tracking: 'transaction-submitted' } };
    // Even a custom processor calling this a failure cannot make it final.
    vi.mocked(f.payments.settle).mockResolvedValue({ status: 'failed', receipt: pending });
    const result = await createPaidMcpTool(f.options)(paidRequest, f.context);
    expect(getMcpPaymentRequired(result)).toBeUndefined();
    expect(result._meta?.['x402/payment-response']).toEqual(pending);
    expect([...f.store.records.values()][0]).toMatchObject({ phase: 'settlement_unknown', receipt: pending, result: output });
    const replay = await createPaidMcpTool(f.options)(paidRequest, f.context);
    expect(replay._meta?.['x402/payment-response']).toEqual(pending);
    expect(f.payments.settle).toHaveBeenCalledTimes(1);
  });

  it('rejects unsupported payment flow even with a permissive custom processor', async () => {
    const f = fixture();
    f.options.payments.supports = () => true;
    f.options.requirements = { ...requirements, accepts: [{ ...payment.accepted, extra: { paymentFlow: 'upfront' } }] };
    await expect(createPaidMcpTool(f.options)(request, f.context)).rejects.toThrow('unsupported');
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('persists before execution, settlement, and returning the result', async () => {
    const f = fixture();
    f.execute.mockImplementation(async () => {
      expect([...f.store.records.values()][0].phase).toBe('executing');
      return output;
    });
    vi.mocked(f.payments.settle).mockImplementation(async () => {
      expect([...f.store.records.values()][0]).toMatchObject({ phase: 'settling', result: output });
      return { status: 'settled', receipt };
    });
    await createPaidMcpTool(f.options)(paidRequest, f.context);
    expect([...f.store.records.values()][0]).toMatchObject({ phase: 'complete', receipt });
  });

  it.each(['executing', 'executed', 'settling', 'complete'])('fails closed on an uncertain %s persistence write', async phase => {
    const f = fixture();
    const original = f.store.compareAndSwap.bind(f.store);
    f.store.compareAndSwap = async (id, revision, record) => {
      const result = await original(id, revision, record);
      if (record.phase === phase) throw new Error('commit acknowledgement lost');
      return result;
    };
    const tool = createPaidMcpTool(f.options);
    expect((await tool(paidRequest, f.context)).isError).toBe(true);
    await createPaidMcpTool(f.options)(paidRequest, f.context);
    expect(f.execute.mock.calls.length).toBeLessThanOrEqual(1);
    expect(vi.mocked(f.payments.settle).mock.calls.length).toBeLessThanOrEqual(1);
    if (phase === 'executing') expect(f.execute).not.toHaveBeenCalled();
    if (phase === 'executed' || phase === 'settling') expect(f.payments.settle).not.toHaveBeenCalled();
  });

  it('retains interrupted handler state without executing again or settling', async () => {
    const f = fixture();
    f.execute.mockRejectedValue(new Error('remote action may have happened'));
    const tool = createPaidMcpTool(f.options);
    await tool(paidRequest, f.context);
    await createPaidMcpTool(f.options)(paidRequest, f.context);
    expect([...f.store.records.values()][0].phase).toBe('execution_unknown');
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.payments.settle).not.toHaveBeenCalled();
  });

  it('preserves tool errors without charging and rejects task handles as completed delivery', async () => {
    const f = fixture();
    const result = { ...output, isError: true };
    f.execute.mockResolvedValue(result);
    const tool = createPaidMcpTool(f.options);
    expect(await tool(paidRequest, f.context)).toEqual(result);
    expect(await tool(paidRequest, f.context)).toEqual(result);
    expect(f.payments.settle).not.toHaveBeenCalled();
    const task = fixture();
    task.execute.mockResolvedValue({ content: [], resultType: 'task', task: { taskId: 'later' } });
    expect((await createPaidMcpTool(task.options)(paidRequest, task.context)).isError).toBe(true);
    expect(task.payments.settle).not.toHaveBeenCalled();
  });

  it('strips a foreign receipt and recovery state from handler errors without settling', async () => {
    const f = fixture();
    f.execute.mockResolvedValue({ ...output, isError: true, _meta: {
      ...output._meta,
      'x402/payment-response': { ...receipt, transaction: 'another-purchase' },
      'dexter/payment-state': { phase: 'complete', paymentId: 'foreign' },
    } });
    const tool = createPaidMcpTool(f.options);
    const result = await tool(paidRequest, f.context);
    expect(result).toEqual({ ...output, isError: true });
    expect((await tool(paidRequest, f.context))._meta).toEqual(output._meta);
    expect(f.payments.settle).not.toHaveBeenCalled();
  });

  it('retains a nested tool payment challenge privately instead of demanding another payment', async () => {
    const f = fixture();
    const nested = { isError: true, structuredContent: { ...requirements },
      content: [{ type: 'text', text: JSON.stringify(requirements) }] };
    f.execute.mockResolvedValue(nested);
    const tool = createPaidMcpTool(f.options);
    expect(getMcpPaymentRequired(await tool(paidRequest, f.context))).toBeUndefined();
    expect(getMcpPaymentRequired(await tool(paidRequest, f.context))).toBeUndefined();
    expect([...f.store.records.values()][0].result).toEqual(nested);
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.payments.settle).not.toHaveBeenCalled();
  });
});
