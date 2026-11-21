'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import LifecycleStepper from '@/components/LifecycleStepper';
import QrPassCard from '@/components/QrPassCard';
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
  const autoPickedRef = useRef(false);

  useEffect(() => {
    let loadedTray: Array<Record<string, unknown>> = [];
    try {
      const saved = localStorage.getItem('fairtickets-credentials');
      if (saved) {
        loadedTray = JSON.parse(saved);
        setTray(loadedTray);
        setCredential(JSON.stringify(loadedTray[0] || {}, null, 2));
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
        if (!autoPickedRef.current && data.contract && loadedTray.length > 0) {
          const currentIdx = [...loadedTray]
            .reverse()
            .findIndex((c) => String(c.contract || '').toLowerCase() === data.contract.toLowerCase());
          if (currentIdx >= 0) {
            const actualIdx = loadedTray.length - 1 - currentIdx;
            setSelected(String(actualIdx));
            setCredential(JSON.stringify(loadedTray[actualIdx] || {}, null, 2));
          }
          autoPickedRef.current = true;
        }
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

  function clearOldPasses() {
    if (!status?.contract) return;
    const currentContract = status.contract.toLowerCase();
    const filtered = tray.filter((c) => String(c.contract || '').toLowerCase() === currentContract);
    setTray(filtered);
    localStorage.setItem('fairtickets-credentials', JSON.stringify(filtered));
    setSelected('0');
    setCredential(JSON.stringify(filtered[0] || {}, null, 2));
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
  const isOldContract = Boolean(
    status?.contract &&
      parsedCred?.contract &&
      String(parsedCred.contract).toLowerCase() !== status.contract.toLowerCase(),
  );
  const hasOldPasses = Boolean(
    status?.contract &&
      tray.some((c) => c.contract && String(c.contract).toLowerCase() !== status.contract.toLowerCase()),
  );

  const decisionKind = !result
    ? null
    : result.txStatus === 'unknown_recovering' || result.txStatus === 'pending'
      ? 'hold'
      : result.gateDecision === 'ADMIT' || result.txStatus === 'confirmed'
        ? 'admit'
        : 'reject';

  return (
    <main className="page">
      <div className="card-head">
        <div>
          <p className="eyebrow">ZONE 2 · ORGANISER &amp; GATE</p>
          <h1>Verify a ticket</h1>
        </div>
        <div className="actions" style={{ margin: 0 }}>
          <Link className="button secondary" href="/organiser">
            ← Back to Organiser
          </Link>
        </div>
      </div>

      <LifecycleStepper phase={status?.phase} context="gate" />

      {statusError && (
        <p className="role-warning" role="alert">
          {statusError}
        </p>
      )}

      {status && !currentTicket && parsedCred?.slot !== undefined && (
        <div className="role-warning" role="status">
          Slot #{credentialSlot} has <strong>not been claimed yet</strong> on-chain (<code>Not issued</code>).
          A reserved fan must claim the ticket during the <strong>CLAIM</strong> phase before it can
          be verified at the gate.
        </div>
      )}

      {status && status.phase !== 'GATE' && (
        <div className="flow-callout">
          <span>
            Current phase is <strong>{status.phase}</strong>. Gate admission opens in the{' '}
            <strong>GATE</strong> phase.
          </span>
          <Link className="small-link" href="/organiser">
            Advance phase on Organiser →
          </Link>
        </div>
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
                  : explainErrorCode(result.errorCode, result.error) ||
                    result.error ||
                    'This pass could not be verified on-chain.'}
          </p>
        </section>
      )}

      <section className="card narrow">
        {tray.length > 0 ? (
          <>
            <label>
              Saved credential
              <select value={selected} onChange={(e) => choose(e.target.value)}>
                {tray.map((c, i) => {
                  const isOld = Boolean(
                    status?.contract &&
                      c.contract &&
                      String(c.contract).toLowerCase() !== status.contract.toLowerCase(),
                  );
                  return (
                    <option key={i} value={i}>
                      {String(c.label || `Credential ${i + 1}`)}
                      {isOld ? ' (Old event)' : ''}
                    </option>
                  );
                })}
              </select>
            </label>
            {hasOldPasses && (
              <div className="preset-row">
                <button type="button" className="secondary small-btn" onClick={clearOldPasses}>
                  Clear old-event passes
                </button>
              </div>
            )}
          </>
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
            {isOldContract && (
              <span className="pill warn">Old event contract (will reject as FORGED_CREDENTIAL)</span>
            )}
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

        <QrPassCard
          credential={parsedCred}
          label={
            tray[Number(selected)]?.label
              ? String(tray[Number(selected)].label)
              : undefined
          }
        />

        <details style={{ margin: '10px 0' }}>
          <summary>Paste or inspect Credential JSON</summary>
          <label>
            Credential JSON
            <textarea
              rows={7}
              value={credential}
              onChange={(e) => setCredential(e.target.value)}
            />
          </label>
        </details>

        <button disabled={busy} onClick={() => void redeem()}>
          {busy ? 'Verifying…' : 'Verify and redeem'}
        </button>

        <p>
          Entry is admitted only after the CLI confirms the successful receipt and matching{' '}
          <code>Admitted</code> contract event.
        </p>

        {(result?.txStatus === 'unknown_recovering' || result?.txStatus === 'pending' || result?.txHash) && (
          <TxStatusBanner result={result} busy={busy} onResume={() => void resume()} />
        )}

        <details style={{ marginTop: 12 }}>
          <summary>Raw gate response JSON</summary>
          <pre>{JSON.stringify(result, null, 2)}</pre>
        </details>
      </section>
    </main>
  );
}
