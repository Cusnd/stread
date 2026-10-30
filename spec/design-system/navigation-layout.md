# 导航、布局与列表

[设计系统](README.md) · 更新：2026-10-30

本页记录当前工作区与 Reader 的空间关系、导航方式和状态连续性。尺寸来自当前源码，均以 `--ui-scale: 1` 为基准；它们是已有实现的参照，不意味着每一种页面差异都应继续保留。

## 页面职责与共同骨架

| 场景 | 当前组织 | 应保持的体验 |
| --- | --- | --- |
| Collection | 默认工作区；分类导航、资料列表、所选资料详情 | 先浏览与选择，再进入阅读；查找条件和选中项有稳定位置 |
| Flow | 与 Collection 并列；概览、洞见、阅读计划、历史；按内容显示右侧栏 | 回顾真实活动与洞见，安排阅读；各分区保留自己的位置 |
| Queue | 与前两者并列；任务类型、状态筛选、可展开的任务列表 | 在任务原位置查看要求与结果；编号、复制、撤回等动作含义明确 |
| Reader | 文档视图；阅读顶栏、目录、正文与边注、可开启的侧面板 | 将空间优先留给正文；返回打开它的工作区 |
| 文章笔记 | 从 Reader 进入的文档笔记视图 | 返回当前文章的阅读上下文，或定位笔记对应来源 |

工作区的同级导航共用中性浅灰选中面（`--selected-surface`）与文字强调，不用白底描边或阴影装饰导航按钮；悬停不替代 current，键盘焦点使用独立 focus 标识。内容标题统一 `--ui-font-heading`（`16px × scale`），常规标题区高 `65px × scale`；常规左右内边距 `26px × scale`，紧凑布局为 `20px × scale`。

工作区共用 [WorkspaceHeader](../../prototypes/insight-composer/src/workspace/WorkspaceHeader.jsx)。左侧是导航开关与 Collection / Flow / Queue，右侧是设置、引用定位、修订及当前页面的添加动作。选中页面使用文字强调与底线，不给三个工作区各做一套顶栏。链接保留真实 `href`，修饰键点击仍遵循链接行为；键盘提供跳至内容入口。

Reader 不加入第四个工作区标签。其返回文字随来源显示“返回资料库”“返回 Flow”或“返回 Queue”；没有来源的直接打开回到 Collection。具体实现在 [WorkspaceApp](../../prototypes/insight-composer/src/WorkspaceApp.jsx) 与 [related-navigation](../../prototypes/insight-composer/src/related-navigation.js)。

## 当前布局参照

| 对象 / 选择器 | 当前代表值 | 使用范围 |
| --- | --- | --- |
| `.workspace-header`；Reader `--top-height` | 高 `56px × scale` | 顶部工具区的共同高度 |
| 工作区左导航；Reader 默认 `--nav-width` | 宽 `184px × scale` | 常规窗口下的导航列；Reader 可由窄窗口规则调整 |
| `.workspace-collection` | `184px / minmax(0, 1fr) / 306px`，固定两侧乘 scale | Collection 常规三栏；收起导航后左列为 0 |
| Collection 紧凑详情列 | `286px × scale` | `1100 × scale` 及以下进入紧凑布局 |
| Flow 右栏 | 概览默认 `364px × scale`；洞见通常 `306px × scale`，窄窗口为 `286px × scale` | 可拖动，最小 `260px × scale`，最大值同时受用途和可用宽度限制；可用内容宽不足 `560px × scale` 时切换为紧凑内容布局 |
| `.queue-page` | 左导航 + 剩余内容区 | 任务详情在行内展开，没有固定第三栏 |
| `.workspace-document-row` | 高 `58px × scale` | Collection 单行标题、元信息、状态 |
| `.queue-task-summary` | 最小高 `69px × scale` | Queue 标题、任务编号、时间与展开操作；窄容器可增高 |

Flow 实页与加载壳共用 [workspace-layout](../../prototypes/insight-composer/src/workspace/workspace-layout.js) 的 `flowPanelLayout`，依据分区、选择、保存的面板宽度、界面比例和实际内容宽度生成相同列布局。加载完成不能从不相关的默认三栏开始播放一次布局动画。

源码：[workspace.css](../../prototypes/insight-composer/src/workspace/workspace.css)、[FlowPage](../../prototypes/insight-composer/src/workspace/FlowPage.jsx)、[flow.css](../../prototypes/insight-composer/src/workspace/flow.css)、[queue.css](../../prototypes/insight-composer/src/workspace/queue.css)、[styles.css](../../prototypes/insight-composer/src/styles.css)。

统一的是对齐、视觉层级和动作含义，不是把文章正文、资料列表和任务要求压成同一种行高。Reader 正文宽度、边注及原页面板受阅读偏好与可用空间控制，不应直接套用工作区表格列宽。

## 列表、详情与选择

