# 状态、加载与反馈

[设计系统](README.md) · 更新：2026-10-30

反馈要告诉用户当前发生了什么，以及是否需要操作。尽量放在动作发生的位置；不为普通切换增加解释段落，也不把后台刷新表现为整页重新打开。本页记录共享实现与业务反馈边界。

## 反馈放在哪里

| 场景 | 当前复用入口 | 规则 |
| --- | --- | --- |
| 用户主动打开页面、文档或切换需要读取的内容 | [NavigationLoadingLine](../../prototypes/insight-composer/src/NavigationLoadingLine.jsx) | 顶栏底部细线，不挤动内容，不伪造完成百分比 |
| 首次加载模块或工作区 | [WorkspaceLoadingShell / WorkspacePagePlaceholder](../../prototypes/insight-composer/src/WorkspaceLoading.jsx) | 尽量保留导航和栏位几何；用 `aria-busy` 标识忙碌 |
| 列表或详情后台刷新 | Flow / Queue 自身资源逻辑 | 已有有效内容保留；后台轮询不反复播放前景加载提示 |
| 操作失败 | [InlineError / ActionError](../../prototypes/insight-composer/src/Feedback.jsx) | 就近显示可读错误，保留输入；有恢复动作时给出明确入口 |
| 模块载入失败 | `WorkspacePageBoundary` | 页面级错误与“重新加载”；不继续展示假的空列表 |
| 服务暂不可达、访问令牌缺失 | [WorkspaceApp 的 ServiceGate](../../prototypes/insight-composer/src/WorkspaceApp.jsx) | 区分连接失败与授权输入，提供重新连接或继续入口 |
| 归档 / 删除后可恢复 | Collection `.workspace-undo`、Flow `.flow-undo` | 说明发生的动作并就近提供撤销；不要依赖用户记住另一处入口 |
| 跨页面操作结果或状态提示 | `WorkspaceApp` 的 `MotionNotice` / `.workspace-toast` | 用于当前页面局部反馈不足以表达的状态，提供关闭操作 |
| 简单复制结果 | [useClipboardFeedback / CopyFeedback](../../prototypes/insight-composer/src/Feedback.jsx) | 反馈留在原操作附近，避免为每次复制弹出新对话框 |

“反馈在原位置”是默认选择，是否允许关闭、是否需要重试取决于实际动作。关闭错误提示不等于写入成功；取消任务、撤销归档、重新读取也不是同一个操作。

## 导航加载的现有时序

[navigation-loading.js](../../prototypes/insight-composer/src/navigation-loading.js) 统一追踪多个并发前景加载任务：每次开始返回一个可重复安全调用的结束函数，调用方在完成、异常与取消路径都负责结束。

| 参数 | 当前值 | 目的 |
| --- | --- | --- |
| 出现延迟 | `120ms` | 瞬间完成的动作不闪一下 |
| 最短可见时间 | `180ms` | 已出现的提示有可感知的持续时间 |
| 完成淡出 | `180ms` | 视觉结束自然，不延迟真实工作结果 |
| 线条高度 | `2px` | 保持顶栏尺寸和内容位置 |
| 扫动周期 | `1400ms` | 表达不确定进度，不当作真实百分比 |

线条在所有前景工作结束后才淡出；淡出期间有新工作则继续显示，不重新挂载整条提示。`aria-hidden` 在真实工作结束后设定，最短显示和淡出时间不会继续向辅助技术宣告忙碌。减少动态效果模式下取消扫动，显示静止线；透明度退场仍使用其专用规则。

对应 [navigation-loading.css](../../prototypes/insight-composer/src/navigation-loading.css)、[workspace-loaders.js](../../prototypes/insight-composer/src/workspace-loaders.js)。悬停和聚焦预加载是安静的，不获取前景加载提示。这里的时序专用于导航加载，不应作为所有动效的通用时长；动效规则见 [motion](motion.md)。

## 内容加载与稳定性

- **首次打开**：保留工作区顶栏和大致栏位，避免整屏白闪。占位区域明确 `aria-busy`，不可用的添加和设置动作暂时禁用。Queue 与其他工作区使用相同的顶部加载线，不另加“正在读取队列”说明；不要画出尚不存在的数量或业务完成状态。
- **切换筛选**：显示当前请求身份对应的数据；旧请求迟到不能盖住新选择。加载期间不能提前显示“没有任务”“没有洞见”。
- **已有内容刷新**：同一资源可以暂时保留上次数据，在原位置提示失败。不要每隔几秒清空列表、恢复滚动、闪加载线。
- **展开详情**：详情本身标识忙碌；读取期间禁用依赖最新详情的动作。展开高度变化与列表滚动恢复要协调，不能把中间高度下的位置写回最终视图。
- **图片预览**：Queue 首页预览用 `aspect-ratio: 3 / 4` 预留空间，失败后当前实现保持占位、隐藏图片容器，其他任务动作仍可用。后续替换占位设计时必须保持列表稳定；图片失败不是整个任务失败。

实现入口：[FlowPage](../../prototypes/insight-composer/src/workspace/FlowPage.jsx)、[QueuePage](../../prototypes/insight-composer/src/workspace/QueuePage.jsx)、[queue.css](../../prototypes/insight-composer/src/workspace/queue.css)、[workspace-loading.css](../../prototypes/insight-composer/src/workspace-loading.css)。数据加载、详情展开和用户滚动的关系见 [导航与布局](navigation-layout.md)。

## 空状态与数量

空状态至少区分三类：首次没有内容、当前筛选没有结果、读取失败。正常空状态保持低对比的一句事实和必要的下一步，不加营销式标题和重复说明。

