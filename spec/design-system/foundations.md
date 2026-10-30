# 视觉基础

[设计系统](README.md) · 更新于 2026-10-30

本页记录界面外壳的颜色、字形、尺度与图标。表中的数值来自当前源码；它们是维护入口，不代表所有页面已经使用同一套组件。正文、批注和作者内容另有阅读尺度，不能通过整体缩放来替代其专用设置。

## 设计约定

- 白色承载正文与主要工作面，浅灰承载导航和辅助区域；通过对齐、间距和少量分隔线建立层次。
- 相同信息角色使用相同颜色、字重与密度。先复用已有语义变量，再考虑新增变量；不要为一个页面另建近似灰色主题。
- 次要说明只用于解释必要的限制、结果或恢复办法。不要为了填充版面增加副标题、状态口号或装饰性标签。
- 彩色用于来源内容、批注和确实有语义的反馈。工作区导航与日常控件保持中性。
- 界面尺寸和阅读尺寸分开。用户调整正文大小时，工具栏不能一起变大；调整界面大小时，不改变来源内容与引用几何。

## 当前颜色变量

基础定义在 [styles.css](../../prototypes/insight-composer/src/styles.css) 的 `:root`。工作区的 `--workspace-*` 在 [workspace.css](../../prototypes/insight-composer/src/workspace/workspace.css) 中映射到这些变量，并非另一套主题。

| 角色 | 变量 | 当前值 | 使用边界 |
| --- | --- | --- | --- |
| 阅读面 / 浮层 | `--surface-reading` / `--surface-floating` | `#ffffff` / `#ffffff` | 页面正文、弹窗、菜单 |
| 导航面 | `--surface-navigation` | `#f7f7f7` | 侧栏、辅助区域、Queue 输入面 |
| 主要 / 次要 / 不可用文字 | `--text-primary` / `--text-secondary` / `--text-disabled` | `#252525` / `#686868` / `#989898` | 标题正文、元信息、不可用状态 |
| 分隔 / 浮层边界 | `--line` / `--border-floating` | `#e5e5e5` / `#d9d9d9` | 结构分隔与浮层边界 |
| 较强控件边界 | `--border-control` | `#919191` | 需要明确可操作边缘的控件 |
| 交互前景 / 悬停前景 | `--accent` / `--accent-hover` | `#303030` / `#111111` | 链接、选中前景、活动指示；不是品牌彩色 |
| 选中面 / 选中文字 | `--selected-surface` / `--selected-text` | `#f0f0f0` / `#242424` | 可持续的选中状态 |
| 悬停面 | `--hover-surface` | `#f3f3f3` | 临时指针反馈，不代替选中状态 |
| 操作面 / 悬停面 / 边界 | `--action-surface` / `--action-hover` / `--action-border` | `#ffffff` / `#f5f5f5` / `#b8b8b8` | 当前白底操作按钮 |
| 不可用面 / 原生文字选区 | `--disabled-surface` / `--selection` | `#ededed` / `#dedede` | 不可用操作、文本选择 |
| 浅焦点光晕 | `--focus-halo` | `#30303012` | 部分控件的轻量焦点反馈；当前并未全局统一 |

`--action-shadow` 当前为 `0 1px 2px #00000008`，用于轻量控件；`--shadow-floating` 当前为 `0 8px 28px #24282d0f, 0 2px 6px #24282d08`。弹窗仍有局部阴影，不能把这两个值解释成已覆盖全应用的唯一阴影等级。

批注的 amber、green、blue、rose 有独立颜色变量，用户还可修改色板。不要将批注色替换为选中背景，也不要用错误色装饰普通操作。

## 字体与层级

