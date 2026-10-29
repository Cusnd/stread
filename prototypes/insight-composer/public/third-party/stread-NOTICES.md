# Third-party notices and source

Copyright (c) 2026 stread contributors. Project-original code is licensed under **GNU AGPL version 3 only**, as provided in [LICENSE](https://github.com/Cusnd/stread/blob/v0.1.3/LICENSE). This does not change the licenses or ownership of third-party software, fonts, documents, figures, or other content.

## Software

The lockfiles record the exact JavaScript dependency versions. Installed dependency directories retain their upstream license files. The packaged application's `runtime/client/third-party/` directory includes the project license and generated JavaScript license notices. Python and PyMuPDF retain their license material inside `runtime/python`; Electron retains its `LICENSE` and Chromium license notices in the application distribution.

| Component | Release version / source | License information |
| --- | --- | --- |
| Electron | [v45.0.0 source](https://github.com/electron/electron/tree/v45.0.0) | MIT; Chromium and other embedded components retain their individual notices |
| CPython embedded runtime | [3.13.17 source](https://www.python.org/ftp/python/3.13.17/Python-3.13.17.tgz) | Python Software Foundation license and included third-party notices |
| PyMuPDF | [1.27.2.2 source distribution](https://files.pythonhosted.org/packages/f1/32/f6b645c51d79a188a4844140c5dabca7b487ad56c4be69c4bc782d0d11a9/pymupdf-1.27.2.2.tar.gz) | AGPL-3.0; commercial licensing is separately offered by the upstream publisher |
| MuPDF within PyMuPDF | Source and build retrieval are supplied by the pinned PyMuPDF source distribution | AGPL-3.0; see upstream source and bundled notices |
| PDF.js | Version pinned in the frontend lockfile; [source](https://github.com/mozilla/pdf.js) | Apache-2.0 and bundled resource licenses |
| React, KaTeX, CodeMirror, markdown-it, Motion, icon libraries and other JavaScript dependencies | Versions in the package lockfiles | Individual package licenses in generated notices and upstream packages |

The precise downloaded Python and PyMuPDF artifact URLs and SHA-256 hashes are pinned in [`electron/prepare-python.mjs`](https://github.com/Cusnd/stread/blob/v0.1.3/electron/prepare-python.mjs). Runtime dependency versions are locked in [`electron/runtime-package-lock.json`](https://github.com/Cusnd/stread/blob/v0.1.3/electron/runtime-package-lock.json). Build scripts and configuration are included in this repository; release tags identify the corresponding project source. For the bundled PyMuPDF/MuPDF source, download the **source distribution**, not just the binary wheel, from the pinned release above. Its build scripts identify and retrieve the matching MuPDF source.

Run `npm run licenses` after installing dependencies to regenerate the bundled JavaScript notices. Do not remove or rewrite upstream notices when updating a dependency. The notice inventory can include build-time packages and packages removed by tree shaking; inclusion is conservative, not a claim that every package executes in the desktop runtime.

The pinned PyMuPDF source distribution is 85,354,380 bytes; SHA-256: `ea8fdc3ab6671ca98f629d5ec3032d662c8cf1796b146996b7ad306ac7ed3335`. This is the source archive hash, separate from the runtime wheel hash.

## Example documents

The repository contains scholarly example documents and test fixtures (including Attention Is All You Need, MapReduce, ResNet and CRISPR examples). Their authors and publishers retain the rights to the original text and figures. Project licensing applies to the Reader implementation, not a new license grant for those papers. Original titles, authors and source references are retained with the examples; contributors must check redistribution rights before adding or replacing content. Prefer synthetic material for new regression fixtures and screenshots.

Reports about incorrect attribution or content rights may be filed through the repository's [Issues](https://github.com/Cusnd/stread/issues). Avoid including private source documents in public reports.
