# Codex DSH Executor Bridge

让 Codex 的强主模型负责规划、拆分、验收和修正，让 DeepSeek Harness（DSH）执行边界明确的子任务。主模型保持你当前选择的模型，安装器不会更换它。

这是一个本地 stdio MCP 服务。模型请求由你自己安装的 DSH 发出；**不要求使用 DeepSeek 官方 API**。可以复用 DSH 中已选定的第三方模型服务，但服务必须支持 DSH 所选协议、工具调用和模型配置。不要把任意聊天接口直接当成兼容的代理执行接口。

## 工作方式

```text
Codex 强主模型 → 拆分任务/明确边界与验收条件
              → delegate_to_deepseek → DSH 独立会话 → 文件修改/检查
              ← 执行报告、进程状态和完成事件
              → 独立检查实际 diff 与测试 → 必要时定向修正 → 最终验收
```

- 默认每个 MCP 进程最多 **4** 个并发任务，可配置为 **1–5**。
- 同一个真实工作区路径串行；独立目录或 Git worktree 可以并发。不要把相互重叠的父子目录当作独立工作区。
- 桥接器不会自动拆任务。主模型需要主动同时发起多个独立委派；顺序调用仍然是顺序执行。
- 每个聊天可能启动独立的 MCP 进程；不同进程不共享并发额度，也不共享工作区锁。
- `execution_completed` 只表示执行协议完整结束，**验收由主模型负责**。

## 快速配置（Windows）

已在 Windows 的 DSH Desktop **0.2.1-rc.2** 环境验证。Node.js 要求 **24 或更新版本**。其他 DSH 版本可能调整内部 CLI 路径或配置格式；安装后先做 smoke test。macOS/Linux 的实际 DSH 启动尚未验证。

