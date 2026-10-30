# 表单、选择器与设置控件

[设计系统](README.md) · 更新于 2026-10-30

表单应让用户直接识别需要填写的内容。字段名保持简短，布局说明分组关系；辅助文字只用于必要条件、错误、冲突或恢复步骤。外观统一不能牺牲原生输入、文字选择、表单校验和键盘行为。

2026-10-30 的表单定稿使用白色字段、完整 1px 浅边框与 6px × scale 圆角。普通输入、选择器和 textarea 共用清晰的字段边界；hover 与 focus-visible 沿同一个外框反馈，书写区保持白色。按钮继续遵循自己的无深色描边规则。

## 选择控件的规则

| 用户任务 | 优先控件 | 约定 |
| --- | --- | --- |
| 输入自由文本 | 原生 `input` / `textarea` | 保留原生选区、复制粘贴与输入法；多行正文不套进单行输入框 |
| 从有限列表中选择一个值 | 共享 `ReaderSelect` | 保留原生 select 语义、值、typeahead 与校验，不新建伪下拉 |
| 少量互斥选项需要同时可见 | 原生 radio 或既有可访问 radio 实现 | Settings 分段选项与 Collection 阅读状态各有现有实现；不能只靠 CSS 类模拟选择状态 |
| 即时开关 | 既有 `.settings-switch` | 用 `role="switch"`、`aria-checked` 表达状态；提交中阻止重复写入 |
| 连续数值调整 | 原生 `input[type="range"]` 与当前值 | 拖动直接响应，保留键盘步进，不让空间动画追赶指针 |
| 搜索或筛选 | 带明确可访问名称的搜索输入 | placeholder 是示例或提示，不能代替字段名称 |

当前共享组件名为 **`ReaderSelect`**，定义在 [ReaderSelect.jsx](../../prototypes/insight-composer/src/ReaderSelect.jsx)。不要依据视觉名称另造一个 `SelectMenu` 实现。Collection 详情中的快捷阅读状态「未读 / 在读 / 已读」当前是行内 radio 加底线，见 [MaterialDetails.jsx](../../prototypes/insight-composer/src/workspace/MaterialDetails.jsx)；这一处不恢复下拉。[资料编辑表单](../../prototypes/insight-composer/src/workspace/CollectionForms.jsx)仍使用 `ReaderSelect` 编辑阅读状态，两种操作场景分别维护。

## 当前输入样式

| 场景与选择器 | 当前代表值（基础界面比例） | 边界 |
| --- | --- | --- |
| 通用 `.workspace-field` | 字号 12px × scale；字段下间距 17px × scale，标题与控件间距 7px × scale | 通用工作区表单 |
| `.ui-field` 与工作区表单原生输入 | 最小高 38px × scale；内边距上下 8px、左右 10px × scale；6px × scale 圆角、白底、完整 1px `--ui-field-border` 浅边 | 由共享 `ui-controls.css` 提供；页面私有规则只调整布局和必要密度 |
| 共享 textarea | 最小高 90px × scale、行高 1.8；四边内边距 10px × scale，白底、完整浅边框与共享字段圆角；默认允许竖向调整 | 多行控件也必须具有明确边界，保留原生光标、选区与内部滚动 |
| Queue 任务类型行 | 表单第一行；标签列 64px × scale，标签与控件间距 10px × scale；选择器宽 `min(200px × scale, 100%)`，使用共享白底浅边框 | 位于类型页面上方，切换页面和滚动字段时保持位置；文字与右对齐箭头使用共享 12px × scale 间距 |
| Queue 上下文行 | 字段名与控件同行，标签列 64px × scale；控件最小高 34px × scale，组内间距 8px × scale | 文件、标题、文章和语言配置通过对齐与留白分组，取消组结束分隔线；各字段保留完整浅边框 |
| Queue 书写区 | 上下文组下留白 18px × scale；textarea 使用共享白底、完整浅边框、圆角与焦点反馈；固定编辑器内自行滚动，不提供 resize 手柄 | 新建转换保留至少 65px × scale 的书写高度，其他任务至少 100px × scale；紧凑外框保持不变 |
| `.queue-source-selection .reader-select` | 源文件标签同行；选择、搜索与文字操作共用一个上下文组 | 搜索行更紧凑；上传和更多文件保持文字操作，不增加灰色容器 |
| `.workspace-search` | 高 30px × scale、4px 圆角、白底细边；输入文字 11px × scale | `focus-within` 改变外壳边缘，内部 input 不再另画外框 |

