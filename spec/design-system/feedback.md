# 状态、加载与反馈

[设计系统](README.md) · 更新：2026-10-30

反馈要告诉用户当前发生了什么，以及是否需要操作。尽量放在动作发生的位置；不为普通切换增加解释段落，也不把后台刷新表现为整页重新打开。本页区分当前实现和后续应收敛的规则。

## 反馈放在哪里

| 场景 | 当前复用入口 | 规则 |
| --- | --- | --- |
| 用户主动打开页面、文档或切换需要读取的内容 | [NavigationLoadingLine](../../prototypes/insight-composer/src/NavigationLoadingLine.jsx) | 顶栏底部细线，不挤动内容，不伪造完成百分比 |
| 首次加载模块或工作区 | [WorkspaceLoadingShell / WorkspacePagePlaceholder](../../prototypes/insight-composer/src/WorkspaceLoading.jsx) | 尽量保留导航和栏位几何；用 `aria-busy` 标识忙碌 |
| 列表或详情后台刷新 | Flow / Queue 自身资源逻辑 | 已有有效内容保留；后台轮询不反复播放前景加载提示 |
| 操作失败 | [ActionError](../../prototypes/insight-composer/src/workspace/shared.jsx) | 就近显示可读错误，保留输入；有恢复动作时给出明确入口 |
| 模块载入失败 | `WorkspacePageBoundary` | 页面级错误与“重新加载”；不继续展示假的空列表 |
| 服务暂不可达、访问令牌缺失 | [WorkspaceApp 的 ServiceGate](../../prototypes/insight-composer/src/WorkspaceApp.jsx) | 区分连接失败与授权输入，提供重新连接或继续入口 |
| 归档 / 删除后可恢复 | Collection `.workspace-undo`、Flow `.flow-undo` | 说明发生的动作并就近提供撤销；不要依赖用户记住另一处入口 |
| 跨页面操作结果或状态提示 | `WorkspaceApp` 的 `MotionNotice` / `.workspace-toast` | 用于当前页面局部反馈不足以表达的状态，提供关闭操作 |
| 简单复制结果 | Queue 按钮“已复制”、Flow 局部复制状态 | 反馈留在原操作附近，避免为每次复制弹出新对话框 |

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

数量是辅助信息，沿用较小字号与等宽数字；不挤压标题、不替代状态文字。当前实现尚有首轮 Queue 数据未返回时显示回落计数 `0` 的情况，不能将这个实现当成“加载时显示零”的统一规范。

## 错误、忙碌与恢复

`useTask` 在执行期间拦截重复提交；`ActionError` 用 `role="alert"` 和警告图标表达错误，退出时设为不可交互并从辅助技术隐藏。调用方仍需决定禁用哪些按钮、何时保存或清除草稿、如何重试，不能只把按钮改成灰色。

当前 `.workspace-error` 的代表样式是细红色边框 `#e8cecb`、浅底 `#fff7f5`、文字 `#923f38`、`4px` 圆角，尺寸随 UI scale。它适用于工作区内操作错误；此处记录的是现有样式，尚未有统一的全局错误色 token。详见 [workspace.css](../../prototypes/insight-composer/src/workspace/workspace.css)。

行为要求：

- 失败后保留能够恢复的输入、选区和草稿，明确失败发生在读取还是保存。
- 读取失败提供重新读取；版本冲突不能覆盖其他修改，应保留本次输入并通过现有重载流程恢复。
- 错误提示可关闭时，关闭仅改变提示可见性。不要把“保存失败”在定时器到期后无声当成成功。
- “已复制”只在剪贴板写入成功后出现；“已保存”只对应获得确认的业务写入。
- 空状态、加载中和错误状态不能叠加成互相矛盾的结论。部分加载失败时优先保留可用区域。
- 错误和提示文字允许换行、能读全；操作按钮保持可见，键盘焦点不因反馈出现而被强制移动。

全局 `.workspace-toast` 当前位于视口底部居中，最大宽度为视口减 `32px`，使用浮层表面、边框、`8px` 圆角，采用 `role="status"` 和显式关闭按钮。它不是所有错误的默认去处。源码：[WorkspaceApp](../../prototypes/insight-composer/src/WorkspaceApp.jsx)、[workspace-shell.css](../../prototypes/insight-composer/src/workspace-shell.css)。

## 已知差异与后续收敛

1. 工作区 `ActionError` 与服务弹窗 `.workspace-service-error` 使用不同字号、圆角和硬编码颜色；后者还通过 `MotionFeedback` 包装。后续应先统一反馈语义与 token，再调整容器适配。
2. Collection、Flow、Queue 的空状态分别实现：Collection 含图标、Flow 有局部 `EmptyState`、Queue 使用状态文本。尚无统一组件；不要把装饰性图标设成必需，也不能删除有助于恢复的动作。
3. 首次加载壳与实际页面布局并非逐状态一致，尤其 Flow 可变右栏；当前加载壳是基础占位，不是完整最终布局的验收结论。
4. 复制反馈存在按钮原位变化与独立状态文字两种形式；新场景默认就近反馈，只有动作位置无法承载时才扩大提示范围。
5. Queue 首轮计数使用 `0` 回落，部分占位未逐处提供独立文案。这些是待核对的呈现细节，不意味着真实业务结果为零。

## 修改后的检查

- 快速完成不闪提示；慢请求有反馈；多个请求重叠不会提前结束；失败与取消均结束忙碌状态。
- 切筛选、连续展开两项、返回页面、后台轮询时，旧结果和旧动画都不会覆盖当前内容。
- 加载中不显示错误的空状态；失败后可重试；复制失败不显示成功；重复点击不产生重复写入。
- 检查长错误文本、键盘焦点、减少动态效果、列表滚动和窄窗口，不只截取正常状态。
- 可按改动选择 [navigation-loading.test](../../prototypes/insight-composer/tests/navigation-loading.test.mjs)、[queue-loading.browser](../../prototypes/insight-composer/tests/queue-loading.browser.mjs)、[flow-resource-store.test](../../prototypes/insight-composer/tests/flow-resource-store.test.mjs)、[collection-plan-feedback.browser](../../prototypes/insight-composer/tests/collection-plan-feedback.browser.mjs)。本页是源码核对记录，未据此宣称这些检查本轮已运行或安装版已验收。
