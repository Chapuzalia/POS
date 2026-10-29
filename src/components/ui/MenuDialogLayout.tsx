import { X } from 'lucide-react'
import type { ReactNode, Ref } from 'react'
import { formatMoney } from '../../lib/format'
import { AppModal } from './AppModal'
import { Button } from './Button'

type Props = {
  children: ReactNode
  controls?: ReactNode
  disabled: boolean
  footer: ReactNode
  onClose: () => void
  sectionRef?: Ref<HTMLElement>
  skipEnterAnimation?: boolean
  title: string
  variantName: string
  priceCents: number
}

export function MenuDialogLayout({ children, controls, disabled, footer, onClose, sectionRef, skipEnterAnimation = false, title, variantName, priceCents }: Props) {
  return (
    <AppModal backdropClassName={skipEnterAnimation ? 'data-[entering=true]:!animate-none' : ''} containerClassName={`!p-4 ${skipEnterAnimation ? 'data-[entering=true]:!animate-none' : ''}`} dismissDisabled={disabled} label={`Configurar ${title}`} maxWidth={1024} onClose={onClose} scroll="content">
      <section ref={sectionRef} className="flex max-h-[inherit] min-h-0 flex-col overflow-hidden bg-[var(--surface)] text-[var(--foreground)]">
        <header className="shrink-0 space-y-4 border-b border-[var(--separator)] p-4 sm:p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 className="break-words text-2xl font-bold">{title}</h2>
              <p className="text-sm text-[var(--muted)]">{variantName} · {formatMoney(priceCents)} por menú</p>
            </div>
            <Button aria-label="Cerrar" className="!size-11 !min-h-11 !min-w-11 !shrink-0 !rounded-[12px] !p-0" disabled={disabled} onClick={onClose} size="sm" type="button" variant="tertiary">
              <X aria-hidden="true" className="h-4 w-4" />
            </Button>
          </div>
          {controls}
        </header>
        <div className="min-h-0 space-y-5 overflow-y-auto overscroll-contain p-4 [-webkit-overflow-scrolling:touch] sm:p-5 [&>:first-child]:mt-0">
          {children}
        </div>
        {footer ? <footer className="shrink-0 space-y-3 border-t border-[var(--separator)] bg-[var(--background)] p-4 sm:px-5">{footer}</footer> : null}
      </section>
    </AppModal>
  )
}