来源：[ui-controls.css](../../prototypes/insight-composer/src/ui-controls.css)、[workspace.css](../../prototypes/insight-composer/src/workspace/workspace.css)、[queue.css](../../prototypes/insight-composer/src/workspace/queue.css)。共享规则覆盖 `.ui-field`，以及 `.workspace-field`、`.workspace-form`、`.workspace-review` 中的普通原生输入、textarea 和 select；checkbox、radio、file 和 hidden 输入明确排除。任务类型使用普通字段外观；搜索壳和源文件组合区保留各自的紧凑结构。

## ReaderSelect 的完整行为

共享选择器仍是原生 `<select>`。支持 `appearance: base-select` 时，组件只安装浏览器拥有的 `selectedcontent` 显示槽，选项仍由 React 管理；不支持时保留原生选择器。原生 picker 进入浏览器 top layer，可以用于弹窗内。样式在 [reader-select.css](../../prototypes/insight-composer/src/reader-select.css)。

| 部分 | 当前规则 |
| --- | --- |
| 触发器 | 普通独立或字段内选择器使用白底、完整 1px 浅边框、6px × scale 圆角；横向文字留白 10px × scale。文字区域与箭头之间使用共享 12px × scale 间距，箭头靠右对齐；任务类型同样使用这一规则 |
| picker | 宽度以 `anchor-size(width)` 保留触发器宽度，同时设最小宽 `min(160px × scale, 100dvw - 16px)`，最大宽 `100vw - 16px`；靠近右边缘时保留浏览器原生位置回退。最大高 `min(320px × scale, 100dvh - 24px)`；圆角 8px × scale、上下留白 5px × scale；白色面、浅边缘和柔和阴影 |
| 选项 | 字号固定为 12px × scale、行高 1.5，不继承标题或大字段的字号；最小高 30px × scale，内边距上下 6px、左右与触发器一致；长文字可换行 |
| 当前选项 | 保持白底，以字重 500 和行尾 11px × scale 小勾表达当前值；不保留整行灰色选中块 |
| hover / 键盘定位 | hover 使用 3% 文字色混合的浅背景，键盘定位为 7%；不增加第二层黑框，与当前选项的小勾区分 |
| disabled / placeholder | 不可用项保留原生 disabled；选择提示可以保留在关闭的触发器中，但 Queue 的空值提示使用 `disabled hidden` 从菜单排除，共享 CSS 明确令 `option[hidden]` 为 `display: none` |
| Escape | picker 开着时，先交给浏览器关闭 picker，并阻止上层弹窗同时处理这一按键；不取消原生默认行为 |
| 动效与减少动态效果 | picker 只做共享 `fade` 淡入淡出；`display` / `overlay` 离散过渡维持退出层，实时减少动态效果立即移除过渡 |

弹窗焦点循环需要排除浏览器显示槽 `.reader-select-button`，防止出现第二个 Tab 停靠点。不要通过额外 JS 抢选区、重开 picker 或把焦点强行转回标签。共享模态策略 [useModalDialog.js](../../prototypes/insight-composer/src/useModalDialog.js) 已包含相应过滤。

菜单的字号必须同时设置在 picker 和 option 上：option 的 DOM 父元素是 select，仅修改 picker 字号仍会让选项继承触发器的大号字体。触发器的宽度不能直接压缩整个菜单，最小宽度应容纳完整短标签和勾选标记；长文章标题仍可正常换行。保留浏览器 top layer、原生选择值、键盘机制与窗口边缘回退。

