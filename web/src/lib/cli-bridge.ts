import { spawn } from 'node:child_process';
import path from 'node:path';
import type { ApiMutationResponse, RoleId } from './types';

const repoRoot = path.resolve(process.cwd(), '..');
const cliPath = path.join(repoRoot, 'src', 'cli.cjs');

export function runCli(args: string[], timeoutMs = Number(process.env.FAIRTICKETS_CLI_TIMEOUT_MS || 15_000)): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args, '--json'], { cwd: repoRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (value: Record<string, unknown>) => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, txStatus: 'unknown_recovering', txHash: null, errorCode: 'RPC_TIMEOUT', error: 'The command timed out. Check or resume its journal before retrying.' });
    }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => finish({ ok: false, txStatus: 'unknown_recovering', txHash: null, errorCode: 'INTERNAL_ERROR', error: error.message }));
    child.once('close', (code) => {
      try {
        const value = JSON.parse(stdout) as Record<string, unknown>;
        if (typeof value.txStatus === 'string') value.ok = value.txStatus === 'confirmed';
        finish(value);
      } catch {
        finish({ ok: false, txStatus: code === 0 ? 'rejected' : 'unknown_recovering', txHash: null, errorCode: 'INTERNAL_ERROR', error: (stderr || stdout || `CLI exited with ${code}`).trim() });
      }
    });
  });
}

export function roleArgs(role?: RoleId) { return role ? ['--role', role] : []; }
export function httpStatus(result: ApiMutationResponse) {
  if (result.txStatus === 'pending' || result.txStatus === 'unknown_recovering') return 202;
  if (result.txStatus === 'rejected') return 409;
  return 200;
}
