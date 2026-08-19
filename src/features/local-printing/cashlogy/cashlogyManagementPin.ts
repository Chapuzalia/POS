const CASHLOGY_MANAGEMENT_PIN = '7474'

export function validateCashlogyManagementPin(pin: string) {
  return pin === CASHLOGY_MANAGEMENT_PIN
}
