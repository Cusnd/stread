# 表单、选择器与设置控件

[设计系统](README.md) · 更新于 2026-10-30

表单应让用户直接识别需要填写的内容。字段名保持简短，布局说明分组关系；辅助文字只用于必要条件、错误、冲突或恢复步骤。外观统一不能牺牲原生输入、文字选择、表单校验和键盘行为。

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
| `.workspace-field input/select/textarea` | 最小高 34px × scale；内边距 6px / 9px × scale，1px 细边，4px 圆角、白底 | textarea 最小高 82px × scale，行高 1.75，允许竖向调整 |
| Queue `.workspace-field` | 字段间距 18px × scale；标题间距 6px × scale、字重 500 | Queue 的局部覆盖 |
| Queue 字段输入 | 最小高 38px × scale；内边距 8px / 12px × scale、7px × scale 圆角、浅灰底、透明边框 | textarea 最小高 90px × scale、行高 1.8 |
| `.queue-source-selection .reader-select` | 最小高 40px × scale；与搜索、文字操作共享浅灰源文件容器 | 选择区不重复绘制第二个外框 |
| `.workspace-search` | 高 30px × scale、4px 圆角、白底细边；输入文字 11px × scale | `focus-within` 改变外壳边缘，内部 input 不再另画外框 |

来源：[workspace.css](../../prototypes/insight-composer/src/workspace/workspace.css)、[queue.css](../../prototypes/insight-composer/src/workspace/queue.css)。这些差异目前仍存在。新表单应复用场景所属的既有实现；将 Queue 的柔和输入推广到其他表单时，必须同时调整共享入口和记录迁移范围，不能只继续追加局部覆盖。

## ReaderSelect 的完整行为

共享选择器仍是原生 `<select>`。支持 `appearance: base-select` 时，组件只安装浏览器拥有的 `selectedcontent` 显示槽，选项仍由 React 管理；不支持时保留原生选择器。原生 picker 进入浏览器 top layer，可以用于弹窗内。样式在 [reader-select.css](../../prototypes/insight-composer/src/reader-select.css)。

| 部分 | 当前规则 |
| --- | --- |
| 触发器 | 默认白底、1px `--line`、4px × scale 圆角；横向文字内边距 10px × scale |
| picker | 与触发器同宽；最大高 `min(320px × scale, 100dvh - 24px)`；圆角 6px × scale、上下留白 4px × scale |
| 选项 | 最小高 30px × scale，内边距上下 6px、左右与触发器一致；长文字可换行 |
| 当前选项 | 选中背景、字重 500；checkmark 在行尾 |
| hover / 键盘定位 | 使用轻量背景，不增加第二层黑框；选中、hover 和键盘定位仍是不同状态 |
| disabled | 文字弱化、禁止选择；原生 disabled 语义不能仅替换成灰色 |
| Escape | picker 开着时，先交给浏览器关闭 picker，并阻止上层弹窗同时处理这一按键；不取消原生默认行为 |

弹窗焦点循环需要排除浏览器显示槽 `.reader-select-button`，防止出现第二个 Tab 停靠点。不要通过额外 JS 抢选区、重开 picker 或把焦点强行转回标签。源码中的 [shared.jsx](../../prototypes/insight-composer/src/workspace/shared.jsx) 已包含相应过滤。

## Queue 表单模式

[QueueTaskDialog.jsx](../../prototypes/insight-composer/src/workspace/QueueTaskDialog.jsx) 的 `TaskField` 使用一个可见 `span` 和 `aria-labelledby` 关联字段：只有点击控件内部才聚焦，点击标题或外围留白不再把焦点转入输入框。保持可访问名称时不要重新用覆盖整块区域的 `label` 还原该行为。它是 Queue 内部组件，尚未导出为全应用字段组件；文档不能宣称它已经替换所有工作区字段。

任务类型放在标题旁的紧凑 `ReaderSelect`；源文件选择、搜索与“上传新文件”等文字动作在同一区域。原文语言与输出语言并排，要求输入保持主要可用空间。不要重新加入大块任务类型导航、重复「已选择」标签或把上传改成纯图标。

各任务类型通过保留挂载的 `TaskFields` 页面切换，非活动页的 `fieldset` 被禁用，并由共享页面动效处理可见性与交互；这样隐藏的必填字段不会阻止当前任务提交。表单区独立滚动，提交动作在固定页脚。类型切换不能导致外壳忽高忽低，也不能将非活动字段留在键盘焦点顺序中。

错误与版本冲突应保留用户输入。待确认保存使用同一项操作继续确认；不能因为视觉上恢复默认状态而清空草稿、重新生成提交身份或假装保存成功。Queue 当前的 `busy`、`pendingCommand` 与 `conflict` 有不同含义，应继续分别处理。

## 设置控件

来源：[ReadingSettings.jsx](../../prototypes/insight-composer/src/ReadingSettings.jsx)、[reading-settings.css](../../prototypes/insight-composer/src/reading-settings.css)。

- `.reading-control-row` 用左右排列的名称与控件组成一行，常见字号 13px × scale、上下 14px × scale；通过分隔线和组间距分组，不为每行加一张卡片。
- `.settings-switch` 当前为 34 × 21px × scale，圆点 15px × scale；选中用 `--accent`，圆点移动 13px × scale。开关保留可访问名称与即时状态。
- `.settings-choice-group` 使用真实 radio；选中项为白底、深字及轻阴影，容器为浅灰。键盘 focus 落在实际 radio 上，并在可见选项上表达。
- `.reading-size-slider` 轨道高 4px × scale、滑块 15px × scale。数值通过 `output` 呈现，正文尺寸范围与 UI 比例见 [视觉基础](foundations.md)。
- Settings 打开时冻结自身使用的界面比例，拖动界面大小不会让当前弹窗持续改变尺寸；下次打开使用新比例。这是特定交互约定，不应无意中因 token 重构移除。

## 焦点差异与维护检查

当前并未形成单一焦点配方：通用 workspace 控件是深色 2px 外框，`ReaderSelect` 默认只加强现有边框，Queue 字段是浅 halo 与轻微底色变化，Settings radio 使用深色 outline。它们应在后续统一工作中一起比较。不要把“去掉黑线”解释成删除键盘焦点；应分别检查鼠标聚焦、键盘 `focus-visible`、picker 打开和选项定位。

修改相关控件时至少验证：

1. Tab / Shift+Tab 顺序、方向键与键入查找、Escape 先关闭 picker 再关闭弹窗；禁用与隐藏字段不被误选中。
2. 长选项、空列表、加载失败、必填校验、多行输入与较大界面比例；没有第二个横向滚动条或重复焦点框。
3. 切换任务类型、关闭后重开、错误和冲突恢复时，草稿与选择值按业务规则保留。
4. Picker 左右文字与触发器对齐，滚动条不吃掉高亮边缘；保持原生文本选择与输入法。

可复用的验证脚本包括 [reader-select.browser.mjs](../../prototypes/insight-composer/tests/reader-select.browser.mjs)、[reader-select-alignment.browser.mjs](../../prototypes/insight-composer/tests/reader-select-alignment.browser.mjs)、[queue-motion.browser.mjs](../../prototypes/insight-composer/tests/queue-motion.browser.mjs)、[collection-reading-status.browser.mjs](../../prototypes/insight-composer/tests/collection-reading-status.browser.mjs)。它们是维护入口，本次文档整理没有重新运行这些浏览器验证。
