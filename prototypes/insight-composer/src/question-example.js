// Demonstration content only. A real answer is stored after the user's approval
// and a successful MCP write; its presence therefore means the question is solved.
export const exampleAnswer = {
  sourceLabel: "示例回答",
  blocks: [
    { type: "paragraph", text: "因为这里比较的是同一个提示 x 下的两个回答。Z(x) 只随 x 改变，因此两项奖励里的 β log Z(x) 完全相同，相减后就是 0。" },
    { type: "heading", text: "把两项奖励分别写出来" },
    { type: "paragraph", text: "从原文的式（5）出发，用 y₊ 和 y₋ 表示同一个提示下的两个回答。" },
    { type: "math", tex: "r(x,y_+)=\\beta\\log\\frac{\\pi^*(y_+\\mid x)}{\\pi_{\\mathrm{ref}}(y_+\\mid x)}+\\beta\\log Z(x)" },
    { type: "math", tex: "r(x,y_-)=\\beta\\log\\frac{\\pi^*(y_-\\mid x)}{\\pi_{\\mathrm{ref}}(y_-\\mid x)}+\\beta\\log Z(x)" },
    { type: "heading", text: "相减时，公共项消去" },
    { type: "paragraph", text: "把上面两式相减。两项中相同的 β log Z(x) 抵消，剩下两个对数概率比之差。" },
    { type: "math", tex: "r(x,y_+)-r(x,y_-)=\\beta\\left[\\log\\frac{\\pi^*(y_+\\mid x)}{\\pi_{\\mathrm{ref}}(y_+\\mid x)}-\\log\\frac{\\pi^*(y_-\\mid x)}{\\pi_{\\mathrm{ref}}(y_-\\mid x)}\\right]" },
    { type: "heading", text: "需要留意的条件" },
    { type: "paragraph", text: "两项必须使用同一个 x，以及式中同一套策略、参考策略和 β。若比较的是不同提示，归一化项会分别变成 Z(x₁) 和 Z(x₂)，就不能直接消去。这里还沿用原式中概率比及对数有定义的条件。" },
    { type: "paragraph", text: "所以，理解这一步时先检查两项是否共享同一个归一化项，再做相减。Z(x) 仍参与单项奖励的表达，只是在这一次奖励差中不再出现。" },
  ],
};