## Queue 表单模式

[QueueTaskDialog.jsx](../../prototypes/insight-composer/src/workspace/QueueTaskDialog.jsx) 的 `TaskField` 使用一个可见 `span` 和 `aria-labelledby` 关联字段：只有点击控件内部才聚焦，点击标题或外围留白不再把焦点转入输入框。保持可访问名称时不要重新用覆盖整块区域的 `label` 还原该行为。它是 Queue 内部组件，尚未导出为全应用字段组件；文档不能宣称它已经替换所有工作区字段。

标题区域只保留“添加任务”或“编辑任务”及关闭入口。任务类型作为表单第一行的 `TaskField`，可见标签为“任务类型”，固定在各类型页面上方。标签列与下方文章、文件等字段对齐：64px × scale 标签列、10px × scale 间距；`ReaderSelect` 宽 `min(200px × scale, 100%)`，使用普通白底浅边字段，文字与右侧箭头之间保留共享 12px × scale 间距。编辑或保存冻结时继续按业务状态禁用该选择器。

源文件选择、搜索与“上传新文件”等文字动作在同一区域。原文语言与输出语言并排，要求输入保持主要可用空间。不要重新加入大块任务类型导航、重复「已选择」标签或把上传改成纯图标。

Queue 保持 `560 × 420px × scale` 的 `composer` 外框。关联文章是标签与选择器同行的上下文行；转换的文件、标题和语言也是紧凑行。上下文组以 8px × scale 间距排列，取消组结束分隔线，下方是带完整字段边框的主要书写区；取消在页脚左侧，提交在右侧。窄内容区的双语言字段改为纵向排列，标题、动作和长文本仍可达。源文件、文章和问题的空占位项只显示在尚未选择的触发器中，不作为菜单内可选记录。

各任务类型通过保留挂载的 `TaskFields` 页面切换，非活动页的 `fieldset` 被禁用，并由共享页面动效处理可见性与交互；这样隐藏的必填字段不会阻止当前任务提交。类型选择行留在切页区域之外，类型页中的上下文与书写区独立滚动，提交动作在固定页脚。类型切换不能导致外壳忽高忽低，也不能将非活动字段留在键盘焦点顺序中。

错误与版本冲突应保留用户输入。待确认保存使用同一项操作继续确认；不能因为视觉上恢复默认状态而清空草稿、重新生成提交身份或假装保存成功。Queue 当前的 `busy`、`pendingCommand` 与 `conflict` 有不同含义，应继续分别处理。

## 设置控件

来源：[ReadingSettings.jsx](../../prototypes/insight-composer/src/ReadingSettings.jsx)、[reading-settings.css](../../prototypes/insight-composer/src/reading-settings.css)。

- `.reading-control-row` 用左右排列的名称与控件组成一行，常见字号 13px × scale、上下 14px × scale；通过分隔线和组间距分组，不为每行加一张卡片。
- `.settings-switch` 当前为 34 × 21px × scale，圆点 15px × scale；选中用 `--accent`，圆点移动 13px × scale。开关保留可访问名称与即时状态。
- `.settings-choice-group` 使用真实 radio；容器为无描边浅灰，选中项为 `--action-selected` 较深灰与深字，不加阴影。界面模式、图标风格、色板预置遵循相同默认/选中层级。键盘 focus 落在实际 radio 上，并在可见选项上表达。
- `.reading-size-slider` 轨道高 4px × scale、滑块 15px × scale。数值通过 `output` 呈现，正文尺寸范围与 UI 比例见 [视觉基础](foundations.md)。
- Settings 打开时冻结自身使用的界面比例，拖动界面大小不会让当前弹窗持续改变尺寸；下次打开使用新比例。这是特定交互约定，不应无意中因 token 重构移除。

## 焦点与维护检查

