'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/attack', label: 'Attack' },
  { href: '/fan', label: 'Fan' },
  { href: '/gate', label: 'Gate' },
  { href: '/organiser', label: 'Organiser' },
];

export default function NavLinks() {
  const pathname = usePathname();
  return (
    <nav aria-label="Primary">
      {LINKS.map((item) => {
        const active = pathname === item.href;
        return (
          <Link key={item.href} href={item.href} className={active ? 'nav-active' : undefined}>
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
