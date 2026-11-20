'use client';
import { useEffect, useState } from 'react';
import TxStatusBanner from '@/components/TxStatusBanner';
import { formatUnixTime, formatWeiToEth, shortAddress } from '@/lib/format';
import type { AlertItem, ApiMutationResponse, DemoStatusResponse, RoleId } from '@/lib/types';

type AlertsPayload = { ok?: boolean; alerts?: AlertItem[]; error?: string };

export default function OrganiserPage() {
  const [status, setStatus] = useState<DemoStatusResponse | null>(null);
  const [alertsData, setAlertsData] = useState<AlertsPayload | null>(null);
  const [result, setResult] = useState<ApiMutationResponse | null>(null);
  const [statusError, setStatusError] = useState('');
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      const [sRes, aRes] = await Promise.all([
        fetch('/api/status', { cache: 'no-store' }),
        fetch('/api/organiser/alerts', { cache: 'no-store' }),
      ]);
      const sJson = (await sRes.json()) as DemoStatusResponse & { error?: string };
      const aJson = (await aRes.json()) as AlertsPayload;
      if (!sRes.ok || sJson.ok === false) {
        throw new Error(sJson.error || 'Could not load chain state.');
      }
      setStatus(sJson);
      setAlertsData(aJson);
      setStatusError('');
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : 'Could not load organiser state.');
    }
  }

  useEffect(() => {
    void refresh();
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
  }, []);

  async function act(endpoint: string, body: Record<string, unknown> = {}) {
    setBusy(true);
    try {
      const r = await fetch(`/api/${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'organiser', ...body }),
      });
      setResult((await r.json()) as ApiMutationResponse);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

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
  const alerts = Array.isArray(alertsData?.alerts) ? alertsData.alerts : [];

  return (
    <main className="page">
      <p className="eyebrow">ORGANISER CONSOLE</p>
      <h1>Event operations</h1>

      <div className="toolbar">
        <div className="actions" style={{ margin: 0 }}>
          <button disabled={busy} onClick={() => void act('organiser/advance-and-lock')}>
            Close entry and lock draw
          </button>
          <button disabled={busy} onClick={() => void act('organiser/draw')}>
            Run draw
          </button>
          <button disabled={busy} className="secondary" onClick={() => void act('withdraw')}>
            Withdraw proceeds
          </button>
        </div>
        <button className="secondary" onClick={() => void refresh()}>
          Refresh evidence
        </button>
      </div>

      {statusError && (
        <p className="role-warning" role="alert">
          {statusError}
        </p>
      )}

      <TxStatusBanner
        result={result}
        busy={busy}
        onResume={() => void act('tx/resume', { txHash: result?.txHash })}
      />

      <section className="card">
        <div className="card-head">
          <h2>Event &amp; phase summary</h2>
          {status && <span className="pill">{status.phase}</span>}
        </div>
        {status ? (
          <div className="metrics-grid">
            <div className="metric">
              <span>Entrants</span>
              <strong>{status.entrantsCount}</strong>
            </div>
            <div className="metric">
              <span>Winners</span>
              <strong>{status.winnersCount}</strong>
            </div>
            <div className="metric">
              <span>Issued / Capacity</span>
              <strong>
                {status.issuedCount} / {status.capacity}
              </strong>
            </div>
            <div className="metric">
              <span>Admitted</span>
              <strong>{status.admittedCount}</strong>
            </div>
            <div className="metric">
              <span>Face price</span>
              <strong>{formatWeiToEth(status.facePriceWei)}</strong>
              <small>{status.facePriceWei} wei</small>
            </div>
            <div className="metric">
              <span>Max resale cap</span>
              <strong>{formatWeiToEth(status.maxResalePriceWei)}</strong>
              <small>{status.maxResalePriceWei} wei</small>
            </div>
          </div>
        ) : (
          <p>Loading chain state…</p>
        )}
        {status && (
          <p className="meta-row">
            Claim deadline: {formatUnixTime(status.claimDeadline)} · Resale cutoff:{' '}
            {formatUnixTime(status.resaleCutoff)} · Gate close: {formatUnixTime(status.gateClose)}
          </p>
        )}
      </section>

      <section className="grid">
        <article className="card">
          <h2>Contract &amp; hash evidence</h2>
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
                <dt>Contract balance</dt>
                <dd>
                  <strong>{formatWeiToEth(status.balanceWei)}</strong> ({status.balanceWei} wei)
                </dd>
              </div>
            </dl>
          ) : (
            <p>Loading contract evidence…</p>
          )}
        </article>

        <article className="card">
          <h2>100k volume evidence</h2>
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
            <p>
              No <code>volume-summary.json</code> artifact loaded yet. Run{' '}
              <code>node src/volume-fairtickets.cjs 100000</code> to attach verified throughput and
              manifest checksums.
            </p>
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
                  <th>ETH Balance</th>
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
                    <td>{formatWeiToEth(r.ethBalanceWei)}</td>
                    <td>
                      <strong>{formatWeiToEth(r.withdrawableWei)}</strong>{' '}
                      <span className="meta">({r.withdrawableWei} wei)</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p>Loading role accounts…</p>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Suspicious activity</h2>
          <span className="pill warn">Review signal only — does not auto-block</span>
        </div>
        {alerts.length > 0 ? (
          <ul className="alert-list">
            {alerts.map((alert) => (
              <li key={alert.id} className="alert-item">
                <div className="alert-item-head">
                  <strong>{alert.rule}</strong>
                  <span className="pill">Count: {alert.count}</span>
                  <code>{alert.subjectOrSlot}</code>
                  <span className="meta">{new Date(alert.timestamp).toLocaleTimeString()}</span>
                </div>
                <p>{alert.reason}</p>
                <small>{alert.note}</small>
              </li>
            ))}
          </ul>
        ) : (
          <p>No suspicious activity signals recorded in the current activity log.</p>
        )}
      </section>

      <details className="card">
        <summary>Raw JSON evidence</summary>
        <pre>{JSON.stringify({ status, alerts: alertsData, lastAction: result }, null, 2)}</pre>
      </details>
    </main>
  );
}
