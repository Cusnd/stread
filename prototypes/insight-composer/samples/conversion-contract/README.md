# 三篇真实论文的作者输入

这三份 `reader-authoring-1` 是可修订的正文来源；`public/articles/<paper>/document.json`、`identity.json`、`text-index.json`、`compile-report.json` 是编译结果。后续修订作者输入时沿用已有 key 和身份登记，不把派生索引作为另一份手改正文。

| 作者输入 | 来源 | 范围 |
| --- | --- | --- |
| [resnet.authoring.json](resnet.authoring.json) | arXiv 1512.03385v1，12 页 | 全文、附录、50 条文献、7 图、14 表、2 条独立公式；表 1、14 有中文示例。 |
| [mapreduce.authoring.json](mapreduce.authoring.json) | USENIX OSDI 2004，13 页 | 全文、18 条文献、附录 C++、4 图、1 表、伪代码与类型声明；首段伪代码、图 3、表 1 有中文示例。 |
| [crispr.authoring.json](crispr.authoring.json) | Experimental & Molecular Medicine 48, e265，11 页 | 全文、110 条文献、3 图、1 表；图 2、表 1 有中文示例。 |

翻译编辑源为 [reviewed-translations.json](reviewed-translations.json)，提取脚本将它们合入作者输入。当前脚本是针对三种已保存官方 HTML 的提取辅助工具，含本轮逐项修正，不是通用 PDF 解析器。MapReduce 图像从原 PDF 按记录的页面矩形以 4 倍比例重提取，避免旧 HTML 的灰底低分辨率图片；其余原始 SVG/JPEG 来自官方页面。本仓库保留作者输入、编译结果和原始资源；此前的私有验收截图与研究记录不随源码发布。

从原型目录编译：

```powershell
npm run compile:authoring -- samples/conversion-contract/resnet.authoring.json public/articles/resnet
npm run test:conversion
```

编译器先检查完整结果，再写入本地文件。正式服务现已提供 Agent 作者输入校验、资源绑定、事务发布、幂等重试和 MCP 入口，见 [服务指南](../../../../services/workspace/README.md)；本目录仍为此前的本地转换样本，不因此自动获得新的服务验收结论。`text-index.json` 当前保存 HTML 单元的派生文本，标准模块仍通过既有字段读取。每份原 PDF 与资源须已在输出目录，缺失、空资源或 PDF 哈希不符会报错。

复现提取需要 Python 的 BeautifulSoup、html5lib、requests、PyMuPDF，以及自行保存的相应版本官方 HTML。历史抓取输入未随源码发布；可直接从已提交的作者输入重建编译结果。样本中的部分译文不满足新转换默认完整中文的交付要求。
