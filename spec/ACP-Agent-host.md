# Desktop Agent host

> 本页保留产品约定及带日期的设计背景。早期研究稿、截图和个人待办不随公共源码发布；历史验证描述不代表当前发布包的验收结果。当前范围以根目录 AGENTS.md、现行服务合同及本仓库代码为准。

**Retired 2026-10-28 at the user's request.** The built-in host, UI, desktop bridge and bundled adapters have been removed from the active application. Reader no longer starts Agent processes. External MCP conversion and independent review remain supported; saved documents and historical run/evidence files are preserved. The design below is historical and does not authorize reintroducing this integration.

Approved implementation scope, 2026-10-27. This document supersedes the earlier prohibition on internal Agent sessions **only for the optional desktop ACP host described here**. The workspace service still does not choose models, run extraction/OCR, or orchestrate Agents. Its local SQLite/filesystem storage and existing [32-tool MCP contract](../services/workspace/mcp-management.md) remain authoritative.

The host uses Agent Client Protocol to communicate with an external Agent process. It does not implement a provider API or a second document service. External MCP clients and copied conversion requests remain supported independently.

## User actions and task scope

| Entry | Launch-time binding | Authorized behavior |
| --- | --- | --- |
| Uploaded original → `交给 Agent` → `开始执行` | Retained source ID, title/language, shared conversion instruction | Complete original plus default zh-CN conversion, independent review, repair, and exact reviewed publication |
| Saved pending AI request → `交给 Agent` | Request ID/version/body, document ID/revision, exact saved source envelope | Execute that frozen request through existing document/revision semantics |
| Selected passage, formula, table cell, or Q/N → `询问 Agent` → `发送问题` | Document/revision, variant, block/item/cell/node address, offsets/quote and available source hash; saved insight ID/version/reference when applicable | Read bounded context and answer the question |

Upload, save, selection, article opening, task-panel opening, and Agent selection never start execution by themselves. Questions do not save an insight, change an existing answer, resolve a question, or broaden a task's write scope. The initial question runner is read-only; separately requested persistence uses the existing explicit Reader/MCP actions. Glossary mutations still require an explicit glossary instruction.

Reader anchors, current mode, native selection, return origin, and unfinished drafts survive opening/closing a task. A captured source envelope is independent of later selection changes. A saved request edited after launch cannot silently replace its original instruction or version.

When a saved request produces a revision preview, publication rechecks that originating request's exact version and pending status and records its completion in the same guarded transaction as the body revision. The host supplies this binding through trusted local execution metadata; the public MCP and HTTP input schemas are unchanged. A cancelled or edited request blocks a new publication. Exact replay of an already committed request still returns its original receipt.

## Managed conversion

The desktop conversion action sends `automatic: true`. Direct host API callers use manual operation unless they explicitly set this flag. Existing requests and questions do not implicitly opt into automatic conversion.

1. The generator receives the retained source, current authoring contract, and a short managed-role instruction. It chooses extraction, composition, checking, and repair methods. The host owns reviewer creation and publication for this managed run; the generator does not impersonate a reviewer or publish.
2. Candidate identity comes from an actual successful `create_authoring_preview` response observed at the MCP boundary. Agent prose and an ACP `end_turn` are not publication or review evidence.
3. Before handoff, the host checks that the candidate is the current successful draft head, matches its exact retained hash, and has no draft error. Automatic handoff requires one unambiguous draft. Multiple drafts require an explicit candidate choice.
4. A genuinely separate reviewer process/session first receives only the originals and delivery requirements. The host retains its actual source-first baseline and observed launch/session evidence before releasing candidate access.
5. The reviewer then receives the exact immutable preview/hash, service-derived scope/template, and an isolated real Reader browser. It compares source, original text, translations, objects, and actual Reader usability. Initial page readiness is not whole-document acceptance.
6. The reviewer supplies the compact `reader-quality-review-3` result and supporting evidence. The host binds local evidence files to actual uploaded source IDs without inventing semantic assertions. Existing v2 submissions retain their stricter service checks.
7. Blocking findings remain outstanding until the latest candidate contains explicit evidence-backed resolutions. Repairs produce a new preview/hash and receive fresh review. Missing translations, independent review, real Reader inspection, or required evidence remain publication blockers.
8. The host journals the complete exact publication request before calling `publish_authoring_preview`. It keeps the same idempotent request ID when reconciling an uncertain result and marks the task published only after authoritative receipt/readback identifies the saved document/revision.

