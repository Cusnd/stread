# stread

面向论文与长文的本地阅读工作台：集中整理资料，在原文与译文之间阅读，把洞见、问题和后续阅读安排留在同一处。

**桌面程序目前显示为 Continuous Reader。** `stread` 是开源项目名称；可执行文件名称、应用标识和已有资料目录保持不变。

[下载安装](https://github.com/Cusnd/stread/releases/tag/v0.1.3) · [使用指南](docs/GETTING_STARTED.md) · [MCP 接入](docs/MCP.md) · [开发指南](docs/DEVELOPMENT.md) · [更新记录](CHANGELOG.md)

## 可以做什么

| 工作区 | 用途 |
| --- | --- |
| **Collection** | 按集合、标签和阅读状态管理资料，搜索、归档、恢复，并进入阅读。 |
| **Reader** | 阅读结构化正文，切换原文／译文／对照，查看原始 PDF，记录带来源位置的批注、笔记和问题。 |
| **Flow** | 查看阅读活动、集中管理洞见、安排阅读计划，以及回顾阅读历史。 |

阅读位置、洞见、原文件和已发布内容保存在本机。前台阅读活动用于形成阅读记录；保存位置不代表文章已经读完。

外部 Agent 可以通过 **32 个 MCP 工具**读取受限上下文、整理资料、修改内容并提交经过审阅的版本。Reader 本身不启动 Agent、不运行模型，也不提供云端同步。非中文资料的默认转换交付为完整原文加简体中文；发布前需要真实的独立审阅和 Reader 检查。

## 安装与更新

当前桌面发行目标为 **Windows x64**。首次安装使用完整安装包，当前基础版本为 **0.1.3**：

- `Continuous-Reader-0.1.3-Setup-x64.exe`：常规安装，适合日常使用。
- `Continuous-Reader-0.1.3-Portable-x64.exe`：单文件启动包。资料仍保存在用户目录，不保存在可执行文件旁。

从 [0.1.3 Releases 页面](https://github.com/Cusnd/stread/releases/tag/v0.1.3) 获取文件。安装后的运行不需要另装 Node.js 或 Python。Windows 可执行文件目前没有 Authenticode 签名；程序增量更新使用的是另一套 Ed25519 签名校验，二者不能混同。

后续在 **设置 → 更新 → 检查更新** 中下载并重启更新。日常界面、桌面逻辑和工作台服务更新只传输程序层文件；匹配上一版本时使用真正的文件差分，跨过版本时使用完整程序层包。Electron、Python、生产依赖或数据库结构等基础条件变化时，程序会引导安装完整版本。

旧于 0.1.3 的程序需要先安装一次包含更新引导程序的完整版本。普通浏览器和源码开发窗口没有桌面更新页。更新流程、备份和恢复见[使用指南](docs/GETTING_STARTED.md)。

## 第一次使用

1. 打开 Continuous Reader，在 Collection 中选择资料；单击查看详情，双击进入阅读。
2. 导入自己的文件时，选择“准备转换”保存原文件，再复制转换请求。
3. 将请求交给已经接入本机 MCP 的外部 Agent。它完成生成、独立审阅和发布后，文章才会成为可读资料。
4. 在 Reader 中阅读、记录洞见，在 Flow 中安排后续阅读与回顾。

导入界面接受 PDF、HTML、Markdown、文本或结构化 JSON，单个文件最大 64 MB。保存原文件只是转换的开始；语言按钮展示已经保存的内容，不会即时调用模型翻译。

## 数据与连接

默认资料目录是 `%USERPROFILE%\.continuous-reader`。安装版和 Portable 默认使用同一目录；可通过 `--reader-user-data=<绝对目录>` 使用独立资料库。备份前正常退出程序，然后完整复制该目录。

资料、原文件、预览和业务执行都在本机。检查和下载程序更新时会连接 GitHub；打开外部链接时会使用浏览器。外部 Agent 是否使用远程模型，以及向模型提供哪些材料，取决于你选择的客户端和授权。

## 从源码运行

开发需要 Git、Node.js **24 或更新版本**及可用的 Python。先安装 JavaScript 依赖：

```powershell
git clone https://github.com/Cusnd/stread.git
cd stread
npm ci
npm run setup
```

完成[开发指南中的 Python 配置](docs/DEVELOPMENT.md#准备-python)后，使用独立开发资料目录启动：

```powershell
$devProfile = Join-Path $env:USERPROFILE '.stread-development'
npm run desktop:dev -- "--reader-user-data=$devProfile"
```

桌面开发入口支持前端热更新，并在桌面或服务代码变化时先保存再重启。浏览器开发、测试、静态构建和打包命令见[开发指南](docs/DEVELOPMENT.md)。

## 文档

| 需要了解的内容 | 文档 |
| --- | --- |
| 安装、导入、阅读、更新和备份 | [使用指南](docs/GETTING_STARTED.md) |
| 外部 Agent 连接与转换工作流 | [MCP 接入](docs/MCP.md) |
| 开发环境、命令和验证 | [开发指南](docs/DEVELOPMENT.md) |
| 进程、存储、内容与更新边界 | [架构说明](docs/ARCHITECTURE.md) |
| 启动、PDF、MCP 和更新故障 | [故障排查](docs/TROUBLESHOOTING.md) |
| 签名密钥、完整发布和增量发布 | [发布指南](docs/RELEASING.md) |
| 提交问题和代码 | [贡献指南](CONTRIBUTING.md) |
| 安全问题报告 | [安全政策](SECURITY.md) |

## 许可

项目代码采用 **AGPL-3.0-only**，详见 [LICENSE](LICENSE)。依赖、字体、图标、论文示例及其他第三方材料保留各自许可或权利，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
