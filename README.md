# Subtitle Timeline Workbench

单机字幕时间轴修复工作台。它把 SRT、WebVTT 和帧号文本导入为不可变原始 cue，在服务端识别时间轴断点、诊断冲突、求候选方案、做版本控制与三方合并；网页只作为规则的可见入口。

## 运行

```bash
npm install
npm test -- --run
npm run dev -- --host 127.0.0.1 --port 5201 --strictPort
```

打开：<http://127.0.0.1:5201>

运行时没有第三方依赖，不需要构建步骤。持久化默认写入 `data/`，也可用 `TIMELINE_DATA_DIR=/path/to/data` 指定独立目录。

## 数据模型

- `source.raw`：导入文件的完整原文。
- `source.headers`：WebVTT 的 `NOTE`、`STYLE`、`REGION` 等原始块。
- `cue.rawBlock`：每个 cue 在源文件中的原始文本块。
- `timeline`：规范化后的当前基线，所有时间均为非负整数毫秒。
- `candidates`：求解、手工修改或合并产生的版本；原始时间轴不会被覆盖。
- `events.jsonl`：事件日志；状态在启动时重放得到。
- `requests.json`：幂等 requestId 到响应的持久化索引。

异常退出后启动时会重放完整 JSONL，并丢弃最后一条不完整事件。有效事件不会被回滚，因此崩溃前已确认的提交仍可恢复。

## 规则与求解器

服务端规则在 `src/core/rules.mjs`：

- cue 不允许倒序或负时长。
- 相邻 cue 必须满足最小间隔。
- 说话人切换必须满足额外间隔。
- 按去标签后的字符数计算最大 CPS 所需时长。
- 锚点声明某个 cue 的开始或结束必须落在指定毫秒。
- `stretchCueIds` 中的 cue 允许变长；刚性 cue 保持原时长。

每个 cue 被建模为刚性时间块，约束写成相邻开始时间的下界差分约束：

`start[i] + duration[i] + requiredGap <= start[i+1]`

无锚点区间先检查固定锚点之间是否已经矛盾；固定约束矛盾时直接返回最小相关约束集合。可行时把非负毫秒变量转换为单调 L1 投影，用 Pool Adjacent Violators 风格的中位数合并得到总绝对位移最小的整数解。伸缩 cue 只使用 `max(originalDuration, cpsDuration)`，不会为了避让而缩短阅读时间。

不可行时不挑一个约束“自动忽略”，而是返回冲突核心。当前实现通过 Bellman-Ford 正环检测和逐条边删除来缩小冲突集合；它面向后期制作中常见的几十到几百条 cue，没有为超大文件做专门的高性能 MUS 枚举。

## 时间轴断点

`src/core/parser.mjs` 会标出：

- cue 重叠；
- 相邻 cue 的显式 fps 标记变化；
- 超过 60 秒的大间隔；
- WebVTT/帧号块中携带的 timebase/fps 标记。

支持 23.976（24000/1001）、24、25、29.97、30 以及其他正数 fps。23.976 使用精确有理数换算，再对单帧毫秒四舍五入；重复 SRT/WebVTT 导出不会持续漂移，帧号导出的边界也由同一换算函数集中计算。

## 版本、锁定与合并

- 所有写请求都带 `expectedVersion`；落后版本返回 `409`、当前项目状态和 incoming/current 差异，不静默覆盖。
- `Idempotency-Key` 语义由请求体中的 `requestId` 提供；相同 requestId 重放持久化结果。
- 候选可从 active 锁定为 locked；locked 不能再次锁定，merged/superseded 也不能跳回 active。
- 合并使用 base/A/B 三方比较：不同字段的非冲突修改自动合入；同一 cue 的同一文本或时间字段被双方改成不同值时生成冲突候选和三方上下文。

页面可以锁住一段后重新求解；锁定会把该 cue 当前开始和结束转换为锚点。若这些锚点与规则冲突，服务端返回冲突集合而不是强行移动锁住内容。

## 导出与 loss report

`GET`/导出 API 可选择原时间轴或某个候选，输出：

- 确定性序列化文本；
- JSON loss report；
- 建议文件名。

SRT 只能保留序号、毫秒时间和正文；WebVTT cue settings、非数字 cue id、`NOTE`、`STYLE`、`REGION` 会记录为无法写回。WebVTT 导出保留这些块。帧号文本导出会记录 fps 和帧边界量化。原始内容始终留在事件数据中，loss report 只描述目标格式不能表达什么。

## 主要 API

- `POST /api/projects`：导入并创建项目。
- `GET /api/projects/:id`：读取完整项目、候选和诊断。
- `POST /api/projects/:id/solve`：基于锚点、伸缩 cue、锁定 cue 求候选。
- `POST /api/projects/:id/candidates`：手工候选。
- `POST /api/projects/:id/candidates/:candidateId/lock`：更新锁定状态。
- `POST /api/projects/:id/merge`：三方合并两个候选。
- `POST /api/projects/:id/export`：导出内容与 loss report。
- `GET /api/health`：健康检查和事件版本号。

## 测试

`npm test -- --run` 覆盖：

- SRT/WebVTT/帧号解析与 raw block 保留；
- 23.976 帧换算和确定性时间戳；
- 重叠修复、整数毫秒、最小位移；
- 锚点矛盾与最小冲突集合；
- CPS、相邻间隔、说话人切换诊断；
- 三方自动合并与文本冲突；
- 确定性导出和 loss report；
- 重复 requestId、版本冲突、非法状态跳转；
- 事件日志尾部损坏后的进程恢复。

## 架构取舍与限制

- 选择 Node 内置 HTTP + JSONL，而不是数据库或 Web 框架：零安装、易审计、事件可直接检查；代价是尚无多用户认证和复杂查询。
- 核心规则与 UI 完全解耦，所有约束都在 `src/core` 中可单测。
- 当前目标是单机工作台，所有 store 写操作为同步 I/O；这保证崩溃语义直观，但不应直接扩展成高并发服务。
- 时间轴断点提示是诊断线索，不会猜测用户意图自动改 fps。
- 伸缩段以 cue 为单位；尚未实现跨多条 cue 的单条仿射 warp 曲线编辑 UI。
- 样式块在 WebVTT 往返中保留，但解析器不验证 CSS/REGION 语义。
