# Conversion request

Replace the source ID with the user-authorized source.

The external caller owns generation, an actually separate independent review, repair and exact-version publication through the local MCP service.

> source_id: <uploaded-source-id>
>
> 调用 get_authoring_contract 获取格式，通过 query_uploaded_sources(action=get) 取得原件。
>
> 将指定原文件转换为 reader-authoring-1；非中文默认保留完整原文并提供完整简体中文。提取、组织、生成和修复方法由你决定。实际启动未参与生成的独立 Agent，先读原件，再对照候选复审内容、译文，并打开 Reader 实时预览检查显示与交互。修复后复查最新候选，仅发布复审通过的同一版本。返回阅读链接、独立复审记录及未解决问题；无法复审或预览时明确报告未完成。格式、示例及参数按需读取。

[Format guide](../authoring-guide.md) · [Review record](../conversion-workflow.md)
