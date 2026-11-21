import { NextRequest } from 'next/server';

export function authorizeSecurityEvaluation(_req: NextRequest, _operation: 'replay' | 'capacity benchmark') {
  return null;
}
