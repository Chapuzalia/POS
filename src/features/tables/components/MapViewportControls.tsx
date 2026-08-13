import { Button as UiButton } from '../../../components/ui/Button'
import { Maximize2, RotateCw, ZoomIn, ZoomOut } from 'lucide-react'

type Props = { mobileLayout?: boolean; rotated?: boolean; zoom: number; onFit: () => void; onReset: () => void; onRotate?: () => void; onZoomIn: () => void; onZoomOut: () => void }

export function MapViewportControls({ mobileLayout = false, rotated = false, zoom, onFit, onReset, onRotate, onZoomIn, onZoomOut }: Props) {
  return <div className={`absolute z-20 flex items-center gap-1 rounded-[10px] border border-[var(--separator)] p-[5px] shadow-[var(--shadow)] [&>button]:inline-flex [&>button]:items-center [&>button]:justify-center [&>button]:gap-1.5 [&>button]:rounded-[7px] [&>button]:border-0 [&>button]:bg-transparent [&>button]:text-xs [&>button]:font-extrabold [&>button]:text-[var(--foreground)] [&>button]:hover:bg-[var(--accent-soft)] [&>button]:hover:outline-2 [&>button]:hover:outline-offset-1 [&>button]:hover:outline-[color-mix(in_srgb,var(--accent)_50%,transparent)] [&>button]:focus-visible:bg-[var(--accent-soft)] [&>button]:focus-visible:outline-2 [&>button]:focus-visible:outline-offset-1 [&>button]:focus-visible:outline-[color-mix(in_srgb,var(--accent)_50%,transparent)] ${mobileLayout ? 'bottom-[max(.5rem,env(safe-area-inset-bottom))] left-1/2 -translate-x-1/2 bg-[color-mix(in_srgb,var(--surface)_96%,transparent)] [&>button]:min-h-11 [&>button]:min-w-11 [&_button_span]:hidden' : 'bottom-3 right-3 bg-[color-mix(in_srgb,var(--surface)_94%,transparent)] backdrop-blur-lg [&>button]:min-h-[38px] [&>button]:min-w-[38px]'}`} role="toolbar" aria-label="Controles del mapa">
    <UiButton aria-label="Alejar" title="Alejar" onClick={onZoomOut} type="button"><ZoomOut size={17} /></UiButton>
    <UiButton aria-label="Restablecer zoom" className="min-w-[54px]" title="Restablecer zoom" onClick={onReset} type="button">{Math.round(zoom * 100)}%</UiButton>
    <UiButton aria-label="Acercar" title="Acercar" onClick={onZoomIn} type="button"><ZoomIn size={17} /></UiButton>
    <UiButton aria-label="Ajustar a pantalla" title="Ajustar a pantalla" onClick={onFit} type="button"><Maximize2 size={17} /><span>Ajustar</span></UiButton>
    {mobileLayout && onRotate ? <UiButton active={rotated} aria-label={rotated ? 'Restaurar orientacion horizontal' : 'Girar mapa 90 grados'} aria-pressed={rotated} className={rotated ? '!bg-[var(--accent-soft)] !text-[var(--accent)]' : ''} title={rotated ? 'Restaurar orientacion horizontal' : 'Girar mapa 90 grados'} onClick={onRotate} type="button"><RotateCw size={17} /></UiButton> : null}
  </div>
}
