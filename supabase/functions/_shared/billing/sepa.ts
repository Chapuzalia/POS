export const sepaAuthorizationVersion = '2026-11-13.2'
export const sepaPreNotificationDays = 3
export const sepaAuthorizationLabel = 'Autorizo los adeudos recurrentes SEPA Core de Alteil, a través de Mollie, y acuerdo reducir el preaviso de 14 a 3 días naturales.'
export const sepaCreditor = {
  beneficiary: 'Alteil Solutions, S.L.', taxId: 'B05839543',
  address: 'Calle Primer de Maig 37, 08710 Santa Margarida de Montbui (Barcelona), España',
  collectingCreditor: 'Mollie, por cuenta de Alteil Solutions, S.L.', identifier: 'NL08ZZZ502057730000',
} as const
export const sepaAuthorizationText = 'Autorizo a Alteil Solutions, S.L., a través de Mollie, a enviar instrucciones a mi entidad para adeudar las cuotas recurrentes de Tickit y autorizo a mi entidad a efectuar los adeudos siguiendo dichas instrucciones. Confirmo que soy titular de la cuenta o dispongo de facultades para autorizarla. Se aplica SEPA Core. Acuerdo expresamente con Alteil reducir el plazo general de pre-notificación de 14 a 3 días naturales: recibiré el importe y la fecha de cada adeudo con al menos 3 días naturales de antelación. Puedo pedir a mi entidad la devolución sin justificación durante las ocho semanas siguientes al adeudo y reclamar los adeudos no autorizados hasta trece meses desde el cargo, según las condiciones del esquema y la normativa aplicable. Puedo revocar el mandato para cargos futuros comunicándolo a Alteil y, cuando proceda, a mi entidad; la revocación no cancela por sí sola el contrato ni una deuda legítima. Esta autorización de pago no es un consentimiento general de privacidad.'
export type SepaAuthorizationInput = { version: string; accepted: boolean }
export type SepaInput = { accountHolder: string; iban: string; authorization?: SepaAuthorizationInput }
export type SepaEvidence = {
  version: string; accepted: true; acceptedAt: string; actorId: string; tenantId: string
  reference: string; creditor: typeof sepaCreditor; scheme: 'SEPA Core'; type: 'recurrent'
  accountHolder: string; ibanLast4: string; ibanSha256: string; label: string; text: string; sha256: string
  preNotificationDays: 3 | 14
}
export type SepaRecord = {
  id: string; createdAt: string; evidence?: SepaEvidence
  notice?: { status: string; dueDate: string; amountCents: number; reference: string; recipient: string; sentAt?: string }
}

export function mandateReference(id: string, replacement = false) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) throw new Error('BILLING_INVALID_REQUEST')
  // 35 characters, retaining the entire UUID rather than its first 32 bits.
  return `${replacement ? 'TKM' : 'TKI'}${id.replaceAll('-', '').toUpperCase()}`
}
export function requireSepaAuthorization(value: SepaAuthorizationInput | undefined) {
  if (value?.accepted !== true || value.version !== sepaAuthorizationVersion) throw new Error('BILLING_SEPA_AUTHORIZATION_REQUIRED')
}
export function noticeWindowOpen(dueDate: string, at = new Date(), days: 3 | 14 = 14) {
  const date = Date.parse(`${dueDate}T00:00:00.000Z`)
  const today = Date.parse(`${at.toISOString().slice(0, 10)}T00:00:00.000Z`)
  return Number.isFinite(date) && date - today >= days * 86_400_000
}
export function sepaEvidencePayload(evidence: Omit<SepaEvidence, 'sha256'>) {
  // The receipt has two object levels. Sort their keys so JSONB reordering does
  // not invalidate the downloadable evidence; the digest itself is excluded.
  return JSON.stringify(evidence, [...Object.keys(evidence).filter(key => key !== 'sha256'), ...Object.keys(evidence.creditor)].sort())
}
export async function sepaEvidence(input: SepaInput, actorId: string, tenantId: string, reference: string): Promise<SepaEvidence> {
  requireSepaAuthorization(input.authorization)
  const hash = async (value: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('')
  const iban = input.iban.replace(/\s/g, '').toUpperCase()
  const receipt: Omit<SepaEvidence, 'sha256'> = {
    version: sepaAuthorizationVersion, accepted: true as const, acceptedAt: new Date().toISOString(), actorId, tenantId,
    reference, creditor: sepaCreditor, scheme: 'SEPA Core' as const, type: 'recurrent' as const,
    preNotificationDays: sepaPreNotificationDays,
    accountHolder: input.accountHolder.trim(), ibanLast4: iban.slice(-4), ibanSha256: await hash(iban), label: sepaAuthorizationLabel, text: sepaAuthorizationText,
  }
  return { ...receipt, sha256: await hash(sepaEvidencePayload(receipt)) }
}
