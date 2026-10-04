import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Save, ShieldCheck } from "lucide-react";
import { sileo } from "sileo";
import { Button as UiButton } from "../../../../components/ui/Button";
import { Checkbox as UiCheckbox } from "../../../../components/ui/Checkbox";
import { Input as UiInput } from "../../../../components/ui/Input";
import type { TenantContext } from "../../../../types";
import {
  loadFiscalPosSettings,
  saveFiscalPosSettings,
  saveFiscalAeatEnvironment,
  type FiscalPosSettings,
} from "../../../fiscal/local/settings";
import { Field } from "../../shared/components/Field";
import type { RunAction } from "../../shared/types";

type Props = {
  disabled: boolean;
  runAction: RunAction;
  tenantContext: TenantContext;
};

const inputClass =
  "!h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none focus:!border-[var(--crm-blue)] focus:!shadow-[0_0_0_3px_var(--crm-blue-soft)]";

export function LocalFiscalSettings({
  disabled,
  runAction,
  tenantContext,
}: Props) {
  const canEdit = tenantContext.role === "owner";
  const [settings, setSettings] = useState<FiscalPosSettings>({
    tenant_id: tenantContext.tenantId,
    bridge_url: "",
    aeat_environment: "production",
    print_ticket_qr: true,
    producer_name: "",
    producer_nif: "",
    system_id: "",
    system_version: "",
  });
  const [exists, setExists] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [savingEnvironment, setSavingEnvironment] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const loaded = await loadFiscalPosSettings(tenantContext.tenantId);
      setSettings(loaded);
      setExists(true);
      setLoadError(null);
    } catch (error) {
      setExists(false);
      setSettings({
        tenant_id: tenantContext.tenantId,
        bridge_url: "",
        aeat_environment: "production",
        print_ticket_qr: true,
        producer_name: "",
        producer_nif: "",
        system_id: "",
        system_version: "",
      });
      setLoadError(
        error instanceof Error
          ? error.message
          : "No se pudo cargar la configuración fiscal.",
      );
    }
  }, [tenantContext.tenantId]);

  useEffect(() => {
    void runAction(refresh);
  }, [refresh, runAction]);

  function update<K extends keyof FiscalPosSettings>(
    key: K,
    value: FiscalPosSettings[K],
  ) {
    setSettings((current) => ({ ...current, [key]: value }));
  }

  async function changeEnvironment(checked: boolean) {
    if (!canEdit || savingEnvironment) return;
    const environment = checked ? "test" : "production";
    if (!exists) {
      update("aeat_environment", environment);
      return;
    }
    setSavingEnvironment(true);
    try {
      await runAction(async () => {
        const saved = await saveFiscalAeatEnvironment(
          tenantContext.tenantId,
          environment,
        );
        update("aeat_environment", saved.aeat_environment);
        sileo.success({
          title:
            saved.aeat_environment === "test"
              ? "Entorno AEAT de pruebas guardado"
              : "Entorno AEAT de producción guardado",
        });
      });
    } finally {
      setSavingEnvironment(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canEdit) return;
    await runAction(async () => {
      const saved = await saveFiscalPosSettings({
        ...settings,
        tenant_id: tenantContext.tenantId,
        bridge_url: settings.bridge_url.trim(),
        producer_name: settings.producer_name.trim(),
        producer_nif: settings.producer_nif.trim().toUpperCase(),
        system_id: settings.system_id.trim().toUpperCase(),
        system_version: settings.system_version.trim(),
      });
      setSettings(saved);
      setExists(true);
      setLoadError(null);
      sileo.success({
        title: "Configuración fiscal guardada",
        description: saved.bridge_url
          ? "Las cajas intentarán entregar al puente los registros pendientes."
          : "Las cajas emitirán y conservarán los registros localmente hasta configurar el puente.",
      });
    });
  }

  return (
    <section className="!min-w-0 !overflow-hidden !rounded-2xl !bg-[var(--crm-surface)] !text-[var(--crm-text)] !shadow-[var(--crm-shadow-card)]">
      <header className="!px-[18px] !pt-[18px] !pb-3 md:!px-[22px]">
        <h2 className="!m-0 !text-base !font-bold">
          SIF local de Tickit y puente VERI*FACTU
        </h2>
        <p className="!mt-1 !mb-0 !text-xs !font-medium !text-[var(--crm-text-muted)]">
          Configura los datos públicos del productor. La URL HTTPS del VPS es
          opcional mientras la remisión no esté activada; los registros quedarán
          pendientes en la caja.
        </p>
      </header>
      <form
        className="!grid !gap-4 !border-t !border-[var(--crm-border-subtle)] !px-[18px] !py-5 md:!px-[22px]"
        onSubmit={(event) => void submit(event)}
      >
        {loadError ? (
          <p
            role="status"
            className="!m-0 !rounded-xl !bg-[var(--crm-blue-soft)] !px-4 !py-3 !text-xs !font-semibold !text-[var(--crm-blue)]"
          >
            {loadError}
          </p>
        ) : null}
        <div className="!grid !grid-cols-1 !gap-4 lg:!grid-cols-2">
          <Field label="URL HTTPS del puente VPS (opcional)">
            <UiInput
              className={inputClass}
              disabled={disabled || !canEdit}
              onChange={(event) => update("bridge_url", event.target.value)}
              placeholder="https://fiscal.ejemplo.es/"
              type="url"
              value={settings.bridge_url}
            />
          </Field>
          <div className="!grid !gap-2 !flex-col !rounded-xl !bg-[var(--crm-surface-soft)] !px-3.5 !py-3">
            <UiCheckbox
              checked={settings.aeat_environment === "test"}
              disabled={disabled || !canEdit || savingEnvironment}
              onChange={(checked) => void changeEnvironment(checked)}
            >
              Usar URL de pruebas de AEAT para el QR
            </UiCheckbox>
            
            <p className="!m-0 !text-xs !text-[var(--crm-text-muted)]">
              {exists
                ? "Este cambio se guarda automáticamente y habilita la recuperación temporal de instalaciones en pruebas."
                : "Guarda la configuración para aplicar el entorno seleccionado."}
            </p>
            <UiCheckbox checked={settings.print_ticket_qr} disabled={disabled || !canEdit} onChange={(checked) => update('print_ticket_qr', checked)}>Imprimir código QR en el ticket</UiCheckbox>
          </div>
          <Field label="Razón social del productor SIF">
            <UiInput
              className={inputClass}
              disabled={disabled || !canEdit}
              maxLength={120}
              onChange={(event) => update("producer_name", event.target.value)}
              required
              value={settings.producer_name}
            />
          </Field>
          <Field label="NIF del productor">
            <UiInput
              className={inputClass}
              disabled={disabled || !canEdit}
              maxLength={9}
              onChange={(event) => update("producer_nif", event.target.value)}
              required
              value={settings.producer_nif}
            />
          </Field>
          <Field label="ID de sistema (2 caracteres)">
            <UiInput
              className={inputClass}
              disabled={disabled || !canEdit}
              maxLength={2}
              onChange={(event) => update("system_id", event.target.value)}
              required
              value={settings.system_id}
            />
          </Field>
          <Field label="Versión del sistema">
            <UiInput
              className={inputClass}
              disabled={disabled || !canEdit}
              maxLength={40}
              onChange={(event) => update("system_version", event.target.value)}
              required
              value={settings.system_version}
            />
          </Field>
        </div>
        <p className="!m-0 !flex !items-start !gap-2 !text-xs !leading-5 !text-[var(--crm-text-muted)]">
          <ShieldCheck className="!mt-0.5 !size-4 !shrink-0" />
          Sin URL, el POS numera, encadena, firma con huella y genera el QR,
          pero no remite a AEAT. No introduzcas certificados ni secretos del
          VPS. Una factura ya emitida conserva su propia copia.
        </p>
        {canEdit ? (
          <footer className="!flex !justify-end">
            <UiButton
              className="!inline-flex !min-h-10 !items-center !gap-2 !rounded-[10px] !border-0 !bg-[var(--crm-blue)] !px-4 !text-[13px] !font-semibold !text-white"
              disabled={disabled || savingEnvironment}
              type="submit"
            >
              <Save className="!size-4" />
              {exists ? "Guardar cambios" : "Guardar configuración"}
            </UiButton>
          </footer>
        ) : null}
      </form>
    </section>
  );
}
