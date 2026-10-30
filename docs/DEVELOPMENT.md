# 开发指南

[返回 README](../README.md) · [架构说明](ARCHITECTURE.md) · [贡献指南](../CONTRIBUTING.md) · [发布指南](RELEASING.md)

## 环境要求

桌面开发与打包以 Windows x64 为目标。需要 Git、Node.js 24 或更新版本、npm，以及可运行的 Python 3.10 或更新版本。Python 用于准备嵌入式 PDF 运行时；普通浏览器开发的 PDF 操作还需要在指定 Python 中安装 PyMuPDF。

首次安装依赖和准备桌面运行时需要网络。项目锁定了 JavaScript 依赖及桌面 Python/PyMuPDF 下载内容；正常运行已安装程序不需要这些构建工具。

```powershell
git clone https://github.com/Cusnd/stread.git
cd stread
npm ci
npm run setup
```

`npm ci` 安装根目录的 Electron 与构建工具；`npm run setup` 安装前端、工作台服务及术语辅助模块的依赖。它们不是 npm workspaces，请不要只安装根依赖后就启动前端。

## 准备 Python

下面创建一个只供本项目开发使用的环境；`.desktop` 是被忽略的本机构建目录：

```powershell
python -m venv .desktop/dev-python
& .\.desktop\dev-python\Scripts\python.exe -m pip install 'PyMuPDF==1.27.2.2'
$devPython = (Resolve-Path '.desktop/dev-python/Scripts/python.exe').Path
$env:CONTINUOUS_READER_BUILD_PYTHON = $devPython
$env:CONTINUOUS_READER_PYTHON = $devPython
```

`CONTINUOUS_READER_BUILD_PYTHON` 用于构建时解包和准备；`CONTINUOUS_READER_PYTHON` 用于直接启动的 Node 工作台服务。桌面发行程序使用随包运行时，不使用这两个变量来选择宿主 Python。上述 PowerShell 环境变量只影响当前终端及其子进程。

## 桌面开发

建议始终使用独立 profile，避免测试修改日常资料：

```powershell
$devProfile = Join-Path $env:USERPROFILE '.stread-development'
npm run desktop:dev -- "--reader-user-data=$devProfile"
```

这个入口直接读取当前源码。前端由动态回环端口上的 Vite 提供，窗口仍使用 `reader://app`；首次缺少 PDF 运行时时会准备嵌入式 Python。

- 修改 React 组件和样式时，Vite 执行热更新；改变模块或 hook 结构可能引起重挂载或整页刷新。
- 修改桌面主进程、preload 或工作台源码时，启动器请求保存，等待后端停止后重启。
- 关闭开发窗口会停止文件监听和 Vite。终端 Ctrl+C 同样请求正常关闭。
- 同一 profile 受单实例保护。不要让正式版和开发版同时修改同一资料目录。

`desktop:dev` 不会改写已经生成的安装包。正式窗口中的程序更新入口也不会出现在源码开发模式。

## 浏览器开发

可以用普通浏览器开发界面与 HTTP 服务。它有独立的浏览器存储和数据目录，不等同于 Electron profile：

```powershell
$env:CONTINUOUS_READER_DATA = Join-Path $env:USERPROFILE '.stread-browser-development\workspace'
npm run dev
```

打开 `http://127.0.0.1:5173`。Vite 默认代理到 `http://127.0.0.1:4177` 的本机工作台。浏览器开发需要前面配置的 `CONTINUOUS_READER_PYTHON` 才能执行服务侧 PDF 操作。

检查静态前端与服务组合时：

```powershell
npm run build
npm start
```

