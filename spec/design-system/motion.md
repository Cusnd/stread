# 动效与状态连续性

[设计系统](README.md) · 相关：[弹窗与浮层](overlays.md)

实现核对：2026-10-30。现行实现的入口是 [motion-system.js](../../prototypes/insight-composer/src/motion-system.js)、[Motion.jsx](../../prototypes/insight-composer/src/Motion.jsx)、[motion.css](../../prototypes/insight-composer/src/motion.css)。普通模态共用 [useModalDialog.js](../../prototypes/insight-composer/src/useModalDialog.js)。[连续动效系统](../连续动效系统.md) 保留更完整的设计背景和历史验收说明。

## 动效表达什么

界面的业务目标立即改变，可见对象连续到达新状态。选中背景移向新目标，列表给增删项让位，弹窗完整进退，局部反馈占据并释放自己的空间。动效不延后保存或输入，不伪造业务进度。

同类变化使用同一运动规则；不同操作保留各自的空间关系。侧栏从所属边缘出现，居中弹窗在中心附近进退，菜单原地淡入，设置和任务类型按顺序轻微横移。统一体验不要求所有元素使用一种动画。

不额外动画化光标、原生选区、滚动条、用户滚动、拖动和尺寸拖拽。这些操作本身已经连续，补间会产生操作滞后。后台计时或无可见差异的更新也无需装饰动画。

## 共用参数与实现归属

空间变化采用接近临界阻尼的弹簧；实际时长随距离、速度及停止阈值变化。不要把下面的参数解释成固定播放时长。

| `motionTransition(kind)` | stiffness / damping / mass | 使用场景 |
| --- | --- | --- |
| `control` | 600 / 45 / 0.7 | 页签与分段控件的选中指示 |
| `content` | 500 / 45 / 0.8 | 内容页交接、短提示 |
| `disclosure` | 180 / 28 / 1 | Queue 任务详情等需要更充分表达高度变化的内容；透明度采用 200ms |
| `surface` | 420 / 42 / 1 | 弹窗与普通浮层 |
| `panel` | 360 / 38 / 1 | 工具侧栏 |
| `layout` | 300 / 35 / 1 | 列表项增删与位置重排 |

共享透明度 `MOTION_FADE` 为 140ms linear；`disclosure` 例外为 200ms。弹簧停止阈值为 `restDelta: 0.25`、`restSpeed: 4`，避免已经不可见的长尾持续占用模态输入锁。新增场景先选现有 kind；确实需要修改全局节奏时修改统一来源，并复核所有消费者。

`installMotionCssTokens` 从 `MOTION_FADE` 安装 `--motion-fade-duration` 和 `--motion-fade-ease`；ReaderSelect picker、洞见动作菜单、Reader 导航菜单和图片 Viewer 的显隐均消费这两个变量，不再分别写 140ms。直接引入这些 CSS 的独立组件也要加载参数模块，不能依赖另一页恰好完成初始化。普通原生模态的背景不启动 CSS 计时器，而是直接消费面板 opacity MotionValue。

CSS 颜色、边框、阴影等控件反馈由 `motion.css` 管理，普通反馈使用 `--motion-control: 120ms`。同文件还定义 feedback 160ms、content 200ms、surface 300ms、layout 360ms 等 CSS 变量；这些是 CSS 时长，不能用来替代同名 Motion 弹簧。不得使用 `transition: all`，也不要在同一属性上叠加 CSS transition 与 Motion。

### 现有组件的职责

| 组件或 hook | 负责的连续性 | 调用方仍需负责 |
| --- | --- | --- |
| `ContinuousMotion` | 默认 Motion 配置与系统 reduced-motion 偏好 | 选择合适的场景和组件 |
| `MotionItem` | 列表布局、进入退出、退出中的 inert/aria-hidden | 稳定业务 ID、列表语义、真实数据更新 |
| `MotionSelection` | 同一个选中背景在控件之间运动 | 稳定 `layoutId`、选中状态与可访问语义 |
| `MotionPanelPage` | 常驻页面的透明度和水平偏移；隐藏页 inert | 固定外框、每页滚动、正确 `active` 与顺序 |
| `MotionPanelIndicator` | 持续存在的页签指示器 | 当前指标位置 |
| `MotionNotice` | 固定提示的进入退出，保留 CSS 居中 transform | 真实结果、持续时间与撤销业务 |
| `MotionFeedback` | 局部提示高度与透明度，退出时保留上一份内容 | 合适的 status/alert 语义 |
| `useMotionPresence` | 保留实例直到实际退出完成；变更目标及代次保护 | 焦点、inert、原生 dialog/popover 生命周期、背景、滚动锁、退出期间的数据 |
| `useModalDialog` | 在 presence 上统一原生顶层、背景进度、inert、Tab 环绕、返回焦点和计数滚动锁 | 业务关闭入口、初始与返回焦点目标、退出期间的数据和所属内容布局 |

