# Theme

## Compact token summary

- Framework: React 19 + Vite 8.
- Components: HeroUI v3 primitives with local wrappers.
- Styling: Tailwind CSS v4 utility classes plus CSS custom properties in `src/index.css`.
- Font: Inter, then system sans-serif.
- CRM radii: 6 / 10 / 14 / 20 / 24px; pills use 999px.
- CRM light surfaces: canvas `#f3f5f7`, surface `#ffffff`, soft surface `#f1f4f7`, hover `#e8edf2`.
- CRM text: primary `#15171a`, secondary `#5d6269`, muted `#858b93`.
- CRM blue: `#1478ed`; soft blue `rgba(20,120,237,.15)`.
- CRM green: `#16b865`; soft green `rgba(22,184,101,.14)`.
- Borders: subtle `#e1e5ea`, standard `#d4dae2`.
- Shadows: card `0 0 0 1px rgba(24,32,44,.055), 0 10px 28px rgba(24,32,44,.09)`; floating `0 18px 50px rgba(24,32,44,.16)`.
- Dark mode retains the same structure using near-black canvas and `#181a1c` surfaces.
- Existing superadmin language: neutral grouped panels, small green status cue for always-enabled core, blue reserved for actions and selected state.

## Raw token source

```css
.crm-shell {
  --crm-radius-xs: 6px; --crm-radius-sm: 10px; --crm-radius-md: 14px; --crm-radius-lg: 20px; --crm-radius-xl: 24px;
  --crm-canvas: #f3f5f7; --crm-surface: #ffffff; --crm-surface-soft: #f1f4f7; --crm-surface-hover: #e8edf2;
  --crm-input-bg: #f8fafc; --crm-input-border: #cfd6df; --crm-border-subtle: #e1e5ea; --crm-border: #d4dae2;
  --crm-text: #15171a; --crm-text-secondary: #5d6269; --crm-text-muted: #858b93;
  --crm-blue: #1478ed; --crm-blue-hover: #0e6fdf; --crm-blue-soft: rgba(20, 120, 237, 0.15);
  --crm-green: #16b865; --crm-green-soft: rgba(22, 184, 101, 0.14);
  --crm-shadow-card: 0 0 0 1px rgba(24, 32, 44, 0.055), 0 10px 28px rgba(24, 32, 44, 0.09);
  --crm-shadow-floating: 0 18px 50px rgba(24, 32, 44, 0.16);
  font-family: Inter, ui-sans-serif, system-ui, sans-serif;
}
```

Complete raw source: `src/index.css` (248 lines; includes POS tokens, CRM light/dark scopes, popover tokens, and document defaults).