The automated path may proceed through these stages within the user's explicit conversion request. It does not add a generic confirmation between already authorized stages. Existing concrete revision approval and service quality gates remain in force.

## Interface and configuration

Use the existing compact neutral UI, shared settings surface, native dialogs, and motion/focus conventions. The task panel contains real task status, normalized messages/tool summaries, pending permission choices, candidate links, and the available next action. Closing it does not cancel execution; `停止` is the explicit cancellation action. Retained tasks reopen from the Agent settings history.

Agent profiles configure an exact executable and argument array. Do not offer raw environment-variable or credential fields in the renderer. The implementation starts with the pinned Codex ACP adapter and detected/configured OpenCode; discovery is not evidence that an account is authenticated or a model is available.

Model and reasoning selectors come only from the connected Agent's advertised `configOptions` with `model` and `thought_level` categories. Preserve advertised value IDs and grouping; do not maintain a hardcoded global model/provider catalog. The host validates each selected value against the session and remembers it for that Reader profile. If a later generator/reviewer session no longer advertises a saved choice, stop with an actionable configuration error instead of silently switching models or reasoning settings. Controls are disabled during active work. A failed or idle task can accept a supported choice and then an explicit follow-up.

If publication is uncertain, expose `核对发布结果` when the host reports a retained publication request. This action replays/reconciles that exact request; it does not create a new publication payload. Do not accept a replacement follow-up while the publication outcome remains pending.

## Boundaries and lifecycle

- The renderer receives a narrow typed bridge. It receives no general process, filesystem, credential, or broad Reader bearer-token API. Main-process checks require the trusted Reader window/main frame; stale backend messages cannot resolve another backend's request or update the visible task.
- Hosted Agents use short-lived run-scoped Reader grants. Generator, source-first reviewer, candidate reviewer, and question access are checked at MCP and protected HTTP/resource boundaries. The public workspace catalog remains 32 tools. The review browser is a separate supporting MCP server, not an addition to that catalog.
- Public snapshots have monotonically increasing sequence values, including permission transitions. Render only normalized `message`, `tool`, and `status` events; do not display raw protocol traffic or private reasoning as the conversation.
- Permission responses bind the run, active permission, offered option, and connection lifecycle. Cancellation revokes grants, cancels pending permissions, and stops the owned Agent process tree; retained candidates and evidence are not discarded.
- Run metadata, event history, exact pending mutations, and review evidence live locally beside the desktop workspace data. Restart exposes interrupted/uncertain tasks without silently launching a new Agent. Recovered transcript text is not proof of a committed write.
- Separate Agent working directories, scoped Reader credentials, isolated preview browsing, and private provider configuration reduce accidental cross-task access. They do not constitute an operating-system sandbox against a malicious native Agent. The application does not claim adversarial isolation from every file or process available to the user's account.
- Reader storage, business execution, previews, and journals remain local. The chosen external Agent may use its own remote model provider. This feature does not restore cloud Reader storage, automatic synchronization, or remote deployment.

## Implementation and acceptance

Historical implementation and private run evidence are not included in this public snapshot. Related contracts are [conversion quality](转换质量反馈.md), [Agent conversion](Agent转换约定.md), [bilingual delivery](双语对照.md), [MCP revisions](MCP文档修订.md), and [insight/question semantics](洞见与问题合集.md).

Keep evidence levels separate: unit/bridge tests, isolated UI tests, actual provider sessions, source-first independent conversion review, real Reader inspection, and packaged Electron acceptance establish different claims. A passing mock or screenshot never establishes a completed real-provider conversion. Record live acceptance and failures separately from isolated tests.
