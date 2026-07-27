import { Button as UiButton } from '../../../components/ui/Button'
import { Maximize2, RotateCcw, ZoomIn, ZoomOut } from 'lucide-react'

type Props = { zoom: number; onFit: () => void; onReset: () => void; onZoomIn: () => void; onZoomOut: () => void }

export function MapViewportControls({ zoom, onFit, onReset, onZoomIn, onZoomOut }: Props) {
  return <div className="absolute bottom-3 right-3 z-20 flex items-center gap-1 rounded-[10px] border border-[var(--separator)] bg-[color-mix(in_srgb,var(--surface)_94%,transparent)] p-[5px] shadow-[var(--shadow)] backdrop-blur-lg max-[760px]:bottom-2 max-[760px]:right-2 [&>button]:inline-flex [&>button]:min-h-[38px] [&>button]:min-w-[38px] [&>button]:items-center [&>button]:justify-center [&>button]:gap-1.5 [&>button]:rounded-[7px] [&>button]:border-0 [&>button]:bg-transparent [&>button]:text-xs [&>button]:font-extrabold [&>button]:text-[var(--foreground)] [&>button]:hover:bg-[var(--accent-soft)] [&>button]:hover:outline-2 [&>button]:hover:outline-offset-1 [&>button]:hover:outline-[color-mix(in_srgb,var(--accent)_50%,transparent)] [&>button]:focus-visible:bg-[var(--accent-soft)] [&>button]:focus-visible:outline-2 [&>button]:focus-visible:outline-offset-1 [&>button]:focus-visible:outline-[color-mix(in_srgb,var(--accent)_50%,transparent)] max-[760px]:[&>button]:min-h-[42px] max-[760px]:[&>button]:min-w-[42px] max-[760px]:[&_button_span]:hidden" role="toolbar" aria-label="Controles del mapa">
    <UiButton aria-label="Alejar" title="Alejar" onClick={onZoomOut} type="button"><ZoomOut size={17} /></UiButton>
    <UiButton aria-label="Restablecer zoom" className="min-w-[54px]" title="Restablecer zoom" onClick={onReset} type="button">{Math.round(zoom * 100)}%</UiButton>
    <UiButton aria-label="Acercar" title="Acercar" onClick={onZoomIn} type="button"><ZoomIn size={17} /></UiButton>
    <UiButton aria-label="Ajustar a pantalla" title="Ajustar a pantalla" onClick={onFit} type="button"><Maximize2 size={17} /><span>Ajustar</span></UiButton>
    <UiButton aria-label="Restablecer zoom" className="hidden max-[760px]:!inline-flex" title="Restablecer zoom" onClick={onReset} type="button"><RotateCcw size={16} /></UiButton>
  </div>
}
