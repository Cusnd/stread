# Queue implementation review — 2026-10-29

Source visual truth: `research/queue-page-design-2026-10-29/queue-selected-with-task-id.png`.
Implementation: `.audit/queue-design-2026-10-29/queue-desktop.jpg`.

The approved 1672 × 941 image was normalized to a 1280 × 720 CSS viewport. The browser capture is 1280 × 720 at one pixel per CSS pixel. Both show the conversion type, pending status, an expanded first task and a collapsed second task. The implementation uses the repository's actual Attention and ResNet PDFs, allocated task IDs and current counts; the design's GQA thumbnail, task names, counts and timestamps are illustrative.

Full comparison: `.audit/queue-design-2026-10-29/comparison-full.png`. Focused metadata, typography and action comparison: `.audit/queue-design-2026-10-29/comparison-detail.png`. Both place the normalized design and browser capture in one image.

## Findings and comparison history

- The first desktop comparison found no actionable visual mismatch. The implementation preserves the type sidebar, status controls, copyable task reference, inline expansion, restrained actions and real source preview. It follows existing Stread typography and its 184px sidebar instead of treating generated text metrics as a new design system.
- [P2, fixed] At 320 × 720, the third workspace link pushed persistent header actions outside the viewport. Reduced the navigation gaps and narrow-screen type size in `workspace/workspace.css`. The post-fix capture is `.audit/queue-design-2026-10-29/queue-320.jpg`; the document scroll width is 312px within the 320px viewport and all header actions remain visible. At 390 × 844 the sidebar becomes an overlay; the background content is inert until dismissal. Evidence: `queue-narrow.jpg`.
- [P2, fixed] Returning from Reader initially restored the expanded row before its animated height was available, clamping the saved Queue scroll position to zero. Restoration now observes content height until expansion settles; opening Reader captures the position and protects it from outgoing layout events. The real pointer round trip restored exactly 116px to 116px with the same filter and expanded task. Evidence: `queue-scroll-restored.jpg`. An intermediate locator-click check scrolled the button before activation; the pointer check avoids that test-induced position change.

## Fidelity surfaces

- **Fonts and typography:** Existing Noto Sans SC / Microsoft YaHei workspace stack, compact 12–16px hierarchy, monospaced task references, visible focus and natural title wrapping on narrow screens. Deliberately reuses production tokens; the generated heading is somewhat larger.
- **Spacing and layout:** Existing 56px topbar and 184px navigation, flat list rows, independently scrolling content, two-column expanded task with a right-side original-page preview. A narrower task stacks its preview below the requirements and actions.
- **Colors and tokens:** Existing neutral white, pale gray, charcoal, line and selection tokens. The primary handoff action matches the approved dark treatment. No invented progress or status colors.
- **Image quality:** PDF thumbnail is rendered from the retained original at 600px width, preserving aspect ratio. It is an actual source page rather than the generated mock thumbnail. Icons reuse the existing library.
- **Copy and content:** Task ID stays visible when collapsed. Conversion output and requirements are explicit; no decorative descriptions were added. Status, diagnostics, preview/revision and result actions follow persisted facts.

## Browser interaction evidence

Checked through the in-app browser against an isolated test profile:

- Conversion filtering, expansion, actual PDF preview, editing, withdrawal, restoration and stable task ID.
- ID search; opening Reader and returning with the same filter and expanded task.
- Closing/reopening an unfinished draft and creating an article correction with both T and R identities.
- Direct links to withdrawn tasks reveal the requested task across filters.
- Explicit question enqueue; stale question version produces a recoverable error, refreshing/reselecting retains supplemental requirements, and a saved test answer moves the task to completed with a result action.
- Queue → upload new PDF → enqueue preserves an explicit source-only output choice and custom requirements.
- Edit dialog focuses requirements and returns keyboard focus to its task after closing.
- Desktop, 390px and 320px layout inspection; final browser error-log read returned an empty list.

The initial custom-port development server rejected a browser write because its allowed origin was not configured. The isolated server was restarted with its explicit local preview origin; no production origin/authentication policy was changed.

## Verification scope

This is browser UI and local service verification. It does not establish packaged Electron behavior, an installed personal profile migration, an external provider run, or the fidelity of a newly converted article. Test publication/answer evidence is synthetic and is only used to exercise state and transaction contracts.

Checks completed:

- Final frontend regression: 402/402 passed.
- Workspace service full regression: 534/534 passed; after follow-up compatibility changes, Queue and request-publication tests passed 21/21. Final Queue/HTTP/MCP focused verification passed 22/22.
- MCP protocol, catalog, management, Queue and contract-quality focused suite: 28/28 passed. All 32 public tools and their input schemas were compared with the prior catalog and remain identical.
- Final production frontend build passed. Existing large-chunk warnings remain.
- Independent code review's three P2 findings (question-conflict recovery, multi-page revision consistency, and direct-link visibility) were fixed, covered by regression tests, and confirmed by a read-only follow-up review.

No actionable P0/P1/P2 findings remain. The preview uses an isolated test profile and real retained sample files.

final result: passed
