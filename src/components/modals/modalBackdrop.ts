import type { MouseEvent } from 'react'

export function closeOnModalBackdrop(
  event: MouseEvent<HTMLElement>,
  onClose: () => void,
  disabled = false,
) {
  if (!disabled && event.target === event.currentTarget) onClose()
}
