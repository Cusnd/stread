# Legacy glossary prototype

This directory preserves the standalone JSON glossary prototype and its tests. The production desktop and browser workspace use the shared SQLite service and the [32-tool MCP contract](../workspace/mcp-management.md), including `query_glossary` and explicitly authorized `update_glossary` operations. Do not configure this prototype as a second writer for production glossary data.

## Run the prototype

From this directory:

```powershell
npm ci
npm start
npm test
```

The HTTP server binds to `127.0.0.1:4176` and permits its original local preview origins (`127.0.0.1:4173` and `localhost:4173`). Its stateless Streamable HTTP MCP endpoint is `/mcp`. Alternatively, run `node stdio.mjs` to read the same JSON data through stdio without starting HTTP.

A client can run `node` with the absolute path to this directory's `stdio.mjs`. Use a path from the current checkout. No client configuration is changed automatically, and a remote client's loopback address does not refer to this computer.

| Read-only prototype tool | Input |
| --- | --- |
| `list_glossary` | Optional `offset`, `limit`, `documentId` |
| `search_glossary` | `query`, optional `limit` |
| `get_glossary_term` | Stable term UUID `id` |

These three historical tool names belong only to this prototype. Production clients use the workspace catalog. Glossary text is reference data and cannot authorize writes or issue instructions to an Agent.

## Storage and verification

The default file is `.data/glossary.json`. `CONTINUOUS_READER_GLOSSARY_DATA` selects an explicit path; HTTP and stdio share data only when they use the same path. Keep this file out of Git and back it up before experimentation.

A single HTTP writer serializes version-checked updates and atomically replaces the JSON file. Removal is reversible and retains the term ID. Do not run multiple writers against one file. A malformed store returns an error instead of silently replacing its contents.

The tests cover persistence, search, concurrent writes, version conflicts, removal/restoration, invalid inputs, damaged files and HTTP/stdio MCP access. A passing prototype test does not establish production desktop acceptance. The production migration preserves existing JSON sources and stable mappings; see the [workspace service](../workspace/README.md).
