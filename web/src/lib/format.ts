export function shortAddress(address?: string | null): string {
  if (!address) return '—';
  if (/^0x0{40}$/i.test(address)) return 'Unclaimed (0x0000…0000)';
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function formatWeiToEth(wei?: string | number | bigint | null, maxDecimals = 6): string {
  if (wei === undefined || wei === null || wei === '') return '—';
  try {
    const value = BigInt(wei);
    const zero = BigInt(0);
    const negative = value < zero;
    const abs = negative ? -value : value;
    const base = BigInt('1000000000000000000');
    const whole = abs / base;
    const frac = abs % base;
    if (frac === zero) return `${negative ? '-' : ''}${whole.toString()} ETH`;
    const padded = frac.toString().padStart(18, '0').slice(0, maxDecimals).replace(/0+$/, '');
    if (!padded) return `${negative ? '-' : ''}${whole.toString()} ETH`;
    return `${negative ? '-' : ''}${whole.toString()}.${padded} ETH`;
  } catch {
    return `${String(wei)} wei`;
  }
}

export function formatUnixTime(unixSeconds?: number | null): string {
  if (!unixSeconds || !Number.isFinite(unixSeconds)) return '—';
  return new Date(unixSeconds * 1000).toLocaleString();
}

const ERROR_EXPLANATIONS: Record<string, string> = {
  RESALE_CAP_EXCEEDED: 'Listing price exceeds the on-chain resale cap (the lower of face price and last paid price).',
  STALE_CREDENTIAL: 'This gate credential was signed for an older ticket version and was invalidated when the ticket was resold.',
  ALREADY_ADMITTED: 'This ticket or scan ID has already been admitted or finalized on-chain.',
  FORGED_CREDENTIAL: 'The signature or EIP-712 domain did not match the current ticket holder, contract, chain, or edition.',
  NOT_WINNER: 'Only wallets selected in the draw can claim a reserved slot.',
  ALREADY_CLAIMED: 'This winning wallet has already claimed its reserved ticket.',
  WRONG_PHASE: 'This action is not permitted in the current on-chain event phase.',
  LISTING_NOT_ACTIVE: 'No active resale listing matches this slot, version, and expected price.',
  INSUFFICIENT_PAYMENT: 'The transaction value did not match the exact required ticket price.',
  RPC_TIMEOUT: 'The RPC response was lost or timed out. Use Check / Resume to reconcile the existing journal instead of resending.',
  INTERNAL_ERROR: 'An unexpected client or bridge error occurred while invoking the CLI.',
};

export function explainErrorCode(errorCode?: string | null): string | null {
  if (!errorCode) return null;
  return ERROR_EXPLANATIONS[errorCode] ?? null;
}
