'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import LifecycleStepper from '@/components/LifecycleStepper';
import TxStatusBanner from '@/components/TxStatusBanner';
import { describeAllocation } from '@/lib/allocation';
import { formatWeiToInr, inrToWei, shortAddress } from '@/lib/format';
import type { ApiMutationResponse, DemoStatusResponse, RoleId } from '@/lib/types';

export default function FanPage() {
  const [role, setRole] = useState<RoleId>('fanA');
  const [status, setStatus] = useState<DemoStatusResponse | null>(null);
  const [subject, setSubject] = useState('fan-a-subject');
  const [slot, setSlot] = useState('1');
  const [version, setVersion] = useState('1');
  const [price, setPrice] = useState('2400');
  const [message, setMessage] = useState<ApiMutationResponse | null>(null);
  const [tray, setTray] = useState<Array<Record<string, unknown>>>([]);
  const [enteredByContract, setEnteredByContract] = useState<Record<string, Record<string, { blockNumber?: number | null }>>>({});
  const [statusError, setStatusError] = useState('');
  const [busy, setBusy] = useState(false);
  const isFan = role === 'fanA' || role === 'fanB';

  async function refresh(): Promise<DemoStatusResponse | null> {
    try {
      const r = await fetch('/api/status', { cache: 'no-store' });
      const data = await r.json();
      if (!r.ok || data.ok === false) throw new Error(data.error || 'Could not load chain state.');
      setStatus(data);
      setStatusError('');
      return data as DemoStatusResponse;
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : 'Could not load chain state.');
      return null;
    }
  }

  useEffect(() => {
    void refresh();
    const id = setInterval(refresh, 3000);
    try {
      const saved = localStorage.getItem('fairtickets-credentials');
      if (saved) setTray(JSON.parse(saved));
    } catch {
      localStorage.removeItem('fairtickets-credentials');
    }
    try {
      const savedEntered = localStorage.getItem('fairtickets-entered');
      if (savedEntered) setEnteredByContract(JSON.parse(savedEntered));
    } catch {
      localStorage.removeItem('fairtickets-entered');
    }
    const onRole = (e: Event) => {
      const next = (e as CustomEvent<RoleId>).detail;
      setRole(next);
      if (next === 'fanA' || next === 'fanB') setSubject(`demo-${next}-subject`);
    };
    window.addEventListener('fairtickets-role-change', onRole);
    const active = localStorage.getItem('fairtickets-role') as RoleId | null;
    if (active) {
      setRole(active);
      if (active === 'fanA' || active === 'fanB') setSubject(`demo-${active}-subject`);
    }
    return () => {
      clearInterval(id);
      window.removeEventListener('fairtickets-role-change', onRole);
    };
  }, []);

  async function act(endpoint: string, body: Record<string, unknown> = {}) {
    setBusy(true);
    try {
      const r = await fetch(`/api/${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role, ...body }),
      });
      const data = (await r.json()) as ApiMutationResponse;
      setMessage(data);
      const latestStatus = await refresh();
      const contractAddr = latestStatus?.contract || status?.contract;
      if (endpoint === 'enter' && data.txStatus === 'confirmed' && contractAddr) {
        const contractKey = contractAddr.toLowerCase();
        setEnteredByContract((prev) => {
          const next = {
            ...prev,
            [contractKey]: {
              ...(prev[contractKey] || {}),
              [role]: { blockNumber: data.blockNumber ?? null },
            },
          };
          try {
            localStorage.setItem('fairtickets-entered', JSON.stringify(next));
          } catch {}
          return next;
        });
      }
    } finally {
      setBusy(false);
    }
  }

  async function credential() {
    setBusy(true);
    try {
      const inGate = status?.phase?.toUpperCase().includes('GATE');
      const expirySeconds = !inGate && status?.resaleCutoff ? status.resaleCutoff + 60 : undefined;
      const r = await fetch('/api/credential/sign', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          role,
          slot: Number(slot),
          version: Number(version),
          ...(expirySeconds ? { expirySeconds } : {}),
        }),
      });
      const data = await r.json();
      setMessage(data);
      if (data.credential) {
        const next = [
          ...tray,
          { ...data.credential, label: `${role === 'fanA' ? 'Fan A' : 'Fan B'} · v${version}`, role },
        ];
        setTray(next);
        localStorage.setItem('fairtickets-credentials', JSON.stringify(next));
      }
    } finally {
      setBusy(false);
    }
  }

  function applyPriceRatio(numerator: number, denominator: number) {
    const baseInr = status?.facePriceInr || 3000;
    const val = Math.round((baseInr * numerator) / denominator);
    setPrice(String(val));
  }

  const activeAccount = status?.roles?.[role];
  const activeAddr = activeAccount?.address?.toLowerCase() || '';
  const isWinner = Boolean(activeAddr && status?.winners?.some((w) => w.toLowerCase() === activeAddr));
  const heldTicket = status?.tickets?.find((t) => t.owner.toLowerCase() === activeAddr);
  const activeListings = status?.tickets?.filter((t) => t.listed) || [];
  const phase = status?.phase?.toUpperCase() || '';
  const allocationInfo = describeAllocation(status);
  const enteredInfo = status?.contract ? enteredByContract[status.contract.toLowerCase()]?.[role] : undefined;

  useEffect(() => {
    if (heldTicket) {
      setSlot(String(heldTicket.slot));
      setVersion(String(heldTicket.version));
    } else if (activeListings.length > 0) {
      setSlot(String(activeListings[0].slot));
      setVersion(String(activeListings[0].version));
    }
  }, [role, heldTicket?.slot, heldTicket?.version, activeListings[0]?.slot, activeListings[0]?.version]);

  const fanQueueStatus = !status
    ? 'Loading chain state…'
    : heldTicket
      ? `Holds slot #${heldTicket.slot} (v${heldTicket.version}${heldTicket.admitted ? ', admitted' : ''})`
      : isWinner
        ? 'Reservation available to claim'
        : status.drawn
          ? 'No reservation after finalization'
          : status.drawLocked
            ? 'Allocation pending'
            : enteredInfo
              ? `Entry confirmed${enteredInfo.blockNumber ? ` (mined in block #${enteredInfo.blockNumber})` : ''}`
              : 'Not yet entered';

  return (
    <main className="page">
      <p className="eyebrow">FAN CONSOLE</p>
      <h1>Your ticket journey</h1>

      <LifecycleStepper phase={status?.phase} context="fan" />

      <div className="toolbar">
        <div className="toolbar-meta">
          <span>
            Acting as{' '}
            <strong>{isFan ? (role === 'fanA' ? 'Fan A' : 'Fan B') : role[0].toUpperCase() + role.slice(1)}</strong>
          </span>
          {status && <span className="pill">{status.phase}</span>}
          {isFan && status && (
            <span className="meta">
              {fanQueueStatus}
              {' · '}Withdrawable: {formatWeiToInr(activeAccount?.withdrawableWei, status?.facePriceWei, status?.facePriceInr)}
            </span>
          )}
        </div>
        <button className="secondary" onClick={() => void refresh()}>
          Refresh chain state
        </button>
      </div>

      {!isFan && (
        <p className="role-warning" role="status">
          Choose Fan A or Fan B in the role selector to use fan actions.
        </p>
      )}
      {isFan && status && (
        <div className="flow-callout">
          <span>
            {phase.includes('ENTRY')
              ? enteredInfo
                ? 'Entry confirmed in queue. Switch to the other fan to enter, or open Organiser to close entry.'
                : 'Entry is open — click "Enter event" below to join the ticket queue.'
              : phase.includes('DRAW')
                ? 'Entry is closed. Go to Organiser to lock allocation and finalize reservations.'
                : phase.includes('CLAIM')
                  ? isWinner && !heldTicket
                    ? 'You have a reservation! Click "Claim reserved ticket" below.'
                    : heldTicket
                      ? 'Ticket claimed! Sign a v1 gate pass now, or advance to Resale on Organiser.'
                      : 'No reservation for this role. Switch to the reserved fan or advance to Resale.'
                  : phase.includes('RESALE')
                    ? heldTicket && !heldTicket.listed
                      ? 'You hold a ticket — test 120% (rejected) or list at 80%/100% for resale.'
                      : !heldTicket && activeListings.length > 0
                        ? 'A resale listing is live! Click "Buy listing" to purchase at the capped price.'
                        : heldTicket
                          ? 'Ticket listed or updated — sign a gate pass for your current version, then advance to Gate.'
                          : 'Resale window is open.'
                    : phase.includes('GATE')
                      ? heldTicket
                        ? 'Venue Gate is open! Sign a pass for your current version, then open Gate to redeem.'
                        : 'Venue Gate is open — take a saved pass to the Gate tab.'
                      : 'Event closed. Withdraw any remaining proceeds below.'}
          </span>
          {(phase.includes('DRAW') || (phase.includes('CLAIM') && heldTicket) || (phase.includes('RESALE') && heldTicket)) && (
            <Link className="small-link" href="/organiser">
              Open Organiser →
            </Link>
          )}
          {phase.includes('GATE') && (
            <Link className="small-link" href="/gate">
              Open Gate Scanner →
            </Link>
          )}
        </div>
      )}
      {statusError && (
        <p className="role-warning" role="alert">
          {statusError}
        </p>
      )}

      <TxStatusBanner
        result={message}
        busy={busy}
        onResume={() => void act('tx/resume', { scanId: message?.scanId, txHash: message?.txHash })}
      />

      <section className="grid">
        <article className={`card ${phase.includes('ENTRY') ? 'card-active' : ''}`}>
          <div className="card-head">
            <h2>1. Join the ticket queue</h2>
            {phase.includes('ENTRY') && <span className="pill ok">Active phase</span>}
          </div>
          <p>
            {allocationInfo.mode === 'queue_by_entry_block' ? (
              <>
                Each verified person gets <strong>one queue entry</strong>. Earlier blocks get
                priority; only a batch of entries mined in the same block that exceeds remaining
                capacity enters a lottery. Re-submitting the same subject or wallet is rejected
                on-chain.
              </>
            ) : (
              <>
                Each verified person gets <strong>one entry</strong>. Re-submitting the same subject
                or wallet is rejected on-chain.
              </>
            )}
          </p>
          {isFan && status && (
            <p className="meta">
              Queue status: <strong>{fanQueueStatus}</strong>
            </p>
          )}
          <label>
            Demo subject
            <input value={subject} onChange={(e) => setSubject(e.target.value)} />
          </label>
          <button disabled={!isFan || busy} onClick={() => void act('enter', { subject })}>
            Enter event
          </button>
        </article>

        <article className={`card ${phase.includes('CLAIM') || phase.includes('RESALE') ? 'card-active' : ''}`}>
          <div className="card-head">
            <h2>2. Claim or trade</h2>
            {(phase.includes('CLAIM') || phase.includes('RESALE')) && (
              <span className="pill ok">Active phase</span>
            )}
          </div>
          <p>
            Reserved fans claim at face price (
            {status ? formatWeiToInr(status.facePriceWei, status.facePriceWei, status.facePriceInr) : '—'}
            ). During resale, holders can list at or below the on-chain cap.
          </p>
          {isFan && status && !heldTicket && (
            <p className="meta">
              {isWinner
                ? 'Reservation available to claim — click "Claim reserved ticket" below.'
                : status.drawn
                  ? 'No reservation after finalization for this wallet.'
                  : status.drawLocked
                    ? 'Allocation pending — waiting for the organiser to finalize reservations.'
                    : 'Reservations are finalized after entry closes.'}
            </p>
          )}

          {activeListings.length > 0 && (
            <div className="listing-box">
              <strong>Live resale listing:</strong>
              {activeListings.map((t) => (
                <div key={t.slot} className="listing-row">
                  <span>
                    Slot #{t.slot} (v{t.version}) ·{' '}
                    {formatWeiToInr(t.resalePriceWei, status?.facePriceWei, status?.facePriceInr)}
                  </span>
                  <button
                    type="button"
                    className="secondary small-btn"
                    onClick={() => {
                      setSlot(String(t.slot));
                      setVersion(String(t.version));
                      const inrLabel = formatWeiToInr(t.resalePriceWei, status?.facePriceWei, status?.facePriceInr).replace(/[₹,\s]/g, '');
                      setPrice(inrLabel || '2400');
                    }}
                  >
                    Fill listing
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="inline-fields">
            <label>
              Slot
              <input value={slot} onChange={(e) => setSlot(e.target.value)} />
            </label>
            <label>
              Ticket version
              <input value={version} onChange={(e) => setVersion(e.target.value)} />
            </label>
          </div>

          {heldTicket && (
            <div className="preset-row">
              <button
                type="button"
                className="secondary small-btn"
                onClick={() => {
                  setSlot(String(heldTicket.slot));
                  setVersion(String(heldTicket.version));
                }}
              >
                Use my ticket (Slot #{heldTicket.slot}, v{heldTicket.version})
              </button>
            </div>
          )}

          <label>
            Resale price (INR)
            <input value={price} onChange={(e) => setPrice(e.target.value)} />
          </label>

          {status && (
            <div className="preset-row">
              <span className="meta">Quick price:</span>
              <button
                type="button"
                className="secondary small-btn"
                onClick={() => applyPriceRatio(80, 100)}
              >
                80% (valid)
              </button>
              <button
                type="button"
                className="secondary small-btn"
                onClick={() => applyPriceRatio(100, 100)}
              >
                Max cap (100%)
              </button>
              <button
                type="button"
                className="secondary small-btn"
                onClick={() => applyPriceRatio(120, 100)}
              >
                120% (test reject)
              </button>
            </div>
          )}

          <div className="actions">
            <button
              disabled={!isFan || busy}
              className={phase.includes('CLAIM') && isWinner && !heldTicket ? '' : 'secondary'}
              onClick={() => void act('claim')}
            >
              Claim reserved ticket
            </button>
            <button
              disabled={!isFan || busy}
              className={phase.includes('RESALE') && heldTicket && !heldTicket.listed ? '' : 'secondary'}
              onClick={() =>
                void act('list', {
                  slot: Number(slot),
                  version: Number(version),
                  priceWei: inrToWei(price, status?.facePriceWei, status?.facePriceInr),
                })
              }
            >
              List for resale
            </button>
            <button
              disabled={!isFan || busy}
              className={phase.includes('RESALE') && !heldTicket && activeListings.length > 0 ? '' : 'secondary'}
              onClick={() =>
                void act('buy', {
                  slot: Number(slot),
                  version: Number(version),
                  priceWei: inrToWei(price, status?.facePriceWei, status?.facePriceInr),
                })
              }
            >
              Buy listing
            </button>
          </div>
          <p>
            Max resale price:{' '}
            <strong>
              {status ? formatWeiToInr(status.maxResalePriceWei, status.facePriceWei, status.facePriceInr) : '—'}
            </strong>
            . Try a higher INR amount (for example 30000) to see the cap enforced.
          </p>
        </article>

        <article className={`card ${phase.includes('GATE') ? 'card-active' : ''}`}>
          <div className="card-head">
            <h2>3. Gate passes &amp; proceeds</h2>
            {phase.includes('GATE') && <span className="pill ok">Active phase</span>}
          </div>
          <p>
            Sign a short-lived gate pass for your ticket. Older passes (like <code>v1</code> after a
            resale) stay saved so you can verify they are rejected at the gate.
          </p>
          <div className="actions" style={{ marginTop: 12 }}>
            <button disabled={!isFan || busy} onClick={() => void credential()}>
              Sign and save credential
            </button>
            <button disabled={!isFan || busy} className="secondary" onClick={() => void act('withdraw')}>
              Withdraw proceeds
            </button>
          </div>
          {tray.length > 0 ? (
            <>
              <ul className="pass-list">
                {tray.map((c, i) => {
                  const isOldEvent =
                    Boolean(status?.contract && c.contract && String(c.contract).toLowerCase() !== status.contract.toLowerCase());
                  return (
                    <li key={i} className="pass-item">
                      <div>
                        <strong>{String(c.label)}</strong>
                        <span className="meta">
                          {' '}
                          · Slot #{String(c.slot)} · v{String(c.version)}
                        </span>
                        {isOldEvent && (
                          <span className="pill warn" style={{ marginLeft: 8 }}>
                            Old event
                          </span>
                        )}
                      </div>
                      <Link className="small-link" href="/gate">
                        Use at Gate →
                      </Link>
                    </li>
                  );
                })}
              </ul>
              <div className="preset-row" style={{ marginTop: 10 }}>
                {status?.contract &&
                  tray.some(
                    (c) => c.contract && String(c.contract).toLowerCase() !== status.contract.toLowerCase(),
                  ) && (
                    <button
                      type="button"
                      className="secondary small-btn"
                      onClick={() => {
                        const filtered = tray.filter(
                          (c) =>
                            String(c.contract || '').toLowerCase() === status.contract.toLowerCase(),
                        );
                        setTray(filtered);
                        localStorage.setItem('fairtickets-credentials', JSON.stringify(filtered));
                      }}
                    >
                      Clear old-event passes
                    </button>
                  )}
                <button
                  type="button"
                  className="secondary small-btn"
                  onClick={() => {
                    setTray([]);
                    localStorage.removeItem('fairtickets-credentials');
                  }}
                >
                  Clear saved passes
                </button>
              </div>
            </>
          ) : (
            <p className="meta">No saved passes yet. Claim or buy a ticket, then sign a pass.</p>
          )}
        </article>
      </section>

      <StatePanel status={status} message={message} />
    </main>
  );
}

function resolveRoleLabel(status: DemoStatusResponse, address: string): string {
  const lower = address.toLowerCase();
  const entry = Object.values(status.roles || {}).find((r) => r.address.toLowerCase() === lower);
  return entry ? `${entry.label} (${shortAddress(address)})` : shortAddress(address);
}

function StatePanel({ status, message }: { status: DemoStatusResponse | null; message: unknown }) {
  return (
    <section className="card state">
      <div className="card-head">
        <h2>On-chain tickets</h2>
        {status && (
          <span className="meta">
            {status.phase} · {status.entrantsCount} entrants · {status.issuedCount}/{status.capacity}{' '}
            issued · {status.admittedCount} admitted
          </span>
        )}
      </div>

      {status && status.tickets.length > 0 ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Slot</th>
                <th>Owner</th>
                <th>Version</th>
                <th>Paid Price</th>
                <th>Listing</th>
                <th>Admitted</th>
              </tr>
            </thead>
            <tbody>
              {status.tickets.map((t) => (
                <tr key={t.slot}>
                  <td>#{t.slot}</td>
                  <td>
                    <code title={t.owner}>{resolveRoleLabel(status, t.owner)}</code>
                  </td>
                  <td>v{t.version}</td>
                  <td>{formatWeiToInr(t.paidPriceWei, status.facePriceWei, status.facePriceInr)}</td>
                  <td>
                    {t.listed
                      ? formatWeiToInr(t.resalePriceWei, status.facePriceWei, status.facePriceInr)
                      : 'Not listed'}
                  </td>
                  <td>{t.admitted ? 'Yes' : 'No'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p>{status ? 'No tickets issued yet.' : 'Loading chain state…'}</p>
      )}

      <details style={{ marginTop: 14 }}>
        <summary>Raw state &amp; last action JSON</summary>
        <pre>
          {JSON.stringify(
            {
              contract: status?.contract,
              codeHash: status?.codeHash,
              tickets: status?.tickets,
              lastAction: message,
            },
            null,
            2,
          )}
        </pre>
      </details>
    </section>
  );
}
