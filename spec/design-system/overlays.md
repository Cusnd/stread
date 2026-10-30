# 弹窗、菜单与浮层

[设计系统](README.md) · 相关：[按钮](buttons.md)、[表单](forms.md)、[动效](motion.md)

实现核对：2026-10-30。普通模态现已共用 [useModalDialog.js](../../prototypes/insight-composer/src/useModalDialog.js) 的原生顶层、退场、焦点和滚动锁策略，以及 [modal.css](../../prototypes/insight-composer/src/modal.css) 的背景与尺寸规则。各业务容器保留自己的内容布局。

## 按任务选择容器

| 任务 | 当前入口 | 使用规则 |
| --- | --- | --- |
| 工作区内的编辑、确认、导航与详情 | [workspace/shared.jsx 的 WorkspaceDialog](../../prototypes/insight-composer/src/workspace/shared.jsx) | 使用工作区的标题、内容、操作区；保留业务 focus key，接入共享模态生命周期 |
| 添加或编辑 Queue 任务 | [QueueTaskDialog.jsx](../../prototypes/insight-composer/src/workspace/QueueTaskDialog.jsx) | 复用上述容器的 `composer` 角色；固定紧凑外框，任务类型在表单首行、位于类型页上方，上下文行与书写区内部独立滚动 |
| 导入源文件、审阅修订、打开引用 | [WorkspaceDialog.jsx 的 WorkspaceDialog](../../prototypes/insight-composer/src/WorkspaceDialog.jsx) | 与工作区同名组件保留不同的内容 API，但共用生命周期和 simple / wide 外框；接入时确认导入路径 |
| 阅读和界面偏好 | [ReadingSettings.jsx](../../prototypes/insight-composer/src/ReadingSettings.jsx) | 原生 dialog 内固定 panel、多页常驻、每页独立滚动；偏好即时生效 |
| Reader 洞见、问题及本段洞见详情 | [App.jsx](../../prototypes/insight-composer/src/App.jsx)、[QuestionDetail.jsx](../../prototypes/insight-composer/src/QuestionDetail.jsx)、[MarginGroupDetail.jsx](../../prototypes/insight-composer/src/MarginGroupDetail.jsx) | 同样使用共享原生模态策略；保留来源定位、编辑动作和 Reader 快捷键 |
| 对现有对象执行短操作 | [ContextMenu.jsx](../../prototypes/insight-composer/src/ContextMenu.jsx) | 使用同一右键菜单，保持目标对象与列表选中状态独立，不再加一套专属菜单 |
| 从有限选项中选择一个值 | [ReaderSelect.jsx](../../prototypes/insight-composer/src/ReaderSelect.jsx) | 使用原生 select 语义及共享 picker；具体规则见[表单](forms.md) |
| 查看、平移、缩放文章图片 | [ImageLightbox.jsx](../../prototypes/insight-composer/src/ImageLightbox.jsx) | 使用图片灯箱；深色背景服务于图片查看，不作为普通弹窗配色范例 |

不要因为内容属于新页面就建立新弹窗族。先选已有容器，再讨论确实需要的尺寸或内容差异。简单确认无需套用设置面板的大尺寸；复杂表单也不应挤进菜单。

## 当前外框与布局

以下为 `--ui-scale: 1` 时的基准值（设置中的 80%）。普通外框统一由 `data-modal-size` 选择，不再在工作区和服务弹窗各写一套宽度、圆角和缩放算法。

| 角色及容器 | 当前代表值 | 内容布局与边界 |
| --- | --- | --- |
| `simple`：普通工作区和服务表单 | 宽 440px，圆角 8px | 内容按需增长；工作区标题 sticky，服务弹窗标题在滚动区外；长表单操作区 sticky |
| `wide`：修订审阅、Reader 洞见等 | 宽 800px，圆角 8px | 为对照和内容管理提供宽度；仍受统一窗口边距约束 |
| `panel`：设置 | 宽 560px、高 640px，圆角 14px | 多分类设置需要较多可见内容，页签切换不改变外框 |
| `composer`：Queue 任务编辑 | 宽 560px、高 420px，圆角 14px | 编辑任务以短上下文和正文为主；五种任务保持相同外框，标题、表单首行的任务类型、取消与提交固定，类型页中的复杂字段内部滚动 |
| `navigation`：窄窗口工作区导航 | 使用所属侧栏宽度、全视口高，无圆角 | 保留侧边导航的空间关系；背景和交互生命周期仍共用模态策略 |

尺寸均随 `--ui-scale` 计算。普通弹窗的窗口边距为 `clamp(12px, 24px × scale, 32px)`；最大宽高为当前视口减去两侧边距，使用 `100dvh`。圆角来自 [ui-tokens.css](../../prototypes/insight-composer/src/ui-tokens.css)，布局分别见[工作区](../../prototypes/insight-composer/src/workspace/workspace.css)、[服务弹窗](../../prototypes/insight-composer/src/workspace-shell.css)、[设置](../../prototypes/insight-composer/src/reading-settings.css)、[Queue](../../prototypes/insight-composer/src/workspace/queue.css)。

