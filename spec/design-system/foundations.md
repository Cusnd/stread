# 视觉基础

[设计系统](README.md) · 更新于 2026-10-30

本页记录界面外壳的颜色、字形、尺度与图标。共享入口为 [ui-tokens.css](../../prototypes/insight-composer/src/ui-tokens.css)，控件配方为 [ui-controls.css](../../prototypes/insight-composer/src/ui-controls.css)。正文、批注和作者内容另有阅读尺度，不能通过整体缩放来替代其专用设置。

## 设计约定

- 白色承载正文与主要工作面，浅灰承载导航和辅助区域；通过对齐、间距和少量分隔线建立层次。
- 相同信息角色使用相同颜色、字重与密度。先复用已有语义变量，再考虑新增变量；不要为一个页面另建近似灰色主题。
- 次要说明只用于解释必要的限制、结果或恢复办法。不要为了填充版面增加副标题、状态口号或装饰性标签。
- 彩色用于来源内容、批注和确实有语义的反馈。工作区导航与日常控件保持中性。
- 界面尺寸和阅读尺寸分开。用户调整正文大小时，工具栏不能一起变大；调整界面大小时，不改变来源内容与引用几何。

## 当前颜色变量

基础定义在 `ui-tokens.css`，由 [styles.css](../../prototypes/insight-composer/src/styles.css) 引入。工作区的 `--workspace-*` 在 [workspace.css](../../prototypes/insight-composer/src/workspace/workspace.css) 中映射到这些变量，并非另一套主题。Desktop Updates 已使用这些颜色、尺寸与按钮角色。

| 角色 | 变量 | 当前值 | 使用边界 |
| --- | --- | --- | --- |
| 阅读面 / 浮层 | `--surface-reading` / `--surface-floating` | `#ffffff` / `#ffffff` | 页面正文、弹窗、菜单 |
| 导航面 | `--surface-navigation` | `#f7f7f7` | 侧栏、辅助区域；不再用作普通输入或 Queue 要求的填充面 |
| 主要 / 次要 / 不可用文字 | `--text-primary` / `--text-secondary` / `--text-disabled` | `#252525` / `#686868` / `#989898` | 标题正文、元信息、不可用状态 |
| 分隔 / 浮层边界 | `--line` / `--border-floating` | `#e5e5e5` / `#d9d9d9` | 结构分隔与浮层边界 |
| 较强控件边界 | `--border-control` | `#919191` | 需要明确可操作边缘的控件 |
| 交互前景 / 悬停前景 | `--accent` / `--accent-hover` | `#303030` / `#111111` | 链接、选中前景、活动指示；不是品牌彩色 |
| 选中面 / 选中文字 | `--selected-surface` / `--selected-text` | `#f0f0f0` / `#242424` | 可持续的选中状态 |
| 悬停面 | `--hover-surface` | `#f3f3f3` | 临时指针反馈，不代替选中状态 |
| 操作面 / 悬停面 / 边界 | `--action-surface` / `--action-hover` / `--action-border` | `#f1f1f1` / `#e8e8e8` / `transparent` | 浅灰无描边操作按钮，禁止恢复黑边白底样式 |
| 操作选中面 | `--action-selected` | `#dedede` | 图标、界面模式、色板预置、快捷键录入等有持续状态的控件，使用较深灰区分选中 |
| 不可用面 / 原生文字选区 | `--disabled-surface` / `--selection` | `#ededed` / `#dedede` | 不可用操作、文本选择 |
| 键盘焦点 / 光晕 | `--ui-focus-ring` / `--ui-focus-halo` | `#737b83` / `#737b8324` | 1px 外框、2px 外偏移与浅光晕；`--focus-halo` 为兼容别名 |
| 字段面 / 默认边框 | `--ui-field-surface` / `--ui-field-border` | `#fff` / `#d9dfe4` | 普通输入、选择器与 textarea 使用白底和完整 1px 浅边框 |
| 字段悬停边框 | `--ui-field-hover-border` | `#bdc7cf` | 只在非 disabled、非 focus-visible 的 hover 状态使用，避免盖掉焦点反馈 |
| 字段焦点边框 / 光晕 | `--ui-field-focus-border` / `--ui-field-focus-halo` | `#8c9daa` / `#8c9daa20` | focus-visible 沿原有完整外框反馈，并增加 3px 柔和光晕；字段面保持白色 |
| 错误文字 / 背景 / 边界 | `--ui-error-text` / `--ui-error-surface` / `--ui-error-border` | `#923f38` / `#fff7f5` / `#e8cecb` | 错误反馈与更新错误；不可用于装饰普通操作 |

