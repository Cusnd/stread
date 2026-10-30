# Frontend contributor instructions

This directory contains the production React interface for Stread. Its historical directory name does not imply a separate product or storage service. Follow the repository [instructions](../../AGENTS.md).

Keep Collection, Flow, Queue and Reader visually consistent: compact neutral surfaces, content-driven rows and restrained topbar controls. Reuse shared settings, navigation, context menus and motion primitives. Do not add secondary labels when alignment and grouping explain the relationship.

Before a UI change, read the relevant topic in the [design system](../../spec/design-system/README.md) and check its [known inconsistencies](../../spec/design-system/inconsistencies.md). Every frontend appearance or interaction update must also update its topic and the [design changelog](../../spec/design-system/changelog.md) in the same change. An implementation-only fix should update the topic's implementation or verification note rather than inventing a new rule. New variants need a documented role and reason; inspect equivalent controls across affected pages, including transitional states. Use the [maintenance checklist](../../spec/design-system/maintenance.md) as the completion condition.

Preserve stable document/block/insight identities, exact source variants and offsets, drafts, native selection, keyboard focus, scroll positions and the Reader's opening workspace. Reading completion changes only through the existing explicit reading actions. Language switches display stored variants and must not synthesize translations or change reference identities.

Paragraph margin previews may group presentation, but each insight keeps its own identity, color, source order, version and operations. Different list items and authored HTML paragraphs stay distinct. Preserve exact cell/node references when presenting whole-object navigation.

The shared workspace service persists documents, insights, plans, requests and object preferences. Browser caches and optimistic state must preserve request IDs and retry behavior. Saving an AI request does not run an Agent. Cloud synchronization and the built-in Agent host are retired.

Use shared motion rules, finish exits before unmounting, make closing controls inert, reject stale completions and honor live reduced-motion changes. Input, dragging and native scrolling remain direct. Prefer desktop keyboard and pointer verification for this desktop product.

Run relevant tests from this directory with `node --test tests/<name>.test.mjs`. Use the root `npm run dev` for the connected browser interface or `npm run desktop:dev -- --reader-user-data=<absolute-test-profile>` for native inspection. Do not use a personal profile as a test fixture. A screenshot or a synthetic test does not establish final Electron or source-content acceptance.

The optional Sites output is a static sample adapter. Keep its worker, hosting configuration and tests consistent with the frontend build, but do not treat it as the local workspace backend or deploy it implicitly.
