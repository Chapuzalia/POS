import { FINAL_JOB_STATUSES } from '../constants/config.ts'
import { PrintAgentError } from '../api/PrintAgentError.ts'
import type { PrintAgentClient } from '../api/printAgentClient.ts'
import type { PrintJob } from '../types.ts'

type PollOptions = {
  intervalMs?: number
  maxWaitMs?: number
  onUpdate?: (job: PrintJob) => void
  signal?: AbortSignal
}

export async function pollPrintJob(client: PrintAgentClient, jobId: string, options: PollOptions = {}) {
  const intervalMs = options.intervalMs || 800
  const deadline = Date.now() + (options.maxWaitMs || 15_000)
  while (Date.now() < deadline) {
    if (options.signal?.aborted) throw new PrintAgentError({ code: 'ABORTED' })
    const job = await client.getJob(jobId, options.signal)
    options.onUpdate?.(job)
    if (FINAL_JOB_STATUSES.has(job.status)) return job
    await new Promise<void>((resolve, reject) => {
      const timer = globalThis.setTimeout(resolve, intervalMs)
      options.signal?.addEventListener('abort', () => { globalThis.clearTimeout(timer); reject(new PrintAgentError({ code: 'ABORTED' })) }, { once: true })
    })
  }
  return { id: jobId, jobId, status: 'unknown' } satisfies PrintJob
}
