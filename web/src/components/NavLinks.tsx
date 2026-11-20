'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const ZONES = [
  { href: '/fan', label: 'User (Fan)', match: ['/fan'] },
  { href: '/organiser', label: 'Organiser / Gate', match: ['/organiser', '/gate'] },
  { href: '/admin', label: 'Admin', match: ['/admin', '/attack'] },
];

export default function NavLinks() {
  const pathname = usePathname();
  return (
    <nav aria-label="Primary zones">
      {ZONES.map((zone) => {
        const active = zone.match.includes(pathname);
        return (
          <Link key={zone.href} href={zone.href} className={active ? 'nav-active' : undefined}>
            {zone.label}
          </Link>
        );
      })}
    </nav>
  );
}