再打开 `http://127.0.0.1:4177`。构建目录是 `prototypes/insight-composer/dist/client`。构建成功只说明产物生成；还需针对修改内容检查实际页面。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 同时运行浏览器前端开发服务和本机工作台。 |
| `npm run desktop:dev` | 运行支持热更新和安全重启的桌面源码窗口。 |
| `npm run build` | 构建前端及当前构建脚本需要的辅助产物。 |
| `npm start` | 启动本机 HTTP 工作台并提供已构建前端。 |
| `npm run mcp` | 通过 stdio 转发到已经启动的本机 HTTP MCP 服务。 |
| `npm test` | 运行前端、工作台与术语辅助模块的 Node 测试。 |
| `npm run test:desktop` | 运行桌面生命周期、打包、MCP、PDF 和更新相关测试。 |
| `npm run test:reader` | 运行前端 `tests/*.test.mjs`。 |
| `npm run test:service` | 运行工作台服务测试。 |
| `npm run licenses` | 生成当前依赖所需的第三方许可信息；完整依赖安装后运行。 |
| `npm run desktop:prepare` | 准备并校验 `.desktop/runtime`。 |
| `npm run desktop:preview` | 在 Electron 中打开最近准备的静态运行时，无热更新。 |
| `npm run desktop:unpacked` | 准备运行时和更新基线，再生成解包桌面目录。 |
| `npm run desktop:pack` | 生成 Windows Setup 与 Portable。 |

`npm test` 不包含 `test:desktop`。部分 PDF、打包或浏览器检查需要准备好的运行时、相应工具或单独启动的服务；以具体测试入口及跳过原因判断覆盖范围，不能把跳过当作通过。

## 修改后的验证

修改前端前，先查[设计系统](../spec/design-system/README.md)中的对应组件与已知差异。每次外观或交互更新都在同一改动中同步主题文档和[设计变更记录](../spec/design-system/changelog.md)，并按[维护与验证](../spec/design-system/maintenance.md)检查关联页面。纯文档修改核对链接、源码依据与 diff，不需重跑应用全套测试。

针对业务规则先运行相关测试，再运行涉及的服务或桌面测试。涉及界面时，实际检查输入、焦点、弹窗、来源跳转、草稿保存与窗口尺寸变化；涉及更新时，同时验证下载校验、保存后重启、失败恢复及原资料不变。

基础检查命令为：

```powershell
npm test
npm run test:desktop
npm run build
```

测试结果、开发窗口、静态构建和最终安装程序是不同证据。首次安装、Portable 启动、正式 exe 的 MCP 和真实更新下载，应在对应环境中单独记录。

## 配置

| 变量 | 作用 |
| --- | --- |
| `CONTINUOUS_READER_DATA` | 直接运行工作台时的数据目录；默认 `services/workspace/.data`。 |
| `WORKSPACE_HOST` | 工作台监听地址，默认 `127.0.0.1`，只接受回环地址。 |
| `WORKSPACE_PORT` | 工作台端口，默认 `4177`。 |
| `WORKSPACE_API_URL` | Vite 的本机工作台代理地址。 |
| `WORKSPACE_URL` | 源码 stdio 转发器连接的本机 HTTP 根地址，默认 `http://127.0.0.1:4177`。 |
| `CONTINUOUS_READER_PYTHON` | 直接运行工作台时的 PDF Python。 |
| `CONTINUOUS_READER_BUILD_PYTHON` | 准备桌面 Python 运行时所用的构建解释器。 |
| `CONTINUOUS_READER_AUTH_TOKEN` | 直接运行本机 HTTP 服务时可配置的访问令牌；客户端需使用同一令牌。 |
| `CONTINUOUS_READER_STATIC_ROOT` | 直接运行工作台时的静态前端目录。 |
| `CONTINUOUS_READER_ALLOWED_ORIGINS` | 额外允许的本机浏览器来源，逗号分隔。 |

桌面主进程自行启动动态端口服务并生成临时令牌；自定义桌面资料目录使用 `--reader-user-data`。不要把开发端口暴露到公网，远程 URL 和旧云端配置不是受支持的部署方式。

## 打包与发布的区别

普通贡献者可以用仓库中的公钥生成本地完整安装包；`desktop:pack` 的基线步骤不需要官方私钥。生成可被官方安装程序接受的签名增量包则需要对应的私钥。

不要为一次普通构建替换仓库公钥，也不要提交私钥、profile、数据库或生成的安装包。版本、基础兼容性、依赖锁、签名与 GitHub 发布流程统一见[发布指南](RELEASING.md)。
