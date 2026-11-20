'use client';
import type { ApiMutationResponse } from '@/lib/types';
export default function TxStatusBanner({ result, onResume }: { result: ApiMutationResponse | null; onResume?: () => void }) {
  if (!result) return null;
  const status = result.txStatus || 'confirmed';
  const label = status === 'unknown_recovering' ? 'Pending / Recovering' : status === 'pending' ? 'Pending' : status === 'confirmed' ? 'Confirmed' : 'Rejected';
  return <section className={`tx-banner ${status}`} aria-live="polite"><strong>{label}</strong>{result.error && <span>{result.error}</span>}{result.errorCode && <code>{result.errorCode}</code>}{result.txHash && <code>{result.txHash}</code>}{(status === 'unknown_recovering' || status === 'pending') && onResume && <button className="secondary" onClick={onResume}>Check / Resume</button>}</section>;
}
