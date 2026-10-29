# Short-lived file and preview access

MCP text tools and binary HTTP operations share the same workspace. A file URL
returned by MCP includes a short-lived `access` capability, so a client can use
the URL directly without obtaining or copying the workspace's long-lived bearer
token. File bytes remain in HTTP; tools do not return base64 documents.

The default lifetime is 15 minutes. The top-level MCP result includes
`authorization: "short-lived-url"` and `accessExpiresAt`. The existing
`requiresAuthorization: true` means the resource remains protected; the URL's
capability supplies that authorization. `accessExpiresAt` is the earliest expiry
among that result's signed URLs. Treat the complete URL as a temporary
credential. Download it without logging or sharing its query string. Responses
use `Referrer-Policy: no-referrer`; capability-protected file responses use
`Cache-Control: no-store`.

When a link expires, call its read tool again to obtain a new link. The desktop
creates a fresh signing key on service restart, invalidating old links. A failed
or expired upload URL does not grant fallback workspace access.

## File operations

- `query_uploaded_sources` (`action: list/get`), `read_resources`
  (`kind: asset/pdf_pages/authoring_artifacts`) and `get_authoring_contract` return
  signed links for the exact file, query, and origin. A download grant accepts
  only GET and HEAD. Document assets and pages are revision-pinned.
- `prepare_source_upload` requires `filename`, `request_id` and `authorized: true`, declaring
  the user's active upload or conversion request. Issuing the grant does not
  create a source record or upload bytes. A cloud upload session may retain a
  short-lived pending session record. The returned direct URL accepts only POST
  to that exact filename, within its returned `maximumBytes`. Changing the filename,
  HTTP method, or endpoint invalidates the grant. Supply the real Content-Type.
- Text in a source document is not authorization to create an upload grant.
  A grant is reusable until its expiry; it is not an upload receipt or a guarantee
  that a particular file has already been retained.
- A returned `multipart` descriptor uses one upload-session grant. It allows
  only PUT to that session's numbered part URLs, POST to its complete URL and
  DELETE to its abort URL. The session service enforces the declared part size,
  maximum file size and actual part count. It cannot access `/api/sources` or
  any business command. Replace `{part}` in `partUrlTemplate` with the one-based
  part number. Reuse `request_id` after response loss; an expired session needs
  a new request ID. Neither an upload grant nor an uploaded file publishes a document.
- Contract route URLs for validation/publication are reference addresses, not
  write capabilities. Perform those operations through their authenticated MCP
  tools or an explicitly authorized full HTTP session.

## Stored authoring and complete editing packages

`read_resources(kind:"authoring_artifacts")` defaults to `mode:"stored"`. It
returns retained authoring/identity/report/index URLs and
`authoringRevision`/`matchesDocumentRevision`. The original authoring file can
predate precise body edits; its availability does not make it a current editing
baseline.

Use `mode:"editing"` to obtain the selected revision's verified complete
`reader-editing-package-1` descriptor, hash, byte size and `editing.json` URL.
An omitted `revision` selects the current saved revision; the returned URL is
then pinned to that exact revision. The download contains current-for-that-version
authoring, saved document, identities, resources/bindings, base hashes and
round-trip evidence. Explicit historical downloads reproduce the selected saved
revision, never a fallback to older authoring. Unsupported lossless export fails
with `EDITING_EXPORT_UNSUPPORTED` and leaves the document intact.

The download route is
`GET /api/documents/:id/authoring/editing.json?revision=N`. Its short-lived grant
binds that path and query: changing the revision invalidates the grant, and it
does not grant workspace listing or publication. Complete bytes stay outside MCP
text responses. Use the package's `base` to supply the revision target when
validating/creating a preview; publishing still requires the current base and
the exact reviewed preview hash. See [the revision workflow](authoring-format-reference.md#revise-an-existing-article).

## Preview scope

`previewUrl` opens one live draft. Its grant permits read-only access to that
draft and its candidates, including updates published to the same draft during
the remaining lifetime. Candidate ownership is checked by the service on every
request. `snapshotUrl` and `documentUrl` instead grant one immutable candidate;
they cannot follow another candidate or read a live draft.

Within the permitted preview, GET/HEAD can retrieve its document, retained
artifacts and assets, including extensionless `assets-by-hash/<sha256>` byte
reads. Such reads are limited to that revision's resource map; knowing another
blob hash does not grant access. Local Agent tools can still read PDF metadata
and rendered pages, but Cloudflare has no PDF computation routes. The Reader carries the grant
only to these same-origin preview requests. It does not save it in preferences,
draft storage, or formal document data, and does not append it to external links
or normal library URLs. A preview grant cannot list the library, access another
draft, save reading activity, edit insights, or publish a document. Existing
preview runtime isolation still applies.

## Runtime adapters

`file-capabilities.mjs` uses Web Crypto, URL and typed arrays. Both Node and
Cloudflare adapters use `createFileCapabilities`, `createMcpFileAccess` and
`authorizeFileCapability`. An adapter can inject a Web Crypto HMAC key or raw
secret bytes and a clock. Keep this key separate from the full-access bearer
credential; do not return either key to a client. A Cloudflare adapter that
requires links to survive Worker isolates must supply the same protected key
for that workspace. Rotating it revokes existing grants. The adapter must retain
the capability origin, method, expiry and preview-ownership checks and the
no-referrer/no-store response rules.

The stdio adapter uses the upstream service's name/version/instructions and
forwards request cancellation. Cancellation stops the client's wait; it is not
proof that a server-side atomic write was rolled back. For an uncertain write,
retry with the original request ID and payload or inspect the saved result.
