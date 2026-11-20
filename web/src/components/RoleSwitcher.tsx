'use client';
import { useEffect, useState } from 'react';
import type { RoleId } from '@/lib/types';
const roles: RoleId[] = ['fanA', 'fanB', 'organiser', 'gate'];
export default function RoleSwitcher() {
  const [role, setRole] = useState<RoleId>('fanA');
  const [address, setAddress] = useState('');
  useEffect(() => {
    const saved = localStorage.getItem('fairtickets-role') as RoleId | null;
    if (saved && roles.includes(saved)) setRole(saved);
    fetch('/api/status', { cache: 'no-store' }).then((r) => r.json()).then((s) => setAddress(s.roles?.[saved || 'fanA']?.address || '')).catch(() => {});
  }, []);
  function change(next: RoleId) {
    setRole(next); localStorage.setItem('fairtickets-role', next); window.dispatchEvent(new CustomEvent('fairtickets-role-change', { detail: next }));
    fetch('/api/status', { cache: 'no-store' }).then((r) => r.json()).then((s) => setAddress(s.roles?.[next]?.address || '')).catch(() => setAddress(''));
  }
  return <div className="role-switch"><select aria-label="Active demo role" value={role} onChange={(e) => change(e.target.value as RoleId)}>{roles.map((r) => <option key={r} value={r}>{r === 'fanA' ? 'Fan A' : r === 'fanB' ? 'Fan B' : r[0].toUpperCase() + r.slice(1)}</option>)}</select><small>{address ? `${address.slice(0, 6)}…${address.slice(-4)}` : 'Demo key'}</small></div>;
}
