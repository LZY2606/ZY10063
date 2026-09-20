# 字幕时间轴工作台

面向后期制作的单机工作台：导入 SRT / WebVTT / 带帧号文本（支持 23.976、24、25 fps 及中途换时基），
在保留原始 cue 的前提下识别时间轴断点，通过锚点声明与段伸缩求出「不倒序、无负时长、尽量少移动」
的修复方案，并支持锁段重解、三方合并与确定性导出。

## 运行

```bash
npm install
npm test -- --run
npm run dev -- --host 127.0.0.1 --port 5201 --strictPort
# 打开 http://127.0.0.1:5201
```

零第三方依赖，Node.js ≥ 18 即可（开发用的是 Node 26）。

## 架构

```
src/core/    纯函数规则层（不依赖 Node API 之外任何东西）
  parse.js     SRT / WebVTT / 帧号文本解析，raw 块原样保留
  solve.js     锚点/锁段约束求解 + 最小冲突集（MUS）归约
  diagnose.js  断点识别（fps 切换、重叠、倒序、大空隙）与 CPS/间隔/说话人诊断
  merge.js     三方合并（base/left/right），冲突附三方上下文
  diff.js      cue 级差异
  export.js    SRT / WebVTT / 帧号文本导出 + loss report
server/      规则的唯一执行入口
  store.js     快照 + 追加式日志持久化，崩溃后重放恢复
  app.js       HTTP API：状态机、版本并发控制、幂等键
  index.js     CLI 入口（--host/--port/--strictPort/--data-dir）
web/         静态页面，只是规则的可见入口（原时间轴 / 候选方案 / 差异轨道）
tests/       node:test 测试
```

**核心规则全部在服务端**。网页不实现任何求解/合并/导出逻辑，只调用 API 并渲染结果。

## 关键设计取舍

- **原文与修订分离**：导入内容（`source.raw`）与每次解析/求解产生的版本（`revisions`）分开持久化，
  任何规范化、求解、合并都另存新版本，原始 cue 永不被覆盖。
- **求解模型**：锚点（台词 → 帧）与锁段构成固定点，固定点之间做分段线性时间扭曲（段内整体伸缩），
  段外刚性平移；随后按最小时长（默认 800ms）与最小间隔（默认 80ms）做确定性放置。
  这是启发式而非严格 LP 最优，但保证：不倒序、无负时长、锚点精确命中、结果确定。
- **无解时的最小冲突集**：求解器报告冲突约束键（如 `anchor:cue-3`、`segment-fit:cue-1:cue-2`），
  `minimizeConflictSet` 用「只启用子集」的归约法求 MUS——集合整体不可解、去掉任意一个即可解，
  由用户决定放松哪条，系统不擅自忽略约束。
- **CPS 与说话人连续性**作为诊断参与冲突分析：CPS 超限时先向后续空隙延展，仍超限则列入诊断，
  不静默截断文本。
- **并发控制**：每个项目有单调递增 `version`，所有变更请求必须携带 `expectedVersion`；
  落后的写入返回 409 及该版本到当前版本的 cue 级差异，绝不静默覆盖。
- **幂等**：POST 携带 `idempotencyKey` 时，重复请求（包括重试、刷新重发）回放首个响应，
  不产生重复副作用；失败响应同样被记录。
- **崩溃恢复**：所有写操作先追加到 `journal.log`（同步落盘）再应用；正常退出时写快照并清空日志；
  异常退出后重启从「快照 + 日志重放」恢复，半行写入会被安全跳过。
- **确定性导出**：导出内容只依赖 cue 数据（无时间戳、固定排序、固定换行），同一版本导出两次字节一致；
  帧号导出把时间量化到帧，一次量化即达不动点，重复导入导出不会持续漂移。
- **Loss report**：导出时保留目标格式可表达的全部信息（如 VTT 的 NOTE/STYLE/cue 设置/说话人标签），
  无法写回的（如 SRT 丢掉注释、样式、cue id）逐条列入 loss report。

## 状态机

```
draft --analyze--> analyzed --solve--> solved --finalize--> finalized
                     ↑________solve________|        |
                     └──locks(锁段重解)──┘        └--export--> (solved/finalized 均可导出)
```

非法跳转（如 draft 直接 solve/export）返回 409 `illegal_transition`。

## 帧号文本格式

```
# fps=23.976        ← 时基声明，可多次出现（中途换时基）
120 168 台词文本     ← 起始帧 结束帧 文本
150|180|也支持竖线
200-240 也支持横线
```

## API 摘要

- `POST /api/projects` 导入（`content`/`format`/`fps`/`idempotencyKey`）
- `POST /api/projects/:id/analyze|solve|locks|merge|finalize|export`（均需 `expectedVersion`）
- `GET /api/projects/:id`、`GET /api/projects/:id/diff?a=1&b=2`

## 已知限制

- 求解器是确定性启发式，不保证数学意义上的全局最小移动量。
- 最小冲突集求的是某一个 MUS，不枚举全部冲突集。
- 合并以 cue id 对齐，不处理双方各自新增/删除整行之外的结构性重排。
- 单机单进程设计，持久化为 JSON 日志，未考虑多进程并发写同一数据目录。
- 帧号文本的「台词文本」按纯文本处理，不解析内联样式。
