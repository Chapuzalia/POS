# TICKIT POS — Reservations design system

## Product and task context

TICKIT is a multi-tenant hospitality POS. Reservations is a touch-first operational workspace used by hosts, waiters and managers during live service. The redesign must improve scan speed, exception handling, availability awareness, creation/editing safety and cross-device ergonomics without changing the existing reservation domain, status model or backend.

Core jobs: review a service/day, find a booking, create or edit it, understand table availability, assign tables, mark arrival, seat guests, open the linked order, cancel/no-show safely, and recover from conflicts or offline state.

## Existing visual language — hard constraints

- Use only Inter, ui-sans-serif and the system sans stack.
- Use the existing POS palette and semantic tokens: background `#f6f7fb`, surface `#ffffff`, secondary surface `#eef1f6`, foreground `#111827`, muted `#667085`, separator `#d9dee8`, blue accent `#2563eb`, accent soft `#dbeafe`, success `#0f9f6e`, danger `#dc2626`, warning `#b7791f`.
- Primary actions use solid blue with white text. Secondary actions use white/neutral surfaces and restrained borders. Danger stays reserved for destructive actions.
- Cards and panels use white surfaces, subtle gray borders and the current soft shadow `0 18px 44px rgba(17,24,39,.08)` sparingly.
- Keep the existing HeroUI/Tailwind component character and Lucide outline icon language. Do not introduce gradients, illustrations, decorative fonts, glassmorphism, neon colors or marketing-page styling.
- Use practical, moderately rounded geometry: 12–18px for panels and 10–14px for controls; pills only for compact filters and status chips. The current global 80px radius should not dictate large panel geometry in the proposal.
- Touch targets are at least 44px. Visible focus, sufficient contrast, explicit labels and icon-plus-text for important actions are required.

## Information hierarchy

1. Persistent operational context: back to POS, page title, active date, service period and primary “Nueva reserva” action.
2. Exceptions requiring action: late arrivals, arrived-but-not-seated and bookings without a table. Summary indicators should be compact and clickable/filtering, not large passive KPI cards.
3. Main workspace: dense chronological list or floor map, with a stable details/actions region on larger viewports.
4. Secondary utilities: search, filters, refresh and view switcher.

The default list should prioritize time, customer, party size, table/area, state and urgency. Semantic status must combine text, icon/shape and restrained color; never rely on color alone. Archived states should be separated or collapsed below active service rather than mixed at equal visual weight.

## Interaction and operational speed

- Preserve list and map modes. List is the fastest scanning default; map is for table-centric assignment and availability.
- Keep date navigation one tap away, but add an explicit date picker affordance and a reliable “Hoy” reset when browsing another day.
- Surface quick filters for active service, arrived, late and unassigned. Search across dates must clearly disclose that scope and show result dates.
- Desktop may use a master-detail split. Tablet uses a responsive split or deliberate side sheet. Mobile uses a single-column list with a full-height bottom sheet; never leave ambiguous interactive content visible beneath it.
- Keep primary row actions predictable. “Sentar” is primary only when valid. If no table is assigned, the action should communicate “Asignar mesa y sentar” rather than failing after the tap.
- Do not invent keyboard-only workflows, backend fields or statuses. Optional shortcut hints may be shown only as enhancements.

## Creation and editing

- Structure the form into three readable groups: service (date, time, duration, party size), guest (name, phone, email, notes), and table assignment/availability.
- On desktop/tablet, keep a persistent booking summary and table availability alongside the form. On mobile, use a clear step/section progression with a sticky summary/action bar.
- Validate at field level and summarize only when useful. Show table capacity and time conflicts before the final save attempt whenever the current frontend data permits.
- A past booking, insufficient capacity or overlapping table requires an explicit confirmation state with the consequence and conflicting booking details. “Guardar igualmente” must be visually secondary to resolving the conflict.
- Closing a dirty form should offer discard/continue editing. Editing a seated reservation keeps its current locked schedule/table behavior and explains why.

## Responsive layouts

- Desktop (>=1200px): compact top command bar, chronological list plus 360–400px stable details panel; optional availability rail in form.
- Tablet (761–1199px): command bar wraps once at most; list remains dense; details use a side sheet with backdrop or a 40/60 split in landscape.
- Mobile (<=760px): title/back and primary action share the first row; date/service is the second row; compact horizontal filters; 64–76px rows; details and form are full-height sheets with sticky actions and safe-area padding.
- Avoid hard-coded top insets that assume one header height. Sheets should anchor to the viewport and their own safe areas.

## Motion

Use quick 120–180ms transitions for selected rows, chips and sheets. Respect reduced motion. Loading refresh may rotate the existing refresh icon. Do not animate layout during live list updates.

## Prototype scope

The design should depict representative data and the complete operational hierarchy for list, detail and creation/availability. It may simulate filters, selected states and warnings visually, but must not require backend or domain logic changes to be implementable.