设置与 Reader 洞见的原生 dialog 覆盖整个视口，内部 `.ui-modal-surface` 承担内容和运动；背景不会在 Reader 顶栏或滚动条处留下空隙。设置在本次打开时固定其外框比例，拖动 UI 比例滑块时不让当前设置面板跟着改变尺寸；下次打开使用新比例。

统一的是布局关系：标题和退出入口稳定，内容超过可用高度时在所属区域滚动，主操作始终容易找到。Queue 的短任务编辑不沿用设置的高面板，避免简单表单留下大片空白；复杂转换仍通过紧凑字段与内部滚动适配同一个编辑器。新增变体要说明必要性，并与相邻场景对照。

标题应直接说明任务。Queue 标题区保留“添加任务”或“编辑任务”及关闭入口；“任务类型”是下方表单第一行，与关联文章、文件等字段使用相同的标签列。选择器宽 `min(200px × scale, 100%)`，使用普通白底浅边框，箭头右对齐并保留共享文字间距，详见[表单规范](forms.md#queue-表单模式)。不增加重复的用途描述、大面积类型导航或说明卡片。新文件上传保留明确的文字动作。

## 打开、关闭与背景

模态弹窗遵守以下生命周期。右键菜单的焦点交接发生得更早，按下方菜单专节处理，不套用弹窗的退场后归还规则：

1. 接受打开意图，保存有效的返回焦点，取得需要的滚动锁，显示容器。
2. 将焦点放到有意义的入口。一般弹窗使用指定控件或关闭按钮；Queue 新建任务先聚焦表单表面，避免打开即让输入框出现强焦点边框。
3. 收到关闭意图后立即让退出中的内容 `inert`，必要时同步 `aria-hidden`，停止接受动作。
4. 面板、背景遮罩和模糊同时开始退出。面板已淡出时，不能仍留下一层模糊或灰幕等待弹簧尾段。
5. 实际退场完成后关闭原生 `dialog` 或移除浮层，释放滚动锁，将焦点还给有效的触发入口。

`open` 表示当前交互意图，`present` 表示为完成视觉退场而仍在场。不得用 `open && <Dialog />` 从外部提前卸载拥有退出动画的容器；必须先确认组件自身的生命周期设计。

**背景直接消费面板的实际透明度。** `useModalDialog` 将面板 opacity MotionValue 的更新写入原生 dialog 的 `--modal-backdrop-progress`，`modal.css` 据此计算背景颜色和 blur，不再启动另一个 CSS 过渡。普通透明度使用共享 140ms 淡变；位置/缩放弹簧可以更晚结束，但已经透明的模态不会留下灰幕或模糊。原生生命周期仍等完整退场结束。

### 统一背景与专属场景

| 场景 | 当前背景 | 实现方式 |
| --- | --- | --- |
| 普通工作区弹窗、Queue、服务弹窗、设置、Reader 洞见与详情 | `#24282d38`，`blur(2px)` | 同一 `.ui-modal::backdrop`，颜色与模糊都消费同一个面板进度 |
| 右键菜单、select picker | 不压暗页面 | 锚定当前操作对象，保留周围阅读上下文 |
| 图片灯箱 | `#191a1c` 的不透明深色场景 | Viewer 管理整个图片模态，整体淡出 |

嵌套模态始终只显示一层背景，由最后进入原生顶层的 dialog 持有，包括它正在退出的阶段。背景进度取仍在场各面板透明度的最大值；父层保持打开时，打开或关闭子层不会让背景重复变深、叠加模糊或短暂恢复清晰。最后一层退出才让背景完整淡去。下层先关闭也不能抢走上层焦点或释放上层的滚动锁。

## 滚动与焦点

- 复用 [acquirePageScrollLock](../../prototypes/insight-composer/src/page-scroll-lock.js)。它按根节点计数，保留原有 overflow、scrollbar gutter 与补偿 padding；嵌套浮层关闭一个不能释放另一个仍需要的锁。释放函数可以重复调用。
- 模态内容内部使用自己的滚动容器与 `overscroll-behavior: contain`。不要为全屏遮罩留下未覆盖的滚动条边缘，也不要因锁滚动让整个页面横向跳动。
- 普通模态统一使用原生 `showModal()`，由浏览器提供顶层和背景不可交互，hook 补充 Tab 环绕与退出行为；仅设置 `aria-modal="true"` 不能替代该策略。
- 共享 hook 接受 `initialFocus`、`returnFocus` 和 `fallbackFocus`；恢复前检查节点仍连接、可见、可交互，且属于仍有效的顶层。业务容器继续提供自己的回退入口，不能假定共享 hook 知道正确的业务位置。
- 工作区弹窗保留 `initialFocusKey`、`returnFocusKey` 及工作区搜索/导航回退；Reader 详情保留触发项或文章入口。子层关闭回到父层有效控件；父层先卸载时沿返回链恢复原页面触发项。
- 关闭按钮、Esc 和点击背景应进入同一关闭流程；弹窗内部点击不能误判为背景点击。业务正在处理时哪些关闭动作可用，应按真实业务设计，不用视觉忙碌状态替代决策。
- Tab/Shift+Tab 只访问当前活动内容；隐藏页、关闭中的控件和禁用字段不参与交互。设置页和 Queue 类型页切换时保留各自容器与滚动位置。

## 右键菜单与锚定浮层

当前右键菜单基准宽 224px，子菜单 180px，行高至少 32px，面板圆角 8px，均随界面比例缩放。分组用留白，不增加标题、说明或编号。极简模式可以隐藏装饰图标，勾选标记和子菜单箭头保留。

菜单从第一帧就在最终锚点，原地淡入淡出。连续右键换对象时立即定位到新锚点；禁止从旧对象飞到新对象、缩放、弹跳和高度展开。子菜单根据可用空间翻转或夹紧。该规则是有意的交互差异，不应为了“所有浮层一样”而套入居中弹窗的位移。

当前实现使用手动原生 popover 进入顶层。窗口中仅一个菜单所有者；外部滚动、窗口尺寸改变、目标失效或上下文改变会关闭菜单，菜单内部滚动保持直接。上下/Home/End 跳过禁用项；左右控制子菜单；Enter/Space 执行动作；Esc 逐层返回；Tab 收起后继续普通导航。

Esc、Tab 和菜单动作先恢复触发焦点，再交给业务操作；若动作打开弹窗，弹窗可以捕获正确的返回目标。外部点击不把焦点抢回旧入口，退出结束也不再次抢焦点。输入框、可编辑区和无业务对象的位置保留原生右键行为。完整业务入口规则见[右键菜单](../右键菜单.md)。

## 图片灯箱的专属行为

[ImageLightbox.jsx](../../prototypes/insight-composer/src/ImageLightbox.jsx) 使用 Viewer 管理图片手势，React 提供具备标签的控制按钮。打开时保存并设置背景 inert；退出开始使灯箱 inert，保留图片当前几何形状并整体淡出；清理时恢复背景、滚动和图片触发焦点。

拖动与滚轮缩放直接跟手。按钮旋转、适应窗口或双击切换比例可以使用短过渡；不能把按钮动画的时延加到直接手势上。左右键切图，首尾禁用相应箭头；加载失败提供清晰状态，不显示破图。样式及例外见 [image-lightbox.css](../../prototypes/insight-composer/src/image-lightbox.css)。

## 修改后的检查

检查一次完整交互，而不只看打开后的截图：关闭按钮、Esc、背景点击；关闭中再次打开；弹窗内菜单和嵌套浮层；长内容与短窗口；Tab 环绕、失效触发项的焦点回退；退出中实时开启减少动态效果。逐帧检查背景颜色与 blur，不允许面板消失后背景残留。

验证入口包括 [dialog-backdrop.browser.mjs](../../prototypes/insight-composer/tests/dialog-backdrop.browser.mjs)、[reader-overlay-motion.browser.mjs](../../prototypes/insight-composer/tests/reader-overlay-motion.browser.mjs)、[workspace-dialog-scroll.browser.mjs](../../prototypes/insight-composer/tests/workspace-dialog-scroll.browser.mjs)、[page-scroll-lock.test.mjs](../../prototypes/insight-composer/tests/page-scroll-lock.test.mjs)、[image-lightbox-desktop.browser.mjs](../../prototypes/insight-composer/tests/image-lightbox-desktop.browser.mjs)。浏览器样例使用独立内存资料，不接触真实 profile；浏览器结果不代替 Electron 或安装版验收。

2026-10-30 已完成的共享模态浏览器回归：服务表单、工作区弹窗、长表单、Queue、设置、导航、问题详情和本段洞见共八类入口的关闭按钮 / Esc / 背景点击、退场中重开、实时减少动态效果、焦点、滚动锁及 StrictMode 卸载通过。退出至面板 opacity ≤ 0.01 的保留帧中，背景残余 blur 最大约 0.014px，alpha 约 0.002。嵌套打开、关闭及下层先关的逐帧检查确认仅一层可见背景；灰幕与 blur 没有重复叠加或闪空。服务表单、普通长表单、Queue 和设置的 80 / 100 / 120 三档比例 × 900 / 420px 窗口高共 24 组几何检查通过，标题及主操作可见、无横向溢出。真实 Reader fixture 另通过洞见 / 设置显隐、反向、实时减少动态效果、焦点和嵌套共 11 组检查。该记录早于任务类型移至表单首行；本轮另外通过 26 组控件复验，确认新位置、类型切换中间帧和 900×600 / 120% 下的固定类型行、独立内容滚动及页脚可达。完整应用 4 组联测同时通过。
