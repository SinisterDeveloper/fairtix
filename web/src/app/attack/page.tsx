'use client';
import { useRef, useState } from 'react';
import Link from 'next/link';
import { shortAddress } from '@/lib/format';
import type { DemoAttackResponse, RoleId } from '@/lib/types';

export default function AttackPage() {
  const [attemptsCount, setAttemptsCount] = useState('3');
  const [controlRole, setControlRole] = useState<Extract<RoleId, 'fanA' | 'fanB'>>('fanA');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DemoAttackResponse | null>(null);
  const [error, setError] = useState('');
  const inFlightRef = useRef(false);

  async function launchAttack() {
    if (inFlightRef.current || busy) return;
    inFlightRef.current = true;
    setBusy(true);
    setError('');
    try {
      const r = await fetch('/api/attack/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          scenario: 'repeated-entry',
          attempts: Number(attemptsCount),
          controlRole,
        }),
      });
      const data = (await r.json()) as DemoAttackResponse;
      if (!r.ok || data.ok === false) {
        setError(data.error || 'Attack scenario failed.');
      }
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to run attack scenario.');
    } finally {
      inFlightRef.current = false;
      setBusy(false);
    }
  }

  const attempts = result?.attempts || [];
  const relatedAlerts = result?.relatedAlerts || [];

  return (
    <main className="page">
      <p className="eyebrow">ADVERSARIAL DEMO · SPLIT-SCREEN READY</p>
      <h1>Attacker Console</h1>
      <p className="meta">
        Simulates a bounded repeated-entry bot alongside a legitimate control fan on the local Anvil
        chain. Open <Link href="/organiser">/organiser</Link> side-by-side to watch live review
        alerts and eligible counts update.
      </p>

      <section className="card">
        <div className="card-head">
          <h2>Repeated-entry scenario</h2>
          {busy && <span className="pill warn">Run in progress…</span>}
        </div>
        <div className="inline-fields">
          <label>
            Bot attempts (2–10)
            <input
              type="number"
              min={2}
              max={10}
              value={attemptsCount}
              disabled={busy}
              onChange={(e) => setAttemptsCount(e.target.value)}
            />
          </label>
          <label>
            Legitimate control role
            <select
              value={controlRole}
              disabled={busy}
              onChange={(e) => setControlRole(e.target.value as 'fanA' | 'fanB')}
            >
              <option value="fanA">Fan A</option>
              <option value="fanB">Fan B</option>
            </select>
          </label>
        </div>
        <div className="actions" style={{ marginTop: 12 }}>
          <button disabled={busy} onClick={() => void launchAttack()}>
            {busy ? 'Running attack…' : 'Launch Attack'}
          </button>
          <Link className="button secondary" href="/organiser">
            Open Security Command Center →
          </Link>
        </div>
      </section>

      {error && (
        <p className="role-warning" role="alert">
          {error}
        </p>
      )}

      {result?.summary && (
        <section className="card">
          <div className="card-head">
            <h2>Outcome summary</h2>
            <span className="pill ok">Run ID: {result.runId}</span>
          </div>
          <div className="metrics-grid">
            <div className="metric">
              <span>Repeated attempts</span>
              <strong>{result.summary.repeatedAttempts}</strong>
              <small>
                {result.summary.repeatedAllowed} allowed · {result.summary.repeatedRejected} rejected
              </small>
            </div>
            <div className="metric">
              <span>Extra entries added</span>
              <strong>{result.summary.extraEntriesAdded}</strong>
              <small>Contract enforces 1 entry per subject/wallet</small>
            </div>
            <div className="metric">
              <span>Legitimate control</span>
              <strong>{result.summary.controlEligible ? 'Eligible' : 'Not eligible'}</strong>
              <small>{controlRole === 'fanA' ? 'Fan A' : 'Fan B'} stayed unaffected</small>
            </div>
            <div className="metric">
              <span>Review alert</span>
              <strong>{result.summary.reviewAlertTriggered ? 'Triggered' : 'None'}</strong>
              <small>Review signal only — separate from contract rules</small>
            </div>
            {result.before && result.after && (
              <div className="metric">
                <span>Eligible entries</span>
                <strong>
                  {result.before.entrantsCount} → {result.after.entrantsCount} / {result.after.capacity}
                </strong>
                <small>Before → After run</small>
              </div>
            )}
          </div>
        </section>
      )}

      {attempts.length > 0 && (
        <section className="card">
          <h2>Per-attempt contract decisions</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Participant</th>
                  <th>Decision</th>
                  <th>Block</th>
                  <th>Reason / Code</th>
                  <th>Tx</th>
                </tr>
              </thead>
              <tbody>
                {attempts.map((a) => (
                  <tr key={a.attemptId}>
                    <td>
                      <strong>{a.participantLabel}</strong>
                      <div className="meta">{a.subjectLabel || a.kind}</div>
                    </td>
                    <td>
                      <span className={`pill ${a.decision === 'ALLOWED' ? 'ok' : 'warn'}`}>
                        {a.decision}
                      </span>
                    </td>
                    <td>{a.blockNumber ?? '—'}</td>
                    <td>
                      {a.reason || 'Accepted on-chain'}
                      {a.errorCode && (
                        <>
                          {' '}
                          <code>{a.errorCode}</code>
                        </>
                      )}
                    </td>
                    <td>
                      <code>{a.txHash ? shortAddress(a.txHash) : '—'}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {relatedAlerts.length > 0 && (
        <section className="card">
          <div className="card-head">
            <h2>Triggered review alerts</h2>
            <span className="pill warn">Review signal only</span>
          </div>
          <ul className="alert-list">
            {relatedAlerts.map((alert) => (
              <li key={alert.id} className="alert-item">
                <div className="alert-item-head">
                  <strong>{alert.rule}</strong>
                  <span className="pill">Count: {alert.count}</span>
                  {alert.grouping && <span className="pill">{alert.grouping}</span>}
                  <code>{alert.subjectLabel || alert.subjectOrSlot}</code>
                </div>
                <p>{alert.reason}</p>
                <small>{alert.note}</small>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
