import { TextArea as HeroTextArea } from '@heroui/react'
import type { ComponentProps } from 'react'

export type TextAreaProps = ComponentProps<'textarea'>

export function TextArea({ className, ...props }: TextAreaProps) {
  const heroProps = props as unknown as ComponentProps<typeof HeroTextArea>

  return <HeroTextArea {...heroProps} className={className} />
}
