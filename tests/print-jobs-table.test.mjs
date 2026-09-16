import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { nodes } from './helpers/component-harness.mjs'
import { compileComponent } from './helpers/component-harness.mjs'
import test from 'node:test'

const source = await readFile(new URL('../src/features/local-printing/components/PrintJobsTable.tsx', import.meta.url), 'utf8')
const modules = {
  '../../../components/ui/DataTable': { DataTable: () => null },
  'react/jsx-runtime': (await import('react/jsx-runtime')),
  react: (await import('react')),
}
const { PrintJobsTable } = compileComponent(source, modules)

const job = { id: 'job-1', jobId: 'job-1', requestId: 'print:sale:1', status: 'sent', updatedAt: '', createdAt: '' }

test('the empty print jobs state renders a plain fallback without a data table', () => {
  const empty = PrintJobsTable({ jobs: [] })
  assert.equal(empty.props.className.includes('rounded'), true)
  assert.equal(nodes(empty).some((node) => node.props?.children === 'No hay trabajos recientes.'), true)
  assert.equal(nodes(empty).some((node) => typeof node.type === 'function' && node.props?.['aria-label'] === 'Trabajos de impresión'), false)
})

test('the print jobs table renders the data table when records exist', () => {
  const withJobs = PrintJobsTable({ jobs: [job] })
  assert.equal(nodes(withJobs).some((node) => node.props?.children === 'No hay trabajos recientes.'), false)
  assert.equal(nodes(withJobs).some((node) => node.type === 'tr'), true)
})
