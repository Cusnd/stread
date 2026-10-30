# 维护与发布

Stread 的正式源码与更新源是 [Cusnd/stread](https://github.com/Cusnd/stread)。桌面应用与新构建产物统一使用 **Stread** 名称，继续沿用现有应用标识和本地资料目录。当前发布目标是 Windows x64，版本来自根 `package.json`，GitHub Release 标签采用 `v<版本>`。

日常应用更新使用签名增量包，无需重新制作安装器。首次安装更新功能，或底层运行环境变化时，才发布完整安装器。本指南面向维护者；用户安装说明见 [快速开始](GETTING_STARTED.md)，更新协议细节见 [桌面增量更新说明](../electron/UPDATES.md)。

Stread 更名涉及引导程序和安装器中的名称，首次发布更名版本应使用新的版本号和 `full` 模式。已发布的 0.1.3 附件保留原名，不覆盖旧 Release；完成新安装后，使用实际的 `Stread.exe` 路径更新外部 MCP 客户端配置。

## 选择发布方式

| 模式 | 适用修改 | 输出 | 用户如何获得 |
| --- | --- | --- | --- |
| `app` | 前端、桌面入口、本地工作台服务、authoring 资源等应用层修改，且基础指纹一致 | 签名清单、完整应用层包、相对上一正式版本的差分包 | 设置中检查、下载并重启 |
| `full` | 首次发布，或 Electron、Python、生产依赖、更新引导程序、公钥、图标、数据库 schema 等基础文件变化 | 签名清单、完整应用层包、NSIS Setup、Portable | 安装新的完整基础版本 |

完整应用层包不包含 Electron、Python 或 `node_modules`。它供跨版本升级、或无法使用上一版本差分的用户下载。差分包只包含变化的应用文件；新版本的完整文件清单同时决定删除哪些旧资源。完整安装器仍需保留在对应 Release，供新用户和旧基础版本用户下载。

`installerVersion` 是签名清单中指向完整安装器版本的字段。应用更新继承它，完整发布将其设为当前版本。不要把只有 `.crupdate` 的 Release 当作首次安装入口，也不要删除仍被后续清单引用的完整安装器。

## 版本、源码与密钥

发布前完成代码评审、测试和 [CHANGELOG](../CHANGELOG.md)，再冻结同一份源码。使用稳定的 `x.y.z` 版本，不使用 prerelease 或 build 后缀：

```powershell
npm version 0.1.4 --no-git-tag-version
git diff -- package.json package-lock.json CHANGELOG.md
```

这个命令中的版本是示例，请替换为下一个未发布版本。根 `package.json` 与 `package-lock.json` 必须一致；桌面版本与 workspace/MCP 协议版本是独立概念，不要为桌面发布无理由地修改所有子包版本。

提交并推送经过复核的源码后，针对该提交运行发布工作流。生成产物期间不要更改源码、锁文件、公钥或已准备的运行时。标签、签名清单、完整安装器和应用包必须来自同一冻结提交。工作流会拒绝已经发布的版本、指向其他提交的同名标签，以及属于其他提交的同名草稿。

主仓库已配置 Actions secret `READER_UPDATE_PRIVATE_KEY_PEM`。它必须与仓库中的 `electron/update-public-key.pem` 匹配；签名步骤会验证这件事。日常发布无需在工作流中输出、重新生成或手工复制密钥。维护者需要自行保管离线备份，GitHub secret 不能导出原文。

PR 的 **CI** 工作流没有签名密钥，没有 Release 写权限，也不会创建发布产物。它执行 Windows 构建、现有测试和无需私钥的基础清单验证。**Desktop release** 只通过维护者手工触发，签名 secret 只在签名步骤提供。

## 使用 GitHub Actions 发布

1. 打开 [Desktop release 工作流](https://github.com/Cusnd/stread/actions/workflows/desktop-release.yml)，选择已经复核的分支或标签。
2. 选择 `app` 或 `full` 并运行。首次发布更新功能必须选择 `full`。
3. 等待锁定依赖安装、运行时准备、前端构建、桌面与服务测试、签名构建全部完成。
4. 从本次运行下载产物，进行下文的原生复核。检查草稿 Release 的版本、提交、说明和附件。
5. 确认无遗漏后，将草稿发布为正式 Release。客户端只读取最新的正式发布，不读取草稿或 prerelease。

工作流不会自动将草稿公开。`electron-builder` 使用 `--publish never`，附件仅由工作流最后的 GitHub CLI 步骤上传。相同提交的草稿可以重新运行并更新；已经公开的版本必须通过新版本修复，不覆盖旧附件、不移动旧标签。

`app` 模式会下载上一正式版本的已签名清单，验证签名与基础指纹，并生成差分。基础不兼容时工作流停止，应改用 `full`。完整模式不依赖旧签名，因此也适用于经过计划的公钥轮换。

## 本机构建等价流程

在 Windows x64 的仓库根目录运行。需要 Node.js 24 或更新的兼容版本，以及 Python 3.13；Python 只用于构建时解压已校验的归档，不要求 pip。项目依赖按锁文件安装：

```powershell
npm ci
npm run setup
$env:CONTINUOUS_READER_BUILD_PYTHON = (Get-Command python).Source
npm run desktop:prepare
$env:CONTINUOUS_READER_PYTHON = (Resolve-Path .desktop/runtime/python/python.exe).Path
npm run test:desktop
npm run build
npm test
```

每个命令都应成功后再继续。先构建前端，是因为完整测试包括对生成的静态产物的检查。PDF 测试显式使用已经准备的内置 Python，避免依赖构建者的私人 Python 环境。

本地签名可从受控环境变量 `READER_UPDATE_PRIVATE_KEY_PEM` 读取私钥，也可使用被 Git 忽略的 `.desktop/update-signing-private.pem`。不要把它写进脚本、命令行参数、日志、Issue 或 Release 附件。一般贡献者不需要私钥，可以使用 `desktop:unpacked` 或 `desktop:pack` 验证自己的完整构建。

日常应用更新使用从上一正式 Release 下载的清单：

```powershell
npm run desktop:update:build -- --base ./previous/reader-update-win32-x64.json --require-compatible-base
```

`desktop:update:build` 重新生成当前应用源码，并复用兼容的锁定依赖。它不运行 electron-builder。若没有上一版清单，签名构建不会默认为普通更新。

首次或底层变化时，在完成上面的准备和测试后，直接使用同一份准备结果生成应用包与完整安装器：

```powershell
node electron/build-update.mjs --full-foundation
npx --no-install electron-builder --win --x64 --publish never
```

发布目录是 `release/<版本>/`。需要上传的附件如下：

| 附件 | `app` | `full` |
| --- | --- | --- |
| `updates/reader-update-win32-x64.json` | 必须 | 必须 |
| 清单中 `payload.name` 对应的完整 `.crupdate` | 必须 | 必须 |
| 清单中 `delta.name` 对应的差分 `.crupdate` | 有该字段时必须 | 通常不生成 |
| `Stread-<版本>-Setup-x64.exe` | 不生成 | 必须 |
| `Stread-<版本>-Portable-x64.exe` | 不生成 | 必须 |
| `updates/SHA256SUMS.txt` | 必须 | 必须 |

工作流在构建完成后生成 `SHA256SUMS.txt`，按附件文件名排序，记录签名清单、全部 `.crupdate` 和完整模式下的 `.exe` 的 SHA-256，不包含校验文件自身。每行格式为 `哈希值  文件名`，文件名与 Release 附件一致。本地手工发布也应对最终附件生成同样格式的校验文件。

只上传这一构建的校验文件、清单和它引用的文件。`latest.yml` 是打包工具可能生成的其他更新格式，本项目的应用更新客户端不读取它。不要上传 `.desktop`、`win-unpacked`、用户 profile、连接令牌或签名私钥。

## 基础指纹与可重复构建

基础指纹覆盖 Electron 版本、平台与架构，以及以下内容：

- 实际 Node 生产依赖文件、Python/PyMuPDF 文件及 `electron/runtime-package-lock.json`。
- `bootstrap.cjs`、`update-core.cjs`、`update-config.cjs`、更新公钥和桌面图标。
- `workspace-schema.mjs` 与 `sync-schema.mjs`。

稳定引导源码、锁文件和 schema 的指纹统一 LF/CRLF 换行；实际下载、复制和执行的文件仍按原始字节校验。Python `runtime-only-v2` 直接解压经过哈希校验的原始 wheel，避免把构建机绝对路径写入程序文件。

修改生产依赖声明后，运行并提交新的运行时锁文件：

```powershell
npm run desktop:runtime:lock
```

这个命令会重新准备运行时，随后应选择完整发布。不要手改签名清单中的 `foundation`，也不要删除检查来强行制作兼容更新。如果源码看似没有基础变化却出现指纹差异，应先对比依赖/Python 清单和构建环境。

schema 文件检查不能识别所有数据格式变化。若其他代码开始写入旧版不能读取的数据，同样需要维护者安排完整版本、备份与迁移。程序回退不等于数据回退。

## 发布前后的验证

自动测试通过只证明所执行的检查成功。每次发布仍应使用独立 profile 测试实际桌面程序，避免用个人资料库承担试用：

```powershell
$profile = Join-Path $env:TEMP 'stread-release-review'
& './release/0.1.4/win-unpacked/Stread.exe' "--reader-user-data=$profile"
```

路径中的版本要替换为本次版本。这个 profile 会保留试用数据；不要把它加入源码或 Release。

| 验证项 | 应记录的结果 |
| --- | --- |
| 新装或 Portable 启动 | Collection、设置、原页 PDF 和重开后的持久化能正常使用 |
| MCP | 由实际安装程序的 `--mcp` 入口连接正在运行的同一 profile，目录仍为约定的 32 工具 |
| 上一兼容版本更新 | 选择差分包，下载完成后经正常保存流程重启，阅读位置和草稿保留 |
| 跳过版本更新 | 选择完整应用层包，不要求用户先装每个中间版本 |
| 首次启动失败 | 保留可用旧程序；确认没有把程序回退误记为数据库回退 |
| 网络/下载失败 | 旧版继续可用；未校验完成的内容不能被启用 |
| 新基础版本 | 旧基础客户端打开实际含 Setup/Portable 的 `installerVersion` Release |

草稿未公开时，普通客户端无法从正式更新源获取它。预发布验证可使用隔离测试中的固定响应；发布后必须另行验证公开网络路径，不能把模拟响应测试称为线上更新验证。

正式发布后，使用不带登录令牌的请求检查 `https://api.github.com/repos/Cusnd/stread/releases/latest`，确认标签、发布状态和附件。下载公开清单，使用最终安装器内的公钥验证签名，再核对它引用的 `.crupdate` 哈希。检查安装器链接是否能被未登录用户访问。当前版本客户端应正常显示已是最新；实际升级行为需要较旧的兼容基础版本，旧的无引导程序版本不能用这个功能自动升级。

用户或复核者下载附件后，可用 PowerShell 计算哈希，并与同一 Release 的 `SHA256SUMS.txt` 对应行比较：

```powershell
Get-FileHash -LiteralPath './Stread-0.1.4-Setup-x64.exe' -Algorithm SHA256
```

替换为实际下载的文件名；哈希大小写不影响比较。校验文件用于发现下载损坏，来源仍取决于所信任的 Release 页面。应用内更新另行验证内置公钥对应的 Ed25519 签名和文件哈希，不能用一个可随附件一起替换的校验文件代替签名验证。

在 Release 说明中分别记录自动测试、原生安装/Portable、MCP、线上下载、实际升级和用户验收。没有执行的项目明确写未验证，不以本机构建代替所有用户电脑的验证。

## 故障处理与密钥轮换

下载、签名或文件校验失败时，保留当前安装与资料库，先检查公开附件是否完整、签名是否与内置公钥一致、网络是否返回 GitHub 限流。更新副本位于 profile 的 `updates`；正常资料位于 `workspace`。不要通过删除整个 profile 排查更新问题。

新应用版本首次启动失败时，引导程序保留上一可用程序。若需要维护者协助，先正常关闭主程序和对应 MCP 客户端，备份整个 profile，再在副本上检查 `desktop.log` 与更新状态。日志可能涉及私人路径；不要公开 `connection.json`、完整资料库或原文文件。严重回归应发布版本号更高的修复版本，不复用旧版本号或覆盖旧签名包。

更换签名密钥需要新的完整安装器。旧客户端只信任已经内置的公钥，不能验证由新密钥签名的清单，因此不能假设旧版更新界面会自动引导用户完成换钥。通过项目 README 与 Release 说明提供明确的完整下载安装路径，并保留对旧版用户的说明。

对新的 fork，先配置自己的 `update-config.cjs` 更新仓库、自己的公钥和 Actions secret，再发布第一个完整基础版本。`desktop:update:keygen` 遇到现有密钥会拒绝覆盖；不要在日常发布时重新生成密钥。丢失私钥时应按换钥处理，不尝试伪造原签名。

发布遵循仓库 [LICENSE](../LICENSE) 与 [第三方说明](../THIRD_PARTY_NOTICES.md)。更新签名用于验证维护者身份和文件内容，不是 Windows Authenticode 代码签名；当前构建没有 Windows 代码签名配置。
