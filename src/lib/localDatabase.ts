const dbName = 'tickit-verifactu-local-v1'
const dbVersion = 5

export function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error) })
}

export function transactionDone(tx: IDBTransaction): Promise<void> {
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB canceló la emisión fiscal.'))
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB no guardó la emisión fiscal.'))
  })
  void done.catch(() => {})
  return done
}

export async function openLedger(): Promise<IDBDatabase> {
  if (!globalThis.indexedDB) throw new Error('IndexedDB no está disponible. No se puede expedir.')
  const opening = indexedDB.open(dbName, dbVersion)
  opening.onupgradeneeded = () => {
    const db = opening.result
    const upgradeTx = opening.transaction
    if (!upgradeTx) throw new Error('No se pudo iniciar la migración fiscal de IndexedDB.')
    if (!db.objectStoreNames.contains('cursors')) db.createObjectStore('cursors', { keyPath: 'scope' })
    if (!db.objectStoreNames.contains('numbers')) db.createObjectStore('numbers', { keyPath: 'key' })
    if (!db.objectStoreNames.contains('bindings')) db.createObjectStore('bindings', { keyPath: 'scope' })
    const entries = db.objectStoreNames.contains('entries')
      ? upgradeTx.objectStore('entries')
      : db.createObjectStore('entries', { keyPath: 'id' })
    if (!entries.indexNames.contains('scope')) entries.createIndex('scope', 'scope')
    if (!entries.indexNames.contains('ticket')) entries.createIndex('ticket', ['scope', 'invoice.ticketId'])
    if (!db.objectStoreNames.contains('delivery')) db.createObjectStore('delivery', { keyPath: 'id' })
    if (!db.objectStoreNames.contains('economicSales')) {
      const economicSales = db.createObjectStore('economicSales', { keyPath: 'id' })
      economicSales.createIndex('scope', 'scope')
    }
    const paymentOperations = db.objectStoreNames.contains('paymentOperations')
      ? upgradeTx.objectStore('paymentOperations') : db.createObjectStore('paymentOperations', { keyPath: 'key' })
    if (!paymentOperations.indexNames.contains('scope')) paymentOperations.createIndex('scope', 'scope')
    if (!db.objectStoreNames.contains('durableSales')) {
      const sales = db.createObjectStore('durableSales', { keyPath: 'id' })
      sales.createIndex('scope', 'scope')
    }
    const durableEvents = db.objectStoreNames.contains('durableEvents')
      ? upgradeTx.objectStore('durableEvents') : db.createObjectStore('durableEvents', { keyPath: 'id' })
    if (!durableEvents.indexNames.contains('route')) durableEvents.createIndex('route', 'route')
    const restaurantPayments = db.objectStoreNames.contains('restaurantPayments')
      ? upgradeTx.objectStore('restaurantPayments') : db.createObjectStore('restaurantPayments', { keyPath: 'key' })
    if (!restaurantPayments.indexNames.contains('scope')) restaurantPayments.createIndex('scope', 'entry.scope')
  }
  const db = await request(opening)
  db.onversionchange = () => db.close()
  return db
}
