# Extractable components

## CrmShell
- Source: `src/features/crm/layout/CrmShell.tsx`
- Category: layout
- Description: Shared CRM frame with sidebar, topbar, contextual title, venue selector, and content canvas.
- Extractable props: `activeSection`, `isOnline`, `selectedVenueId`.
- Hardcoded: shell geometry, typography, colors, sidebar/topbar placement.

## CrmSidebar
- Source: `src/features/crm/layout/CrmSidebar.tsx`
- Category: layout
- Description: Responsive dark navigation sidebar with grouped sections.
- Extractable props: `activeSection`, `isOpen`, feature-dependent item visibility.
- Hardcoded: icons, section names, navigation spacing and visual states.

## SuperAdminModal
- Source: `src/components/superadmin/SuperAdminPage.tsx`
- Category: layout
- Description: CRM-themed large modal used for tenant create/edit/detail flows.
- Extractable props: `label`, `size`.
- Hardcoded: modal surface, spacing, responsive max-height, shadow.

## FeatureAssignmentGroup
- Source: `src/components/superadmin/SuperAdminPage.tsx`
- Category: basic
- Description: Core-feature summary plus selectable optional feature assignments.
- Extractable props: selected feature keys, feature names, descriptions, disabled state.
- Hardcoded: core/optional hierarchy and CRM theme tokens.
