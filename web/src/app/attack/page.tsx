'use client';
import { useRef, useState } from 'react';
import Link from 'next/link';
import { shortAddress } from '@/lib/format';
import type {
  AccountFarmAttackResponse,
  DemoAttackResponse,
  RoleId,
  SecurityDecisionResponse,
} from '@/lib/types';

export default function AttackPage() {
  const [attemptsCount, setAttemptsCount] = useState('3');
  const [controlRole, setControlRole] = useState<Extract<RoleId, 'fanA' | 'fanB'>>('fanA');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DemoAttackResponse | null>(null);
  const [farmBusy, setFarmBusy] = useState(false);
  const [farmResult, setFarmResult] = useState<AccountFarmAttackResponse | null>(null);
  const [probeBusy, setProbeBusy] = useState(false);
  const [probeLabel, setProbeLabel] = useState('');
  const [probeResult, setProbeResult] = useState<SecurityDecisionResponse | null>(null);
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

  async function launchAccountFarm() {
    if (farmBusy) return;
    setFarmBusy(true);
    setError('');
    try {
      const r = await fetch('/api/attack/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scenario: 'account-farm' }),
      });
      const data = (await r.json()) as AccountFarmAttackResponse;
      if (!r.ok || data.ok === false) {
        setError(data.error || 'Account farm scenario failed.');
      }
      setFarmResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to run account farm scenario.');
    } finally {
      setFarmBusy(false);
    }
  }

  async function runSecurityProbe(preset: 'legit' | 'cluster' | 'sniper') {
    if (probeBusy) return;
    setProbeBusy(true);
    setError('');
    const runTag = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const baseMs = Date.now();
    const saleId = 'concert_live_probe';
    try {
      const sendEvent = async (ev: Record<string, unknown>) => {
        const r = await fetch('/api/security/eval', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(ev),
        });
        const data = (await r.json()) as SecurityDecisionResponse;
        if (!r.ok || data.ok === false) {
          throw new Error(data.error || 'Security evaluation failed.');
        }
        return data;
      };

      let last: SecurityDecisionResponse;
      if (preset === 'legit') {
        setProbeLabel('Legitimate Fan (normal pacing, unique identifiers)');
        const actor = {
          accountId: `probe_fan_${runTag}`,
          sessionId: `probe_sess_fan_${runTag}`,
          deviceId: `probe_dev_fan_${runTag}`,
          networkId: `probe_net_home_${runTag}`,
          paymentTokenHash: `probe_pay_fan_${runTag}`,
        };
        await sendEvent({ ...actor, eventType: 'ACCOUNT_REGISTER', timestamp: new Date(baseMs).toISOString(), eventContext: { eventSaleId: saleId, ...actor } });
        await sendEvent({ ...actor, eventType: 'QUEUE_JOIN', timestamp: new Date(baseMs + 2200).toISOString(), eventContext: { eventSaleId: saleId, ...actor } });
        last = await sendEvent({ ...actor, eventType: 'RESERVATION_CREATE', timestamp: new Date(baseMs + 5100).toISOString(), eventContext: { eventSaleId: saleId, ...actor, reservationId: `res_${runTag}` } });
      } else if (preset === 'cluster') {
        setProbeLabel('Linked Account Cluster (3 accounts sharing device & payment across distinct IPs)');
        const sharedDev = `probe_shared_dev_${runTag}`;
        const sharedPay = `probe_shared_pay_${runTag}`;
        last = { ok: true };
        for (let i = 1; i <= 3; i++) {
          last = await sendEvent({
            accountId: `probe_farm_${runTag}_${i}`,
            sessionId: `probe_sess_farm_${runTag}_${i}`,
            eventType: 'QUEUE_JOIN',
            timestamp: new Date(baseMs + i * 250).toISOString(),
            eventContext: {
              eventSaleId: saleId,
              deviceId: sharedDev,
              networkId: `probe_proxy_ip_${runTag}_${i}`,
              paymentTokenHash: sharedPay,
            },
          });
        }
      } else {
        setProbeLabel('Robotic Stealth Sniper Bot (unique device/IP/payment, 150ms sub-second cadence)');
        const sniper = {
          accountId: `probe_sniper_${runTag}`,
          sessionId: `probe_sess_sniper_${runTag}`,
          deviceId: `probe_dev_sniper_${runTag}`,
          networkId: `probe_ip_sniper_${runTag}`,
          paymentTokenHash: `probe_pay_sniper_${runTag}`,
        };
        await sendEvent({ ...sniper, eventType: 'ACCOUNT_REGISTER', timestamp: new Date(baseMs).toISOString(), eventContext: { eventSaleId: saleId, ...sniper } });
        await sendEvent({ ...sniper, eventType: 'QUEUE_JOIN', timestamp: new Date(baseMs + 150).toISOString(), eventContext: { eventSaleId: saleId, ...sniper } });
        last = await sendEvent({ ...sniper, eventType: 'RESERVATION_CREATE', timestamp: new Date(baseMs + 300).toISOString(), eventContext: { eventSaleId: saleId, ...sniper, reservationId: `res_sn_${runTag}` } });
      }
      setProbeResult(last);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Security probe failed.');
    } finally {
      setProbeBusy(false);
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

      <section className="card">
        <div className="card-head">
          <h2>50-Account Coordinated Farm (Milestone 1)</h2>
          <span className="pill">Account-Linkage Graph + Shared-Wi-Fi Isolation</span>
        </div>
        <p className="meta">
          Simulates 50 coordinated bot accounts across distinct IPs competing against 15 shared-Wi-Fi
          fans and 2 family household accounts.
        </p>
        <div className="actions">
          <button disabled={farmBusy} onClick={() => void launchAccountFarm()}>
            {farmBusy ? 'Running 50-Account Farm…' : 'Run 50-Account Farm Attack'}
          </button>
        </div>

        {farmResult && (
          <div style={{ marginTop: 16 }}>
            <div className="metrics-grid">
              <div className="metric">
                <span>Farm Accounts Flagged</span>
                <strong>
                  {farmResult.farmAccountsFlagged ?? 0} / {farmResult.farmAccountsTotal ?? 50}
                </strong>
                <small>{farmResult.farmCheckoutsSucceeded ?? 0} tickets acquired by farm</small>
              </div>
              <div className="metric">
                <span>Shared-Wi-Fi Fans Disrupted</span>
                <strong>
                  {farmResult.sharedWifiFlagged ?? 0} / {farmResult.sharedWifiTotal ?? 15}
                </strong>
                <small>{farmResult.sharedWifiCheckoutsSucceeded ?? 0} / {farmResult.sharedWifiTotal ?? 15} succeeded</small>
              </div>
              <div className="metric">
                <span>Family Household Affected</span>
                <strong>
                  {farmResult.familyFlagged ?? 0} / {farmResult.familyTotal ?? 2}
                </strong>
                <small>{farmResult.familyCheckoutsSucceeded ?? 0} / {farmResult.familyTotal ?? 2} succeeded</small>
              </div>
              <div className="metric">
                <span>Seeded Clusters Discovered</span>
                <strong>{farmResult.discoveredFarmClusters?.length ?? 0}</strong>
                <small>BFS connected components</small>
              </div>
            </div>

            {farmResult.discoveredFarmClusters && farmResult.discoveredFarmClusters.length > 0 && (
              <div className="table-wrap" style={{ marginTop: 12 }}>
                <table>
                  <thead>
                    <tr>
                      <th>Cluster ID</th>
                      <th>Accounts</th>
                      <th>Distinct Networks</th>
                      <th>Shared Identifiers</th>
                    </tr>
                  </thead>
                  <tbody>
                    {farmResult.discoveredFarmClusters.map((c) => (
                      <tr key={c.clusterId}>
                        <td><code>{c.clusterId}</code></td>
                        <td><strong>{c.accountCount}</strong></td>
                        <td>{c.distinctNetworkCount}</td>
                        <td><code>{c.sharedIdentifiers.slice(0, 4).join(', ')}{c.sharedIdentifiers.length > 4 ? '…' : ''}</code></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Live Hybrid Risk Engine &amp; ML Probe</h2>
          <span className="pill ok">Rules + BFS Graph + Iliou ML + Kaggle Unsupervised</span>
        </div>
        <p className="meta">
          Sends live `SecurityEvent` sequences through `src/cli.cjs security-eval --json` and inspects
          returned scores, reason codes, and ML feature attributions.
        </p>
        <div className="actions">
          <button className="secondary" disabled={probeBusy} onClick={() => void runSecurityProbe('legit')}>
            {probeBusy ? 'Evaluating…' : 'Probe: Legitimate Fan'}
          </button>
          <button className="secondary" disabled={probeBusy} onClick={() => void runSecurityProbe('cluster')}>
            {probeBusy ? 'Evaluating…' : 'Probe: Linked Cluster (3 accounts)'}
          </button>
          <button disabled={probeBusy} onClick={() => void runSecurityProbe('sniper')}>
            {probeBusy ? 'Evaluating…' : 'Probe: Robotic Stealth Sniper Bot'}
          </button>
        </div>

        {probeResult && (
          <div style={{ marginTop: 16 }}>
            <div className="card-head">
              <strong>{probeLabel}</strong>
              <span
                className={`pill ${
                  probeResult.decision === 'ALLOW'
                    ? 'ok'
                    : probeResult.decision === 'BLOCK'
                      ? 'danger'
                      : 'warn'
                }`}
              >
                {probeResult.decision} (risk {probeResult.riskScore ?? 0}/100)
              </span>
            </div>
            <div className="metrics-grid" style={{ marginTop: 8 }}>
              <div className="metric">
                <span>Supervised ML Score</span>
                <strong>{probeResult.mlScore ?? 0} / 100</strong>
                <small>Iliou Web Bot Logistic Model</small>
              </div>
              <div className="metric">
                <span>Unsupervised Anomaly</span>
                <strong>{probeResult.unsupervisedAnomalyScore ?? 0} / 100</strong>
                <small>Welford Human Baseline</small>
              </div>
              <div className="metric">
                <span>Cluster Size</span>
                <strong>{probeResult.clusterSummary?.accountCount ?? 1}</strong>
                <small>Decision ID: {probeResult.decisionId || '—'}</small>
              </div>
            </div>
            <p style={{ marginTop: 10 }}>
              <strong>Reasons:</strong>{' '}
              {probeResult.reasons && probeResult.reasons.length > 0
                ? probeResult.reasons.map((r) => (
                    <code key={r} style={{ marginRight: 6 }}>{r}</code>
                  ))
                : 'Clean ALLOW — no risk flags'}
            </p>
            {probeResult.mlTopContributors && probeResult.mlTopContributors.length > 0 && (
              <p className="meta">
                <strong>Top ML Contributors:</strong>{' '}
                {probeResult.mlTopContributors
                  .map((c) => `${c.feature}=${c.value} (+${c.contribution})`)
                  .join(' · ')}
              </p>
            )}
          </div>
        )}
      </section>
    </main>
  );
}
