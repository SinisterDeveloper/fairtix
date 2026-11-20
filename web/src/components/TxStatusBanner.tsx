'use client';
import { explainErrorCode } from '@/lib/format';
import type { ApiMutationResponse } from '@/lib/types';

export default function TxStatusBanner({
  result,
  onResume,
  busy = false,
}: {
  result: ApiMutationResponse | null;
  onResume?: () => void;
  busy?: boolean;
}) {
  if (!result) return null;
  const status = result.txStatus || 'confirmed';
  const label =
    status === 'unknown_recovering'
      ? 'Pending / Recovering'
      : status === 'pending'
        ? 'Pending'
        : status === 'confirmed'
          ? 'Confirmed'
          : 'Rejected';
  const explanation = status === 'confirmed' ? null : explainErrorCode(result.errorCode);
  const canResume = (status === 'unknown_recovering' || status === 'pending') && Boolean(onResume);

  return (
    <section className={`tx-banner ${status}`} aria-live="polite">
      <div className="tx-banner-main">
        <div className="tx-banner-head">
          <strong>{label}</strong>
          {result.gateDecision && <span className="pill">{result.gateDecision}</span>}
          {result.errorCode && <code>{result.errorCode}</code>}
          {typeof result.blockNumber === 'number' && <span className="meta">Block #{result.blockNumber}</span>}
        </div>
        {result.error && <p className="tx-banner-msg">{result.error}</p>}
        {explanation && explanation !== result.error && (
          <p className="tx-banner-hint">{explanation}</p>
        )}
        {result.txHash && (
          <p className="tx-banner-meta">
            Tx: <code>{result.txHash}</code>
          </p>
        )}
      </div>
      {canResume && (
        <button className="secondary" disabled={busy} onClick={onResume}>
          {busy ? 'Checking…' : 'Check / Resume'}
        </button>
      )}
    </section>
  );
}