`--action-shadow` 为 `none`，普通浅色按钮不加阴影描边；`--shadow-floating` 当前为 `0 8px 28px #24282d0f, 0 2px 6px #24282d08`。浮层边界与按钮边界是不同角色，不能用浮层阴影重新给浅色按钮描边。

批注的 amber、green、blue、rose 有独立颜色变量，用户还可修改色板。不要将批注色替换为选中背景，也不要用错误色装饰普通操作。

## 字体与层级

| 场景 | 当前代表规则 | 维护要求 |
| --- | --- | --- |
| 应用界面 | `Noto Sans SC, Microsoft YaHei, system-ui, sans-serif`；`.workspace-ui` 默认 `12px × --ui-scale`，行高 `1.5` | 字体按系统回退；输入控件继承界面字体 |
| 工作区标题 | `.workspace-catalog-heading h1`：`15px × scale`、字重 `600` | 用短标题识别当前内容，不增加重复的页面介绍 |
| 普通弹窗标题 | `.workspace-dialog-heading h2`：`--ui-font-label`（13px × scale）、字重 `600` | 简单表单使用紧凑标题 |
| Settings / Queue 标题 | Settings：`18px × scale`、`550`；Queue：`17px × scale`、`600` | 设置面板与紧凑任务编辑器分别保留居中 / 左对齐标题；外壳角色与生命周期使用共享模态实现 |
| 次要信息 | 工作区常见 `11px × scale`，计数使用 `tabular-nums` | 仅用于实际元信息，不以小字堆叠解释布局 |
| 阅读正文 | 中文使用 `Noto Serif SC, SimSun, serif`，英文使用 `Georgia, Times New Roman, serif`；字号取 `--reading-size` | `.paper-reader .article p.paper-text` 默认行高 `1.9`，英文段落覆盖为 `1.78`；不要套用工作区行高 |

阅读设置默认正文为 `20px`，可在 `14–24px` 之间调整；正文宽度默认 `80%`，范围 `50–100%`、步长 `5%`。来源见 [reading-preferences.js](../../prototypes/insight-composer/src/reading-preferences.js)、[paper-article.css](../../prototypes/insight-composer/src/paper-article.css)。对象跟随正文或单独字号的规则见 [统一样式](../统一样式.md)，不能用全局 UI token 覆盖内容语义。

## 尺度、留白与圆角

界面设置中的 **80% 是当前紧凑设计基线**。运行时公式为 `--ui-scale = percent / 80`，所以 80% 对应 `1`，100% 对应 `1.25`，120% 对应 `1.5`；允许范围为 80–120%，步长 5%。来源见 [ui-scale.js](../../prototypes/insight-composer/src/ui-scale.js) 和 [InterfaceScale.jsx](../../prototypes/insight-composer/src/InterfaceScale.jsx)。本组文档中的基础像素值默认指 `--ui-scale: 1`。

