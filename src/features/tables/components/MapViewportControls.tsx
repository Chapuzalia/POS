import { Maximize2, RotateCcw, ZoomIn, ZoomOut } from 'lucide-react'
import './map-viewport.css'

type Props = { zoom: number; onFit: () => void; onReset: () => void; onZoomIn: () => void; onZoomOut: () => void }

export function MapViewportControls({ zoom, onFit, onReset, onZoomIn, onZoomOut }: Props) {
  return <div className="map-viewport-controls" role="toolbar" aria-label="Controles del mapa">
    <button aria-label="Alejar" title="Alejar" onClick={onZoomOut} type="button"><ZoomOut size={17} /></button>
    <button aria-label="Restablecer zoom" className="map-zoom-value" title="Restablecer zoom" onClick={onReset} type="button">{Math.round(zoom * 100)}%</button>
    <button aria-label="Acercar" title="Acercar" onClick={onZoomIn} type="button"><ZoomIn size={17} /></button>
    <button aria-label="Ajustar a pantalla" title="Ajustar a pantalla" onClick={onFit} type="button"><Maximize2 size={17} /><span>Ajustar</span></button>
    <button aria-label="Restablecer zoom" className="map-reset-control" title="Restablecer zoom" onClick={onReset} type="button"><RotateCcw size={16} /></button>
  </div>
}