| 当前场景 | 示例文案 / 动作 | 约束 |
| --- | --- | --- |
| Collection 空分类 | “这个分类还没有资料” + 添加资料 | 只在数据已得到且确实为空时显示 |
| Collection 筛选为空 | “没有符合条件的资料” + 清除筛选 | 保留现有条件，只有用户清除后才重置 |
| Flow 洞见筛选为空 | “没有符合条件的洞见。” + 清除筛选 | 待回顾为空可使用其业务名称 |
| Flow 时间段为空 | “这段时间还没有阅读记录。” | 没有活动不能表述为阅读时长为零的完成证明 |
| Queue 搜索为空 | “没有匹配的任务” | 不和任务读取失败混用 |
| Queue 某状态为空 | “没有需要处理的任务”等 | 按所选状态描述；添加入口只在适用场景显示 |

数量是辅助信息，沿用较小字号与等宽数字；不挤压标题、不替代状态文字。Queue 首轮尚未取得计数时保留原位空白，并从辅助技术隐藏；只有收到真实数据后才显示数字。加载中、真实零值与请求失败分别表达。Flow 的加载壳通过 `flowPanelLayout` 复用实际页面的右栏、选中详情、缩放与窄容器规则，避免先渲染另一套栏位。

## 错误、忙碌与恢复

`useTask` 在执行期间拦截重复提交；`ActionError` 用 `role="alert"` 和警告图标表达错误，退出时设为不可交互并从辅助技术隐藏。调用方仍需决定禁用哪些按钮、何时保存或清除草稿、如何重试，不能只把按钮改成灰色。

`InlineError` 是工作区和导入/修订弹窗的同一个错误组件；`ActionError` 保留为兼容导出。颜色来自 `--ui-error-border` / `--ui-error-surface` / `--ui-error-text`，圆角、字号、内边距来自共享 token，并随 UI scale 变化。当前细框/浅底仍为 `#e8cecb` / `#fff7f5`，错误文字为 `#923f38`。退出保留最后一份内容，同时设为 inert 与 aria-hidden；关闭中重开可反向继续。详见 [Feedback.jsx](../../prototypes/insight-composer/src/Feedback.jsx)、[feedback.css](../../prototypes/insight-composer/src/feedback.css)、[ui-tokens.css](../../prototypes/insight-composer/src/ui-tokens.css)。

行为要求：

- 失败后保留能够恢复的输入、选区和草稿，明确失败发生在读取还是保存。
- 读取失败提供重新读取；版本冲突不能覆盖其他修改，应保留本次输入并通过现有重载流程恢复。
- 错误提示可关闭时，关闭仅改变提示可见性。不要把“保存失败”在定时器到期后无声当成成功。
- “已复制”只在剪贴板写入成功后出现；“已保存”只对应获得确认的业务写入。
- 空状态、加载中和错误状态不能叠加成互相矛盾的结论。部分加载失败时优先保留可用区域。
- 错误和提示文字允许换行、能读全；操作按钮保持可见，键盘焦点不因反馈出现而被强制移动。

全局 `.workspace-toast` 当前位于视口底部居中，最大宽度为视口减 `32px`，使用浮层表面、边框、`8px` 圆角，采用 `role="status"` 和显式关闭按钮。它不是所有错误的默认去处。源码：[WorkspaceApp](../../prototypes/insight-composer/src/WorkspaceApp.jsx)、[workspace-shell.css](../../prototypes/insight-composer/src/workspace-shell.css)。

## 共享空态与复制反馈

三页复用 `EmptyState`：列表空态采用相同文字层级、间距及恢复动作位置；Flow 概览中嵌入局部面板时使用 `compact`，保持该面板的内容流。文案与“清除筛选”“添加资料”等动作仍由业务场景决定，组件不自动插入装饰图标或重复标题。

Queue 和 Flow 共用 `useClipboardFeedback`：剪贴板 Promise 成功后才展示“已复制”；最新请求拥有结果，迟到的旧成功或失败不能覆盖它；成功提示持续 2400ms，失败保留到下一次尝试或显式清除。卸载取消旧回调。Queue 以按钮原位文本表达成功、行内错误表达失败；Flow 用靠近编号的 `CopyFeedback`。位置不同有业务原因，但成功边界与生命周期相同。

## 本轮核验

2026-10-30 的 [feedback.browser](../../prototypes/insight-composer/tests/feedback.browser.mjs) 已在实际浏览器通过：两类错误计算样式一致；关闭退出内容保留、退出中重开与草稿保留；复制等待不假报成功、异步乱序、失败保持与成功重试；320px / 120% 下长错误换行；中途打开减少动态效果时立即完成退场；空态恢复按钮可用。Queue 慢加载及 Flow 占位几何见 [导航与布局](navigation-layout.md) 的本轮验证记录。

## 修改后的检查

- 快速完成不闪提示；慢请求有反馈；多个请求重叠不会提前结束；失败与取消均结束忙碌状态。
- 切筛选、连续展开两项、返回页面、后台轮询时，旧结果和旧动画都不会覆盖当前内容。
- 加载中不显示错误的空状态；失败后可重试；复制失败不显示成功；重复点击不产生重复写入。
- 检查长错误文本、键盘焦点、减少动态效果、列表滚动和窄窗口，不只截取正常状态。
- 可按改动选择 [navigation-loading.test](../../prototypes/insight-composer/tests/navigation-loading.test.mjs)、[queue-loading.browser](../../prototypes/insight-composer/tests/queue-loading.browser.mjs)、[flow-resource-store.test](../../prototypes/insight-composer/tests/flow-resource-store.test.mjs)、[collection-plan-feedback.browser](../../prototypes/insight-composer/tests/collection-plan-feedback.browser.mjs)。仅“本轮核验”及本次变更记录列出的实际执行结果是本轮证据；未运行的其他脚本只是复验入口，浏览器结果不代表安装版验收。
