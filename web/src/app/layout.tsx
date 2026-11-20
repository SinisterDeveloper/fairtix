import type { ReactNode } from 'react';
import Link from 'next/link';
import RoleSwitcher from '@/components/RoleSwitcher';
import './styles.css';

export const metadata = { title: 'FairTickets Demo', description: 'Receipt-backed event ticketing prototype' };
export default function Layout({ children }: { children: ReactNode }) {
  return <html lang="en"><body><header><Link className="brand" href="/">FairTickets</Link><nav><Link href="/attack">Attack</Link><Link href="/fan">Fan</Link><Link href="/gate">Gate</Link><Link href="/organiser">Organiser</Link></nav><RoleSwitcher/><span className="chain">Anvil · 31337</span></header><p className="demo-banner">Hackathon Demo Mode: roles use separated local Anvil keys. In production, fans sign from their own wallets.</p>{children}</body></html>;
}
