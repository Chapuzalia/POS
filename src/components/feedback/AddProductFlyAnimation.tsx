import { createPortal } from 'react-dom'
import type { CSSProperties } from 'react'
import type { AddProductFlyFeedback } from '../../hooks/useAddProductFeedback'

type AddProductFlyAnimationProps = {
  feedback: AddProductFlyFeedback | null
}

export function AddProductFlyAnimation({ feedback }: AddProductFlyAnimationProps) {
  if (!feedback || typeof document === 'undefined') return null

  const sourceX = feedback.sourceRect.left + feedback.sourceRect.width / 2
  const sourceY = feedback.sourceRect.top + feedback.sourceRect.height / 2
  const targetX = feedback.targetRect.left + feedback.targetRect.width / 2 - sourceX
  const targetY = feedback.targetRect.top + feedback.targetRect.height / 2 - sourceY
  const style = {
    left: sourceX,
    top: sourceY,
    '--add-feedback-x': `${targetX}px`,
    '--add-feedback-y': `${targetY}px`,
  } as CSSProperties

  return createPortal(
    <span aria-hidden="true" className="pos-add-product-fly" style={style} />,
    document.body,
  )
}
