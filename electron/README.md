# Desktop application

The Windows x64 desktop app packages Electron, the local workspace service, the Reader frontend, authoring tools and an isolated Python/PyMuPDF runtime. Installed builds do not require a separate Node.js or Python installation. Reader storage and execution remain local. External Agents connect through MCP; the desktop does not launch or coordinate Agent processes.

## Install and run

Use a Setup or Portable artifact from a published release. The NSIS installer provides normal installation and shortcuts. Portable is a single-file launcher; it still stores persistent data in the user's profile rather than next to the executable.

The default profile is `%USERPROFILE%\.continuous-reader`. Setup and Portable use that same profile and its single-instance protection. An explicit `--reader-user-data=<absolute-directory>` selects a separate profile, including its own workspace. Profiles do not exchange data automatically.

| Profile path | Contents |
| --- | --- |
| `workspace/workspace.sqlite`, WAL and SHM | Documents, insights, plans, requests, metadata, reading activity, receipts and retained historical state |
| `workspace/objects` | Immutable content, authoring and reviewed-preview objects addressed by SHA-256 |
| `workspace/blobs` | Original files and resource bytes addressed by content hash |
| `workspace/pages` | Regenerable PDF page cache |
| `reader-session.json` | Saved desktop session and pending draft snapshots |
| Chromium storage directories | View preferences and browser storage for this profile |
| `desktop-state.json` | Window geometry |
| `connection.json` | Current loopback address, PID and temporary MCP token; removed on normal exit |
| `desktop.log` | Startup, runtime and failure diagnostics |

Do not publish `connection.json`, profiles, tokens or private signing keys. Installation resources and user data are separate; upgrading the application does not place documents in its installation directory.

## Backup and restore

Close the application normally and wait for it to exit, then copy the entire profile directory. Preserve SQLite together with `objects`, `blobs`, session files and browser storage. Copying a live SQLite database without its WAL is not a consistent backup.

To inspect a backup, copy it to a new directory and open that copy with `--reader-user-data=<absolute-directory>`. Keep the original backup until documents, originals, drafts and preferences have been checked. Do not run two restored copies of the same historical replica simultaneously. A future database format may be unreadable by an older application; rollback of application code is not a substitute for a pre-upgrade data backup.

Historical synchronization receipts, outbox entries, tombstones and conflicts remain inspectable locally. Obsolete remote, sync and preview environment settings do not start transfers or switch the active database. The settings page exposes historical conflicts only when there are records to resolve. Local maintenance is also available with `npm run local:history -- status --data-dir=<workspace-directory>`; stop the application before offline maintenance.

## Import an existing development workspace

First import is explicit and only targets a profile without a workspace database. From the repository root after producing an unpacked build:

```powershell
& '.\release\0.1.3\win-unpacked\Continuous Reader.exe' '--reader-user-data=D:\ReaderProfiles\ImportCheck' '--import-workspace=D:\ReaderBackups\workspace'
```

Replace the source and target paths with the intended directories. The importer reads the source through SQLite's online-backup API, includes committed WAL contents, verifies required resource hashes and sizes, then publishes the candidate into the new profile. It does not merge into or overwrite an existing target database. A nonempty target without a database is also rejected.

A source with an existing synchronization replica identity is not eligible for first import. Use its original profile, or restore a complete stopped-profile backup when recovering that same replica. The importer does not rewrite identities or discard historical queues. Browser-only local/session storage is separate from the database and is not imported; save pending work in the original browser first.

## Development

Install dependencies as described in the root [README](../README.md). From the repository root:

```powershell
npm run desktop:dev -- --reader-user-data=D:\ReaderProfiles\Development
```

Use a dedicated profile for development and testing. Omitting the argument opens the default profile, which may contain personal data. The launcher does not force-close an existing application using the same profile.

Development mode opens a native Electron window and serves current source through a loopback Vite process while retaining the `reader://app` origin. The first run prepares the isolated PDF runtime if it is missing. Frontend changes use hot updates; changes requiring a full reload retain the existing draft/position save behavior. Main-process, preload and workspace-service edits request a save before restarting the owned process. Save failures remain visible and require the existing continue/restart choice.

File watching compares content hashes and coalesces bursts. Reading a file or saving identical content does not trigger a backend restart. Normal window close or Ctrl+C requests the save/close sequence and stops the owned watchers. These protections do not guarantee recovery from failed disk writes or forced process termination.

