# 配置参考

安装和注册 MCP 只让工具可用，不代表允许自动委派。默认由 Codex 直接工作；你可以明确要求当前任务使用 DSH，也可以在 Codex 建议具体委派范围后确认。确认前不调用 worker 或为委派导出对话，授权只在本次约定范围内有效。已授权任务的状态查询与取消不需要再次确认委派。

## 交给另一个 Codex 完成安装

可以把下面这段发给自己的 Codex。安装行为仍需符合你对该聊天的授权与本机限制：

> 请阅读本仓库 README.md、CONFIGURATION.md 和 configure.mjs。检查 Node.js 版本、DSH Desktop 的实际安装位置、我已配置的 DSH profile，以及现有 Codex MCP 配置。先运行 npm ci --ignore-scripts 和 npm run test:strict。使用 node setup.mjs --help，先 --dry-run 验证目标，再创建专用 worker profile 并 --register-codex。保留我当前主模型及其他配置，不读取或输出凭据值，不把本地配置提交 Git。检查冲突后再改；在我授权真实 API 测试后运行 smoke。最后说明实际通过和未通过的检查、需要重新加载 MCP 的步骤。

## 安装参数

| 参数 | 默认/含义 |
| --- | --- |
| `--desktop-root DIR` | Windows DSH Desktop 安装根目录，包含 `DeepSeek Harness.exe` 和 `resources/app.asar` |
| `--cli-entry FILE` | 替代 Desktop 模式：已安装的实际 JS CLI 文件，通过当前 Node 启动；不能是 `.cmd`、`.ps1` 或 shell 文件 |
| `--dsh-home DIR` | `DSH_HOME` 或用户主目录下 `.dsh` |
| `--source-profile NAME` | `desktop`，必须已选择有效模型 |
| `--profile NAME` | `codex-worker`，必须不同于源 profile |
| `--max-concurrency N` | `4`，整数 `1..5`，每个 MCP 进程独立计算 |
| `--timeout-ms MS` | `1800000`，总执行时限，允许 `1000..3600000` |
| `--state-dir DIR` | 本仓库 `.state`；包含 tasks 台账，启用隔离时还包含 worker 会话/storage |
| `--isolate-sessions` | 可选；worker 使用独立会话/storage，DSH 桌面默认列表通常不可见。默认复用源 profile 的存储位置 |
| `--config FILE` | 本仓库 `bridge.config.json` |
| `--register-codex` | 显式追加 MCP 条目；默认只生成 DSH/runtime 配置 |
| `--codex-home DIR` | `CODEX_HOME` 或用户主目录下 `.codex` |
| `--server-name NAME` | `deepseek_harness` |
| `--dry-run` | 校验配置、显示目标路径，不写文件 |
| `--force` | 备份并替换不同的 worker/runtime 文件；仍不覆盖冲突的已有 MCP 条目 |

Desktop 模式对应的内部 CLI 为 `resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js`，不是 GUI 的启动入口。版本改变后如果此布局变化，需要重新验证。

## 模型服务与凭据

安装器解析 `profiles/<源profile>/cordis.patch.yml`，读取 `agent-default-model`，支持该 profile 中 `llm-pi-ai` 的选中 provider 或 `deepseek-official` 对应的 `llm-deepseek`。选择的模型必须真实存在于服务商；桥接器不会替服务商实现工具调用或协议转换。

它仅复制选中路由，不读取凭据存储。`apiKeyEnv` 等引用可保留；遇到内嵌 API key、token、密码或含用户信息/查询串的 endpoint 会拒绝生成。请先在 DSH 设置中改为托管凭据引用。不要把凭据放进任务提示词、命令行或提交到 Git。

worker profile 使用 `@deepseek-ai/dsh-base` 与 `@deepseek-ai/dsh-headless`。默认保留桌面会话可见性，独立存储需显式加入 `--isolate-sessions`。关闭递归 subagent、workflow、web 工具和 DeepSeek 会话上传。审批配置为 `never`，匹配 `workspace-write` 自定义 preset：不能通过无人值守的交互审批扩大工作区权限。

## Codex 注册与更新

生成的条目使用当前 Node 的绝对路径和本仓库 `server.mjs` 的绝对路径；移动本仓库后需要更新注册路径。默认工具审批为 `prompt`，不要假设第一次调用一定无提示。

已有相同 MCP 条目时幂等；已有不同条目时拒绝覆盖。先检查现有条目并手工合并，或通过 `--server-name` 选择其他名称；不要同时保留两个服务向同一工作区并发写入。写入前会为原文件生成 `.bak.<时间戳>` 备份，其他 TOML 设置与主模型保持不变。

修改本机 `bridge.config.json` 可调整 `timeoutMs`、`maxConcurrency`、`heartbeatMs`、`stallWarningMs`。通过 `DSH_BRIDGE_CONFIG_PATH` 选择其他 runtime 文件，通过 `DSH_BRIDGE_MAX_CONCURRENCY` 可覆盖并发值。配置中的 `stateDir` 优先，否则读取 `DSH_BRIDGE_STATE_DIR`。修改后重新加载 MCP；只改 runtime 超时不会自动同步现有 Codex 的 `tool_timeout_sec`。

## 失败排查

- `permission_denied`：检查实际可执行路径和 DSH 工作区权限。Codex 外层沙箱限制与 worker 自身限制是两层；不要通过关闭所有保护掩盖错误。
- `launch_error`：检查 executable、ASAR 内 CLI 路径、Node 版本和 DSH 安装完整性。
- `timed_out`：已达到总时限；检查部分修改后拆小任务或调整 worker 与外层 MCP 时限。
- `interrupted` / `process_exit` / `no_final`：没有完整完成证据，不能验收；查看安全元数据、实际文件与 DSH 本地会话。
- `suspectedStall=true`：只有活动间隔较长，可能模型正在思考或工具长时间运行。心跳不代表任务有进展。
- GUI 显示“任务已停止”：先用 `get_bridge_task_status` 对照进程与事件；外部 headless 会话在 GUI 中的历史展示不一定代表当前实际执行状态。

桥接器不自动重试有副作用的任务，也不删除旧台账或会话。需要时在确认任务已结束后自行归档本地 `.state`。
