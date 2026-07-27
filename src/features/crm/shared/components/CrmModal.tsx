import { Modal } from '@heroui/react'
import type { ReactNode } from 'react'

export type CrmModalProps = {
  children: ReactNode
  label: string
  onClose: () => void
  size?: 'compact' | 'large'
}

export function CrmModal({ children, label, onClose, size = 'compact' }: CrmModalProps) {
  const crmTheme = document.querySelector<HTMLElement>('.crm-shell')?.dataset.crmTheme ?? 'light'

  return (
    <Modal isOpen onOpenChange={(isOpen) => {
      if (!isOpen) onClose()
    }}>
      <Modal.Backdrop
        className="crm-shell !z-[80] !bg-black/55 !backdrop-blur-sm"
        data-crm-theme={crmTheme}
        data-theme={crmTheme}
        isDismissable
      >
        <Modal.Container
          className={size === 'large' ? '!max-w-[820px] !p-3 sm:!p-6' : '!max-w-[520px] !p-3 sm:!p-6'}
          placement="center"
          scroll="inside"
          size="lg"
        >
          <Modal.Dialog
            aria-label={label}
            className="min-w-0 overflow-hidden rounded-[var(--crm-radius-lg)] border-0 bg-[var(--crm-surface)] text-[var(--crm-text)] shadow-[var(--crm-shadow-card)] !max-h-[calc(100dvh-24px)] !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !p-0 !text-[var(--crm-text)] !shadow-[var(--crm-shadow-floating)] sm:!max-h-[calc(100dvh-48px)] sm:!rounded-[var(--crm-radius-lg)]"
          >
            {children}
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  )
}
