# Page dependency trees

## `/superadmin`

Entry: `src/components/superadmin/SuperAdminPage.tsx`

- `src/components/ui/Input.tsx`
- `src/components/ui/Button.tsx`
- `src/components/ui/Checkbox.tsx`
- `src/components/ui/AppModal.tsx`
- `src/services/platformService.ts`
- `src/types/domain.ts`
- `src/utils/errors.ts`
- `src/index.css`

## `/crm`

Entry: `src/components/crm/CrmPage.tsx`

- `src/features/crm/layout/CrmShell.tsx`
  - `src/features/crm/layout/CrmSidebar.tsx`
  - `src/features/crm/layout/crmTheme.ts`
  - `src/components/crm/CrmVenueSelector.tsx`
  - `src/components/ui/Button.tsx`
- `src/features/crm/routing/CrmSectionContent.tsx`
- `src/features/crm/routing/crmNavigation.ts`
- `src/features/crm/routing/crmPermissions.ts`
- feature-specific CRM pages

## `/`

Entry: `src/app/PosPage.tsx`

- `src/components/layout/AppHeader.tsx`
- `src/components/pos/CatalogPanel.tsx`
- `src/components/pos/TicketPanel.tsx`
- `src/components/pos/PaymentPanel.tsx`
- `src/components/ui/AppModal.tsx`
- POS modal components
- restaurant, table, reservation, cash-register, and quick-sale feature controllers
