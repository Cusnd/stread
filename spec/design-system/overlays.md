# 弹窗、菜单与浮层

[设计系统](README.md) · 相关：[按钮](buttons.md)、[表单](forms.md)、[动效](motion.md)

初始核对：2026-10-30。本页区分现有容器与共同行为；尺寸相同不代表它们已经使用同一个组件。

## 按任务选择容器

| 任务 | 当前入口 | 使用规则 |
| --- | --- | --- |
| 工作区内的编辑、确认、导航与详情 | [workspace/shared.jsx 的 WorkspaceDialog](../../prototypes/insight-composer/src/workspace/shared.jsx) | 使用工作区的标题、内容、操作区与焦点恢复机制 |
| 添加或编辑 Queue 任务 | [QueueTaskDialog.jsx](../../prototypes/insight-composer/src/workspace/QueueTaskDialog.jsx) | 复用上述容器，固定外框，标题旁的小下拉切换任务类型，字段区独立滚动 |
| 导入源文件、审阅修订、打开引用 | [WorkspaceDialog.jsx 的 WorkspaceDialog](../../prototypes/insight-composer/src/WorkspaceDialog.jsx) | 当前服务弹窗族；与上一行的同名组件是两个实现，接入时必须确认导入路径 |
| 阅读和界面偏好 | [ReadingSettings.jsx](../../prototypes/insight-composer/src/ReadingSettings.jsx) | 固定外框、多页常驻、每页独立滚动；偏好即时生效 |
| 对现有对象执行短操作 | [ContextMenu.jsx](../../prototypes/insight-composer/src/ContextMenu.jsx) | 使用同一右键菜单，保持目标对象与列表选中状态独立，不再加一套专属菜单 |
| 从有限选项中选择一个值 | [ReaderSelect.jsx](../../prototypes/insight-composer/src/ReaderSelect.jsx) | 使用原生 select 语义及共享 picker；具体规则见[表单](forms.md) |
| 查看、平移、缩放文章图片 | [ImageLightbox.jsx](../../prototypes/insight-composer/src/ImageLightbox.jsx) | 使用图片灯箱；深色背景服务于图片查看，不作为普通弹窗配色范例 |

不要因为内容属于新页面就建立新弹窗族。先选已有容器，再讨论确实需要的尺寸或内容差异。简单确认无需套用设置面板的大尺寸；复杂表单也不应挤进菜单。

## 当前外框与布局

以下为界面比例 1 时的源码基准值；带缩放的值通过 `--ui-scale` 计算，并受窗口宽高约束。

| 容器 | 当前代表值 | 内容布局与边界 |
| --- | --- | --- |
| `.workspace-dialog` | 宽 440px，圆角 8px，最大高为视口高减 40px | 外层可滚动，标题 sticky；标题区默认高至少 54px，内容 padding 20px |
| `.workspace-service-dialog` | 宽 490px，wide 为 800px，圆角 12px，最大高为视口高减 32px | 外层可滚动，标题 sticky；这组尺寸目前使用固定 px，未统一按 `--ui-scale` 缩放 |
| `.settings` | 宽 560px，高 640px，圆角 14px，最大高为视口高减 48px | 标题、页签、底部完成按钮不随内容滚动；`.settings-page` 各自滚动 |
| `.queue-task-dialog` | 宽 560px，高 640px，圆角 14px，最大高为视口高减 48px | 标题、底部操作区固定；`.queue-task-form-scroll` 各自滚动；任务类型切换不改变外框 |

来源：[工作区样式](../../prototypes/insight-composer/src/workspace/workspace.css)、[服务弹窗样式](../../prototypes/insight-composer/src/workspace-shell.css)、[设置样式](../../prototypes/insight-composer/src/reading-settings.css)、[Queue 样式](../../prototypes/insight-composer/src/workspace/queue.css)。窄窗口有额外约束，不能只复制表中的宽高。

统一的是布局关系：标题和退出入口稳定，内容超过可用高度时在所属区域滚动，主操作始终容易找到。复杂表单参考设置与 Queue 的固定框架；新增变体要说明必要性，并与相邻场景对照。

标题应直接说明任务。不要在标题下重复解释显而易见的页面用途。Queue 的“任务类型”是标题旁的紧凑下拉；不恢复占用大面积的类型导航或额外说明卡片。新文件上传保留明确的文字动作。

## 打开、关闭与背景

