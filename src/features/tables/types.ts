import type { PaymentMethod, TicketLineModifier } from '../../types/domain'

export type RestaurantTableShape = 'square' | 'rectangle' | 'round'
export type RestaurantTableStatus = 'free' | 'occupied' | 'reserved'
export type ServiceStatus = 'pending' | 'partial' | 'served'
export type DiningArea = { id: string; tenantId: string; venueId: string; name: string; sortOrder: number; isActive: boolean; canvasWidth: number; canvasHeight: number; createdAt: string; updatedAt: string }
export type RestaurantTable = { id: string; tenantId: string; venueId: string; areaId: string; name: string; capacity: number; shape: RestaurantTableShape; positionX: number; positionY: number; width: number; height: number; isActive: boolean; sortOrder: number; reservedUntil: string | null; reservationNote: string | null; createdAt: string; updatedAt: string }
export type RestaurantOrder = { id: string; tenantId: string; venueId: string; cashSessionId: string; cashRegisterId: string; openedByUserId: string; openedByDeviceId: string; guestCount: number; status: 'open' | 'paid' | 'cancelled'; revision: number; openedAt: string; updatedAt: string; closedAt: string | null }
export type OrderTable = { orderId: string; tableId: string; joinedAt: string; releasedAt: string | null }
export type RestaurantOrderLine = { id: string; tenantId: string; venueId: string; orderId: string; productId: string | null; variantId: string | null; productName: string; variantName: string; unitPriceCents: number; quantity: number; servedQuantity: number; fullyServedAt: string | null; modifiers: TicketLineModifier[]; note: string | null; createdAt: string; updatedAt: string }
export type TableLayoutEntry = { positionX: number; positionY: number; groupId: string | null }
export type SessionTableLayout = { cashSessionId: string; revision: number; updatedAt: string; tables: Record<string, TableLayoutEntry> }
export type RestaurantTableMapItem = RestaurantTable & { status: RestaurantTableStatus; orderId: string | null; orderOpenedAt: string | null; guestCount: number | null; totalCents: number; pendingUnits: number; groupTableIds: string[]; layoutGroupId?: string | null; layoutGroupTableIds?: string[] }
export type RestaurantMap = { areas: DiningArea[]; tables: RestaurantTableMapItem[]; layoutRevision?: number }
export type RestaurantOrderDetail = { order: RestaurantOrder; cashRegisterName: string; lines: RestaurantOrderLine[]; tables: RestaurantTable[]; totalCents: number }
export type DiningAreaCreateInput = { venueId: string; name: string; sortOrder: number }
export type DiningAreaUpdateInput = Partial<Pick<DiningArea, 'name' | 'sortOrder' | 'isActive' | 'canvasWidth' | 'canvasHeight'>>
export type RestaurantTableCreateInput = { venueId: string; areaId: string; name: string; capacity: number; shape: RestaurantTableShape; positionX: number; positionY: number; width: number; height: number; sortOrder: number }
export type RestaurantTableUpdateInput = Partial<Pick<RestaurantTable, 'name' | 'capacity' | 'shape' | 'positionX' | 'positionY' | 'width' | 'height' | 'isActive' | 'sortOrder'>>
export type OpenRestaurantOrderInput = { tableIds: string[]; guestCount: number; cashSessionId: string; deviceId: string }
export type CloseRestaurantOrderInput = { orderId: string; paymentMethod: PaymentMethod; receivedCents: number | null }
export type CloseRestaurantOrderResult = { requiresConfirmation: true; pendingUnits: number } | { requiresConfirmation: false; pendingUnits: number; orderId: string; ticketId: string; saleId: string; paymentId: string; totalCents: number }
export type SaveRestaurantOrderLinesResult = { revision: number; lines: RestaurantOrderLine[] }
export type RestaurantOrderSaveState = 'saved' | 'dirty' | 'saving' | 'error'
export type PosView = { type: 'table_map'; areaId?: string } | { type: 'table_order'; orderId: string } | { type: 'quick_sale' }
