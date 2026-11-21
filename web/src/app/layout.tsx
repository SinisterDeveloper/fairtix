import type { ReactNode } from 'react';
import Link from 'next/link';
import NavLinks from '@/components/NavLinks';
import RoleSwitcher from '@/components/RoleSwitcher';
import './styles.css';

export const metadata = { title: 'FairTickets Demo', description: 'Receipt-backed event ticketing prototype' };
export default function Layout({ children }: { children: ReactNode }) {
  return <html lang="en"><body><header><Link className="brand" href="/">FairTickets</Link><NavLinks/><RoleSwitcher/><span className="chain">Anvil · 31337</span></header>{children}</body></html>;
}
