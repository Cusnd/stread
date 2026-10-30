# Contributor instructions

Stread is a local desktop reading workspace, formerly Continuous Reader. This repository is the public source snapshot for the application; private development history and personal profiles are not included.

## Active scope

- Keep Collection as the default workspace, Flow and Queue as peer workspaces, and Reader as the document view. Preserve the opening workspace, list state, reading position, selection and drafts when returning from Reader.
- Desktop, loopback HTTP and stdio share the same local SQLite database and filesystem objects. Do not reintroduce cloud storage, automatic synchronization or remote execution from historical design notes.
- Reader does not launch or coordinate Agent processes. External Agents use the existing MCP interface and copied conversion requests.
- Preserve the exact 32 public MCP tools and input schemas, authorization checks, stable identities, version guards, immutable previews, publication hashes and idempotent receipts. See [the MCP contract](services/workspace/mcp-management.md).
- A default non-Chinese conversion delivers the complete source plus Simplified Chinese. Publication requires an actually independent source-first reviewer, inspection in the real Reader, and review of the latest frozen hash. Structural validation alone is not content acceptance. See [the conversion workflow](services/workspace/conversion-workflow.md).
- Preserve original files, revisions, insights, saved requests, reading activity and historical conflict evidence. A saved position is not proof that an article was completed.
- Product branding is Stread. Retain the existing `com.continuousreader.desktop` app identity, `.continuous-reader` profile, persisted keys, environment variables, CLI arguments and `continous-reader` document format/extension identifiers for compatibility.

## Changes and verification

Inspect the current files and Git diff before editing. Keep changes scoped and do not overwrite unrelated work. Use environment variables or documented platform defaults for local tools; never commit personal paths, user profiles, connection tokens or signing private keys.

Use the existing shared business commands and UI components. Keep the interface compact and content-first; avoid redundant labels, descriptions and decorative controls. Preserve keyboard access, native text selection, focus, reduced motion and independent scrolling.

The [frontend design system](spec/design-system/README.md) is the cross-page UI reference. Every change affecting frontend appearance or interaction must update the relevant topic and its [design changelog](spec/design-system/changelog.md) in the same change. Record remaining inconsistencies explicitly; do not present a local variant as an established global rule. Follow the [maintenance and verification workflow](spec/design-system/maintenance.md), including related surfaces and dynamic states.

Run checks appropriate to the change. The root [README](README.md) documents setup and tests; [desktop documentation](electron/README.md) covers native builds. Report unit, browser, real-provider, packaged-runtime and installed-profile evidence separately. A passing build is not an installation or content-fidelity acceptance result.

Do not publish a release, change external resources or migrate a real profile without the task's authorization. Ordinary local edits and focused verification are expected within the requested scope.

## Repository guidance

- [Frontend instructions](prototypes/insight-composer/AGENTS.md)
- [Frontend design system](spec/design-system/README.md)
- [Workspace service](services/workspace/README.md)
- [Authoring guide](services/workspace/authoring-guide.md)
- [Desktop updates](electron/UPDATES.md)

Dated specifications may record superseded designs. The active scope above and current implementation take precedence over retired cloud, Home and desktop Agent-host proposals.
