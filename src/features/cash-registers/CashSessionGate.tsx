import { Button as UiButton } from "../../components/ui/Button";
import { NativeSelect as UiNativeSelect } from "../../components/ui/NativeSelect";
import { NumericKeypadModal } from "../../components/ui/NumericKeypadModal";
import { useState } from "react";
import { Vault } from "lucide-react";
import type {
  CashClosingRecord,
  CashRegister,
  CashSession,
  TenantContext,
} from "../../types";
import { formatMoney, parseMoneyToCents } from "../../lib/format";
import {
  CashClosingResultModal,
  CashClosingsHistoryModal,
} from "../../components/modals";
import { usePrintAgentStore } from "../local-printing/store/usePrintAgentStore";

type Props = {
  canOpenReservations: boolean;
  context: TenantContext;
  isBusy: boolean;
  isOnline: boolean;
  registers: CashRegister[];
  sessions: CashSession[];
  onJoin: (session: CashSession) => void;
  onLogout: () => void;
  onOpen: (registerId: string, openingFloatCents: number) => Promise<void>;
  onOpenReservations: () => void;
  onRefresh: () => void;
  cashClosings: CashClosingRecord[];
  closingHistoryOpen: boolean;
  completedClosing: CashClosingRecord | null;
  error: string | null;
  printingClosingId: string | null;
  onOpenClosingHistory: () => void;
  onCloseClosingHistory: () => void;
  onCloseCompletedClosing: () => void;
  onPrintClosing: (closing: CashClosingRecord, isReprint: boolean) => void;
};

