/** Journal callbacks must persist before resolving; no private key is accepted here. */
export function createReservationFence({ facilitatorUrl, internalToken, readRecord, writeRecord, fetchImpl = fetch }) {
  const endpoint = new URL('/tab/open', facilitatorUrl).href;
  return async (input) => {
    const key = input.idempotencyKey;
    const body = {
      operation_id: key,
      buyer_swig_address: input.buyerSwigAddress,
      vault_pda: input.vaultPda,
      seller: input.seller,
      channel_id: input.channelId,
      session_public_key: Buffer.from(input.voucher.sessionPublicKey).toString('hex'),
      session_signature: Buffer.from(input.voucher.sessionSignature).toString('hex'),
      session_registration: Buffer.from(input.voucher.sessionRegistration).toString('hex'),
      voucher_digest: input.voucherDigest,
      cumulative_amount_atomic: String(input.voucher.payload.cumulativeAmount),
      sequence_number: input.voucher.payload.sequenceNumber,
      provider_receipt_id: `case-two:${input.voucherDigest}`,
      reservation_amount_atomic: String(input.reservationAmountAtomic),
      network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      mode: 'lock',
    };
    const request = JSON.stringify(body);
    let record = await readRecord(key);
    if (record && (record.endpoint !== endpoint || record.request !== request)) {
      throw new Error('reservation_journal_identity_conflict');
    }
    if (!record) {
      record = { endpoint, request };
      await writeRecord(key, record);
    }
    // Retry the persisted bytes even after an ambiguous response. The facilitator
    // recovers its durable transaction using this same operation_id.
    const response = await fetchImpl(record.endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json', 'x-internal-token': internalToken },
      body: record.request,
    });
    const text = await response.text();
    await writeRecord(key, { ...record, httpStatus: response.status, responseText: text });
    let result;
    try { result = JSON.parse(text); } catch { throw new Error(`reservation_response_not_json:${response.status}`); }
    if (response.status !== 200 || result.armed !== true || !result.receipt) {
      // An expired-unlanded envelope needs /open/successor and its release
      // certificate. Stop with the saved evidence instead of inventing a new
      // operation identity or signing another purchase.
      throw new Error(`reservation_not_armed:${response.status}:${result.error ?? 'pending'}; retry the same purchase and journal`);
    }
    return result.receipt;
  };
}
