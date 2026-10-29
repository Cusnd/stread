# 可组合的阅读布局示例

These examples use the current [32-tool MCP contract](../mcp-management.md). Discover sources with `query_uploaded_sources`, inspect a draft/candidate with `inspect_authoring_preview`, and fetch artifacts with `read_resources`. A conversion is published only through `publish_authoring_preview` after reviewing its exact snapshot/hash. The examples are adaptable authoring structures, not permission to publish or alter saved content.

这些小文档展示 `reader-authoring-1` 已有的表达能力。它们包含自编说明、示意数据和本地绘制的图片，没有原 PDF，也没有伪造的来源坐标或文件指纹。可直接编译、预览和修订；不能作为真实文档转换的完成证明。

下载 [示例清单](manifest.json) 可取得每份作者输入的资源依赖、真实资源 SHA-256、适用条件和检查重点。需要离线使用时下载 [完整示例包](layout-examples.zip)，解压后保留 `images/` 相对路径。

## 按内容选择组合

| 示例 | 适合表达 | 可按内容改变 | 作者输入与资源 |
| --- | --- | --- | --- |
| 图与解释（中英） | 需要同时看一幅图与解释、但文字不宜塞进题注 | 解释较长时将 `layout-pair` 改成 `layout-stack`；独立讨论可以拆回普通块 | [image-text.json](image-text.json)、[paired.png](images/paired.png) |
| 相关多图（英文） | 几幅子图服务于同一个比较或过程，且确实共享题注 | 增减子图、改变内容顺序、使用并排或上下排列；独立图不要为了整齐强行合并 | [multi-figure.json](multi-figure.json)、[scattered.png](images/scattered.png)、[paired.png](images/paired.png)、[grouped.png](images/grouped.png) |
| 步骤与条件（中英） | 步骤、短伪代码及成立条件需要共同阅读 | 去掉不必要的代码、将条件放在步骤之前、改成单列；有先后依赖的步骤仍用有序列表 | [steps-notes.json](steps-notes.json)，无需图片 |
| 定义与解释（中英） | 定义、适用条件和解释属于一个紧密单元 | 选择上下/并排、增减解释；独立公式继续使用普通 `math` 块 | [definition-explanation.json](definition-explanation.json)，无需图片 |
| 分组表与注释（中英） | 多层表头、跨行分类以及适用于全表的说明 | 根据原文改变真实的跨度和分组；简单矩阵应优先用普通 `table` 块 | [grouped-table.json](grouped-table.json)，无需图片 |

这些是可修改的组合，不是按文章类型强制套用的模板。先确定哪些内容需要共同理解，再决定是否合成一个 HTML 对象。标题、普通段落、列表、公式、单图和规则表格仍可分别使用标准块。一个 HTML 对象不应吞掉整篇文章。

## 共同边界

- Agent 决定语义结构、DOM 阅读顺序、真实题注、跨行/跨列、内容分组及共享布局类；示例不使用自定义 CSS。
- 阅读器决定字体、颜色、留白、对象宽度、容器变窄后的排列，以及选区、引用、双语和展开行为。`layout-pair`、`layout-grid` 会随可用容器宽度回到 DOM 顺序。
- 内部 `key` 和 `data-key` 只用于身份与翻译对应。子图的 `(a)`、`(b)`、`(c)` 是本示意图的显式内容，不从 key 生成。
- 中英版本使用相同的对象与文本单元身份。只调整共享布局类时，两种语言保持同一组织方式；不把布局字段塞入翻译对象。
- 示例没有 PDF 映射。改为真实文档时，需要保留实际原件、真实资源、已知来源和内容核对；不能把这些示意说明、数字或图片当成原文。

## 如何验证和预览

外部 Agent：上传所选 JSON 和该条目列出的图片，按 manifest 中的相对 `path` 绑定上传文件 ID，然后使用作者指南提供的验证与预览工具。无需上传其他示例的图片。示例不需要原 PDF 绑定。

仓库内可用正式编译器检查任一输入。先创建输出目录，把该示例列出的 `images/` 文件复制到目录内的同名相对路径，再运行编译；避免把生成产物混入示例源文件：

```powershell
node prototypes/insight-composer/scripts/compile-authoring.mjs services/workspace/authoring-examples/image-text.json <output-directory>
node --test prototypes/insight-composer/tests/layout-examples.test.mjs
```

自动检查覆盖：每份示例的真实图片字节与清单、正式编译和资源校验、双语文本单元对应、共享布局切换时的身份与译文有效性、表格跨度和空白保留、缺资源失败，以及离线包与当前文件的一致性。

结构检查不判断显示效果。预览时仍要检查：桌面阅读区宽/窄两种可用宽度、普通/较大字号、原文/译文/对照、图像完整性、题注归属、对象内滚动与展开、原生文字选择以及引用跳转。这里的“窄”指桌面面板变窄，不要求移动端适配。没有原 PDF 的示例不能验证 PDF 定位；真实转换还要另外核对原稿与来源关系。

维护者修改示例后运行 `python services/workspace/authoring-examples/package.py` 更新图片摘要和离线包，再运行上述测试。`package.py` 仅需 Python 标准库，不参与转换，也不会发布文档。
