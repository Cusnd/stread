# 按钮与操作层级

[设计系统](README.md) · 更新于 2026-10-30

按钮先表达“这个动作在此处有多重要”，再选择外观。相同角色应复用同一实现；页面差异不能成为另写一套按钮的默认理由。当前代码主要共享 CSS 类，尚无覆盖全应用的统一 `Button` 组件。

## 使用约定

| 角色 | 何时使用 | 文案与布局 |
| --- | --- | --- |
| 主要操作 | 当前面板最直接的下一步，例如进入阅读、加入队列、保存修改 | 一个独立操作区保留一个最突出动作；使用具体动词 |
| 次要操作 | 有边界、需要明确命中区域，但不应抢主要动作，例如恢复、另一个编辑入口 | 使用轻边框按钮，与主要操作保持同一基线 |
| 文字操作 | 取消、刷新、更多、局部恢复等上下文已经明确的动作 | 保留可用命中区；不要为普通文字操作添加装饰图标或说明 |
| 工具栏 / 仅图标 | 高频、含义稳定的导航或工具，如关闭、设置、更多 | 使用透明底和悬停面，提供可访问名称；关键含义不明确时保留文字 |
| 危险操作 | 删除等会改变内容的动作 | 清楚描述对象和结果；不能只靠红色传达风险；保留原有撤销或恢复机制 |
| 状态切换 | 已选模式、展开面板、加入计划等持续状态 | 使用 `aria-pressed`、`aria-selected` 或对应控件语义；不要把当前选中当成按压态 |

“取消”放在主要提交动作之前；Queue 当前为右侧动作组、取消在左、提交在右。不要在相同区域同时放两个同等突出的“完成”入口。

## 当前实现目录

下列尺寸是默认界面比例下的基础值；带缩放的数值乘 `--ui-scale`，规则见 [视觉基础](foundations.md)。源码入口为 [workspace.css](../../prototypes/insight-composer/src/workspace/workspace.css)、[styles.css](../../prototypes/insight-composer/src/styles.css)、[queue.css](../../prototypes/insight-composer/src/workspace/queue.css)、[reading-settings.css](../../prototypes/insight-composer/src/reading-settings.css)。

| 当前类 / 场景 | 当前样式与尺寸 | 复用说明 |
| --- | --- | --- |
| `.workspace-primary-button` | 白底，`--action-border` 细边，轻阴影，字重 600；最小高 34px × scale，左右 12px × scale，圆角 4px | 当前工作区通用主按钮；在普通 dialog actions 中最小高又被覆盖为 32px × scale |
| `.workspace-quiet-button` | 白底、`--workspace-line` 细边；最小高 32px × scale，左右 11px × scale，圆角 4px | 次要有边界操作 |
| `.workspace-text-button` | 透明底；左右 7px × scale，圆角 4px，字号 11px × scale；通常继承工作区最小高 32px × scale | 文本操作；具体容器仍可调整尺寸 |
| `.workspace-icon-button` | 透明底、次要文字色；宽 30px × scale、最小高 30px × scale，圆角 4px | 工作区图标操作；导航或小屏有更具体覆盖 |
| `.workspace-quiet-button.workspace-import-button` | 白底、细边框、矩形小圆角；最小高 29px × scale，左右 9px × scale、字号 11px × scale | 顶栏「添加资料 / 添加任务」；已明确保留轻量入口，不改为深色圆润按钮 |
| `.tool-button` | 透明底、图文间距 6px × scale；最小高 28px × scale，内边距 6px / 8px × scale，圆角 4px × scale | Reader 顶栏工具；最终高度仍受行高及专用顶栏规则影响 |
| `.icon-button` | 基础 32px 方形 × scale、圆角 5px × scale | Reader 顶栏与洞见标题后置规则改为 28px 方形 × scale，不能直接用基础值描述它们 |
| `.workspace-material-detail .workspace-read-button` | 深色底、白字，最小高 33px × scale，宽度 100% | Collection 详情的主要阅读入口 |
| `.queue-task-form-actions .workspace-primary-button` | 深色底、白字，最小高 36px × scale，左右 17px × scale、圆角 6px × scale | Queue 的提交按钮，覆盖通用白底配方 |
| `.settings-footer button` | 白底，内描边与轻阴影；上下 7px、左右 19px × scale，圆角 6px × scale | Settings 的完成操作，目前没有与 Queue 共用同一主按钮配方 |

这张表是现状索引，不是允许随意组合的变体菜单。新增场景应从语义上最近的共享入口开始；调整共享规则时同步检查所有引用。若必须新增变体，需要写明使用条件及已有变体无法满足的原因，不能仅以“这页更好看”为依据。

## 已确定的场景区别