1. 安装 [DeepSeek Harness Desktop](https://github.com/deepseek-ai/deepseek-harness)。在桌面端配置模型服务、保存凭据并选中要交给子任务使用的模型。先确认它能正常执行一个简单任务。
2. 克隆本项目并安装固定依赖：

   ```powershell
   git clone https://github.com/eririmoe/codex-dsh-executor-bridge.git
   cd codex-dsh-executor-bridge
   npm ci --ignore-scripts
   ```

3. 预览配置。把示例安装目录替换为自己的实际目录：

   ```powershell
   node setup.mjs --desktop-root "C:\Apps\DeepSeek Harness" --register-codex --dry-run
   ```

4. 检查输出的目标路径后去掉 `--dry-run`：

   ```powershell
   node setup.mjs --desktop-root "C:\Apps\DeepSeek Harness" --register-codex
   ```

   默认读取 DSH 的 `desktop` profile，只复制当前选中模型的路由和凭据引用，创建专用 `codex-worker` profile、忽略入库的 `bridge.config.json`，并为 Codex 追加 MCP 条目。不复制凭据存储，不覆盖主模型。已有不同配置会拒绝覆盖；见 [配置说明](CONFIGURATION.md)。

5. 重启 Codex 或打开能够重新加载 MCP 配置的新聊天。将 [AGENTS.md](AGENTS.md) 中的工作规则合并到需要使用它的项目。可直接告诉 Codex：

   > 保持当前强模型负责规划与验收。通过 deepseek_harness 的 delegate_to_deepseek 委派执行；先明确工作区、允许修改的文件和验收检查。独立任务可使用独立工作区并发，默认最多 4 个。你需要独立检查结果；失败后最多定向修正两轮。

6. 运行本地测试；真实模型测试需单独显式启用，会使用你所配置的模型服务：

   ```powershell
   npm run test:strict
   $env:DSH_BRIDGE_SMOKE = "1"
   npm run smoke
   Remove-Item Env:DSH_BRIDGE_SMOKE
   ```

`dsh` 不在 PowerShell 的 PATH 中也可以使用：Desktop 模式直接调用实际安装目录中的可执行文件和 ASAR 内的 CLI，通过 UTF-8 stdin 发送任务，避免 `.cmd` 和 shell 引号损坏中文或代码。

## 任务上下文（可选）

委派可以增加 `contextPath`：指向**工作区内、主模型已经检查的 JSON 文件**。桥接器在收到请求时读取一次、计算 SHA-256，并把该版本的完整 JSON 与路径直接嵌入 worker 的 stdin。排队期间即使原文件改变，该任务仍使用提交时的内容。台账只记录路径、字节数和哈希。

上下文格式见 [示例](examples/task-context.example.json)：`summary` 写目标背景，`confirmedFacts` 写已核实事实，`invariants` 写不可变约束，`acceptanceChecks` 写验收条件，`messages` 仅存相关用户/助手对话。历史消息不会扩展当前任务授权。正确上下文能减少遗漏，但不能保证执行模型保持概念准确，主模型仍需独立验收。

需要从当前 Codex 聊天导出草稿时，主模型应先核实该聊天的实际 rollout JSONL，再运行：

```powershell
node scripts/export-context.mjs --source "<当前聊天的实际JSONL路径>" --output ".bridge-context/task-001.json"
```

导出器仅保留最近的可见用户/助手文本，默认最多 40 条、48,000 字节文本；排除工具结果、系统/开发者记录及内部分析，不读取消息中提到的文件。它会遮盖部分常见密钥格式，但不能保证识别所有敏感内容。导出不会调用模型；**主模型必须检查草稿、补充事实和不变量后再委派**。不要将原始日志交给 worker，也不要把不同聊天的最新文件误当作当前聊天。

示例工具参数（路径替换为实际绝对路径）：

```json
{
  "workspace": "C:/Projects/example-task",
  "contextPath": "C:/Projects/example-task/.bridge-context/task-001.json",
  "task": "只修正允许文档中的参数解释，遵守上下文中的事实和不变量，并报告检查结果。"
}
```

`contextPath` 必须位于实际工作区内，最大 96 KiB；不接受原始 JSONL、其他角色或未知字段。未提供时保持原来的调用行为。其他项目也应将 `.bridge-context/` 加入自身 Git 忽略规则。

## 超时与停止监测

默认 worker 总时限 **30 分钟**，可通过 `--timeout-ms` 设置 1 秒至 60 分钟。安装器把外层 MCP 工具时限设为 worker 时限加 5 分钟。排队等待也占用调用方的 MCP 时限；大量排队时应缩小批次或自行增加外层时限。

默认每 5 秒记录进程心跳，分别保留真实事件的 `lastActivityAt`。连续 3 分钟没有新事件仅标记 `suspectedStall`，不会因此自动杀进程或编造进度。总时限是硬上限，即使仍有活动也会停止。

成功必须同时满足：进程以 0 退出、收到 `turn_end` 的 `completed` 原因、收到 `final`，且没有协议或显式错误。非零退出、启动权限错误、取消、总超时、输出超限和缺失完成事件会分别报告。失败不自动重试，也不会撤销可能已发生的文件修改。

默认复用源 profile 的会话/storage 位置，保留 DSH 桌面列表可见性。DSH 桌面界面不一定拥有外部 headless 会话的实时状态，可能把它作为历史会话显示中断。请结合 MCP 状态、真实进程和完成事件判断；不能仅凭 GUI 提示认定仍在运行或已经停止。需要独立存储时在安装中加入 `--isolate-sessions`，此时桌面默认列表通常看不到 worker 会话。

## MCP 工具

| 工具 | 用途 |
| --- | --- |
| `delegate_to_deepseek` | 输入 `task`、绝对 `workspace`，可附 `taskId`、`rootTaskId`、`parentTaskId`；排队或执行后返回报告 |
| `get_bridge_task_status` | 查询状态、PID、心跳、实际活动时间、阶段和完成事件；不返回推理或工具输入 |
| `cancel_deepseek_task` | 取消当前 MCP 进程拥有的任务；必须继续检查终态及部分修改 |

任务 ID 不得复用。服务器退出会终止自己创建的 worker。重启后查询旧任务时，如果原 MCP 进程已消失，会报告 `interrupted`；不会仅凭磁盘里的旧 PID 杀进程或自动重新执行。

## 源码与隐私

源自项目 [deepseek-harness-codex-bridge](https://github.com/Aloneswork/deepseek-harness-codex-bridge)，来源与变更见 [NOTICE.md](NOTICE.md)。它是社区桥接器。