模态弹窗遵守以下生命周期。右键菜单的焦点交接发生得更早，按下方菜单专节处理，不套用弹窗的退场后归还规则：

1. 接受打开意图，保存有效的返回焦点，取得需要的滚动锁，显示容器。
2. 将焦点放到有意义的入口。一般弹窗使用指定控件或关闭按钮；Queue 新建任务先聚焦表单表面，避免打开即让输入框出现强焦点边框。
3. 收到关闭意图后立即让退出中的内容 `inert`，必要时同步 `aria-hidden`，停止接受动作。
4. 面板、背景遮罩和模糊同时开始退出。面板已淡出时，不能仍留下一层模糊或灰幕等待弹簧尾段。
5. 实际退场完成后关闭原生 `dialog` 或移除浮层，释放滚动锁，将焦点还给有效的触发入口。

`open` 表示当前交互意图，`present` 表示为完成视觉退场而仍在场。不得用 `open && <Dialog />` 从外部提前卸载拥有退出动画的容器；必须先确认组件自身的生命周期设计。

**背景是面板的从属反馈，不能独立拖尾。** 当前实现中，透明度一般采用 140ms 淡变，位置/缩放弹簧可能更晚结束；遮罩与模糊跟随淡变，原生模态生命周期等弹簧结束。这里的“同步”指可见内容与背景的视觉退场一致，不是把所有物理参数强行变成固定 140ms。

### 当前背景差异

| 场景 | 当前背景 | 实现方式 |
| --- | --- | --- |
| 设置 | `#24282d38`，`blur(2px)` | 独立的 Motion overlay 同时插值背景颜色与模糊；不能只让子面板淡出 |
| 服务弹窗 | `#24242428`，`blur(2px)` | 原生 `::backdrop`，颜色与模糊分别用 140ms 线性过渡；closing 时变透明、blur 归零 |
| 工作区弹窗，包括 Queue | `#24242436`，无 blur | 原生 `::backdrop` 的颜色过渡；closing 时变透明 |
| Reader 居中洞见 | `#24282d30`，无 blur | [App.jsx](../../prototypes/insight-composer/src/App.jsx) 中独立 Motion 背景 |
| 右键菜单、select picker | 不压暗页面 | 锚定当前操作对象，保留周围阅读上下文 |
| 图片灯箱 | `#191a1c` 的不透明深色场景 | Viewer 管理整个图片模态，整体淡出 |

这些背景目前没有统一的 token 和容器策略。本次只记录实际差异；不要把“普通弹窗是否模糊”当作已经统一的结论。后续收敛应同时比较设置、Queue、导入与 Reader 洞见，不在单个页面继续微调新的透明度。

## 滚动与焦点

- 复用 [acquirePageScrollLock](../../prototypes/insight-composer/src/page-scroll-lock.js)。它按根节点计数，保留原有 overflow、scrollbar gutter 与补偿 padding；嵌套浮层关闭一个不能释放另一个仍需要的锁。释放函数可以重复调用。
- 模态内容内部使用自己的滚动容器与 `overscroll-behavior: contain`。不要为全屏遮罩留下未覆盖的滚动条边缘，也不要因锁滚动让整个页面横向跳动。
- 原生 `showModal()` 提供顶层与背景模态行为。设置等自绘 dialog 需要宿主配合背景不可交互和焦点约束，`aria-modal="true"` 本身不能完成这些行为。
- 工作区弹窗通过 `initialFocusKey` 和 `returnFocusKey` 处理进入与返回；触发项消失时回到有效的同类控件或工作区入口。服务弹窗目前主要恢复保存的 DOM 元素，回退策略较少。
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

现有验证入口包括 [dialog-backdrop.browser.mjs](../../prototypes/insight-composer/tests/dialog-backdrop.browser.mjs)、[reader-overlay-motion.browser.mjs](../../prototypes/insight-composer/tests/reader-overlay-motion.browser.mjs)、[workspace-dialog-scroll.browser.mjs](../../prototypes/insight-composer/tests/workspace-dialog-scroll.browser.mjs)、[page-scroll-lock.test.mjs](../../prototypes/insight-composer/tests/page-scroll-lock.test.mjs)、[image-lightbox-desktop.browser.mjs](../../prototypes/insight-composer/tests/image-lightbox-desktop.browser.mjs)。列出脚本表示可复用的验证入口，不表示本轮已运行，也不代替真实 Electron 验收。
