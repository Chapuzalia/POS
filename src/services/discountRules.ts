import { supabase } from '../lib/supabase'

export async function validateConfiguredDiscountPin(discountId: string, pin: string) {
  if (!supabase || !/^\d{4,8}$/.test(pin)) return false
  const { data, error } = await supabase.rpc('validate_discount_pin', {
    p_discount_id: discountId,
    p_pin: pin,
  })
  if (error) throw error
  return data === true
}

export async function validateManualDiscountPin(venueId: string, pin: string) {
  if (!supabase || !/^\d{4,8}$/.test(pin)) return false
  const { data, error } = await supabase.rpc('validate_manual_discount_pin', {
    p_venue_id: venueId,
    p_pin: pin,
  })
  if (error) throw error
  return data === true
}


