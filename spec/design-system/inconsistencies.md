# 待统一项

[设计系统](README.md) · [维护与验证](maintenance.md)

本表记录初始源码核对中发现的差异，不表示这些差异都已被批准为设计变体。本次未修前端，也未重新进行运行时验收。后续触及对应区域时一起处理；解决后记录范围和实际证据，不仅删除条目。

## 需要收敛的差异

| 编号 | 当前事实与影响范围 | 后续方向 | 完成条件 |
| --- | --- | --- | --- |
| DS-01 | 应用间距、圆角、字体层级和阴影分散于局部 CSS；尚无完整的外壳 token 刻度 | 从重复的控件角色抽出少量共享尺度；保留阅读内容独立尺度 | 同一角色有明确入口与代表实例；关联页面缩放与长内容检查通过 |
| DS-02 | `.workspace-primary-button` 被局部覆盖为不同强调级别；图标命中区有 28 / 30 / 32px，disabled 规则也不同 | 明确入口、提交、阅读、工具等语义变体；保留已确定的场景层级 | 相同角色不依赖页面私有覆盖；默认、busy、disabled 与键盘状态均核验 |
| DS-03 | 通用输入、ReaderSelect、Queue 表单和行内阅读状态分别使用深色 outline、边框或浅 halo | 定义鼠标聚焦与键盘聚焦的统一角色规则；Queue 不恢复黑线 | 同类输入和选择器反馈可辨识且一致；点击范围、键盘和高对比检查通过 |
| DS-04 | 两个同名 `WorkspaceDialog`、自绘设置和 Reader 洞见层分别管理背景与焦点；Queue 等工作区弹窗无 blur，设置与服务弹窗有 2px blur | 收敛普通模态背景和生命周期策略，说明无 blur 的场景理由；菜单与灯箱保留专属角色 | 打开及关闭面板、灰幕、blur 同步；嵌套、重开、焦点回退、滚动锁在相关入口均通过 |
| DS-05 | 普通工作区弹窗与服务弹窗的尺寸、圆角和缩放方式不同；设置与 Queue 固定框架相近但实现仍不同 | 按简单表单 / 固定多页面板明确规格与窗口约束；避免为新页面再复制容器 | 80/100/120 三档设置及短窗口下标题、内容滚动和主操作稳定 |
| DS-06 | Queue 侧栏选中面无阴影，Collection / Flow 使用白底边框轻影；Collection 与 Queue 标题区字体及高度也不同 | 对比同级导航和内容标题，选择共享配方；确有必要的差异写明原因 | 三个工作区切换时同级区域视觉稳定，hover / current / focus 可区分 |
| DS-07 | Collection 的主要布局阈值随 scale 调整，Queue 仍有固定 640px 导航断点 | 以可用空间和控件尺度确定折叠策略；保留各页内容布局需要 | 放大界面和缩小窗口不会遮挡入口，导航展开后的背景交互与返回焦点正确 |
| DS-08 | `ActionError` 与服务弹窗错误提示的颜色、圆角、字号不同；空态与复制反馈分散实现 | 统一按反馈位置和严重程度选型，抽取实际重复模式 | 相同失败有相近呈现、恢复入口与可访问提示；不重复弹 Toast 和行内消息 |
| DS-09 | Flow 通用加载壳与动态右侧区域未完全对应；Queue 首轮数据前部分计数回落为 0 | 核对未加载与真实零值的区别，以及加载壳和最终结构的交接 | 慢响应下无误导计数、提前空态或结构跳变；后台刷新保持安静 |
| DS-10 | Motion 已有共享参数，但原生 backdrop、picker 与图片 Viewer 仍有局部时长；修改一个常量不会覆盖所有入口 | 明确共享语义与适配层参数的归属，减少重复值；保留直接手势例外 | 修改动效时能够查全影响入口；中断、反向与实时减少动态效果均核验 |
| DS-11 | Desktop Updates 的颜色、尺寸、焦点含独立硬编码，部分未跟随界面比例 | 将设置内部的更新操作纳入相同 token 和按钮角色 | 更新各业务状态在设置内层级一致，文字与控件随比例可用 |

## 对应源码与主题

| 条目 | 维护入口 |
| --- | --- |
| DS-01、DS-11 | [视觉基础](foundations.md)；[styles.css](../../prototypes/insight-composer/src/styles.css)、[desktop-updates.css](../../prototypes/insight-composer/src/desktop-updates.css) |
| DS-02、DS-03 | [按钮](buttons.md)、[表单](forms.md)；[workspace.css](../../prototypes/insight-composer/src/workspace/workspace.css)、[queue.css](../../prototypes/insight-composer/src/workspace/queue.css)、[reader-select.css](../../prototypes/insight-composer/src/reader-select.css) |
| DS-04、DS-05 | [弹窗](overlays.md)；[共享工作区组件](../../prototypes/insight-composer/src/workspace/shared.jsx)、[WorkspaceDialog.jsx](../../prototypes/insight-composer/src/WorkspaceDialog.jsx)、[ReadingSettings.jsx](../../prototypes/insight-composer/src/ReadingSettings.jsx) |
| DS-06、DS-07 | [导航与布局](navigation-layout.md)；[workspace.css](../../prototypes/insight-composer/src/workspace/workspace.css)、[flow.css](../../prototypes/insight-composer/src/workspace/flow.css)、[queue.css](../../prototypes/insight-composer/src/workspace/queue.css) |
| DS-08、DS-09 | [状态反馈](feedback.md)；[WorkspaceLoading.jsx](../../prototypes/insight-composer/src/WorkspaceLoading.jsx)、[QueuePage.jsx](../../prototypes/insight-composer/src/workspace/QueuePage.jsx)、[workspace-shell.css](../../prototypes/insight-composer/src/workspace-shell.css) |
| DS-10 | [动效](motion.md)；[motion-system.js](../../prototypes/insight-composer/src/motion-system.js)、[Motion.jsx](../../prototypes/insight-composer/src/Motion.jsx) |

## 有理由保留的场景差异

- **顶栏入口与主要提交**：添加任务的白底细框、Queue 提交与阅读主操作的深色强调，反映操作层级；不能用 DS-02 将其全部刷成同色。
- **正文与 UI**：阅读字体、语言、对象字号由内容语义及阅读偏好控制，不要求等于界面文字大小。
- **居中弹窗、菜单与灯箱**：弹窗承担模态任务，菜单锚定当前对象并原地淡入，图片查看保留深色场景与直接手势。
- **不同页的内容组织**：Collection 资料与详情、Flow 阅读活动与洞见、Queue 行内任务展开有不同业务职责；统一框架和操作预期不要求三页列数永远相同。

若后续决定保留表中某项差异，需要在主题页写清适用场景和理由，并在变更记录关闭该项；不能只将“待统一”改名为“例外”。
