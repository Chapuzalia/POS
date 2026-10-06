import { AppModal } from '../../../../components/ui/AppModal'
import type { AppModalProps } from '../../../../components/ui/AppModal'

export type CrmModalProps = Omit<AppModalProps, 'theme' | 'maxWidth'> & {
  label: string
  size?: 'compact' | 'large'
}

export function CrmModal({ size = 'compact', ...props }: CrmModalProps) {
  return <AppModal {...props} maxWidth={size === 'large' ? 1200 : 560} theme="crm" />
}
