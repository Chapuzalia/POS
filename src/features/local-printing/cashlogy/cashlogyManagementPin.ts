const CASHLOGY_MANAGEMENT_PIN = '1988'

export function validateCashlogyManagementPin(pin: string) {
  return pin === CASHLOGY_MANAGEMENT_PIN
}
