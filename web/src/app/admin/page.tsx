'use client';
import { Fragment, useEffect, useState } from 'react';
import Link from 'next/link';
import { describeAllocation } from '@/lib/allocation';
import { formatUnixTime, formatWeiToInr, shortAddress } from '@/lib/format';
import type {
  AdminLogsResponse,
  DemoStatusResponse,
  RoleId,
  SecurityStatusResponse,
} from '@/lib/types';

export default function AdminPage() {
  const [status, setStatus] = useState<DemoStatusResponse | null>(null);
  const [adminLogs, setAdminLogs] = useState<AdminLogsResponse | null>(null);
  const [securityStatus, setSecurityStatus] = useState<SecurityStatusResponse | null>(null);
  const [selectedLogKey, setSelectedLogKey] = useState<string | null>(null);
  const [logPage, setLogPage] = useState(1);
  const [logLimit, setLogLimit] = useState<100 | 500 | 1000>(100);
  const [logSource, setLogSource] = useState<'all' | 'activity' | 'capacity'>('all');
  const [error, setError] = useState('');

  async function refresh(nextPage = logPage, nextLimit = logLimit, nextSource = logSource) {
    try {
      const [sRes, lRes, secRes] = await Promise.all([
        fetch('/api/status', { cache: 'no-store' }),
        fetch(`/api/admin/logs?page=${nextPage}&limit=${nextLimit}&source=${nextSource}`, { cache: 'no-store' }),
        fetch('/api/security/status', { cache: 'no-store' }),
      ]);
      const sJson = (await sRes.json()) as DemoStatusResponse & { error?: string };
      const lJson = (await lRes.json()) as AdminLogsResponse;
      const secJson = (await secRes.json()) as SecurityStatusResponse;
      if (!sRes.ok || sJson.ok === false) throw new Error(sJson.error || 'Could not load chain state.');
      setStatus(sJson);
      setAdminLogs(lJson);
      if (secRes.ok && secJson.ok) setSecurityStatus(secJson);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load admin telemetry.');
    }
  }

  useEffect(() => {
    void refresh(logPage, logLimit, logSource);
    const id = setInterval(() => void refresh(logPage, logLimit, logSource), 3000);
    return () => clearInterval(id);
  }, [logPage, logLimit, logSource]);

  const roleList = status?.roles ? (Object.values(status.roles) as Array<DemoStatusResponse['roles'][RoleId]>) : [];
  const totalCreditsWei = roleList.reduce((sum, item) => {
    try {
      return sum + BigInt(item.withdrawableWei || '0');
    } catch {
      return sum;
    }
  }, BigInt(0));
  const contractBalanceWei = (() => {
    try {
      return status?.balanceWei ? BigInt(status.balanceWei) : BigInt(0);
    } catch {
      return BigInt(0);
    }
  })();
  const reconciled = status ? contractBalanceWei === totalCreditsWei : false;
  const allocationInfo = describeAllocation(status);
  const logs = adminLogs?.logs || [];
  const alerts = adminLogs?.alerts || [];

  return (
    <main className="page">
      <div className="card-head">
        <div>
          <p className="eyebrow">ZONE 3 · ADMIN &amp; OBSERVABILITY</p>
          <h1>Backend Logs &amp; Chain Audit</h1>
        </div>
        <div className="actions" style={{ margin: 0 }}>
          <Link className="button secondary" href="/attack">
            Open Attacker Console
          </Link>
          <button className="secondary" onClick={() => void refresh()}>
            Refresh logs
          </button>
        </div>
      </div>

      {error && (
        <p className="role-warning" role="alert">
          {error}
        </p>
      )}

      <section className="card">
        <div className="card-head">
          <h2>Live backend activity log (newest first)</h2>
          <div className="actions" style={{ margin: 0 }}>
            <span className="pill">
              {(adminLogs?.totalLogs ?? logs.length).toLocaleString()} total
            </span>
            <select
              aria-label="Log source"
              style={{ width: 'auto', padding: '6px 10px' }}
              value={logSource}
              onChange={(e) => {
                setLogSource(e.target.value as 'all' | 'activity' | 'capacity');
                setLogPage(1);
              }}
            >
              <option value="all">All logs</option>
              <option value="activity">Chain &amp; API</option>
              <option value="capacity">Capacity benchmark</option>
            </select>
            <select
              aria-label="Logs per page"
              style={{ width: 'auto', padding: '6px 10px' }}
              value={logLimit}
              onChange={(e) => {
                setLogLimit(Number(e.target.value) as 100 | 500 | 1000);
                setLogPage(1);
              }}
            >
              <option value={100}>100 / page</option>
              <option value={500}>500 / page</option>
              <option value={1000}>1000 / page</option>
            </select>
          </div>
        </div>
        {logs.length > 0 ? (
          <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Action</th>
                  <th>Role</th>
                  <th>Target / Subject</th>
                  <th>Result</th>
                  <th>Tx / Detail</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((entry, idx) => {
                  const rowKey = `${entry.timestamp}-${entry.action}-${entry.txHash || idx}`;
                  const isOpen = selectedLogKey === rowKey;
                  return (
                    <Fragment key={rowKey}>
                      <tr
                        onClick={() => setSelectedLogKey(isOpen ? null : rowKey)}
                        style={{ cursor: 'pointer', background: isOpen ? '#f4faf6' : undefined }}
                      >
                        <td>{entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : '—'}</td>
                        <td>
                          <code>{entry.action}</code>
                        </td>
                        <td>{entry.role || '—'}</td>
                        <td>
                          <code>{entry.subjectLabel || entry.subject || (entry.slot ? `Slot #${entry.slot}` : '—')}</code>
                        </td>
                        <td>
                          <span className={`pill ${entry.success ? 'ok' : 'warn'}`}>
                            {entry.success ? 'SUCCESS' : 'REJECTED / FAILED'}
                          </span>
                        </td>
                        <td>
                          {entry.txHash && <code title={entry.txHash}>{shortAddress(entry.txHash)}</code>}
                          {entry.error && <div className="meta">{entry.error}</div>}
                          <div className="small-link">{isOpen ? 'Hide details ▲' : 'View details ▼'}</div>
                        </td>
                      </tr>
                      {isOpen && (
                        <tr>
                          <td colSpan={6} style={{ background: '#f8faf9', padding: 14 }}>
                            <div className="metrics-grid" style={{ marginTop: 0 }}>
                              <div>
                                <span className="meta">Timestamp</span>
                                <div><code>{entry.timestamp || '—'}</code></div>
                              </div>
                              <div>
                                <span className="meta">Action · Role</span>
                                <div><code>{entry.action}</code> · {entry.role || '—'}</div>
                              </div>
                              <div>
                                <span className="meta">Subject / Slot / Scan ID</span>
                                <div>
                                  <code>
                                    {String(entry.subjectLabel || entry.subject || (entry.slot ? `Slot #${entry.slot}` : entry.scanId || '—'))}
                                  </code>
                                </div>
                              </div>
                              <div>
                                <span className="meta">Transaction Hash</span>
                                <div><code>{entry.txHash || '—'}</code></div>
                              </div>
                            </div>
                            {entry.error && (
                              <p className="role-warning" style={{ margin: '8px 0' }}>
                                <strong>Error / Reason:</strong> {entry.error}
                              </p>
                            )}
                            <pre style={{ margin: '8px 0 0', maxHeight: 220 }}>
                              {JSON.stringify(entry, null, 2)}
                            </pre>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          {(adminLogs?.totalPages ?? 1) > 1 && (
            <div className="toolbar" style={{ marginBottom: 0, marginTop: 14 }}>
              <span className="meta">
                Page {adminLogs?.page ?? logPage} of {adminLogs?.totalPages ?? 1} · Showing{' '}
                {logs.length} of {(adminLogs?.totalLogs ?? logs.length).toLocaleString()}
              </span>
              <div className="actions" style={{ margin: 0 }}>
                <button
                  type="button"
                  className="secondary small-btn"
                  disabled={logPage <= 1}
                  onClick={() => setLogPage((p) => Math.max(1, p - 1))}
                >
                  ← Prev
                </button>
                <button
                  type="button"
                  className="secondary small-btn"
                  disabled={logPage >= (adminLogs?.totalPages ?? 1)}
                  onClick={() => setLogPage((p) => p + 1)}
                >
                  Next →
                </button>
              </div>
            </div>
          )}
        </>
        ) : (
          <p>No activity log entries recorded yet.</p>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Review-only security alerts</h2>
          <span className="pill warn">
            {adminLogs?.activityCount ?? 0} total events · Review signal only
          </span>
        </div>
        {alerts.length > 0 ? (
          <ul className="alert-list">
            {alerts.map((alert) => (
              <li key={alert.id} className="alert-item">
                <div className="alert-item-head">
                  <strong>{alert.rule}</strong>
                  <span className="pill">Count: {alert.count}</span>
                  {alert.grouping && <span className="pill">{alert.grouping}</span>}
                  {alert.windowSeconds && <span className="meta">{alert.windowSeconds}s window</span>}
                  <code>{alert.subjectLabel || alert.subjectOrSlot}</code>
                  <span className="meta">{new Date(alert.timestamp).toLocaleTimeString()}</span>
                </div>
                <p>{alert.reason}</p>
                <small>{alert.note}</small>
              </li>
            ))}
          </ul>
        ) : (
          <p>No suspicious activity signals recorded.</p>
        )}
      </section>

      <section className="grid">
        <article className="card">
          <h2>Contract, hash &amp; allocation telemetry</h2>
          {status ? (
            <dl className="kv-list">
              <div>
                <dt>Chain / RPC</dt>
                <dd>
                  <code>{status.chainId}</code> · <code>{status.rpcUrl}</code>
                </dd>
              </div>
              <div>
                <dt>Contract</dt>
                <dd>
                  <code>{status.contract}</code>
                </dd>
              </div>
              <div>
                <dt>Runtime codeHash</dt>
                <dd>
                  <code>{status.codeHash}</code>
                </dd>
              </div>
              <div>
                <dt>Edition ID</dt>
                <dd>
                  <code>{status.editionId}</code>
                </dd>
              </div>
              <div>
                <dt>Allocation Policy</dt>
                <dd>
                  <code>{allocationInfo.mode}</code>
                  {allocationInfo.mode === 'queue_by_entry_block' && (
                    <span className="meta">
                      {' '}
                      · start={allocationInfo.lotteryStart}, end={allocationInfo.lotteryEndExclusive},
                      targetBlock={allocationInfo.lotteryTargetBlock}
                    </span>
                  )}
                </dd>
              </div>
              <div>
                <dt>Deadlines</dt>
                <dd className="meta">
                  Claim: {formatUnixTime(status.claimDeadline)} · Resale:{' '}
                  {formatUnixTime(status.resaleCutoff)} · Gate: {formatUnixTime(status.gateClose)}
                </dd>
              </div>
            </dl>
          ) : (
            <p>Loading contract telemetry…</p>
          )}
        </article>

        <article className="card">
          <div className="card-head">
            <h2>100k volume evidence</h2>
            <span className="pill warn">Historical · pre-queue-first</span>
          </div>
          <p className="meta">
            Historical throughput benchmark recorded prior to the queue-by-entry-block allocation
            policy change.
          </p>
          {status?.volumeEvidence ? (
            <dl className="kv-list">
              <div>
                <dt>Total mined writes</dt>
                <dd>
                  <strong>{status.volumeEvidence.totalWrites.toLocaleString()}</strong>
                </dd>
              </div>
              <div>
                <dt>Throughput</dt>
                <dd>
                  <strong>{status.volumeEvidence.writesPerSecond.toFixed(2)} writes/s</strong>
                </dd>
              </div>
              <div>
                <dt>Manifest SHA-256</dt>
                <dd>
                  <code>{status.volumeEvidence.manifestSha256}</code>
                </dd>
              </div>
            </dl>
          ) : (
            <p>No volume-summary.json loaded.</p>
          )}
        </article>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Role balances &amp; withdrawable credits</h2>
          {status && (
            <span className={`pill ${reconciled ? 'ok' : 'warn'}`}>
              {reconciled
                ? 'Reconciled: contract balance = sum of credits'
                : 'Mismatch between contract balance and credits'}
            </span>
          )}
        </div>
        {roleList.length > 0 ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Role</th>
                  <th>Address</th>
                  <th>Wallet Balance (INR)</th>
                  <th>Withdrawable Credit</th>
                </tr>
              </thead>
              <tbody>
                {roleList.map((r) => (
                  <tr key={r.role}>
                    <td>
                      <strong>{r.label}</strong> <code>{r.role}</code>
                    </td>
                    <td>
                      <code title={r.address}>{shortAddress(r.address)}</code>
                    </td>
                    <td>{formatWeiToInr(r.ethBalanceWei, status?.facePriceWei, status?.facePriceInr)}</td>
                    <td>
                      <strong>{formatWeiToInr(r.withdrawableWei, status?.facePriceWei, status?.facePriceInr)}</strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {(adminLogs?.totalPages ?? 1) > 1 && (
            <div className="toolbar" style={{ marginBottom: 0, marginTop: 14 }}>
              <span className="meta">
                Page {adminLogs?.page ?? logPage} of {adminLogs?.totalPages ?? 1} · Showing{' '}
                {logs.length} of {(adminLogs?.totalLogs ?? logs.length).toLocaleString()}
              </span>
              <div className="actions" style={{ margin: 0 }}>
                <button
                  type="button"
                  className="secondary small-btn"
                  disabled={logPage <= 1}
                  onClick={() => setLogPage((p) => Math.max(1, p - 1))}
                >
                  ← Prev
                </button>
                <button
                  type="button"
                  className="secondary small-btn"
                  disabled={logPage >= (adminLogs?.totalPages ?? 1)}
                  onClick={() => setLogPage((p) => p + 1)}
                >
                  Next →
                </button>
              </div>
            </div>
          )}
        </>
        ) : (
          <p>Loading role accounts…</p>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Security Engine &amp; ML Telemetry</h2>
          <span className="pill ok">{securityStatus?.recentEventsCount ?? 0} cumulative events</span>
        </div>
        <div className="metrics-grid">
          <div className="metric">
            <span>Supervised ML Artifact</span>
            <strong>{securityStatus?.mlModel?.version || 'Not loaded'}</strong>
            <small>{securityStatus?.mlModel?.modelType || 'l2_logistic_regression_behavioral'}</small>
          </div>
          <div className="metric">
            <span>Unsupervised Baseline</span>
            <strong>
              {securityStatus?.humanBaseline
                ? `${securityStatus.humanBaseline.sampleCount.toLocaleString()} sessions`
                : 'Default'}
            </strong>
            <small>{securityStatus?.humanBaseline?.source || 'Welford online calibration'}</small>
          </div>
        </div>
        {securityStatus && securityStatus.recentEvents.length > 0 && (
          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Event Type</th>
                  <th>Account</th>
                  <th>Session</th>
                  <th>Sale</th>
                </tr>
              </thead>
              <tbody>
                {securityStatus.recentEvents.slice(0, 10).map((ev, idx) => {
                  const ctx = (ev.eventContext as Record<string, unknown> | undefined) || {};
                  return (
                    <tr key={`${String(ev.eventId ?? idx)}`}>
                      <td>{ev.timestamp ? new Date(String(ev.timestamp)).toLocaleTimeString() : '—'}</td>
                      <td><code>{String(ev.eventType ?? 'UNKNOWN')}</code></td>
                      <td><code>{String(ev.accountId ?? '—')}</code></td>
                      <td><code>{String(ev.sessionId ?? '—')}</code></td>
                      <td><code>{String(ctx.eventSaleId ?? '—')}</code></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <details className="card">
        <summary>Raw JSON evidence (status, alerts, logs)</summary>
        <pre>{JSON.stringify({ status, adminLogs }, null, 2)}</pre>
      </details>
    </main>
  );
}
