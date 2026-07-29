import { Modal } from "@heroui/react";
import type { CSSProperties, ReactNode } from "react";

type AppModalProps = {
  backdropClassName?: string;
  children: ReactNode;
  containerClassName?: string;
  dialogClassName?: string;
  dismissDisabled?: boolean;
  label: string;
  maxWidth?: CSSProperties["maxWidth"];
  onClose: () => void;
  placement?: "center" | "bottom";
};

export function AppModal({
  backdropClassName = "",
  children,
  containerClassName = "!p-3 sm:!p-6",
  dialogClassName = "",
  dismissDisabled = false,
  label,
  maxWidth = 1200,
  onClose,
  placement = "center",
}: AppModalProps) {
  return (
    <Modal
      isOpen
      onOpenChange={(isOpen) => {
        if (!isOpen && !dismissDisabled) onClose();
      }}
    >
      <Modal.Backdrop
        className={`!z-[70] !bg-black/55 ${backdropClassName}`}
        isDismissable={!dismissDisabled}
        isKeyboardDismissDisabled={dismissDisabled}
      >
        <Modal.Container
          className={`!max-w-none ${containerClassName}`}
          placement={placement}
          scroll="inside"
        >
          <Modal.Dialog
            aria-label={label}
            className={`!w-full !max-h-[calc(100dvh-24px)] !overflow-hidden !rounded-[var(--radius)] !border !border-[var(--separator)] !bg-[var(--surface)] !p-0 !text-[var(--foreground)] !shadow-[var(--shadow)] [&>*]:!max-w-none ${dialogClassName}`}
            style={{ maxWidth }}
          >
            {children}
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
