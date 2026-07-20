export function getClosedCashState() {
  return {
    session: null,
    ledger: [],
    tickets: [],
  } as const
}
