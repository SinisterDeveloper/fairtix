'use client';
import { useEffect, useState } from 'react';
import type { ApiMutationResponse, DemoStatusResponse, RoleId } from '@/lib/types';
import TxStatusBanner from '@/components/TxStatusBanner';

export default function FanPage() {
  const [role, setRole] = useState<RoleId>('fanA');
  const [status, setStatus] = useState<DemoStatusResponse | null>(null);
  const [subject, setSubject] = useState('fan-a-subject');
  const [slot, setSlot] = useState('1');
  const [version, setVersion] = useState('1');
  const [price, setPrice] = useState('180000');
  const [message, setMessage] = useState<ApiMutationResponse | null>(null);
  const [tray, setTray] = useState<Array<Record<string, unknown>>>([]);
  const [statusError, setStatusError] = useState('');
  const isFan = role === 'fanA' || role === 'fanB';
  async function refresh() {
    try {
      const r = await fetch('/api/status', { cache: 'no-store' });
      const data = await r.json();
      if (!r.ok || data.ok === false) throw new Error(data.error || 'Could not load chain state.');
      setStatus(data);
      setStatusError('');
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : 'Could not load chain state.');
    }
  }
  useEffect(() => { void refresh(); const id = setInterval(refresh, 3000); try { const saved = localStorage.getItem('fairtickets-credentials'); if (saved) setTray(JSON.parse(saved)); } catch { localStorage.removeItem('fairtickets-credentials'); } const onRole = (e: Event) => { const next = (e as CustomEvent<RoleId>).detail; setRole(next); if (next === 'fanA' || next === 'fanB') setSubject(`demo-${next}-subject`); }; window.addEventListener('fairtickets-role-change', onRole); const active = localStorage.getItem('fairtickets-role') as RoleId | null; if (active) { setRole(active); if (active === 'fanA' || active === 'fanB') setSubject(`demo-${active}-subject`); } return () => { clearInterval(id); window.removeEventListener('fairtickets-role-change', onRole); }; }, []);
  async function act(endpoint: string, body: Record<string, unknown> = {}) { const r = await fetch(`/api/${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role, ...body }) }); setMessage(await r.json()); await refresh(); }
  async function credential() { const expirySeconds = status?.resaleCutoff ? status.resaleCutoff + 60 : undefined; const r = await fetch('/api/credential/sign', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role, slot: Number(slot), version: Number(version), ...(expirySeconds ? { expirySeconds } : {}) }) }); const data = await r.json(); setMessage(data); if (data.credential) { const next = [...tray, { ...data.credential, label: `${role === 'fanA' ? 'Fan A' : 'Fan B'} · v${version}`, role }]; setTray(next); localStorage.setItem('fairtickets-credentials', JSON.stringify(next)); } }
  return <main className="page"><p className="eyebrow">FAN CONSOLE</p><h1>Your ticket journey</h1><div className="toolbar"><span>Acting as {isFan ? (role === 'fanA' ? 'Fan A' : 'Fan B') : role[0].toUpperCase() + role.slice(1)}</span><button className="secondary" onClick={() => void refresh()}>Refresh chain state</button></div>{!isFan && <p className="role-warning" role="status">Choose Fan A or Fan B in the role selector to use fan actions.</p>}{statusError && <p className="role-warning" role="alert">{statusError}</p>}<TxStatusBanner result={message} onResume={() => void act('tx/resume', { scanId: message?.scanId })}/><section className="grid"><article className="card"><h2>Register for the draw</h2><label>Demo subject<input value={subject} onChange={(e) => setSubject(e.target.value)} /></label><button disabled={!isFan} onClick={() => void act('enter', { subject })}>Enter event</button><p>Entry closes at the on-chain deadline. Duplicate subjects and wallets are rejected by the contract.</p></article><article className="card"><h2>Claim or trade</h2><label>Slot<input value={slot} onChange={(e) => setSlot(e.target.value)} /></label><label>Ticket version<input value={version} onChange={(e) => setVersion(e.target.value)} /></label><label>Price in wei<input value={price} onChange={(e) => setPrice(e.target.value)} /></label><div className="actions"><button disabled={!isFan} onClick={() => void act('claim')}>Claim reserved ticket</button><button disabled={!isFan} className="secondary" onClick={() => void act('list', { slot: Number(slot), version: Number(version), priceWei: price })}>List for resale</button><button disabled={!isFan} className="secondary" onClick={() => void act('buy', { slot: Number(slot), version: Number(version), priceWei: price })}>Buy listing</button></div><p>Max resale price: {status?.maxResalePriceWei ?? '—'} wei. Try a higher value to see the contract enforce the cap.</p></article><article className="card"><h2>Gate credential tray</h2><p>Sign a short-lived credential for the selected ticket version and preserve older versions for the stale credential demo.</p><button disabled={!isFan} onClick={() => void credential()}>Sign and save credential</button><button disabled={!isFan} className="secondary" onClick={() => void act('withdraw')}>Withdraw proceeds</button><ul>{tray.map((c, i) => <li key={i}>{String(c.label)} · slot {String(c.slot)}</li>)}</ul></article></section><StatePanel status={status} message={message} /></main>;
}
function StatePanel({ status, message }: { status: DemoStatusResponse | null; message: unknown }) { return <section className="card state"><h2>On-chain state</h2><p>{status ? `${status.phase} · ${status.entrantsCount} entrants · ${status.issuedCount}/${status.capacity} issued · ${status.admittedCount} admitted` : 'Loading chain state…'}</p><pre>{JSON.stringify({ contract: status?.contract, codeHash: status?.codeHash, tickets: status?.tickets, lastAction: message }, null, 2)}</pre></section>; }
