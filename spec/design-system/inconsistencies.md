# 统一项与验收状态

[设计系统](README.md) · [维护与验证](maintenance.md) · [设计变更记录](changelog.md)

这里保留初始 11 项差异的编号和解决范围，避免实现后丢失依据。状态仅对应本轮源码及实际浏览器验证，不代表已发布、安装版或真实个人资料库验收。后续出现新差异继续追加编号，不把局部变体悄悄改成全局规则。

## 初始 11 项

| 编号 | 已实施的规则与范围 | 验证依据 | 状态 |
| --- | --- | --- | --- |
| DS-01 | `ui-tokens.css` 提供颜色、字号、尺寸、间距、圆角和焦点刻度；工作区、Reader 常规操作及 Desktop Updates 使用共享角色；Settings 冻结作用域重新计算派生尺寸 | 控件三档缩放、长文案、Settings 打开中改比例及重开 | 已完成 |
| DS-02 | `ui-controls.css` 明确 entry / secondary / submit / read / text / tool 与 compact；浅色操作一律无描边灰底，含选择卡和遗留入口；提交/阅读保留实色 | 默认、hover、selected、disabled、busy、防重复、键盘、遗留控件检查 | 已完成 |
| DS-03 | 普通字段和 ReaderSelect 使用白底、完整浅色细边和 6px × scale 圆角；多行输入保留明确的编辑范围。柔和焦点边框和光晕优先于 hover；紧凑触发器的菜单具有独立最小宽度，保留原生语义与真实点击范围 | 三档白底字段、原生键盘与双 Esc、33 组合对齐、radio、字段点击范围、强制颜色及短窗口滚动；短菜单单行与右缘定位 | 已完成 |
| DS-04 | 两种 WorkspaceDialog、Settings、Reader 洞见、Question、Margin 共享 `useModalDialog`、native top layer、背景、焦点和计数滚动锁 | 八类入口的 24 条关闭路径、嵌套 475 帧、反向、卸载及 Reader 11 组逐帧 | 已完成 |
| DS-05 | 普通表单、宽内容、固定设置面板与紧凑任务编辑器有明确尺寸角色；导航/详情保留明确角色，统一窗口约束与内部滚动；Queue 使用 560×420 基础外框避免简单表单过空 | 80/100/120% 与短窗口几何检查；Queue 五种任务切换不改变外框 | 已完成 |
| DS-06 | 三页同级导航使用无描边浅灰选中面，标题统一 16px × scale 与常规 65px × scale 标题区 | 三页三档比例的计算样式/布局比较及截图 | 已完成 |
| DS-07 | 导航断点统一 640 × scale；窄窗导航是临时模态，不改桌面偏好；Queue 内容按可用宽度与 scale 折叠，Flow 紧凑时纵向排列或用详情弹窗；改变缩放引起的详情弹窗等待设置原生退出 | 三页导航键盘/背景/焦点/resize；900×600、120% 全应用与 700px 额外检查；Flow/Settings 5 组组合回归 | 已完成 |
| DS-08 | `InlineError` / `ActionError`、`EmptyState`、`useClipboardFeedback` / `CopyFeedback` 统一；保留业务恢复动作与就近显示 | 错误反向/草稿/窄窗，复制等待、乱序、失败、重试与生命周期 | 已完成 |
| DS-09 | Flow 实页和加载壳共用 `flowPanelLayout`；Queue 未知计数保留空白，不伪造 0；用户滚动优先于慢响应恢复 | Flow 四分区首帧几何、Queue 慢读/空态/失败/后台刷新、慢读期间真实 wheel | 已完成 |
| DS-10 | `MOTION_FADE` 派生 picker/menu/viewer 的 CSS 时序；普通模态背景直接跟随 Motion 表面透明度；动画命令在挂载完成后的 Motion 帧启动，保留直接手势与页面快照专用规则 | 任务展开中间帧、快速反向、实时 reduced motion、启动前取消、模态逐帧同步与嵌套 | 已完成 |
| DS-11 | Desktop Updates 的操作、文字、状态面板和进度布局使用共享 token 与按钮角色 | 模拟 bridge 的检查/可用/下载/已下载/重启失败/完整安装/空闲与三档比例 | 已完成 |

## 实现与复验入口

| 条目 | 维护位置 |
| --- | --- |
| DS-01、DS-02、DS-03、DS-11 | [视觉基础](foundations.md)、[按钮](buttons.md)、[表单](forms.md)；[ui-tokens.css](../../prototypes/insight-composer/src/ui-tokens.css)、[ui-controls.css](../../prototypes/insight-composer/src/ui-controls.css)、[ui-controls.browser](../../prototypes/insight-composer/tests/ui-controls.browser.mjs) |
| DS-04、DS-05、DS-10 | [弹窗](overlays.md)、[动效](motion.md)；[useModalDialog](../../prototypes/insight-composer/src/useModalDialog.js)、[modal.css](../../prototypes/insight-composer/src/modal.css)、[dialog-backdrop.browser](../../prototypes/insight-composer/tests/dialog-backdrop.browser.mjs)、[reader-overlay-motion.browser](../../prototypes/insight-composer/tests/reader-overlay-motion.browser.mjs) |
| DS-06、DS-07、DS-09 | [导航与布局](navigation-layout.md)、[状态反馈](feedback.md)；[workspace-layout](../../prototypes/insight-composer/src/workspace/workspace-layout.js)、[workspace-design-system.browser](../../prototypes/insight-composer/tests/workspace-design-system.browser.mjs)、[queue-loading.browser](../../prototypes/insight-composer/tests/queue-loading.browser.mjs) |
| DS-08 | [状态反馈](feedback.md)；[Feedback.jsx](../../prototypes/insight-composer/src/Feedback.jsx)、[feedback.browser](../../prototypes/insight-composer/tests/feedback.browser.mjs) |

## 保留的职责差异与验证边界

- **入口与提交**：轻灰无描边入口、深色提交/阅读及纯文字计划操作表达不同层级；不再推荐白底深色描边按钮。
- **字段与动作**：输入区使用白底、浅色完整边框与适度圆角；字段聚焦使用柔和边框和光晕，按钮和选择卡保留独立焦点轮廓。强制颜色使用系统反馈。
- **正文与 UI**：阅读字体、语言和对象字号遵循内容语义及阅读偏好，不跟随界面控件刻度改变原文。
- **弹窗、菜单与灯箱**：普通模态共享背景与生命周期，锚定菜单保持原地出现，图片查看保留深色场景及直接缩放/拖动。
- **不同页的内容组织**：Collection 资料与详情、Flow 活动与洞见、Queue 行内任务有不同职责；统一导航与反馈，不强制相同列数。
- **窗口范围**：当前原生最小窗口为 900×600；700px / 120% 的额外浏览器检查也通过。320px / 390px 配合 120% 的浏览器压力测试仍可能出现顶栏横向溢出；该宽度超出原生窗口范围，没有将本次工作扩展为移动端设计。
- **环境范围**：本轮是独立资料库和测试数据的源码浏览器验证；Desktop Updates 使用模拟 bridge。没有发布安装包、迁移真实个人资料库或进行真实更新下载/重启验收。

新增例外必须写出业务理由、适用入口及验证方式；仅把“待统一”改名为“例外”不算解决。
