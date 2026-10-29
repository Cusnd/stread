# GitHub 增量更新

桌面程序从 `Cusnd/stread` 的最新正式 GitHub Release 检查更新。更新下载和校验完成后，由用户选择重启；原有保存流程结束后才切换版本。软件更新服务只读取公开 Release，不上传资料、批注或本机连接令牌。

首次需要发布并安装一次包含更新引导程序的完整版本。此前的安装包没有更新入口，无法自行获得这个功能。以后日常修改前端、桌面入口、本地工作台服务或 authoring 资源，只需生成应用更新包。增量包包含相对上一正式版本变化的文件；跳过多个版本的用户下载完整的应用层包。两种包都不包含 Electron、Python 或不变的 Node 依赖。

## 用户操作

在桌面设置中检查更新，下载后重启。浏览器模式不显示桌面更新入口。需要更新底层运行时的版本会提供 GitHub Release 链接，安装新的完整版本后继续使用原资料目录。网络不可用或 GitHub 限流只影响检查更新，不影响本地阅读和 MCP。

更新副本与状态保存在所选 profile 的 `updates` 目录，资料仍在原来的 `workspace`。Portable 使用同一 profile 规则，不把更新写进它每次启动的临时解压目录。程序保留上一可用版本；新版本在后端启动和页面加载完成前失败，下次主窗口启动会恢复旧程序。程序回退不会回退数据库，因此应用层更新必须保持旧版可读的数据格式。

## 发布者：首次准备

仓库中的 `electron/update-public-key.pem` 是客户端信任的 Ed25519 公钥。私钥保存在本机构建目录 `.desktop/update-signing-private.pem`，这个目录已被 Git 忽略。不要将私钥提交、上传到 Release、写进日志或发送给用户。将它备份到受控位置，再保存为仓库 Actions secret `READER_UPDATE_PRIVATE_KEY_PEM`。GitHub secret 的值是完整 PEM 内容。

新 fork 在发布其首个完整版本之前，可以移除继承的公钥并运行 `node electron/update-keygen.mjs` 创建自己的密钥，同时修改 `electron/update-config.cjs` 的仓库配置。密钥脚本遇到已有公钥或私钥会拒绝覆盖。已发布后的密钥轮换需要一个新的完整基础版本；不要直接替换公钥继续发布旧基础版本的增量包。

源码贡献者没有私钥也可以运行 `npm run desktop:pack` 或 `npm run desktop:unpacked`：这些命令只写基础版本清单。向正式客户端发布应用更新必须持有与内置公钥匹配的私钥。

## 日常发布

1. 修改代码并运行相关测试，将根 `package.json` 和 `package-lock.json` 的版本递增到新的稳定 `x.y.z`。已发布的版本不可重复使用。
2. 在 GitHub Actions 运行 **Desktop release**，选择 `app`。工作流取上一正式 Release 的已签名清单，构建前端和服务资源，生成全应用层包与差分包，不调用 electron-builder。
3. 下载工作流产物，在独立 profile 中验证升级、原页和 MCP。复核自动生成的草稿 Release 内容，然后手动发布。草稿和 prerelease 不会送达普通用户。

第一次发布更新功能，或 Electron、Python、生产依赖、更新引导程序、公钥、数据库 schema 等基础文件变化时，选择 `full`。这个模式同时生成签名应用包、NSIS 安装器和 Portable。应用模式检测到基础指纹不一致会停止，要求完整发布，不会生成表面可用但运行环境不兼容的增量版本。工作流只能刷新属于同一提交的草稿，不覆盖已经发布的版本。

日常更新的本地等价命令如下，清单应来自上一**已发布**版本：

```powershell
npm run desktop:update:build -- --base C:\Releases\reader-update-win32-x64.json --require-compatible-base
```

输出位于 `release/<版本>/updates/`，包含：

- `reader-update-win32-x64.json`：版本、对应完整安装器版本 `installerVersion`、兼容指纹、文件哈希、下载包哈希与 Ed25519 签名。
- `Continuous-Reader-<版本>-win32-x64-<内容ID>.crupdate`：完整应用层包，供首次增量更新、跨版本升级或差分基线不匹配时使用。
- `...-from-<旧内容ID>.crupdate`：上一版本到当前版本的差分包，提供 `--base` 且底层环境一致时生成。

将同一构建的清单及所有 `.crupdate` 文件一起上传到 `v<版本>` 正式 Release。仅上传差分包会使跨版本用户无法升级。完整安装器不需要随每次应用更新重新生成；草稿说明会链接清单指定的完整基础版本，新用户安装后可以下载最新应用层包。旧基础版本的客户端也会被引导到这个带有安装器的 Release，而不是只有应用增量文件的最新 Release。

无 `--base` 的签名构建默认拒绝运行，防止把只有应用包的版本误称为完整安装器版本。首次发布或底层变化时，显式生成完整基础版本，并同时制作完整安装器：

```powershell
npm run desktop:update:build -- --full-foundation
npm run desktop:pack
```

这两步必须使用同一份源码和同一组运行时依赖，发布时一起提供签名清单、所有 `.crupdate`、Setup 与 Portable。日常应用更新不运行 `desktop:pack`，而是传入上一正式清单以继承正确的安装器版本。

`desktop:prepare --reuse` 复用经过锁文件与文件检查的基础依赖，仍会重新构建当前前端和服务资源。生产依赖锁文件是 `electron/runtime-package-lock.json`；变更依赖时按构建脚本的 `--refresh-lock` 流程更新它，并发布新的完整基础版本。基础指纹覆盖实际依赖文件和 Python 文件，不仅比较包版本号。更新引导源码和 schema 源码的指纹统一换行符，避免 Git 在不同机器上检出 LF/CRLF 造成无意义的不兼容；实际传输和安装文件仍按原始字节校验。

Python 的 `runtime-only-v2` 构建直接解压已经过 SHA-256 校验的原始 PyMuPDF wheel，保留模块、原始包元数据与许可证，避免 pip 把构建机的绝对路径写进安装来源或命令启动器。旧 `runtime-only-v1` 缓存会重建，使本地与 GitHub Actions 的相同基础版本具有一致文件指纹。

`workspace-schema.mjs` 与 `sync-schema.mjs` 的变更会强制完整基础版本。其他文件如果改变数据表示或写入旧版不能读取的内容，维护者仍须显式采用完整版本、备份与迁移流程；文件指纹不能替代对数据兼容性的评审。更换公钥时，上一版清单将不再通过新公钥校验，应在本地完整构建中不传 `--base` 并独立验证新基础版本；工作流的 `full` 模式本来就不使用旧签名生成差分包。

## 验证与限制

客户端先验证公钥签名，再验证压缩包与每个文件的 SHA-256；拒绝越界路径、符号链接、重复或大小写冲突路径、私有资料以及超限包。下载内容在独立目录完整构建后才允许启用，安装资源和用户数据库不参与文件覆盖。底层依赖从已安装基础版本复制到本机更新副本，因此下载量小，但仍需本地磁盘空间。

更新协议 v1 支持 Windows x64、稳定 `x.y.z` 版本及固定 GitHub 仓库。它不提供无网络升级、任意更新源、自动数据迁移回退或 Windows EXE 代码签名。Ed25519 签名证明更新来自持有发布私钥的维护者；SHA-256 负责内容一致性。GitHub secret 配置、实际 Release 发布和不同用户电脑的真实升级验证分别需要完成，不能由本地单元测试代替。