| 场景 | 当前代表规则 | 维护要求 |
| --- | --- | --- |
| 应用界面 | `Noto Sans SC, Microsoft YaHei, system-ui, sans-serif`；`.workspace-ui` 默认 `12px × --ui-scale`，行高 `1.5` | 字体按系统回退；输入控件继承界面字体 |
| 工作区标题 | `.workspace-catalog-heading h1`：`15px × scale`、字重 `600` | 用短标题识别当前内容，不增加重复的页面介绍 |
| 普通弹窗标题 | `.workspace-dialog-heading h2`：`13px × scale`、字重 `600` | 当前通用弹窗仍比 Settings / Queue 小，属于尚未收敛的层级 |
| Settings / Queue 标题 | Settings：`18px × scale`、`550`；Queue：`17px × scale`、`600` | 数值与布局不同，不能宣称统一标题样式已经落地 |
| 次要信息 | 工作区常见 `11px × scale`，计数使用 `tabular-nums` | 仅用于实际元信息，不以小字堆叠解释布局 |
| 阅读正文 | 中文使用 `Noto Serif SC, SimSun, serif`，英文使用 `Georgia, Times New Roman, serif`；字号取 `--reading-size` | `.paper-reader .article p.paper-text` 默认行高 `1.9`，英文段落覆盖为 `1.78`；不要套用工作区行高 |

阅读设置默认正文为 `20px`，可在 `14–24px` 之间调整；正文宽度默认 `80%`，范围 `50–100%`、步长 `5%`。来源见 [reading-preferences.js](../../prototypes/insight-composer/src/reading-preferences.js)、[paper-article.css](../../prototypes/insight-composer/src/paper-article.css)。对象跟随正文或单独字号的规则见 [统一样式](../统一样式.md)，不能用全局 UI token 覆盖内容语义。

## 尺度、留白与圆角

界面设置中的 **80% 是当前紧凑设计基线**。运行时公式为 `--ui-scale = percent / 80`，所以 80% 对应 `1`，100% 对应 `1.25`，120% 对应 `1.5`；允许范围为 80–120%，步长 5%。来源见 [ui-scale.js](../../prototypes/insight-composer/src/ui-scale.js) 和 [InterfaceScale.jsx](../../prototypes/insight-composer/src/InterfaceScale.jsx)。本组文档中的基础像素值默认指 `--ui-scale: 1`。

| 类别 | 当前代表值 | 说明 |
| --- | --- | --- |
| 相邻图标与文字 | 6–8px | 按组件既有 `gap`；不要逐个图标增加补偿空格 |
| 操作组 | 6–10px | 主次关系优先通过位置与按钮角色表达 |
| 内容边距 | 工作区 20–26px，Settings / Queue 22–24px | 不是已实现的全局 spacing token 表 |
| 紧凑控件圆角 | 常见 4px；Reader 图标基础 5px | 目前存在固定值和乘 scale 的混用 |
| Queue 输入 / Settings 分段容器 | 7px × scale | 局部组件样式，不自动推广到所有输入框 |
| Settings / Queue 外壳 | 14px × scale | 参见弹窗文档，窄视口另有约束 |

应用外壳目前没有统一的间距、圆角、字号 token 刻度表。作者内容中的 `--reader-space-*` 是内容布局合同，不能冒充界面组件的 spacing token。后续收敛应从重复使用的语义角色抽取，避免把每一个现有数字各命名为一个变量。

图标族、文字取舍和可访问名称见 [图标、文案与可访问性](icons-accessibility.md)；图标尺寸不等于按钮命中区域，后者见 [按钮](buttons.md)。

## 尚未统一与维护检查

- Desktop Updates 的颜色与尺寸仍在 [desktop-updates.css](../../prototypes/insight-composer/src/desktop-updates.css) 硬编码，未全面接入颜色变量与界面比例。
- 字号、圆角、阴影和间距仍分布在局部 CSS。组件名称相近不代表计算样式相同；记录数值时要检查更具体的选择器与后置覆盖。
- 修改基础变量时同时查看 Collection、Flow、Queue、Reader、Settings；分别检查默认和较大界面比例。检查文字截断、窄窗按钮拥挤和图标命中区域，不只检查单张默认尺寸截图。
- 本页是源码基线说明；本次文档整理没有重新执行浏览器或已安装桌面视觉验收。
