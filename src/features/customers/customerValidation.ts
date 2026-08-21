import { z } from 'zod'
import type { Customer, CustomerCreateInput, CustomerFiscalSnapshot } from '../../types'

export const normalizeCustomerTaxId = (value: string) => value
  .normalize('NFKC')
  .toLocaleUpperCase('es-ES')
  .replace(/[^\p{L}\p{N}]/gu, '')

const requiredText = (label: string) => z.string().trim().min(1, `${label} es obligatorio.`).max(250)

export const customerCreateSchema = z.object({
  legalName: requiredText('El nombre o razón social'),
  taxId: requiredText('El NIF/CIF').refine((value) => normalizeCustomerTaxId(value).length >= 5, 'El NIF/CIF no es válido.'),
  address: requiredText('La dirección fiscal'),
  postalCode: requiredText('El código postal').max(20),
  city: requiredText('La ciudad').max(120),
  province: requiredText('La provincia').max(120),
  country: z.string().trim().max(120).transform((value) => value || 'España'),
  email: z.string().trim().email('El email no es válido.').max(250).nullable(),
  phone: z.string().trim().max(50).nullable(),
}).transform((value) => ({
  ...value,
  email: value.email || null,
  phone: value.phone || null,
}))

export function validateCustomerCreateInput(input: CustomerCreateInput) {
  return customerCreateSchema.parse(input)
}

export function customerFiscalSnapshot(customer: Customer): CustomerFiscalSnapshot {
  const { legalName, taxId, address, postalCode, city, province, country, email, phone } = customer
  return { legalName, taxId, address, postalCode, city, province, country, email, phone }
}
