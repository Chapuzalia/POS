import { X } from 'lucide-react'
import { useState, useSyncExternalStore } from 'react'
import { AppModal } from './AppModal'
import { Button } from './Button'
import { Input } from './Input'
import { getAppDialogSnapshot, settleAppDialog, subscribeAppDialog } from './appDialogStore'
import type { AppDialogRequest } from './appDialogStore'

function AppDialog({ request }: { request: AppDialogRequest }) {
  const [value, setValue] = useState(request.initialValue)
  const title = request.kind === 'confirm' ? 'Confirmar acción' : request.kind === 'prompt' ? 'Introducir dato' : 'Información'
  const close = () => settleAppDialog(request.id, null)
  const confirm = () => settleAppDialog(request.id, request.kind === 'prompt' ? value : true)
  const theme = document.querySelector('.crm-shell') ? 'crm' : 'pos'

  return <AppModal backdropClassName="!z-[100]" closeOnOutsidePress={false} label={title} maxWidth={560} onClose={close} theme={theme}>
    <form onSubmit={(event) => { event.preventDefault(); confirm() }}>
      <header className="flex items-start justify-between gap-3 border-b border-[var(--modal-border)] p-5">
        <h2 className="m-0 text-xl font-bold">{title}</h2>
        <Button aria-label="Cerrar" className="!size-11 !min-h-11 !min-w-11 !shrink-0 !rounded-[12px] !p-0" onClick={close} type="button"><X className="size-5" /></Button>
      </header>
      <div className="grid gap-4 p-5">
        <p className="m-0 whitespace-pre-wrap break-words text-sm leading-6" id="app-dialog-message">{request.message}</p>
        {request.kind === 'prompt' ? <Input aria-label="Valor" aria-describedby="app-dialog-message" autoFocus onChange={(event) => setValue(event.target.value)} value={value} /> : null}
      </div>
      <footer className="flex flex-wrap justify-end gap-2 border-t border-[var(--modal-border)] p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {request.kind !== 'alert' ? <Button onClick={close} type="button" variant="secondary">Cancelar</Button> : null}
        <Button autoFocus={request.kind !== 'prompt'} type="submit" variant="primary">Aceptar</Button>
      </footer>
    </form>
  </AppModal>
}

export function AppDialogHost() {
  const request = useSyncExternalStore(subscribeAppDialog, getAppDialogSnapshot, () => null)
  return request ? <AppDialog key={request.id} request={request} /> : null
}
