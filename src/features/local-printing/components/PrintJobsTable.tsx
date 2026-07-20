import type { PrintJob } from '../types'

export function PrintJobsTable({ jobs }: { jobs: PrintJob[] }) {
  return <div className="overflow-x-auto rounded-[var(--radius)] border border-[var(--separator)]">
    <table className="w-full min-w-[560px] text-left text-sm"><thead className="bg-[var(--surface-secondary)] text-xs uppercase text-[var(--muted)]"><tr><th className="p-3">Trabajo</th><th className="p-3">Peticion</th><th className="p-3">Estado</th><th className="p-3">Fecha</th></tr></thead>
      <tbody>{jobs.length ? jobs.map((job, index) => <tr className="border-t border-[var(--separator)]" key={job.id || job.jobId || job.requestId || index}><td className="p-3 font-mono text-xs">{job.jobId || job.id || '-'}</td><td className="max-w-56 truncate p-3 font-mono text-xs">{job.requestId || '-'}</td><td className="p-3 font-bold">{job.status}</td><td className="p-3 text-[var(--muted)]">{job.updatedAt || job.createdAt || '-'}</td></tr>) : <tr><td className="p-6 text-center text-[var(--muted)]" colSpan={4}>No hay trabajos recientes.</td></tr>}</tbody>
    </table>
  </div>
}
