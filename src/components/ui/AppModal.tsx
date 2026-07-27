import { Modal } from '@heroui/react'
import type { ReactNode } from 'react'

type AppModalProps = {
  backdropClassName?: string
  children: ReactNode
  containerClassName?: string
  dialogClassName?: string
  dismissDisabled?: boolean
  label: string
  onClose: () => void
  placement?: 'center' | 'bottom'
}

export function AppModal({
  backdropClassName = '',
  children,
  containerClassName = '!max-w-xl !p-0 sm:!p-4',
  dialogClassName = '',
  dismissDisabled = false,
  label,
  onClose,
  placement = 'center',
}: AppModalProps) {
  return (
    <Modal
      isOpen
      onOpenChange={(isOpen) => {
        if (!isOpen && !dismissDisabled) onClose()
      }}
    >
      <Modal.Backdrop
        className={`!z-[70] !bg-black/55 !backdrop-blur-[2px] ${backdropClassName}`}
        isDismissable={!dismissDisabled}
        isKeyboardDismissDisabled={dismissDisabled}
      >
        <Modal.Container
          className={containerClassName}
          placement={placement}
          scroll="inside"
          size="lg"
        >
          <Modal.Dialog
            aria-label={label}
            className={`!max-h-[calc(100dvh-24px)] !overflow-hidden !rounded-[var(--radius)] !border !border-[var(--separator)] !bg-[var(--surface)] !p-0 !text-[var(--foreground)] !shadow-[var(--shadow)] ${dialogClassName}`}
          >
            {children}
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  )
}