import { useState } from 'react'
import { createPortal } from 'react-dom'
import { CheckCircle2, ChevronDown, Circle, X } from 'lucide-react'
import { Button } from '../../../components/ui/Button'
import { getOnboardingGroups, type OnboardingTopic } from './onboardingModel'
import { getOnboardingSteps } from './onboardingTours'

type Props = {
  disabled: boolean
  isOpen: boolean
  onClose: () => void
  onStart: (topic: OnboardingTopic) => void
  reviewed: readonly string[]
  theme: string
  topics: readonly OnboardingTopic[]
}

export function OnboardingIndex({ disabled, isOpen, onClose, onStart, reviewed, theme, topics }: Props) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  if (!isOpen) return null
  const groups = getOnboardingGroups(topics, reviewed)
  const done = groups.reduce((total, group) => total + group.completed, 0)

  return createPortal(<aside aria-label="Índice del inicio guiado" className="crm-shell crm-onboarding-index fixed right-3 bottom-[calc(12px+env(safe-area-inset-bottom,0px))] left-3 z-[60] flex max-h-[min(640px,calc(100dvh-100px))] flex-col overflow-hidden rounded-2xl border border-[var(--crm-border-subtle)] bg-[var(--crm-surface)] text-[var(--crm-text)] shadow-[var(--crm-shadow-floating)] sm:right-5 sm:bottom-5 sm:left-auto sm:w-[380px]" data-crm-theme={theme} data-theme={theme} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}>
    <header className="shrink-0 border-b border-[var(--crm-border-subtle)] p-4">
      <div className="flex items-center justify-between gap-3"><h2 className="m-0 text-lg font-bold">Tu inicio guiado</h2><Button aria-label="Cerrar índice" className="!size-11 !min-h-11 !min-w-11 !p-0" onClick={onClose} type="button"><X className="size-4" /></Button></div>
      <p className="mt-2 mb-3 text-sm text-[var(--crm-text-muted)]">Despliega un tema y elige una guía. Las marcas indican guías vistas, no datos guardados.</p>
      <div aria-live="polite" className="flex items-center gap-3 text-xs text-[var(--crm-text-muted)]"><progress aria-label="Guías vistas" className="h-1.5 min-w-0 flex-1 accent-[var(--crm-blue)]" max={Math.max(1, topics.length)} value={done} /><span>{done} de {topics.length} guías vistas</span></div>
    </header>
    <div className="min-h-0 overflow-y-auto overscroll-contain p-3">
      {groups.map(group => <details className="group mb-2 rounded-xl border border-[var(--crm-border-subtle)] last:mb-0" key={group.id} onToggle={event => {
        const open = event.currentTarget.open
        setExpanded(current => {
          if (current.has(group.id) === open) return current
          const next = new Set(current)
          if (open) next.add(group.id)
          else next.delete(group.id)
          return next
        })
      }} open={expanded.has(group.id)}>
        <summary className="flex min-h-14 cursor-pointer list-none items-center gap-3 rounded-xl px-3 py-3 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-[var(--crm-blue)] [&::-webkit-details-marker]:hidden">
          <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-[var(--crm-text-muted)] transition-transform group-open:rotate-180 motion-reduce:transition-none" />
          <span className="min-w-0 flex-1">{group.title}</span><span aria-label={`${group.completed} de ${group.guides.length} guías vistas`} className="shrink-0 rounded-full bg-[var(--crm-surface-soft)] px-2 py-1 text-xs text-[var(--crm-text-muted)]">{group.completed}/{group.guides.length}</span>
        </summary>
        <ul className="m-0 list-none border-t border-[var(--crm-border-subtle)] p-1.5">
          {group.guides.map(topic => {
            const viewed = reviewed.includes(topic.id)
            return <li key={topic.id}><Button aria-label={`Iniciar guía: ${topic.title}`} className="!flex !h-auto !min-h-16 !w-full !items-start !justify-start !gap-3 !rounded-lg !px-3 !py-3 !text-left !whitespace-normal hover:!bg-[var(--crm-surface-soft)]" disabled={disabled} onClick={() => onStart(topic)} type="button">
              {viewed ? <CheckCircle2 aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-[var(--crm-blue)]" /> : <Circle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-[var(--crm-text-muted)]" />}
              <span className="min-w-0"><span className="block text-sm font-semibold text-[var(--crm-text)]">{topic.title}<span className="sr-only">{viewed ? ', guía vista' : ', pendiente'}</span></span><span className="mt-1 block text-xs leading-relaxed text-[var(--crm-text-muted)]">{topic.description}</span><span className="mt-1 block text-xs font-medium text-[var(--crm-blue)]">{getOnboardingSteps(topic).length} pasos</span></span>
            </Button></li>
          })}
        </ul>
      </details>)}
    </div>
  </aside>, document.body)
}
