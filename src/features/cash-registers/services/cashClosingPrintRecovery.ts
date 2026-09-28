import type { CashClosingRecord } from '../../../types/index.ts'
import type { PrintJob } from '../../local-printing/types.ts'
import { cashClosingRequestId } from '../../local-printing/services/cashClosingPrintMapper.ts'

export function nextCashClosingCopyNumber(closing: Pick<CashClosingRecord, 'printCopies' | 'printAttempts'>, requested = 0) {
  return Math.max(1, closing.printCopies + 1, closing.printAttempts, requested)
}

export async function checkUnknownClosingJob(
  closing: Pick<CashClosingRecord, 'id' | 'printRequestId' | 'printJobId'>,
  getJob: (requestId: string, jobId?: string | null) => Promise<PrintJob | null>,
): Promise<'ready' | 'printed' | 'in_progress'> {
  const requestId = closing.printRequestId || cashClosingRequestId(closing.id)
  let previous = await getJob(requestId, closing.printJobId)
  if (previous && previous.requestId !== requestId) previous = await getJob(requestId)
  if (!previous || ['failed', 'cancelled', 'unknown'].includes(previous.status)) return 'ready'
  return previous.status === 'printed' ? 'printed' : 'in_progress'
}
