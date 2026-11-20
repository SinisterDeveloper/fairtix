'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import LifecycleStepper from '@/components/LifecycleStepper';
import TxStatusBanner from '@/components/TxStatusBanner';
import { describeAllocation } from '@/lib/allocation';
import { DEFAULT_EVENT_META, loadEventMeta, saveEventMeta } from '@/lib/event-meta';
import { formatUnixTime, formatWeiToInr, shortAddress } from '@/lib/format';
import type { AlertItem, ApiMutationResponse, DemoStatusResponse, RoleId } from '@/lib/types';

type AlertsPayload = { ok?: boolean; alerts?: AlertItem[]; activityCount?: number; error?: string };

export default function OrganiserPage() {
  const [status, setStatus] = useState<DemoStatusResponse | null>(null);
  const [alertsData, setAlertsData] = useState<AlertsPayload | null>(null);
  const [result, setResult] = useState<ApiMutationResponse | null>(null);
  const [statusError, setStatusError] = useState('');
  const [busy, setBusy] = useState(false);
  const [eventTitle, setEventTitle] = useState(DEFAULT_EVENT_META.title);
  const [eventVenue, setEventVenue] = useState(DEFAULT_EVENT_META.venue);
  const [newCapacity, setNewCapacity] = useState('2');
  const [newQueueSeconds, setNewQueueSeconds] = useState('600');
  const [newPriceInr, setNewPriceInr] = useState('3000');

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
    const meta = loadEventMeta();
    setEventTitle(meta.title);
    setEventVenue(meta.venue);
    void refresh();
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
  }, []);

  async function createEvent() {
    setBusy(true);
    try {
      saveEventMeta({
        title: eventTitle.trim() || DEFAULT_EVENT_META.title,
        venue: eventVenue.trim() || DEFAULT_EVENT_META.venue,
        dateLabel: 'Live Event',
      });
      const r = await fetch('/api/organiser/create-event', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          capacity: Number(newCapacity),
          entryWindowSeconds: Number(newQueueSeconds),
          facePriceInr: Number(newPriceInr),
        }),
      });
      setResult((await r.json()) as ApiMutationResponse);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

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
  const allocationInfo = describeAllocation(status);
  const phase = status?.phase?.toUpperCase() || '';
  const activeStep = !status
    ? 0
    : phase.includes('ENTRY') || (phase.includes('DRAW') && !status.drawLocked)
      ? 1
      : phase.includes('DRAW') && status.drawLocked && !status.drawn
        ? 2
        : phase.includes('CLAIM') || phase.includes('RESALE')
          ? 3
          : phase.includes('GATE') || phase.includes('CLOSED')
            ? 4
            : 0;
  const nextPhaseHint = phase.includes('CLAIM')
    ? status?.issuedCount === 0
      ? '0 tickets claimed yet — have a reserved fan claim on /fan before advancing to RESALE!'
      : 'Currently in CLAIM → click to open RESALE'
    : phase.includes('RESALE')
      ? 'Currently in RESALE → click to open GATE'
      : '3. Fast-forwards the demo clock (Claim → Resale → Gate).';

  return (
    <main className="page">
      <div className="card-head">
        <div>
          <p className="eyebrow">ZONE 2 · ORGANISER &amp; GATE</p>
          <h1>Event operations &amp; live telemetry</h1>
        </div>
        <div className="actions" style={{ margin: 0 }}>
          <Link className="button secondary" href="/gate">
            Open Gate Scanner
          </Link>
          <Link className="button secondary" href="/admin">
            Admin Backend Logs →
          </Link>
        </div>
      </div>

      <LifecycleStepper phase={status?.phase} context="organiser" />

      <section className="card">
        <div className="card-head">
          <h2>Create new event &amp; launch booking queue</h2>
          <span className="pill">Replaces current demo event</span>
        </div>
        <div className="inline-fields">
          <label>
            Event name
            <input value={eventTitle} disabled={busy} onChange={(e) => setEventTitle(e.target.value)} />
          </label>
          <label>
            Venue
            <input value={eventVenue} disabled={busy} onChange={(e) => setEventVenue(e.target.value)} />
          </label>
        </div>
        <div className="metrics-grid">
          <label>
            Total tickets (capacity)
            <input
              type="number"
              min={1}
              max={50}
              value={newCapacity}
              disabled={busy}
              onChange={(e) => setNewCapacity(e.target.value)}
            />
          </label>
          <label>
            Queue window (seconds)
            <input
              type="number"
              min={30}
              max={86400}
              value={newQueueSeconds}
              disabled={busy}
              onChange={(e) => setNewQueueSeconds(e.target.value)}
            />
          </label>
          <label>
            Ticket price (INR)
            <input
              type="number"
              min={100}
              value={newPriceInr}
              disabled={busy}
              onChange={(e) => setNewPriceInr(e.target.value)}
            />
          </label>
        </div>
        <div className="actions" style={{ marginTop: 8, marginBottom: 0 }}>
          <button disabled={busy} className="secondary" onClick={() => void createEvent()}>
            {busy ? 'Creating event…' : 'Create event & open queue'}
          </button>
        </div>
      </section>

      {status && (
        <section className="card">
          <div className="card-head">
            <h2>Live command summary</h2>
            <span className="pill ok">Phase: {status.phase}</span>
          </div>
          <div className="metrics-grid">
            <div className="metric">
              <span>Phase</span>
              <strong>{status.phase}</strong>
            </div>
            <div className="metric">
              <span>Capacity</span>
              <strong>{status.capacity}</strong>
            </div>
            <div className="metric">
              <span>Eligible entries</span>
              <strong>{status.entrantsCount}</strong>
            </div>
            <div className="metric">
              <span>Allocations</span>
              <strong>{status.winnersCount}</strong>
            </div>
            <div className="metric">
              <span>Claims</span>
              <strong>{status.issuedCount}</strong>
            </div>
            <div className="metric">
              <span>Review alerts</span>
              <strong>{alerts.length}</strong>
              <small>{alertsData?.activityCount ?? 0} logged events</small>
            </div>
          </div>
        </section>
      )}

      <section className="card">
        <div className="card-head">
          <h2>Organiser controls (run in order)</h2>
          <button className="secondary" onClick={() => void refresh()}>
            Refresh evidence
          </button>
        </div>
        <div className="step-actions">
          <div className={`step-action ${activeStep === 1 ? 'step-action-active' : ''}`}>
            <button
              disabled={busy}
              className={activeStep === 1 ? '' : 'secondary'}
              onClick={() => void act('organiser/advance-and-lock')}
            >
              Close entry and lock allocation
            </button>
            <small className="meta">
              1. Advances past entry deadline and locks queue allocation (and a future target block if
              an oversubscribed batch needs a lottery).
            </small>
          </div>
          <div className={`step-action ${activeStep === 2 ? 'step-action-active' : ''}`}>
            <button
              disabled={busy}
              className={activeStep === 2 ? '' : 'secondary'}
              onClick={() => void act('organiser/draw')}
            >
              Finalize reservations
            </button>
            <small className="meta">
              2. Finalizes reservations (mines 2 blocks first only when a lottery is required or for
              legacy editions).
            </small>
          </div>
          <div className={`step-action ${activeStep === 3 ? 'step-action-active' : ''}`}>
            <button
              disabled={busy}
              className={activeStep === 3 ? '' : 'secondary'}
              onClick={() => void act('organiser/advance-time', { seconds: 301 })}
            >
              Advance to next phase (+5m)
            </button>
            <small className="meta">{nextPhaseHint}</small>
          </div>
          <div className={`step-action ${activeStep === 4 ? 'step-action-active' : ''}`}>
            <button
              disabled={busy}
              className={activeStep === 4 ? '' : 'secondary'}
              onClick={() => void act('withdraw')}
            >
              Withdraw proceeds
            </button>
            <small className="meta">
              4. Transfers accrued primary-sale proceeds to the organiser wallet.
            </small>
          </div>
        </div>
      </section>

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
              <span>Reserved / Winners</span>
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
              <strong>{formatWeiToInr(status.facePriceWei, status.facePriceWei, status.facePriceInr)}</strong>
              <small>INR ticket face value</small>
            </div>
            <div className="metric">
              <span>Max resale cap</span>
              <strong>{formatWeiToInr(status.maxResalePriceWei, status.facePriceWei, status.facePriceInr)}</strong>
              <small>Enforced 100% cap</small>
            </div>
          </div>
        ) : (
          <p>Loading chain state…</p>
        )}
        {status && (
          <>
            <p className="meta-row">
              {allocationInfo.mode === 'legacy' ? (
                <>
                  <strong>Allocation mode:</strong> Legacy / unknown (allocation metadata absent).
                </>
              ) : allocationInfo.state === 'pending_lock' ? (
                <>
                  <strong>Queue-first allocation:</strong> Earlier blocks get priority; only a batch
                  of entries mined in the same block that exceeds remaining capacity is randomized.
                  Lock allocation after entry closes to check whether a lottery is required.
                </>
              ) : allocationInfo.state === 'lottery_required' ? (
                <>
                  <strong>Lottery required (block #{allocationInfo.lotteryTargetBlock}):</strong>{' '}
                  {allocationInfo.lotteryApplicants} eligible{' '}
                  {allocationInfo.lotteryApplicants === 1 ? 'fan' : 'fans'} in the oversubscribed
                  batch competing for {allocationInfo.lotterySlots} remaining{' '}
                  {allocationInfo.lotterySlots === 1 ? 'slot' : 'slots'}. Earlier batches fit in
                  queue order.
                </>
              ) : (
                <>
                  <strong>No lottery needed:</strong>{' '}
                  {status.drawn
                    ? 'Reservations were finalized in queue order.'
                    : 'Reservations will be finalized in queue order.'}
                </>
              )}
            </p>
            <p className="meta-row">
              Claim deadline: {formatUnixTime(status.claimDeadline)} · Resale cutoff:{' '}
              {formatUnixTime(status.resaleCutoff)} · Gate close: {formatUnixTime(status.gateClose)}
            </p>
          </>
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
                <dt>Escrow balance</dt>
                <dd>
                  <strong>{formatWeiToInr(status.balanceWei, status.facePriceWei, status.facePriceInr)}</strong>
                </dd>
              </div>
            </dl>
          ) : (
            <p>Loading contract evidence…</p>
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
        ) : (
          <p>Loading role accounts…</p>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Suspicious activity</h2>
          <span className="pill warn">
            Review signal only ({alertsData?.activityCount ?? 0} events) — does not auto-block
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
