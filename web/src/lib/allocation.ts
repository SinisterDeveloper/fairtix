import type { DemoStatusResponse } from '@/lib/types';

export type AllocationSummary =
  | { mode: 'legacy' }
  | {
      mode: 'queue_by_entry_block';
      state: 'pending_lock' | 'lottery_required' | 'no_lottery';
      lotteryStart: number;
      lotteryEndExclusive: number;
      lotteryTargetBlock: number;
      lotteryApplicants: number;
      lotterySlots: number;
    };

/** Interpret optional queue-first allocation metadata from `/api/status`. */
export function describeAllocation(status: Partial<DemoStatusResponse> | null | undefined): AllocationSummary {
  const alloc = status?.allocation;
  if (!alloc || alloc.policy !== 'queue_by_entry_block') {
    return { mode: 'legacy' };
  }

  const lotteryStart = Number(alloc.lotteryStart ?? 0);
  const lotteryEndExclusive = Number(alloc.lotteryEndExclusive ?? 0);
  const lotteryTargetBlock = Number(alloc.lotteryTargetBlock ?? 0);
  const capacity = Number(status?.capacity ?? 0);
  const lotteryApplicants = Math.max(0, lotteryEndExclusive - lotteryStart);
  const lotterySlots = Math.max(0, capacity - lotteryStart);

  if (!status?.drawLocked) {
    return {
      mode: 'queue_by_entry_block',
      state: 'pending_lock',
      lotteryStart,
      lotteryEndExclusive,
      lotteryTargetBlock,
      lotteryApplicants,
      lotterySlots,
    };
  }

  return {
    mode: 'queue_by_entry_block',
    state: lotteryTargetBlock !== 0 ? 'lottery_required' : 'no_lottery',
    lotteryStart,
    lotteryEndExclusive,
    lotteryTargetBlock,
    lotteryApplicants,
    lotterySlots,
  };
}

/**
 * Return false only when status succeeds and explicitly identifies a locked
 * queue-first edition that requires no lottery (`lotteryTargetBlock === 0`).
 */
export function shouldMineBeforeFinalize(
  status: (Partial<DemoStatusResponse> & { ok?: boolean }) | null | undefined,
): boolean {
  if (!status || status.ok === false) return true;
  const summary = describeAllocation(status);
  if (summary.mode !== 'queue_by_entry_block') return true;
  return summary.state !== 'no_lottery';
}
