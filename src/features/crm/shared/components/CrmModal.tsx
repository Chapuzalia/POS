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
  const maxWidth = size === 'large' ? 1200 : 560

  return (
    <Modal isOpen onOpenChange={(isOpen) => {
      if (!isOpen) onClose()
    }}>
      <Modal.Backdrop
        className="crm-shell !z-[80] !bg-black/55"
        data-crm-theme={crmTheme}
        data-theme={crmTheme}
        isDismissable
      >
        <Modal.Container
          className="!max-w-none !p-3 sm:!p-6"
          placement="center"
          scroll="inside"
        >
          <Modal.Dialog
            aria-label={label}
            className="min-w-0 overflow-hidden rounded-[var(--crm-radius-lg)] border-0 bg-[var(--crm-surface)] text-[var(--crm-text)] shadow-[var(--crm-shadow-card)] !h-auto !min-h-0 !w-full !max-h-[calc(100dvh-24px)] !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !p-0 !text-[var(--crm-text)] !shadow-[var(--crm-shadow-floating)] [&>*]:!max-w-none sm:!max-h-[calc(100dvh-48px)] sm:!rounded-[var(--crm-radius-lg)]"
            style={{ maxWidth }}
          >
            {children}
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  )
}
