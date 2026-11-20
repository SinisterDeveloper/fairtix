'use client';
import { useEffect, useState } from 'react';
import LifecycleStepper from '@/components/LifecycleStepper';
import TxStatusBanner from '@/components/TxStatusBanner';
import { explainErrorCode, formatUnixTime, shortAddress } from '@/lib/format';
import type { ApiMutationResponse, DemoStatusResponse } from '@/lib/types';

export default function GatePage() {
  const [tray, setTray] = useState<Array<Record<string, unknown>>>([]);
  const [selected, setSelected] = useState('0');
  const [credential, setCredential] = useState('');
  const [scanId, setScanId] = useState('');
  const [result, setResult] = useState<ApiMutationResponse | null>(null);
  const [status, setStatus] = useState<DemoStatusResponse | null>(null);
  const [statusError, setStatusError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem('fairtickets-credentials');
      if (saved) {
        const values = JSON.parse(saved);
        setTray(values);
        setCredential(JSON.stringify(values[0] || {}, null, 2));
      }
    } catch {
      localStorage.removeItem('fairtickets-credentials');
    }

    const refresh = async () => {
      try {
        const r = await fetch('/api/status', { cache: 'no-store' });
        const data = await r.json();
        if (!r.ok || data.ok === false) throw new Error(data.error || 'Could not load chain state.');
        setStatus(data);
        setStatusError('');
      } catch (error) {
        setStatusError(error instanceof Error ? error.message : 'Could not load chain state.');
      }
    };
    void refresh();
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
  }, []);

  function choose(index: string) {
    setSelected(index);
    setCredential(JSON.stringify(tray[Number(index)] || {}, null, 2));
  }

  async function redeem() {
    setBusy(true);
    try {
      const id = scanId || crypto.randomUUID();
      setScanId(id);
      const r = await fetch('/api/gate/redeem', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scanId: id, credential: JSON.parse(credential) }),
      });
      const data = (await r.json()) as ApiMutationResponse;
      setResult(data);
      if (data.txStatus !== 'unknown_recovering' && data.txStatus !== 'pending') setScanId('');
    } catch (e) {
      setResult({
        ok: false,
        error: e instanceof Error ? e.message : 'Invalid credential JSON',
        txStatus: 'rejected',
        txHash: null,
      });
      setScanId('');
    } finally {
      setBusy(false);
    }
  }

  async function resume() {
    setBusy(true);
    try {
      const r = await fetch('/api/tx/resume', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'gate', scanId }),
      });
      const data = (await r.json()) as ApiMutationResponse;
      setResult(data);
      if (data.txStatus !== 'unknown_recovering' && data.txStatus !== 'pending') setScanId('');
    } finally {
      setBusy(false);
    }
  }

  const parsedCred = (() => {
    try {
      return JSON.parse(credential) as Record<string, unknown>;
    } catch {
      return null;
    }
  })();
  const credentialSlot = parsedCred && parsedCred.slot !== undefined ? Number(parsedCred.slot) : 0;
  const credentialVersion =
    parsedCred && parsedCred.version !== undefined ? Number(parsedCred.version) : null;
  const credentialExpiry =
    parsedCred && parsedCred.expiry !== undefined ? Number(parsedCred.expiry) : null;

  const currentTicket = status?.tickets.find((t) => t.slot === credentialSlot);
  const ownerRole = currentTicket
    ? Object.values(status?.roles || {}).find(
        (r) => r.address.toLowerCase() === currentTicket.owner.toLowerCase(),
      )
    : undefined;

  const isStalePreview =
    currentTicket && credentialVersion !== null && credentialVersion < currentTicket.version;

  const decisionKind = !result
    ? null
    : result.txStatus === 'unknown_recovering' || result.txStatus === 'pending'
      ? 'hold'
      : result.gateDecision === 'ADMIT' || result.txStatus === 'confirmed'
        ? 'admit'
        : 'reject';

  return (
    <main className="page">
      <p className="eyebrow">VENUE GATE</p>
      <h1>Verify a ticket</h1>

      <LifecycleStepper phase={status?.phase} context="gate" />

      {statusError && (
        <p className="role-warning" role="alert">
          {statusError}
        </p>
      )}

      {decisionKind && result && (
        <section className={`gate-decision ${decisionKind}`} aria-live="polite">
          <div className="gate-decision-head">
            <strong>
              {decisionKind === 'admit'
                ? 'ADMIT — Entry Granted'
                : decisionKind === 'hold'
                  ? 'HOLD FOR STAFF — Confirmation Pending'
                  : 'DENIED — Entry Rejected'}
            </strong>
            {result.errorCode && <code>{result.errorCode}</code>}
          </div>
          <p>
            {decisionKind === 'admit'
              ? 'The gate transaction was confirmed on-chain and this ticket is now marked admitted.'
              : decisionKind === 'hold'
                ? 'Receipt confirmation is unresolved. Do not re-scan—click Check / Resume below to reconcile.'
                : explainErrorCode(result.errorCode) ||
                  result.error ||
                  'This pass could not be verified on-chain.'}
          </p>
        </section>
      )}

      <section className="card narrow">
        {tray.length > 0 ? (
          <label>
            Saved credential
            <select value={selected} onChange={(e) => choose(e.target.value)}>
              {tray.map((c, i) => (
                <option key={i} value={i}>
                  {String(c.label || `Credential ${i + 1}`)}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p className="meta">
            No saved passes in browser storage yet. Sign a pass on the Fan tab or paste Credential
            JSON below.
          </p>
        )}

        <div className="gate-compare">
          <div>
            <span className="meta">Presented pass</span>
            <strong>
              {parsedCred && parsedCred.slot !== undefined
                ? `Slot #${credentialSlot} · v${credentialVersion ?? '?'}`
                : 'No pass loaded'}
            </strong>
            {credentialExpiry ? (
              <small className="meta">Expires: {formatUnixTime(credentialExpiry)}</small>
            ) : null}
            {isStalePreview && (
              <span className="pill warn">Stale version (ticket is now v{currentTicket?.version})</span>
            )}
          </div>
          <div>
            <span className="meta">Live on-chain ticket</span>
            <strong>
              {currentTicket
                ? `${ownerRole ? `${ownerRole.label} · ` : ''}${shortAddress(currentTicket.owner)} · v${currentTicket.version}`
                : 'Not issued'}
            </strong>
            <small className="meta">
              Phase: {status?.phase || '—'} · Admitted: {currentTicket?.admitted ? 'Yes' : 'No'}
            </small>
          </div>
        </div>

        <label>
          Credential JSON
          <textarea
            rows={9}
            value={credential}
            onChange={(e) => setCredential(e.target.value)}
          />
        </label>

        <label>
          Scan ID
          <input
            value={scanId}
            onChange={(e) => setScanId(e.target.value)}
            placeholder="Generated automatically for each scan"
          />
        </label>

        <button disabled={busy} onClick={() => void redeem()}>
          {busy ? 'Verifying…' : 'Verify and redeem'}
        </button>

        <p>
          Entry is admitted only after the CLI confirms the successful receipt and matching{' '}
          <code>Admitted</code> contract event.
        </p>

        <TxStatusBanner result={result} busy={busy} onResume={() => void resume()} />

        <details style={{ marginTop: 12 }}>
          <summary>Raw gate response JSON</summary>
          <pre>{JSON.stringify(result, null, 2)}</pre>
        </details>
      </section>
    </main>
  );
}