`npm run desktop:preview` opens the most recently prepared static runtime. It does not hot-reload current source. `npm run dev` remains the connected browser-only development entry.

## Synthetic motion demo

```powershell
npm run desktop:demo
```

The demo creates or verifies a separate `.audit/continuous-motion/demo-profile` and opens it in development mode. It includes bundled paper resources plus clearly simulated documents, insights, requests, plans and activity. Those activity records are not personal reading history or research results. The generated `demo-manifest.json` records the initial dataset, and `node scripts/seed-motion-demo.mjs --verify` checks an existing completed demo without resetting subsequent edits. Close the demo before verification or re-running its launcher.

The seed tool refuses unknown data, conflicting locks and unsupported target paths. It does not import the default profile. The [motion specification](../spec/连续动效系统.md) describes the interaction requirements.

## Build Windows x64 artifacts

The build host requires Node.js 24 or newer, npm dependencies and a Python interpreter. Build-time Python defaults to `python` on Windows (`python3` on other platforms for reusable helper tests); `CONTINUOUS_READER_BUILD_PYTHON` can select an executable explicitly. The desktop preparation and packaging target itself is Windows x64.

```powershell
npm ci
npm run setup
npm test
npm run test:desktop
npm run desktop:prepare
npm run desktop:preview -- --reader-user-data=D:\ReaderProfiles\PackageCheck
npm run desktop:unpacked
npm run desktop:pack
```

`desktop:prepare` builds into an owned staging directory under `.desktop`, copies active services and authoring resources, installs dependencies from `runtime-package-lock.json`, and prepares the pinned isolated Python runtime. Python archives and wheels are hash checked; installed runtime files have a checked inventory. The shipped application never downloads Python or falls back to the build host's interpreter.

`--reuse` may reuse matching dependency and Python payloads while rebuilding application source. Validation precedes replacement of `.desktop/runtime`; ordinary preparation errors preserve the old runtime. A forced termination between directory renames is not an atomic power-loss transaction.

`desktop:unpacked` produces `release/<version>/win-unpacked/Continuous Reader.exe`. `desktop:pack` produces Setup and Portable artifacts according to [electron-builder.yml](../electron-builder.yml). Version 0.1.3 uses:

- `Continuous-Reader-0.1.3-Setup-x64.exe`
- `Continuous-Reader-0.1.3-Portable-x64.exe`

These are output names, not a claim that a local build has been installed or accepted. The package verifier checks the actual runtime contents, required licenses, PDF assets and foundation metadata. Personal workspaces and local verification evidence are excluded from release payloads.

## Signed incremental updates

Version 0.1.3 introduces application updates through GitHub Releases. Settings → 更新 checks the release metadata, downloads the signed application payload, and offers a restart after staging. Routine updates reuse a compatible installed Electron/dependency/Python foundation. A changed foundation requires the matching full installer.

The update signature authenticates the application's update manifest and payload. It is separate from Windows executable code signing. Signing-key setup, compatibility rules, release assets, rollback boundaries and CI are documented in [UPDATES.md](UPDATES.md) and the [release guide](../docs/RELEASING.md).

## MCP connection

Open the desktop application first, then configure an MCP client to run the installed executable with `--mcp`. For an installation at `C:\Apps\Continuous Reader`:

```json
{
  "mcpServers": {
    "continuous-reader": {
      "command": "C:\\Apps\\Continuous Reader\\Continuous Reader.exe",
      "args": ["--mcp"]
    }
  }
}
```

Use the actual installed path. For a separate profile, append the same `--reader-user-data=<absolute-directory>` argument to the MCP client command. No fixed port or manually copied token is required.

The stdio process validates the running desktop's connection information and forwards to its local workspace. It does not open a second window or backend. Closing or restarting the main application ends the connection; reopen it and reconnect the client. Diagnostics use stderr and stdout is reserved for MCP. The current [32-tool contract](../services/workspace/mcp-management.md) is shared with the local HTTP service.

## Troubleshooting and acceptance

Inspect the relevant `desktop.log` entries when startup fails. Preserve pending content if save confirmation fails. Share minimal redacted diagnostics rather than a profile or connection file.

Automated tests, local HTTP/PDF checks, browser inspection, development Electron behavior and final installed-package behavior are separate evidence. Release acceptance should exercise fresh installation, original PDF access, saving and reopening, failure/exit handling, executable MCP, update/restart and preservation of an isolated existing profile. An archived screenshot or a successful build does not establish those outcomes.
