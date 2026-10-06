import { Modal } from "@heroui/react";
import type { CSSProperties, ReactNode } from "react";

const crmTokens: CSSProperties & Record<`--${string}`, string> = {
  "--background": "var(--crm-canvas)",
  "--surface": "var(--crm-surface)",
  "--surface-secondary": "var(--crm-surface-soft)",
  "--surface-foreground": "var(--crm-text)",
  "--foreground": "var(--crm-text)",
  "--muted": "var(--crm-text-muted)",
  "--separator": "var(--crm-border-subtle)",
  "--border": "var(--crm-border-subtle)",
  "--field": "var(--crm-input-bg)",
  "--field-background": "var(--crm-input-bg)",
  "--field-foreground": "var(--crm-text)",
  "--field-border": "var(--crm-input-border)",
  "--field-placeholder": "var(--crm-text-muted)",
  "--default": "var(--crm-surface-soft)",
  "--default-foreground": "var(--crm-text)",
  "--overlay": "var(--crm-surface)",
  "--overlay-foreground": "var(--crm-text)",
  "--accent": "var(--crm-blue)",
  "--accent-soft": "var(--crm-blue-soft)",
  "--accent-foreground": "#ffffff",
  "--success": "var(--crm-green)",
  "--success-soft": "var(--crm-green-soft)",
  "--danger": "var(--crm-red)",
  "--danger-soft": "var(--crm-red-soft)",
  "--warning": "var(--crm-yellow)",
  "--warning-soft": "var(--crm-yellow-soft)",
  "--radius": "var(--crm-radius-md)",
  "--field-radius": "var(--crm-radius-md)",
};

export type AppModalProps = {
  backdropClassName?: string;
  children: ReactNode;
  containerClassName?: string;
  dialogClassName?: string;
  dismissDisabled?: boolean;
  closeOnOutsidePress?: boolean;
  label?: string;
  maxWidth?: CSSProperties["maxWidth"];
  onClose: () => void;
  placement?: "center" | "bottom";
  scroll?: "dialog" | "content";
  theme?: "pos" | "crm";
};

export function AppModal({
  backdropClassName = "",
  children,
  containerClassName = "!p-3 sm:!p-6",
  dialogClassName = "",
  dismissDisabled = false,
  closeOnOutsidePress = true,
  label,
  maxWidth = 560,
  onClose,
  placement = "center",
  scroll = "dialog",
  theme = "pos",
}: AppModalProps) {
  const crmTheme = theme === "crm"
    ? document.querySelector<HTMLElement>(".crm-shell")?.dataset.crmTheme ?? "light"
    : undefined;
  const dialogStyle: CSSProperties & Record<`--modal-${string}`, string> = {
    maxWidth,
    "--modal-radius": theme === "crm" ? "var(--crm-radius-lg)" : "min(20px, var(--radius))",
    "--modal-surface": theme === "crm" ? "var(--crm-surface)" : "var(--surface)",
    "--modal-foreground": theme === "crm" ? "var(--crm-text)" : "var(--foreground)",
    "--modal-border": theme === "crm" ? "var(--crm-border-subtle)" : "var(--separator)",
    "--modal-shadow": theme === "crm" ? "var(--crm-shadow-floating)" : "var(--shadow)",
  };
  return (
    <Modal
      isOpen
      onOpenChange={(isOpen) => {
        if (!isOpen && !dismissDisabled) onClose();
      }}
    >
      <Modal.Trigger aria-hidden="true" className="sr-only" tabIndex={-1} />
      <Modal.Backdrop
        className={`${theme === "crm" ? "crm-shell !z-[80]" : "!z-[70]"} !bg-black/55 ${backdropClassName}`}
        data-crm-theme={crmTheme}
        data-theme={crmTheme}
        style={theme === "crm" ? crmTokens : undefined}
        isDismissable={closeOnOutsidePress && !dismissDisabled}
        isKeyboardDismissDisabled={dismissDisabled}
      >
        <Modal.Container
          className={`!max-w-none ${containerClassName}`}
          placement={placement}
          scroll="inside"
        >
          <Modal.Dialog
            aria-label={label}
            className={`!min-w-0 !w-full !max-h-[calc(var(--visual-viewport-height,100dvh)-24px)] sm:!max-h-[calc(var(--visual-viewport-height,100dvh)-48px)] ${scroll === "content" ? "!overflow-hidden" : "!overflow-x-hidden !overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch]"} !rounded-[var(--modal-radius)] !border !border-[var(--modal-border)] !bg-[var(--modal-surface)] !p-0 !text-[var(--modal-foreground)] !shadow-[var(--modal-shadow)] [&_.button]:!rounded-[12px] [&_.card]:!rounded-[var(--modal-radius)] [&>section]:!border-0 [&>section]:!rounded-none [&>section]:!shadow-none [&>section]:!bg-[var(--modal-surface)] [&>section]:!text-[var(--modal-foreground)] [&>form]:!border-0 [&>form]:!rounded-none [&>form]:!shadow-none ${dialogClassName}`}
            style={dialogStyle}
          >
            {children}
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