export function CashSessionGate({
  canOpenReservations,
  cashClosings,
  closingHistoryOpen,
  completedClosing,
  context,
  error,
  isBusy,
  isOnline,
  onCloseClosingHistory,
  onCloseCompletedClosing,
  onJoin,
  onLogout,
  onOpen,
  onOpenClosingHistory,
  onOpenReservations,
  onPrintClosing,
  onRefresh,
  printingClosingId,
  registers,
  sessions,
}: Props) {
  const cashlogyConfigured = usePrintAgentStore((state) => state.cashlogyConfigured);
  const openRegisterIds = new Set(
    sessions.map((session) => session.cashRegisterId),
  );
  const available = registers.filter(
    (register) => register.isActive && !openRegisterIds.has(register.id),
  );
  const [registerId, setRegisterId] = useState(
    context.defaultCashRegisterId ?? available[0]?.id ?? "",
  );
  const [openingFloat, setOpeningFloat] = useState("0.00");
  const [openingFloatKeypadOpen, setOpeningFloatKeypadOpen] = useState(false);
  const canOpen =
    context.canOpenCashSession === true && context.deviceMode !== "satellite";

  return (
    <main className="h-full overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch] bg-[var(--background)] p-4 text-[var(--foreground)]">
      <section className="mx-auto mt-[8vh] w-full max-w-2xl space-y-5 rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] p-6 shadow-[var(--shadow)]">
        <div>
          <h1 className="text-2xl font-black">
            {sessions.length ? "Cajas abiertas" : "No hay ninguna caja abierta"}
          </h1>
          <p className="mt-2 text-[var(--muted)]">
            {sessions.length
              ? "Selecciona la caja con la que vas a trabajar."
              : canOpen
                ? "Abre un punto de caja para comenzar."
                : "Abre una caja desde un dispositivo autorizado para comenzar a trabajar."}
          </p>
        </div>
        {sessions.length ? (
          <div className="grid gap-3">
            {sessions.map((session) => (
              <UiButton
                className="min-h-16 rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface-secondary)] p-4 text-left hover:border-[var(--accent)]"
                disabled={isBusy || !isOnline}
                key={session.id}
                onClick={() => onJoin(session)}
                type="button"
              >
                <strong className="block">{session.cashRegisterName}</strong>
                <span className="text-sm text-[var(--muted)]">
                  Abierta{" "}
                  {new Date(session.openedAt).toLocaleTimeString("es-ES", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}{" "}
                  -{" "}
                  {cashlogyConfigured
                    ? "Fondo gestionado por Cashlogy"
                    : `Fondo ${formatMoney(session.openingFloatCents)}`}
                </span>
              </UiButton>
            ))}
          </div>
        ) : null}
        {canOpen ? (
          <form
            className="space-y-3 border-t border-[var(--separator)] pt-5"
            onSubmit={(event) => {
              event.preventDefault();
              void onOpen(registerId, parseMoneyToCents(openingFloat));
            }}
          >
            <h2 className="font-black">Abrir nueva caja</h2>
            <UiNativeSelect
              className="min-h-12 w-full rounded-[var(--radius)] border border-[var(--field-border)] bg-[var(--field)]"
              disabled={!available.length || isBusy}
              onChange={(event) => setRegisterId(event.target.value)}
              value={registerId}
            >
              {available.map((register) => (
                <option key={register.id} value={register.id}>
                  {register.name}
                </option>
              ))}
            </UiNativeSelect>
            {cashlogyConfigured ? (
              <div className="flex min-h-14 items-center gap-3 rounded-[var(--radius)] border border-emerald-500/35 bg-emerald-500/10 p-3 text-sm text-emerald-800 dark:text-emerald-200">
                <Vault className="h-5 w-5 shrink-0" />
                <span>
                  <strong className="block">
                    Fondo automático desde Cashlogy
                  </strong>
                  Se consultará el efectivo total de la máquina al confirmar la
                  apertura.
                </span>
              </div>
            ) : (
              <UiButton
                aria-haspopup="dialog"
                className="min-h-12 w-full !justify-between rounded-[var(--radius)] border border-[var(--field-border)] bg-[var(--field)] px-4 font-mono text-[var(--field-foreground)]"
                disabled={isBusy}
                onClick={() => setOpeningFloatKeypadOpen(true)}
                type="button"
                variant="tertiary"
              >
                <span className="tabular-nums">{openingFloat}</span>
                <span className="text-sm font-bold text-[var(--muted)]">
                  EUR
                </span>
              </UiButton>
            )}
            <UiButton
              className="min-h-12 w-full rounded-[var(--radius)] bg-[var(--accent)] font-bold text-[var(--accent-foreground)] disabled:opacity-45"
              disabled={!isOnline || isBusy || !registerId || !available.length}
              type="submit"
            >
              {available.length
                ? "Abrir caja"
                : "Todos los puntos de caja ya estan abiertos"}
            </UiButton>
          </form>
        ) : null}
        {error ? (
          <p className="rounded-[var(--radius)] border border-[var(--danger)] bg-[var(--danger-soft)] p-3 text-sm font-semibold text-[var(--danger)]">
            {error}
          </p>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          {canOpenReservations ? <UiButton
            className="min-h-11 w-full rounded-[var(--radius)] border border-[var(--separator)]"
            disabled={!isOnline}
            onClick={onOpenReservations}
            type="button"
          >
            Reservas
          </UiButton> : null}
          <UiButton
            className="min-h-11 w-full rounded-[var(--radius)] border border-[var(--separator)]"
            disabled={isBusy || !isOnline}
            onClick={onRefresh}
            type="button"
          >
            Comprobar de nuevo
          </UiButton>
          <UiButton
            className="min-h-11 w-full rounded-[var(--radius)] border border-[var(--separator)]"
            disabled={!isOnline}
            onClick={onOpenClosingHistory}
            type="button"
          >
            Histórico de cierres
          </UiButton>
          <UiButton
            className="min-h-11 w-full rounded-[var(--radius)] border border-[var(--separator)]"
            onClick={onLogout}
            type="button"
          >
            Cerrar sesión
          </UiButton>
        </div>
      </section>

      {openingFloatKeypadOpen ? (
        <NumericKeypadModal
          decimalSeparator="."
          disabled={isBusy}
          initialValue={openingFloat}
          maxFractionDigits={2}
          onCancel={() => setOpeningFloatKeypadOpen(false)}
          onConfirm={(value) => {
            setOpeningFloat(value);
            setOpeningFloatKeypadOpen(false);
          }}
          unit="EUR"
        />
      ) : null}
      {completedClosing ? (
        <CashClosingResultModal
          closing={completedClosing}
          isPrinting={printingClosingId === completedClosing.id}
          onClose={onCloseCompletedClosing}
          onPrint={() => onPrintClosing(completedClosing, false)}
        />
      ) : null}
      {closingHistoryOpen ? (
        <CashClosingsHistoryModal
          canReprint={Boolean(
            context.canManageCash ||
            ["manager", "owner"].includes(context.role),
          )}
          closings={cashClosings}
          onClose={onCloseClosingHistory}
          onReprint={(closing) => onPrintClosing(closing, true)}
          printingClosingId={printingClosingId}
        />
      ) : null}
    </main>
  );
}