- 顶栏「添加任务」是进入编辑流程的轻量入口，使用白底细框矩形；弹窗内「加入队列」是提交动作，当前使用深底。二者不可因为同属 Queue 就强制改成同一种强调程度。顶栏入口见 [WorkspaceHeader.jsx](../../prototypes/insight-composer/src/workspace/WorkspaceHeader.jsx)。
- Collection 详情的阅读状态与「加入阅读计划」放在同一行，计划操作为纯文字，下面保留全宽深色阅读按钮；不重新加入计划图标、阅读图标或计划按钮的灰色矩形底。
- 阅读状态、计划文案和阅读按钮文案的切换使用连续动效，键盘焦点保持在原控件；不能在改按钮样式时退回生硬的节点替换。实现见 [MaterialDetails.jsx](../../prototypes/insight-composer/src/workspace/MaterialDetails.jsx)。

这些区别有明确的层级和任务原因，应保留。后续统一要让同类场景使用相同配方，并收敛无理由的局部数值差异，而不是把所有按钮涂成同一种颜色。

## 状态与交互

| 状态 | 必须保持的行为 | 当前代表实现 |
| --- | --- | --- |
| 默认 | 文案、命中区与布局稳定；实际动作使用 `button` | 工作区基础按钮使用 `inline-flex` 对齐 |
| hover | 轻量颜色或背景反馈，不改变布局 | 通用主按钮转 `--action-hover`，深色主按钮转 `--accent-hover` |
| pressed | 只在实际按下时反馈，不和持续选中混淆 | Settings 页脚源码有 `scale(.97)` 按下态；这不是全局按钮标准 |
| selected / expanded | 状态保持可见，并有对应可访问属性 | `.tool-button.selected` 使用选中背景；详情加入计划使用 `aria-pressed` |
| focus-visible | 键盘焦点可辨识，不因简化视觉被删除；不能只依赖 hover | 工作区默认深色 2px outline、外偏移 3px；部分局部控件改为浅 halo，尚未统一 |
| disabled | 不触发操作，不显示可用态 hover；解释仅在用户需要恢复时提供 | 工作区按钮通常透明度 `.42`；Reader 工具按钮主要改变文字色 |
| busy | 防止重复提交，保留结果未确认时的恢复路径；不靠动画声称成功 | Queue 提交显示“正在保存…”并禁用；未知结果显示“继续确认保存”并复用待确认操作 |

`aria-disabled` 只表达状态，不会自动阻止事件。使用它保留焦点的操作必须由处理函数阻止重复写入。当前 Collection 阅读状态和加入计划保留焦点的行为需要与原有实现一起维护，不能为了统一外观直接改成移除控件。

普通状态转换使用共享动效，参见 [motion.css](../../prototypes/insight-composer/src/motion.css)。避免 `transition: all`，尤其不能使尺寸、输入光标、滚动和拖动延迟。

## 危险操作与图标按钮

目前没有统一的 `.danger-button`。共享右键菜单通过 `.reader-context-item.is-danger` 使用 `#a53d37`；Flow 删除洞见使用该入口并提供撤销。来源见 [context-menu.css](../../prototypes/insight-composer/src/context-menu.css) 与 [FlowPage.jsx](../../prototypes/insight-composer/src/workspace/FlowPage.jsx)。不要为了颜色统一取消原有业务恢复能力，也不要将普通取消或关闭渲染成危险操作。

图标按钮的 `aria-label` 应说明动作，例如“关闭面板”；有可见文字时图标通常标为装饰。移除可见按钮文字前检查窄屏、键盘与辅助技术仍能识别操作。用户已经明确的文字操作（如“上传新文件”）不能为了更紧凑改成不明确的图标。

## 待收敛与维护检查

- 同一个 `.workspace-primary-button` 类在不同场景有白底和深底覆盖；这些场景区别有层级原因，但实现还没有显式、共享的语义变体入口。应保留已确定的场景区别，避免把同一个类名当作一致性的证明。
- 图标命中区目前常见 28 / 30 / 32px，圆角、禁用透明度与焦点外观也不一致。后续统一应按工具栏、普通表单、局部微操作的角色明确尺寸档位，避免复制页面私有值。
- [desktop-updates.css](../../prototypes/insight-composer/src/desktop-updates.css) 的按钮高 34px、圆角 6px、颜色及焦点均为局部硬编码；这不是新的推荐样式入口。
- 修改按钮时检查默认、hover、键盘 focus、disabled、busy、selected；检查长文案和最大界面比例，确保提交文案变化不会推挤相邻操作。
- 同时检查至少一个工作区按钮、一个 Reader 工具栏按钮与相关弹窗；仅查看新按钮自身不足以验证一致性。
