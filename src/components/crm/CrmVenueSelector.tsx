import { Building2 } from 'lucide-react'
import { CrmSelect } from '../../features/crm/shared/components/CrmSelect'

type VenueOption = {
  id: string
  isActive: boolean
  name: string
}

type Props = {
  disabled: boolean
  onChange: (venueId: string) => void
  value: string
  venues: VenueOption[]
}

export function CrmVenueSelector({ disabled, onChange, value, venues }: Props) {
  const options = venues
    .filter((venue) => venue.isActive)
    .map((venue) => ({ label: venue.name, value: venue.id }))

  return (
    <CrmSelect
      ariaLabel="Seleccionar local"
      className="crm-custom-venue-selector !w-full md:!w-auto md:!min-w-[220px]"
      disabled={disabled}
      leadingIcon={<Building2 className="!hidden !size-4 !shrink-0 !text-[var(--crm-text-muted)] sm:!block" />}
      onChange={onChange}
      options={options}
      placeholder="Selecciona un local"
      value={value}
    />
  )
}