- **Collection**：单击选择资料并显示详情，双击进入阅读。上下方向键、Home / End 移动选择；右键及 Shift+F10 / 菜单键打开相同上下文操作。窄窗口将详情改为弹窗，单击触发详情有短暂延迟以容纳双击；“资料详情”按钮提供明确入口。
- **Flow**：分区导航、筛选、选中洞见与详情分别有状态。概览右侧的阅读计划和待回顾列表各自滚动；洞见详情宽度可用拖动或键盘调整。保留详情里的原文定位及编辑入口。
- **Queue**：摘要整行响应悬停，点击行内非独立控件区域、标题或展开按钮均可控制当前任务详情；任务编号提供独立复制操作。不要在任务摘要旁恢复已移除的装饰性文件图标。选择标题文字时不得误触展开，点击复制或链接不能同时切换展开状态。展开状态用 `aria-expanded` 和 `aria-controls` 表达。
- **通用规则**：选中态、展开态、悬停态、键盘焦点含义不同。颜色和背景可以协同，但不能只靠颜色告知当前对象。对详情仍有用的内容不因列表更新而突然消失；异步结果先核对当前目标。

Collection 详情中的“未读 / 在读 / 已读”目前是底线指示的行内单选控件，和列表顶部用于筛选的按钮不是同一语义。保留显式操作改变阅读状态的边界：保存阅读位置不代表读完，查看已读文章的来源也不应自动开始新一轮阅读。

实现入口：[CollectionPage](../../prototypes/insight-composer/src/workspace/CollectionPage.jsx)、[MaterialDetails](../../prototypes/insight-composer/src/workspace/MaterialDetails.jsx)、[FlowPage](../../prototypes/insight-composer/src/workspace/FlowPage.jsx)、[QueuePage](../../prototypes/insight-composer/src/workspace/QueuePage.jsx)。

## 滚动与往返

工作区采用固定可视高度中的独立内容滚动。导航、列表、详情不能互相带动；列表使用 `min-height: 0`、稳定滚动槽及边界滚动约束，退出动画不得制造第二条横向滚动条。Reader 正文使用自己的阅读位置与来源锚点，目录、PDF 和洞见面板按各自内容滚动。

| 状态 | 当前保存方式 / 行为 | 维护时不能破坏的规则 |
| --- | --- | --- |
| 工作区导航展开 | [workspace-navigation](../../prototypes/insight-composer/src/workspace-navigation.js) 保存宽窗口共享偏好；`WorkspaceApp` 管理窄窗口临时展开 | Collection、Flow、Queue 共用宽窗口偏好；切入窄窗口、临时关闭与切页不覆盖它；Reader 目录是独立偏好 |
| 工作区查找与选择 | `WorkspaceApp` 管理各页视图；[workspace-api](../../prototypes/insight-composer/src/workspace-api.js) 读写会话视图 | 切页面与 Reader 往返不清空筛选、选择和现有草稿 |
| Collection 列表 | `listScrollTop` | 返回恢复；主动改变筛选才回到列表顶部 |
| Flow 各分区 | 分区滚动、右侧详情滚动、概览两个预览滚动分别记录；紧凑概览另存 `compactOverviewScrollTop` | 数据就绪后恢复，不把所有区域合成一个位置；紧凑概览的父容器恢复不能抢回用户已移动的位置 |
| Queue 列表 | `scrollTop`；[queue-scroll](../../prototypes/insight-composer/src/workspace/queue-scroll.js) 等待内容与展开高度恢复 | 图片加载与详情展开不提前覆盖保存值；用户滚动、点击或键盘操作可打断恢复 |
| Reader 来源与位置 | 浏览历史条目记录来源、文章位置及相关文章路径 | 返回恢复原工作区；新导航使旧异步完成失效；正文选区和输入草稿不被后台更新重建 |

导航恢复焦点时使用已有 `data-focus-key`，只定位仍可见、可用且不在 `inert` 区域中的元素，并避免因聚焦额外滚动。删除当前项时，需要合理的相邻项或内容标题作为回落目标。不能用恢复机制持续夺回用户已经移动的焦点和滚动位置。

## 窄窗口与缩放

三个工作区在 `640px × scale` 及以下使用临时导航，均复用 `WorkspaceDialog` 的边侧导航容器。顶栏开关打开导航后，焦点进入当前导航项；Tab 留在模态内，Escape 或选择导航项关闭并返回顶栏开关。底层内容由原生模态隔离，不能在弹层后误操作。调整回宽窗口会退出临时导航并恢复宽窗口偏好，不能把一次临时关闭写成永久收起。

Collection 在 `980px × scale` 以下将固定详情栏改为详情弹窗。Flow 和 Queue 分别根据实际内容可用空间继续处理内部布局：

