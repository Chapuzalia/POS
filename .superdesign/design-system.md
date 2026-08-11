# POS / CRM design system

## Product context

Multi-tenant hospitality POS with three surfaces: touch-first POS, owner/manager CRM, and platform superadmin. The current task targets only the feature assignment group inside the superadmin tenant edit modal.

## Visual direction

Use the existing “Núcleo básico” panel as the exact aesthetic anchor: calm neutral surface, compact spacing, restrained border, small semantic icon tile, clear label, and quiet supporting text. Optional modules should feel like members of the same family, not oversized blue promotion cards.

## Tokens and rules

- Font: Inter/system sans only.
- Surface hierarchy: white modal → `#f1f4f7` grouped section → white or transparent rows.
- Text: `#15171a` primary, `#5d6269` secondary, `#858b93` muted.
- Border: `#e1e5ea`; selected may use `#1478ed` but never flood the full card with blue.
- Status: green is reserved for the always-included core; blue indicates selectable/selected optional modules.
- Radius: 10–14px inside the modal. Avoid excessive pill shapes.
- Shadows: none on individual option rows; the modal owns the floating shadow.
- Spacing: compact 10–14px rows, consistent 8–12px gaps, aligned icon/control column.
- Typography: module name 12–13px semibold/bold; description 10–11px regular/medium.
- Interaction: the entire option row remains clickable; selected state uses a clear checkbox plus subtle border/background change; hover uses `#e8edf2`.
- Responsive: two columns on desktop, one column on small screens; row heights should remain content-driven and balanced.
- Accessibility: preserve visible focus, sufficient contrast, and explicit selected state.

## Target composition

One cohesive grouped module panel: a compact header for “Núcleo básico”, a subtle divider, then optional module rows in a clean two-column list. The active count belongs in a small quiet badge/header line rather than floating over large cards.

Do not introduce gradients, decorative illustration, saturated full-card fills, new fonts, or unrelated colors.