`useMotionPresence` 不是完整弹窗组件。普通模态应复用 `useModalDialog`，不各自复制滚动锁、原生 dialog 及背景状态；菜单和图片 Viewer 按自己的语义接入共享动效参数。

## 可打断的生命周期

打开与关闭使用同一个实例和同一组动画值。目标改变时接续当前位置与速度，不回到预设起点，也不排队等待旧动画。退出开始立即取消交互，退出完成后才清理占位、原生顶层和滚动锁。

[useMotionPresence.js](../../prototypes/insight-composer/src/useMotionPresence.js) 用代次与最新 open 状态保护完成回调；旧关闭回调不能关闭刚重开的面板。它也处理实际订阅和 StrictMode 重播，避免刚挂载的元素丢失动画指令。调用方不要另外加固定 setTimeout 卸载逻辑绕开这条路径。

普通动画命令在下一次 Motion update 帧启动，让较重内容的挂载与订阅重播先完成，避免首次显示时已经消耗掉整个淡入。该帧到来前的新意图、卸载或减少动态效果会取消旧命令；业务状态和 inert 仍即时改变。减少动态效果直接设置目标并完成清理，不等待下一帧。

退出中的内容必须完整。若业务 state 会立即清空，调用方保留最后一次有效标题、字段和内容直到视觉退出结束。工作区 `WorkspaceDialog` 与 `MotionFeedback` 已有内容保留逻辑；新容器需明确自己的数据生命周期。

弹窗的背景颜色、模糊与面板透明度共同表达离场，不能只改面板。共享 hook 订阅面板的 opacity MotionValue，每次更新都将实际进度用于原生 `::backdrop` 的 tint 与 2px blur。只有相同 duration 的两套动画仍可能相差一帧，不能把参数相同当作同步证据。原生 dialog 本身仍等待完整弹簧结束。

嵌套模态仅保留一个可见背景：最上层原生 dialog（包括退出中）拥有它，进度取仍在场各面板透明度的最大值。父层保持可见时，子层进退不造成背景重复变深、模糊叠加或闪空；下层先退出不改变上层的焦点与锁。具体布局和生命周期见[弹窗与浮层](overlays.md)。

## 常见场景的规则

| 场景 | 应有的运动 | 不应出现的结果 |
| --- | --- | --- |
| 列表筛选、增删、重排 | 同业务 ID 的项保留身份，退出后相邻项补位 | 每次筛选全部重建；长列表逐条延迟；焦点随重排丢失 |
| 页签与任务类型 | 指示器接续，常驻页按顺序轻移；外框与操作区稳定 | 切换时整个弹窗改宽高；清空草稿或滚动；隐藏字段参与原生校验 |
| 右键菜单 | 最终锚点原地 140ms 淡入淡出 | 从上次目标飞来；缩放弹跳；高亮跨不同目标滑动 |
| ReaderSelect picker | 原生定位，140ms 透明度过渡 | 将选择逻辑改成自制动作菜单，丢失原生键盘能力 |
| 侧栏与正文布局 | 侧栏沿所属边缘进退，正文空间协调 | 对正文做整体缩放；丢掉选区、草稿或阅读行 |
| 页面导航 | 使用不接收输入的视觉快照交接，保持单一活跃 Reader | 同时挂载两个 Reader、重复观察器或阅读活动记录 |
| 数字和异步反馈 | 真实数值立即准确；图形和提示可以变化 | 统计从零假计数；伪造上传或处理百分比 |
| 图片手势 | 拖动、滚轮缩放即时；按钮动作可短过渡 | 手势滞后、关闭时先将图片缩回起点 |

阅读状态不能只换文字。[MaterialDetails.jsx](../../prototypes/insight-composer/src/workspace/MaterialDetails.jsx) 的行内单选、状态文字、下划线与计划按钮文案使用 `control` 反馈，让同一项的状态变化可辨认。增加类似状态控件时一并覆盖文字、选中指示与操作结果，避免只给容器加动画。

Queue 任务详情当前使用 `MotionFeedback`，但明确传入 `kind="disclosure"`，不能退回普通提示的较快节奏。行位置动画仅随列表顺序依赖变化；详情自身高度变化时，不让父行布局投影再做一次移动。分类筛选使用 `AnimatePresence mode="popLayout"` 释放旧行占位；长详情的异步内容与返回滚动恢复也要一起检查。实现见 [QueuePage.jsx](../../prototypes/insight-composer/src/workspace/QueuePage.jsx)。

