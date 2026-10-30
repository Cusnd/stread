export const CONVERSION_INSTRUCTIONS = "将指定原文件转换为 reader-authoring-1；非中文默认保留完整原文并提供完整简体中文。提取、组织、生成和修复方法由你决定。实际启动未参与生成的独立 Agent，先读原件，再对照候选复审内容、译文，并打开 Reader 实时预览检查显示与交互。修复后复查最新候选，仅发布复审通过的同一版本。完成后返回阅读链接、独立复审记录及未解决问题；无法复审或预览时明确报告未完成。格式、示例及参数按需读取。";

export const CONVERSION_REQUIREMENTS = "完整保留正文、公式、图表与参考文献；转换后在 Reader 中核对。";

export function conversionRequest(source, { title = "", language = "", task } = {}) {
  const outputLanguages = task?.outputLanguages || (language === "zh-CN" ? ["source"] : ["source", "zh-CN"]);
  const output = outputLanguages.filter(value => value !== "source");
  const languageNames = { "zh-CN": "简体中文", en: "English", ja: "日本語", fr: "Français", de: "Deutsch" };
  return [
    ...(task ? [`请处理 Queue 任务 ${task.reference}（版本 ${task.version}）。先通过 resolve_reference 读取这项任务的最新要求；读取本身不表示已开始或完成。`] : []),
    `请转换原文件 ${source.filename}。`,
    `source_id: ${source.sourceId}`,
    ...(title.trim() ? [`文档标题：${title.trim()}`] : []),
    ...(language ? [`原文语言：${language}`] : []),
    `输出要求：${output.length ? "完整原文 + " + output.map(value => "完整" + (languageNames[value] || value)).join(" + ") : "仅完整原文；本任务明确不要求翻译"}。以本任务的输出要求为准。`,
    ...(task?.body ? [`任务要求：${task.body}`] : []),
    "调用 get_authoring_contract 获取格式，通过 query_uploaded_sources(action=get) 取得原件。",
    ...(task ? [`在 authoring JSON 的 extensions 中保留以下任务绑定：${JSON.stringify({ "stread.queue": { taskId: task.id, taskVersion: task.version } })}。原件使用上述 source_id。任务要求更新后必须重新读取并生成候选，不能继续发布旧版本。`] : []),
    CONVERSION_INSTRUCTIONS,
  ].join("\n");
}
