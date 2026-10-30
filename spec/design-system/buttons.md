# 按钮与操作层级

[设计系统](README.md) · 更新于 2026-10-30

按钮先表达“这个动作在此处有多重要”，再选择外观。共享配方位于 [ui-controls.css](../../prototypes/insight-composer/src/ui-controls.css)，新入口使用 `className="ui-button"` 与 `data-ui-button` 声明角色。兼容已有工作区与 Reader 类名，仍使用原生 `button` / `a`，无需为了样式另包一层组件。

## 使用约定

| 角色 | 何时使用 | 文案与布局 |
| --- | --- | --- |
| 主要操作 | 当前面板最直接的下一步，例如进入阅读、加入队列、保存修改 | 一个独立操作区保留一个最突出动作；使用具体动词 |
| 次要操作 | 需要明确命中区域，但不应抢主要动作，例如恢复、另一个编辑入口 | 使用无描边浅灰按钮，与主要操作保持同一基线 |
| 文字操作 | 取消、刷新、更多、局部恢复等上下文已经明确的动作 | 保留可用命中区；不要为普通文字操作添加装饰图标或说明 |
| 工具栏 / 仅图标 | 高频、含义稳定的导航或工具，如关闭、设置、更多 | 使用透明底和悬停面，提供可访问名称；关键含义不明确时保留文字 |
| 危险操作 | 删除等会改变内容的动作 | 清楚描述对象和结果；不能只靠红色传达风险；保留原有撤销或恢复机制 |
| 状态切换 | 已选模式、展开面板、加入计划等持续状态 | 使用 `aria-pressed`、`aria-selected` 或对应控件语义；不要把当前选中当成按压态 |

“取消”放在主要提交动作之前；Queue 当前为右侧动作组、取消在左、提交在右。不要在相同区域同时放两个同等突出的“完成”入口。

## 当前实现目录

下列尺寸是 80% 界面设置的基础值，均乘 `--ui-scale`；规则见 [视觉基础](foundations.md)。局部 CSS 负责排列、宽度与内容结构，共享 `ui-controls.css` 负责颜色、尺寸角色、禁用和焦点反馈。

| 角色 / 兼容类 | 当前样式与尺寸 | 使用场景 |
| --- | --- | --- |
| `entry` / `.workspace-primary-button` | 浅灰底 `--action-surface`、透明边框、无阴影、字重 600；最小高 34px × scale | 开启操作或确认即时设置；Settings「完成」、更新检查 |
| `secondary` / `.workspace-quiet-button` | 同浅灰底、透明边框、无阴影；最小高 34px × scale | 恢复、备用操作 |
| `submit` | 深底白字、字重 600；最小高 36px × scale | Queue 保存、更新下载与重启 |
| `read` | 与 `submit` 共用强调配方；最小高 36px × scale | Collection 阅读入口，局部布局保留全宽 |
| `text` / `.workspace-text-button` | 透明底、次要文字；最小高 30px × scale、左右 6px × scale、字号 11px × scale | 取消、计划、上传新文件等文字动作；hover 强化文字并加下划线 |
| `tool` / `.workspace-icon-button` / `.icon-button` | 30px 方形 × scale、透明底、次要文字 | Reader、工作区与弹窗的仅图标操作 |
| `.tool-button` | 同工具高度 30px × scale，左右 8px × scale、图文间距 6px × scale | Reader 顶栏图文工具 |
| `data-ui-size="compact"` | 高度 28px × scale；有文字时左右 9px × scale、字号 11px × scale | 顶栏「添加资料 / 添加任务」等紧凑入口，以及空间受限的工具 |

所有普通角色使用 `--ui-radius-control`（4px × scale）与共享内边距；长文案允许换行撑高，不能固定高度截掉操作。角色与尺寸是两个维度，紧凑入口仍保留 `entry` 层级。新增场景从语义上最近的共享入口开始；若必须新增变体，需要记录现有角色无法满足的原因。

## 已确定的场景区别

- 顶栏「添加任务」是进入编辑流程的轻量入口，使用无描边浅灰矩形；弹窗内「加入队列」是提交动作，使用深底。2026-10-30 用户明确禁止黑边白色按钮，覆盖旧白底细框规范。顶栏入口见 [WorkspaceHeader.jsx](../../prototypes/insight-composer/src/workspace/WorkspaceHeader.jsx)。
- Collection 详情的阅读状态与「加入阅读计划」放在同一行，计划操作为纯文字，下面保留全宽深色阅读按钮；不重新加入计划图标、阅读图标或计划按钮的灰色矩形底。
- 阅读状态、计划文案和阅读按钮文案的切换使用连续动效，键盘焦点保持在原控件；不能在改按钮样式时退回生硬的节点替换。实现见 [MaterialDetails.jsx](../../prototypes/insight-composer/src/workspace/MaterialDetails.jsx)。

