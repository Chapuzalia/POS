import { supabase } from '../../lib/supabase'
import type { Customer, CustomerCreateInput, CustomerFiscalSnapshot, TicketInvoice } from '../../types'
import type { CustomerRow } from '../../types/supabase'
import { normalizeCustomerTaxId, validateCustomerCreateInput } from './customerValidation'

function client() {
  if (!supabase) throw new Error('Supabase no está configurado.')
  return supabase
}

function mapCustomer(row: CustomerRow): Customer {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    legalName: row.legal_name,
    taxId: row.tax_id,
    address: row.address,
    postalCode: row.postal_code,
    city: row.city,
    province: row.province,
    country: row.country,
    email: row.email,
    phone: row.phone,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function searchCustomers(tenantId: string, query: string): Promise<Customer[]> {
  const { data, error } = await client().rpc('search_invoice_customers', {
    p_tenant_id: tenantId,
    p_query: query.trim(),
    p_limit: 20,
  })
  if (error) throw error
  return ((data ?? []) as CustomerRow[]).map(mapCustomer)
}

export async function createCustomer(tenantId: string, input: CustomerCreateInput): Promise<Customer> {
  const value = validateCustomerCreateInput(input)
  const { data, error } = await client().rpc('create_invoice_customer', {
    p_tenant_id: tenantId,
    p_customer: {
      legalName: value.legalName,
      taxId: value.taxId,
      address: value.address,
      postalCode: value.postalCode,
      city: value.city,
      province: value.province,
      country: value.country,
      email: value.email,
      phone: value.phone,
    },
  }).single()
  if (error) {
    if (error.code === '23505' || error.message.includes('CUSTOMER_TAX_ID_DUPLICATE')) {
      throw new Error(`Ya existe un cliente con el NIF/CIF ${normalizeCustomerTaxId(value.taxId)}.`)
    }
    throw error
  }
  return mapCustomer(data as CustomerRow)
}

export async function updateCustomer(tenantId: string, customerId: string, input: CustomerCreateInput): Promise<Customer> {
  const value = validateCustomerCreateInput(input)
  const { data, error } = await client().from('customers').update({
    legal_name: value.legalName,
    tax_id: value.taxId,
    address: value.address,
    postal_code: value.postalCode,
    city: value.city,
    province: value.province,
    country: value.country,
    email: value.email,
    phone: value.phone,
  }).eq('tenant_id', tenantId).eq('id', customerId).select('*').single()
  if (error) {
    if (error.code === '23505' || error.message.includes('CUSTOMER_TAX_ID_DUPLICATE')) {
      throw new Error(`Ya existe un cliente con el NIF/CIF ${normalizeCustomerTaxId(value.taxId)}.`)
    }
    throw error
  }
  return mapCustomer(data as CustomerRow)
}

export async function deleteCustomer(tenantId: string, customerId: string): Promise<void> {
  const { error } = await client().rpc('delete_invoice_customer', {
    p_tenant_id: tenantId,
    p_customer_id: customerId,
  })
  if (error) {
    if (error.code === '23503' || error.message.includes('CUSTOMER_HAS_INVOICES')) {
      throw new Error('No se puede eliminar este cliente porque ya está asociado a una factura.')
    }
    throw error
  }
}

export async function loadTicketInvoice(tenantId: string, ticketId: string): Promise<TicketInvoice | null> {
  const { data, error } = await client().from('tickets')
    .select('customer_id, customer_snapshot, invoice_series, invoice_number, invoice_issued_at')
    .eq('tenant_id', tenantId)
    .eq('id', ticketId)
    .eq('is_invoice', true)
    .maybeSingle()
  if (error) throw error
  if (!data?.customer_id || !data.customer_snapshot) return null
  return {
    customerId: data.customer_id,
    customer: data.customer_snapshot as CustomerFiscalSnapshot,
    series: data.invoice_series,
    number: data.invoice_number,
    issuedAt: data.invoice_issued_at,
  }
}