| 类别 | 当前代表值 | 说明 |
| --- | --- | --- |
| 字号 | `--ui-font-small/control/label/heading`：11 / 12 / 13 / 16px × scale | 元信息、控件、标签、内容标题；正文不使用这些变量 |
| 按钮与字段 | `--ui-control-height/action-height/tool-size/compact-size/field-height`：34 / 36 / 30 / 28 / 38px × scale | 入口、提交/阅读、工具、紧凑工具、表单字段；长按钮文字可撑高 |
| 间距 | `--ui-space-inline/control/section/panel`：6 / 12 / 18 / 24px × scale | 图文间隔、控件内边距、分组、面板内边距 |
| 字段内边距 | `--ui-field-padding-inline`：10px × scale | 普通输入与选择器的横向内边距；textarea 四边使用这一尺度 |
| 圆角 | `--ui-radius-control/field/surface/dialog/panel`：4 / 6 / 7 / 8 / 14px × scale | 控件、字段、选择/反馈表面、普通弹窗、固定面板 |

这些变量按重复角色命名，不将每个局部数字各命名为一个 token。局部 CSS 继续负责布局与内容所需的差异；共享按钮、表单与 Desktop Updates 不另写一份配色或命中区配方。作者内容中的 `--reader-space-*` 是内容布局合同，不属于界面组件 spacing token。

表单使用白底、完整 1px 浅边框与 6px × scale 圆角；input、select 和 textarea 共用默认、hover 与柔和焦点光晕。普通输入上下内边距为 8px × scale、左右为 10px × scale，textarea 四边为 10px × scale。Queue 保持 `560 × 420px × scale` 的紧凑外框，上下文行用 8px × scale 间距组织，不加组结束分隔线；其 textarea 保留完整字段边界并禁用 resize。色板、引用操作和反馈容器使用独立的 `--ui-radius-surface`，避免字段调整连带改变这些角色。

共享下拉菜单以触发器宽度作为基准，并保留 `min(160px × scale, 100dvw - 16px)` 的最小宽度；紧凑触发器不会把完整短标签与勾选标记挤成多行。菜单最大宽度为视口减 16px，靠近右边缘时继续使用原生定位回退；具体规则见[表单与选择器](forms.md)。

派生尺寸同时定义于 `:root` 与 `[data-ui-scale-scope]`。Settings 打开时冻结自身 `--ui-scale`，作用域内重新计算派生长度，防止根节点缩放后的 px 值穿透进已打开的设置面板；关闭后再打开才采用新比例。

图标族、文字取舍和可访问名称见 [图标、文案与可访问性](icons-accessibility.md)；图标尺寸不等于按钮命中区域，后者见 [按钮](buttons.md)。

## 维护与验证

- Desktop Updates 的配色、字体、尺寸与操作已接入共享变量；[desktop-updates.css](../../prototypes/insight-composer/src/desktop-updates.css) 仅保留更新内容的布局与进度条样式。
- 共享 token 不表示所有专属图形都要相同；Settings 开关、色板和来源内容仍有其形状。组件名称相近不代表计算样式相同，记录数值时要检查后置覆盖。
- 修改基础变量时同时查看 Collection、Flow、Queue、Reader、Settings；分别检查默认和较大界面比例。检查文字截断、窄窗按钮拥挤和图标命中区域，不只检查单张默认尺寸截图。
- 2026-10-30，完整字段边框与菜单最小宽度调整的上一轮 [ui-controls.browser.mjs](../../prototypes/insight-composer/tests/ui-controls.browser.mjs) Edge 无头复验 26 组通过，无页面运行错误；覆盖 80/100/120% 白底完整浅边字段、textarea 焦点光晕和原生全选、hover 与焦点叠加、三档任务类型菜单与短窗口 120% 菜单、900×600 / 120% 表单独立滚动与固定页脚、原生选择器和字段点击范围、Collection 状态及防重复操作、更新各状态、Settings 冻结比例与重开、选择卡及可见焦点代理、遗留按钮 hover、窄布局与强制颜色。选择器另通过 9 组基础检查（含 6 个右边缘场景）及 33 个选择器组合、3 个行内 radio 场景。本记录早于任务类型移至表单首行，该位置调整的本轮证据见[表单验证入口](forms.md#焦点与维护检查)。数据与桌面更新 bridge 为测试替身，不代表已安装 Electron 或真实更新服务验收。
