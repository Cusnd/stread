export const attentionAnswer = {
  sourceLabel: "示例回答",
  blocks: [
    { type: "paragraph", text: "缩放的目的，是控制点积随维度增大而增大的数值幅度，避免 softmax 过早变得过于尖锐。它并不是负责让权重和等于 1；归一化由 softmax 完成。" },
    { type: "heading", text: "先看原文脚注 4 的假设" },
    { type: "paragraph", text: "假设查询 q 和键 k 的各个分量相互独立、均值为 0、方差为 1。每一项 qᵢkᵢ 的均值为 0、方差为 1，dₖ 项相加后的方差就是 dₖ。" },
    { type: "math", tex: "\\operatorname{Var}(q^T k)=d_k,\\qquad\\operatorname{Var}\\!\\left(\\frac{q^Tk}{\\sqrt{d_k}}\\right)=1" },
    { type: "heading", text: "为什么这对 softmax 有帮助" },
    { type: "paragraph", text: "当输入分数的差距很大时，softmax 容易把几乎全部权重集中到一个位置，其他位置的梯度随之变小。除以 √dₖ 可以在上述假设下将分数的方差稳定在 1 附近，使不同键维度下的尺度更可控。" },
    { type: "heading", text: "结论的边界" },
    { type: "paragraph", text: "方差等于 1 的结论依赖脚注中的独立性、零均值和单位方差假设；训练后的投影向量不保证严格满足这些条件。论文以这一计算解释缩放的动机，并没有声称真实模型中的每个注意力分数都精确服从这一分布。" },
  ],
};

export function attentionNotes(paper) {
  function note(id, blockId, quote, body, type, color, variant = "source") {
    const block = paper.blocks.find((item) => item.id === blockId);
    const text = variant === "source" ? block.text : block.translations[variant].text;
    const start = text.indexOf(quote);
    if (start < 0) throw new Error("Sample quote is missing: " + blockId);
    return { id, blockId, documentId: paper.id, revision: paper.revision, variant, field: "text", start, end: start + quote.length, quote, body, type, color };
  }
  const equation = paper.blocks.find((block) => block.id === "S3.E1");
  return [
    note("attention-note-parallel", "abstract1.1", "more parallelizable", "论文的一个关键目标：减少序列内部必须按顺序执行的计算。", "annotation", "blue"),
    { id: "attention-question-scale", blockId: equation.id, documentId: paper.id, revision: paper.revision, variant: "source", field: "tex", sourceType: "math", equationNumber: equation.tag, quote: equation.tex, body: "为什么点积要除以 √dₖ？", type: "question", color: "amber", answer: attentionAnswer },
    note("attention-question-position", "S3.SS5.p4.1", "线性函数", "为什么固定偏移后的位置编码，可以写成原位置编码的线性函数？", "question", "rose", "zh-CN"),
    note("attention-note-cost", "S4.p4.1", "序列长度", "比较复杂度时要同时看序列长度和表示维度。全局自注意力仍包含随序列长度平方增长的计算。", "note", "green", "zh-CN"),
  ];
}