这些区别有明确的层级和任务原因，应保留。后续统一要让同类场景使用相同配方，并收敛无理由的局部数值差异，而不是把所有按钮涂成同一种颜色。

## 状态与交互

| 状态 | 必须保持的行为 | 当前代表实现 |
| --- | --- | --- |
| 默认 | 文案、命中区与布局稳定；实际动作使用 `button` | 工作区基础按钮使用 `inline-flex` 对齐 |
| hover | 轻量颜色或背景反馈，不改变布局 | 通用主按钮转 `--action-hover`，深色主按钮转 `--accent-hover` |
| pressed | 只在实际按下时反馈，不和持续选中混淆 | 按压动效按共享 motion 规则处理，不在每个页面复制一套缩放 |
| selected / expanded | 状态保持可见，并有对应可访问属性 | `.tool-button.selected` 使用选中背景；详情加入计划使用 `aria-pressed` |
| focus-visible | 键盘焦点可辨识，不因简化视觉被删除；不能只依赖 hover | 共享 1px `--ui-focus-ring`、2px 外偏移与浅 halo；强制颜色使用系统 `Highlight` 2px 框 |
| disabled | 不触发操作，不显示可用态 hover；解释仅在用户需要恢复时提供 | `:disabled` 与 `aria-disabled="true"` 共用 `.5` 透明度；强制颜色使用 `GrayText`，保留可辨识边缘 |
| busy | 防止重复提交，保留结果未确认时的恢复路径；不靠动画声称成功 | Queue 提交显示“正在保存…”并禁用；未知结果显示“继续确认保存”并复用待确认操作 |

`aria-disabled` 只表达状态，不会自动阻止事件。使用它保留焦点的操作必须由处理函数阻止重复写入。当前 Collection 阅读状态和加入计划保留焦点的行为需要与原有实现一起维护，不能为了统一外观直接改成移除控件。

普通状态转换使用共享动效，参见 [motion.css](../../prototypes/insight-composer/src/motion.css)。避免 `transition: all`，尤其不能使尺寸、输入光标、滚动和拖动延迟。

## 危险操作与图标按钮

目前没有统一的 `.danger-button`。共享右键菜单通过 `.reader-context-item.is-danger` 使用 `#a53d37`；Flow 删除洞见使用该入口并提供撤销。来源见 [context-menu.css](../../prototypes/insight-composer/src/context-menu.css) 与 [FlowPage.jsx](../../prototypes/insight-composer/src/workspace/FlowPage.jsx)。不要为了颜色统一取消原有业务恢复能力，也不要将普通取消或关闭渲染成危险操作。

图标按钮的 `aria-label` 应说明动作，例如“关闭面板”；有可见文字时图标通常标为装饰。移除可见按钮文字前检查窄屏、键盘与辅助技术仍能识别操作。用户已经明确的文字操作（如“上传新文件”）不能为了更紧凑改成不明确的图标。

## 维护与验证

- 已将 Queue 提交、Collection 阅读与计划、Settings 完成和 Desktop Updates 映射到显式共享角色，删除对应私有颜色与尺寸配方。旧类保留兼容，但不再用 `.workspace-primary-button` 承担页面私有的深色覆盖。
- 术语空态、引用候选、编辑器搜索按钮和 Reader 选中工具也使用浅灰无描边；轻量入口不能通过 hover、内阴影或后置局部规则恢复深色描边。键盘焦点保留独立的灰色光晕，强制颜色保留系统可访问反馈。
- 视觉上的选择卡同样遵守此规则，不以 HTML 元素是 `label` 为例外。Settings 图标选择、界面模式、色板预置、快捷键录入使用浅灰默认面与 `--action-selected` 较深灰选中面；保留 radio / checkbox / pressed 语义，原有勾选指示继续可见。
- 图标使用 30px 工具尺寸；明确的紧凑场景使用 28px 尺寸角色，不能通过页面选择器另造 32px 命中区。
- 修改按钮时检查默认、hover、键盘 focus、disabled、busy、selected；检查长文案和最大界面比例，确保提交文案变化不会推挤相邻操作。
- 同时检查至少一个工作区按钮、一个 Reader 工具栏按钮与相关弹窗；仅查看新按钮自身不足以验证一致性。
- 2026-10-30：[ui-controls.browser.mjs](../../prototypes/insight-composer/tests/ui-controls.browser.mjs) 的 22 组 Edge 无头浏览器检查通过，覆盖三档比例、长文案、透明表单与短窗固定页脚、读/计划状态、提交 busy 去重、更新业务状态、选择卡的选中区分、浅色按钮默认/hover 无描边及强制颜色。桌面更新使用模拟 bridge，不能据此宣称真实下载、签名、安装或重启通过。
