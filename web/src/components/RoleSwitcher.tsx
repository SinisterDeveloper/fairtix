'use client';
import { useEffect, useState } from 'react';
import { formatWeiToEth, shortAddress } from '@/lib/format';
import type { RoleId } from '@/lib/types';

const roles: RoleId[] = ['fanA', 'fanB', 'organiser', 'gate'];

export default function RoleSwitcher() {
  const [role, setRole] = useState<RoleId>('fanA');
  const [address, setAddress] = useState('');
  const [ethBalance, setEthBalance] = useState('');

  async function loadRoleInfo(target: RoleId) {
    try {
      const r = await fetch('/api/status', { cache: 'no-store' });
      const s = await r.json();
      const info = s.roles?.[target];
      setAddress(info?.address || '');
      setEthBalance(info?.ethBalanceWei ? formatWeiToEth(info.ethBalanceWei, 2) : '');
    } catch {
      setAddress('');
      setEthBalance('');
    }
  }

  useEffect(() => {
    const saved = localStorage.getItem('fairtickets-role') as RoleId | null;
    const initial = saved && roles.includes(saved) ? saved : 'fanA';
    setRole(initial);
    void loadRoleInfo(initial);
  }, []);

  function change(next: RoleId) {
    setRole(next);
    localStorage.setItem('fairtickets-role', next);
    window.dispatchEvent(new CustomEvent('fairtickets-role-change', { detail: next }));
    void loadRoleInfo(next);
  }

  return (
    <div className="role-switch">
      <select aria-label="Active demo role" value={role} onChange={(e) => change(e.target.value as RoleId)}>
        {roles.map((r) => (
          <option key={r} value={r}>
            {r === 'fanA' ? 'Fan A' : r === 'fanB' ? 'Fan B' : r[0].toUpperCase() + r.slice(1)}
          </option>
        ))}
      </select>
      <small title={address}>
        {address ? `${shortAddress(address)}${ethBalance ? ` · ${ethBalance}` : ''}` : 'Demo key'}
      </small>
    </div>
  );
}