设置和 Queue 都使用 `MotionPanelPage`，当前页切换偏移为前页 -8px、后页 +8px；减少动态效果时偏移为零。Queue 未激活的 fieldset 同时 disabled，避免隐藏字段拦截当前类型的提交。常驻容器保留滚动，不等于应用承诺保存每种类型的独立草稿；业务草稿状态要按真实实现判断。

页面导航的 CSS 快照使用 120ms 淡出、220ms 淡入，进入画面最多下移 6px；它是内容交接的专属规则。`::view-transition` 不接受指针输入，不支持该能力时仍须得到相同导航结果。实现见 [page-motion.js](../../prototypes/insight-composer/src/page-motion.js) 与 [motion.css](../../prototypes/insight-composer/src/motion.css)。

## 减少动态效果

使用 [useReducedMotionPreference.js](../../prototypes/insight-composer/src/useReducedMotionPreference.js) 订阅实时系统偏好，不能只在首次挂载读一次。共享 Motion 的空间位移清零，动画直接到达目标，仍然保留结果、关闭清理、焦点与滚动恢复。

正在播放的动画也要立即结束。共享组件使用 [useImmediateReducedMotion.js](../../prototypes/insight-composer/src/useImmediateReducedMotion.js) 完成当前值与布局投影，并保留完成回调；只把未来 transition 时长改成零不足以释放已经退出中的元素。CSS 动画、原生 backdrop、select picker 和第三方 Viewer 也必须覆盖，不能只检查 Motion 组件。

图片灯箱是现有适配例外：Viewer 的 show/hide 配置随偏好更新，CSS 使用极短 `.001ms` 保留其事件清理路径；这是第三方生命周期适配，不是通用 reduced-motion 时长。

导航加载线也有独立规则：关闭扫动，保留静止提示和 180ms 线性淡出。该渐隐不移动内容，也不延长真实忙碌语义；见[状态反馈](feedback.md)。不要用共享空间动画的立即完成规则覆盖这个已定义的加载节奏。

## 参数归属与适配边界

- `motion-system.js` 拥有弹簧、普通 fade 及其 CSS 投影。修改 fade 时同时核对 Motion、picker、菜单和 Viewer；不要在适配 CSS 中再添加等值常量。
- `useModalDialog` 拥有普通模态的交互与背景时序；业务组件保留内容布局。设置、Queue、两类 WorkspaceDialog、Reader 洞见、问题和本段洞见详情都消费同一策略。
- `motion.css` 的颜色反馈、页面 View Transition 以及加载条退场是不同角色的节奏，保留已明确的时长；不能机械地将所有数值替换为 fade。
- 本页与[连续动效系统](../连续动效系统.md)共同记录动效语义和参数；修改共享参数、适配例外或生命周期时两处同步。

修改某个动效时，先判断是在修正共享规则还是保留必要的场景例外，再同时更新对应文档与差异记录。

## 验证方法

优先观察连续中间帧：打开后立即关闭、退出中重开、连续切换目标、动画中改变 reduced-motion。分别核对对象身份、输入是否被正确禁止、最终结果、焦点、滚动锁和背景残留。静态截图只能证明某一帧，不能证明完整时序。

相关入口：[motion-presence.test.mjs](../../prototypes/insight-composer/tests/motion-presence.test.mjs)、[immediate-reduced-motion.test.mjs](../../prototypes/insight-composer/tests/immediate-reduced-motion.test.mjs)、[reduced-motion-preference.test.mjs](../../prototypes/insight-composer/tests/reduced-motion-preference.test.mjs)、[page-motion.test.mjs](../../prototypes/insight-composer/tests/page-motion.test.mjs)、[queue-motion.browser.mjs](../../prototypes/insight-composer/tests/queue-motion.browser.mjs)、[context-menu-lifecycle.test.mjs](../../prototypes/insight-composer/tests/context-menu-lifecycle.test.mjs)。本页是源码与测试入口索引；通过项必须在实际运行后另行记录，浏览器结果与真实桌面结果分开报告。

2026-10-30 本轮局部复核：presence、实时减少动态效果和滚动锁共 16 项单元检查通过；新增的启动前取消检查覆盖快速改变意图、卸载与 reduced-motion。真实 Reader 内存资料 fixture 的 [reader-overlay-motion.browser.mjs](../../prototypes/insight-composer/tests/reader-overlay-motion.browser.mjs) 通过 11 组检查，逐帧覆盖洞见与设置的打开、退场、反向、实时减少动态效果及嵌套。Queue 动效浏览器脚本通过正常/放大/窄窗口、分类连续切换、异步详情和输入检查；标题、箭头与键盘三种展开入口的 10–90% 高度变化均约 267ms。以上为无真实 profile 的浏览器和单元证据，不代表 Electron、安装包或正文转换验收。