- **Flow**：内容区不足 `560px × scale` 时，总览的活动、阅读计划和待回顾区域纵向排列；每个列表保留自己的滚动，父容器也可滚动。洞见列表的已选项在详情弹窗中展示，避免右栏最小宽度挤没主列表。扩大窗口后恢复可调整宽度的侧栏。
- **Queue**：内容区在 `760px × scale` 以下收紧预览布局，在 `540px × scale` 以下将搜索移至下一行、标题允许换行、隐藏次要的创建时间，详情与预览纵向排列。阈值依据 `ResizeObserver` 读取的实际宽度，不把视口宽度直接当作内容宽度。
- **共同限制**：布局折叠不丢失内容和操作；窄窗口标题区可以随搜索换行增高，不能为了固定 `65px` 将输入框挤出可视区域。界面比例的基准是 80%（scale 1），100% 对应 1.25，120% 对应 1.5。

设置内调整比例可能让后台 Flow 进入紧凑布局。此时新开的洞见详情必须等待全局浮层的原生 `close` 事件，不能在设置退场期间抢占顶层；已经位于设置下方的详情保持打开。等待期间取消选择、切换分区或恢复宽布局会取消过期的开窗请求。

## 已收敛的差异与保留的职责

DS-06 的同级导航选中面、标题字号、标题区高度与左右对齐已共用配方。DS-07 的导航阈值和 Queue 内容阈值均与界面比例联动，临时导航不再写入宽窗口偏好。DS-09 的 Flow 加载壳按保存视图与实际宽度生成布局，Queue 未取得数据的计数保留空位并从辅助技术隐藏，成功读取后才显示真实数字。

Collection 固定资料详情、Flow 可调右栏和 Queue 行内展开继续保留。这些结构服务不同内容，并不要求所有页面始终具有相同列数。后续新变体仍须说明职责，不能重新引入同级导航或标题的私有样式覆盖。

## 修改后的检查

- 从三个工作区各打开一篇文章，再返回；比较筛选、选中项、展开任务、各滚动区及焦点。
- 列表有长标题、空筛选结果、图片延迟加载、删除或撤回所选项时，检查布局和焦点是否稳定。
- 用键盘选择行、进入详情、复制编号、关闭临时面板；同时检查文本仍能原生选中。
- 在普通和放大界面缩放、常规和窄窗口下检查列宽、标题折行及入口可达性。
- 相关现有检查包括 [workspace-navigation.test](../../prototypes/insight-composer/tests/workspace-navigation.test.mjs)、[queue-navigation.test](../../prototypes/insight-composer/tests/queue-navigation.test.mjs)、[queue-scroll.test](../../prototypes/insight-composer/tests/queue-scroll.test.mjs)、[related-navigation.test](../../prototypes/insight-composer/tests/related-navigation.test.mjs) 与 [reader-navigation.browser](../../prototypes/insight-composer/tests/reader-navigation.browser.mjs)。按实际修改选择运行，这些检查覆盖状态模型，不替代浏览器或 Electron 验收。

## 本次验证记录（2026-10-30）

在独立测试工作树、合成资料与无头 Edge 中运行 [workspace-design-system.browser](../../prototypes/insight-composer/tests/workspace-design-system.browser.mjs)，覆盖三工作区 80% / 100% / 120% 界面比例、宽与紧凑标题对齐、Flow 四分区加载壳到首帧及稳定布局、三个工作区的窄窗口键盘导航与返回焦点、调整窗口恢复导航偏好、紧凑 Flow 滚动恢复与详情弹窗、慢响应前用户滚动接管恢复、Queue 原生选区和展开动画中间帧、实时减少动态效果。

[flow-settings-modal.browser](../../prototypes/insight-composer/tests/flow-settings-modal.browser.mjs) 将真实 Flow、设置和界面缩放组件一起运行，检查 1000px 窗口内从 80% 调至 120% 时设置始终可操作，新详情在设置实际退出后打开，已有下层详情保留，以及选择、分区和宽度变化取消待开请求。

[queue-motion.browser](../../prototypes/insight-composer/tests/queue-motion.browser.mjs) 已通过 80% / 120% 展开、收起、中途反向、分类切换、480px 窄窗口、预览失败、滚动中的任务切换，以及整行悬停、点击、原生选择与键盘操作检查。

[queue-loading.browser](../../prototypes/insight-composer/tests/queue-loading.browser.mjs) 验证慢请求下未知计数不显示 0、有效空结果与错误的区分、失败重试、后台安静刷新、快速切换和卸载取消。`queue-scroll`、`queue-navigation`、`workspace-navigation` 三组单元检查共 16 项通过。

这是浏览器组件与状态行为证据，未据此宣称安装版、真实用户资料或真实服务提供方已经验收。完整应用往返与桌面验证单独记录。

本轮桌面布局目标遵循 [Electron 窗口约束](../../electron/main.cjs) 的最小 `900 × 600`，并覆盖三档界面比例；另以 `700px / 120%` 完成更窄的浏览器检查。`320px / 390px` 视口配合 120% 的浏览器压力检查仍存在顶栏横向溢出，已超出当前原生窗口允许范围，本轮不扩展为移动端或两行顶栏设计。
