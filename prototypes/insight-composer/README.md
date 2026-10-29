# Reader frontend

This React/Vite package contains the production Collection, Flow and Reader interface used by the local browser server and Electron desktop app. The directory name is retained from the original prototype.

## Run locally

From the repository root, install the dependencies and start the connected frontend and workspace service:

```powershell
npm ci
npm run setup
npm run dev
```

The launcher prints the local URL. For a native window and an isolated test profile:

```powershell
npm run desktop:dev -- --reader-user-data=D:\ReaderProfiles\Development
```

See the [desktop guide](../../electron/README.md) for profile locations, packaged builds and troubleshooting. PDF processing in source mode requires a Python interpreter with PyMuPDF; installed desktop builds include their own runtime.

## Product surfaces

- Collection organizes documents, categories, tags, reading status and the shared reading plan.
- Flow exposes recorded reading activity, insights, explicit review membership, the reading plan and reading history.
- Reader presents source, translation or bilingual content, an outline, original PDF navigation, paragraph insights, questions, document notes, glossary and saved AI requests.
- Shared settings preserve reading preferences, interface scale, highlight palettes and shortcuts. Requests are stored locally for external Agents; saving a request never launches one.

The browser and desktop use the same [workspace API and MCP contract](../../services/workspace/README.md). User content is persisted by that service. Browser storage retains scoped view preferences, caches and pending commands; it is not a substitute for acknowledged service writes.

## Source layout

| Path | Responsibility |
| --- | --- |
| `src/WorkspaceApp.jsx`, `src/workspace/` | Collection and workspace navigation |
| `src/workspace/FlowPage.jsx`, `src/workspace/flow-*.js` | Flow views and recorded activity |
| `src/App.jsx`, `src/PaperArticle.jsx`, `src/ReaderRuntime.jsx` | Reader state and document presentation |
| `src/InlineContent.jsx`, `src/HtmlBlock.jsx`, `src/PdfPanel.jsx` | Structured content, semantic HTML and original PDF view |
| `src/ComposerSurface.jsx`, `src/InsightActions.jsx` | Insight editing and operations |
| `src/workspace-api.js` | Shared local service client |
| `scripts/authoring-compiler.mjs`, `scripts/authoring-validation.mjs` | Authoring compilation and structural validation |
| `public/articles/` | Bundled document examples and original resources |

## Build and checks

```powershell
npm --prefix prototypes/insight-composer run build
npm --prefix prototypes/insight-composer run test:html
npm --prefix prototypes/insight-composer run test:conversion
npm run test:reader
```

The build produces `dist/client` for local browser and desktop use. It also emits the optional static sample adapter under `dist/server` and `dist/.openai`; `test:sites` checks that adapter. It does not provide remote access to the local workspace.

Browser scripts ending in `.browser.mjs` require a running test server and the environment described in each script. Automated structure tests, browser behavior, native Electron behavior and semantic source review establish different things. Do not present a successful build as universal paper-conversion acceptance.

## Authoring and examples

External Agents start with the [authoring guide](../../services/workspace/authoring-guide.md), [schema](../../services/workspace/authoring-schema.json) and [conversion workflow](../../services/workspace/conversion-workflow.md). The compiler generates stable consumer identities and validates structure. Publishing a new conversion also requires complete requested translations, a separately spawned source-first reviewer, real Reader inspection, and a fresh review of the exact preview hash.

The bundled examples demonstrate rendering and preserved resources; historical samples may have partial translations. They are not proof that an arbitrary paper is completely or correctly converted. Their source inputs are described in [conversion samples](samples/conversion-contract/README.md) and the [Attention package](public/articles/attention-is-all-you-need/README.md).

```powershell
npm --prefix prototypes/insight-composer run compile:authoring -- samples/conversion-contract/resnet.authoring.json public/articles/resnet
npm --prefix prototypes/insight-composer run sample:html
```

These commands rewrite the selected sample output. Use copies when testing changes that should not alter bundled examples. The HTML sample uses the checked-in table fixture under `tests/fixtures`; generic renderers do not branch on a paper title or table number.
