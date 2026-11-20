'use client';
import { useEffect, useState } from 'react';
export default function GatePage() {
  const [credential, setCredential] = useState(''); const [scanId, setScanId] = useState(''); const [result, setResult] = useState<unknown>(null);
  useEffect(() => { setCredential(localStorage.getItem('fairtickets-credential') || ''); }, []);
  async function redeem() { try { const r = await fetch('/api/gate/redeem', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scanId: scanId || crypto.randomUUID(), credential: JSON.parse(credential) }) }); setResult(await r.json()); } catch (e) { setResult({ error: e instanceof Error ? e.message : 'Invalid credential' }); } }
  return <main className="page"><p className="eyebrow">VENUE GATE</p><h1>Verify a ticket</h1><section className="card narrow"><label>Credential JSON<textarea rows={9} value={credential} onChange={(e) => setCredential(e.target.value)} /></label><label>Scan ID (optional)<input value={scanId} onChange={(e) => setScanId(e.target.value)} placeholder="Generated for this scan" /></label><button onClick={() => void redeem()}>Verify and redeem</button><p>Entry is admitted only after the CLI confirms the successful receipt and matching contract event.</p><pre>{JSON.stringify(result, null, 2)}</pre></section></main>;
}
