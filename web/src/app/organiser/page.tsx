'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import TxStatusBanner from '@/components/TxStatusBanner';
import { describeAllocation } from '@/lib/allocation';
import { DEFAULT_EVENT_META, loadEventMeta, saveEventMeta } from '@/lib/event-meta';
import { formatWeiToInr } from '@/lib/format';
import type { AlertItem, ApiMutationResponse, DemoStatusResponse } from '@/lib/types';

type AlertsPayload = { ok?: boolean; alerts?: AlertItem[]; activityCount?: number; error?: string };

export default function OrganiserPage() {
  const [status, setStatus] = useState<DemoStatusResponse | null>(null);
  const [alertsData, setAlertsData] = useState<AlertsPayload | null>(null);
  const [result, setResult] = useState<ApiMutationResponse | null>(null);
  const [statusError, setStatusError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const busy = busyAction !== null;
  const metaSyncedRef = useRef(false);
  const [eventTitle, setEventTitle] = useState(DEFAULT_EVENT_META.title);
  const [eventVenue, setEventVenue] = useState(DEFAULT_EVENT_META.venue);
  const [eventDate, setEventDate] = useState(DEFAULT_EVENT_META.dateLabel);
  const [newCapacity, setNewCapacity] = useState('2');
  const [newQueueSeconds, setNewQueueSeconds] = useState('600');
  const [newPriceInr, setNewPriceInr] = useState('3000');
  const [metaSavedMsg, setMetaSavedMsg] = useState('');

  async function refresh() {
    try {
      const [sRes, aRes] = await Promise.all([
        fetch('/api/status', { cache: 'no-store' }),
        fetch('/api/organiser/alerts', { cache: 'no-store' }),
      ]);
      const sJson = (await sRes.json()) as DemoStatusResponse & { error?: string };
      const aJson = (await aRes.json()) as AlertsPayload;
      if (!sRes.ok || sJson.ok === false) {
        const msg = sJson.error || 'No active event.';
        if (msg.toLowerCase().includes('missing') || msg.toLowerCase().includes('init-demo')) {
          setStatus(null);
          setAlertsData(aJson);
          setStatusError('');
          return;
        }
        throw new Error(msg);
      }
      setStatus(sJson);
      setAlertsData(aJson);
      setStatusError('');
      if (sJson.eventMeta && !metaSyncedRef.current) {
        metaSyncedRef.current = true;
        setEventTitle(sJson.eventMeta.title);
        setEventVenue(sJson.eventMeta.venue);
        setEventDate(sJson.eventMeta.dateLabel);
        saveEventMeta(sJson.eventMeta);
      }
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : 'Could not load organiser state.');
    } finally {
      setLoaded(true);
    }
  }

  useEffect(() => {
    const meta = loadEventMeta();
    setEventTitle(meta.title);
    setEventVenue(meta.venue);
    setEventDate(meta.dateLabel);
    void refresh();
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
  }, []);

  async function createEvent() {
    setBusyAction('create');
    setMetaSavedMsg('');
    try {
      const meta = {
        title: eventTitle.trim() || DEFAULT_EVENT_META.title,
        venue: eventVenue.trim() || DEFAULT_EVENT_META.venue,
        dateLabel: eventDate.trim() || DEFAULT_EVENT_META.dateLabel,
      };
      saveEventMeta(meta);
      const r = await fetch('/api/organiser/create-event', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...meta,
          capacity: Math.max(1, Math.min(50, Number(newCapacity) || 2)),
          entryWindowSeconds: Math.max(30, Math.min(86400, Number(newQueueSeconds) || 600)),
          facePriceInr: Math.max(100, Number(newPriceInr) || 3000),
        }),
      });
      const resJson = (await r.json()) as ApiMutationResponse;
      setResult(resJson);
      if (resJson.ok) setStatusError('');
      await refresh();
    } finally {
      setBusyAction(null);
    }
  }

  async function saveDisplayDetails() {
    setBusyAction('save');
    setMetaSavedMsg('');
    try {
      const meta = {
        title: eventTitle.trim() || DEFAULT_EVENT_META.title,
        venue: eventVenue.trim() || DEFAULT_EVENT_META.venue,
        dateLabel: eventDate.trim() || DEFAULT_EVENT_META.dateLabel,
      };
      saveEventMeta(meta);
      const r = await fetch('/api/organiser/save-meta', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(meta),
      });
      if (r.ok) {
        setMetaSavedMsg('Saved');
        await refresh();
      }
    } finally {
      setBusyAction(null);
    }
  }

  async function resetEvent() {
    setBusyAction('reset');
    setMetaSavedMsg('');
    try {
      const r = await fetch('/api/organiser/reset-event', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      setResult((await r.json()) as ApiMutationResponse);
      setStatus(null);
      setStatusError('');
    } finally {
      setBusyAction(null);
    }
  }

  async function act(endpoint: string, body: Record<string, unknown> = {}) {
    setBusyAction(endpoint);
    try {
      const r = await fetch(`/api/${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'organiser', ...body }),
      });
      setResult((await r.json()) as ApiMutationResponse);
      await refresh();
    } finally {
      setBusyAction(null);
    }
  }

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

  return (
    <main className="page">
      <div className="card-head">
        <div>
          <p className="eyebrow">ORGANISERS</p>
          <h1>Event Operations</h1>
        </div>
        <div className="actions" style={{ margin: 0 }}>
          <Link className="button secondary small-btn" href="/gate">
            Gate Scanner
          </Link>
          <Link className="button secondary small-btn" href="/admin">
            Admin
          </Link>
        </div>
      </div>

      <p className="stepper-hint">
        <strong>Organiser workflow:</strong>{' '}
        {!loaded
          ? 'Loading event operations…'
          : !status
            ? 'Create a new event below to open the fan booking queue.'
            : activeStep === 1
              ? 'Queue is open. Once fans join on Book Tickets, click "1. Lock queue" below.'
              : activeStep === 2
                ? 'Queue locked. Click "2. Assign slots" to finalize reservations.'
                : activeStep === 3
                  ? `Stage ${status.phase} is open. Advance to the next phase (+5m) when ready.`
                  : 'Doors are open (or event ended). Collect proceeds or open Gate Scanner.'}
      </p>

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

      {status && (
        <section className="status-strip">
          <div>
            <span>Phase</span>
            <strong>{status.phase}</strong>
          </div>
          <div>
            <span>Queue</span>
            <strong>{status.entrantsCount}</strong>
          </div>
          <div>
            <span>Allocated</span>
            <strong>{status.winnersCount}</strong>
          </div>
          <div>
            <span>Claimed</span>
            <strong>
              {status.issuedCount} / {status.capacity}
            </strong>
          </div>
          <div>
            <span>Price</span>
            <strong>{formatWeiToInr(status.facePriceWei, status.facePriceWei, status.facePriceInr)}</strong>
          </div>
        </section>
      )}

      {status && (
        <section className="card">
          <div className="card-head">
            <h2>Phase Controls</h2>
            <span className="pill">
              {allocationInfo.mode === 'legacy'
                ? 'Legacy'
                : allocationInfo.state === 'pending_lock'
                  ? 'Queue open'
                  : allocationInfo.state === 'lottery_required'
                    ? `Lottery: ${allocationInfo.lotteryApplicants} for ${allocationInfo.lotterySlots} slots`
                    : `Direct allocation (Queue ≤ Capacity)`}
            </span>
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
              <small className="meta">1. Lock queue</small>
            </div>
            <div className={`step-action ${activeStep === 2 ? 'step-action-active' : ''}`}>
              <button
                disabled={busy}
                className={activeStep === 2 ? '' : 'secondary'}
                onClick={() => void act('organiser/draw')}
              >
                Finalize reservations
              </button>
              <small className="meta">2. Assign slots</small>
            </div>
            <div className={`step-action ${activeStep === 3 ? 'step-action-active' : ''}`}>
              <button
                disabled={busy}
                className={activeStep === 3 ? '' : 'secondary'}
                onClick={() => void act('organiser/advance-time', { seconds: 301 })}
              >
                Advance to next phase (+5m)
              </button>
              <small className="meta">3. Claim → Resale → Gate</small>
            </div>
            <div className={`step-action ${activeStep === 4 ? 'step-action-active' : ''}`}>
              <button
                disabled={busy}
                className={activeStep === 4 ? '' : 'secondary'}
                onClick={() => void act('withdraw')}
              >
                Withdraw proceeds
              </button>
              <small className="meta">4. Payout</small>
            </div>
          </div>
        </section>
      )}

      {!loaded ? (
        <section className="card">
          <h2>Loading event operations…</h2>
          <p className="meta">Checking active on-chain event state…</p>
        </section>
      ) : (
        <section className="card">
        <div className="card-head">
          <h2>{status ? 'Manage Event' : 'Create Event'}</h2>
          <span className="pill">{status ? 'Live' : 'No active event'}</span>
        </div>
        <div className="metrics-grid">
          <label>
            Event name
            <input value={eventTitle} disabled={busy} onChange={(e) => setEventTitle(e.target.value)} />
          </label>
          <label>
            Venue
            <input value={eventVenue} disabled={busy} onChange={(e) => setEventVenue(e.target.value)} />
          </label>
          <label>
            Date
            <input value={eventDate} disabled={busy} onChange={(e) => setEventDate(e.target.value)} />
          </label>
        </div>
        <div className="metrics-grid">
          <label>
            Capacity
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
            Queue window (sec)
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
            Price (INR)
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
          <button disabled={busy} onClick={() => void createEvent()}>
            {busyAction === 'create' ? 'Creating…' : 'Create event & open queue'}
          </button>
          <button type="button" disabled={busy} className="secondary" onClick={() => void saveDisplayDetails()}>
            {busyAction === 'save' ? 'Saving…' : 'Save display details'}
          </button>
          {status && (
            <button type="button" disabled={busy} className="secondary" onClick={() => void resetEvent()}>
              {busyAction === 'reset' ? 'Closing…' : 'Close & clear event'}
            </button>
          )}
          {metaSavedMsg && <span className="pill ok">{metaSavedMsg}</span>}
        </div>
      </section>
      )}

      {alerts.length > 0 && (
        <div className="flow-callout">
          <span>
            <strong>{alerts.length}</strong> security alert{alerts.length === 1 ? '' : 's'} flagged
          </span>
          <Link className="small-link" href="/admin">
            Inspect in Admin →
          </Link>
        </div>
      )}
    </main>
  );
}