普通输入、textarea 与 ReaderSelect 的默认完整边框为 `--ui-field-border: #d9dfe4`；hover 使用 `--ui-field-hover-border: #bdc7cf`。`focus-visible` 使用 `--ui-field-focus-border: #8c9daa`，配合 `0 0 0 3px var(--ui-field-focus-halo)`（`#8c9daa20`）的柔和光晕。hover 选择器明确排除 `:focus-visible`，保证鼠标仍停在控件上时不会盖掉焦点反馈；各状态都保持白色字段面。

原生文本框可能按浏览器语义在鼠标点击后仍匹配 `focus-visible`，不要用输入方式追踪器强行抹掉焦点。Picker 内键盘定位通过选项背景表达，触发器与当前选项是不同层级。

Collection 行内阅读状态与 Settings radio/色板的可见焦点代理仍使用 `--ui-focus-ring` / `--ui-focus-halo`；浅色按钮继续使用无描边浅灰填充。强制颜色模式中，字段与控件均保留系统 `Highlight` 焦点，不能为了视觉简化删除键盘可访问性。

修改相关控件时至少验证：

1. Tab / Shift+Tab 顺序、方向键与键入查找、Escape 先关闭 picker 再关闭弹窗；禁用与隐藏字段不被误选中。
2. 长选项、空列表、加载失败、必填校验、多行输入与较大界面比例；没有第二个横向滚动条或重复焦点框。
3. 任务类型位于表单第一行，标签列与下方字段对齐；切换类型和滚动时该行、标题和页脚保持位置。关闭后重开、错误和冲突恢复时，草稿与选择值按业务规则保留。
4. Picker 左右文字与触发器对齐，紧凑入口的短标签与勾选标记完整显示；靠近右边缘时菜单仍在视口内，滚动条不吃掉高亮边缘。保持原生文本选择与输入法。
5. 输入、select 和 textarea 在默认、hover、focus-visible 以及 hover 与焦点叠加时，都保留完整边框和白底；柔和光晕不被页面局部规则覆盖。

2026-10-30 的 Edge 无头浏览器检查按本次改动范围记录；任务类型位置调整后的控件复验已完成：

- [ui-controls.browser.mjs](../../prototypes/insight-composer/tests/ui-controls.browser.mjs)：本轮 26 组通过，无页面运行错误；新增三档类型行位置、五种标签的实际文字至箭头留白、键盘 Enter 只选择不提交、双 Escape 与焦点归还、短窗口滚动后类型行固定的检查。继续覆盖三档比例的白底完整浅边框、原生 select 等高、textarea 柔和焦点光晕与原生全选、hover 与焦点叠加、三档任务类型菜单及短窗口 120% 菜单、900×600 / 120% 的独立表单与正文滚动、固定提交页脚，以及五类型切换中间帧/固定外框、问答空态与刷新、编辑冲突恢复及未确认保存身份；同时复核标题/留白点击范围、双 Escape、busy 去重、Settings 比例作用域、无描边选择卡和强制颜色。
- [reader-select.browser.mjs](../../prototypes/insight-composer/tests/reader-select.browser.mjs)：此前字段和菜单宽度调整后 9 组通过，含 6 个右边缘场景，覆盖菜单最小宽度、原生键盘、值、焦点、StrictMode 挂载、picker 与弹窗 Escape、减少动态效果。
- [reader-select-alignment.browser.mjs](../../prototypes/insight-composer/tests/reader-select-alignment.browser.mjs)：此前字段和菜单宽度调整后三档比例的 33 个选择器组合与 3 个行内 radio 场景通过；按共享白底浅边框和柔和焦点光晕检查计算样式，复核菜单宽度、文字对齐与选项可达性。
- [collection-reading-status.browser.mjs](../../prototypes/insight-composer/tests/collection-reading-status.browser.mjs)：三档比例、busy 防重复写入、失败保留状态、键盘选择，以及 390px/320px 三档窄窗检查通过。

[queue-motion.browser.mjs](../../prototypes/insight-composer/tests/queue-motion.browser.mjs) 继续作为 Queue 动效维护入口。以上使用测试记录与模拟桌面 bridge，不代表真实个人资料或已安装 Electron 验收。
