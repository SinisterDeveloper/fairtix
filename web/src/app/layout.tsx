import type { ReactNode } from 'react';
import Link from 'next/link';
import NavLinks from '@/components/NavLinks';
import RoleSwitcher from '@/components/RoleSwitcher';
import './styles.css';

export const metadata = { title: 'FairTix', description: 'Anti-scalping fair-allocation event ticketing platform' };
export default function Layout({ children }: { children: ReactNode }) {
  return <html lang="en"><body><header><Link className="brand" href="/">FairTix</Link><NavLinks/><RoleSwitcher/><span className="chain">Anvil · 31337</span></header>{children}</body></html>;
}
