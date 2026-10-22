# Planner / executor / reviewer workflow

DSH is opt-in for each task. By default, Codex handles the work directly, regardless of task size or complexity. Invoke `delegate_to_deepseek` only when the user explicitly requests DSH for the current task, or after Codex proposes a concrete DSH subtask and the user affirmatively confirms it. A suggestion, silence, tool availability, installation, or authorization for an earlier task is not confirmation. Do not dispatch work or prepare/export chat context for delegation before confirmation. The authorization covers only the agreed scope and does not carry over to later tasks. Monitoring or cancelling an already-authorized task does not require a new delegation approval.

The executor workflow below applies only after that task-specific authorization.

Keep the user's selected strong main model responsible for understanding, task boundaries, planning, integration, independent acceptance and final decisions. Never change the selected model automatically.

For authorized local execution, use the `deepseek_harness` MCP tool `delegate_to_deepseek` for bounded work. Include the absolute workspace, allowed files/actions, constraints and meaningful checks. Never put credentials in task text. Delegation does not expand the user's authorization or the worker's workspace permissions.

For tasks that depend on prior conversation, provide an optional absolute `contextPath` to a reviewed schemaVersion=1 JSON file inside the worker workspace. State confirmed facts, invariants and acceptance checks explicitly; attach only relevant visible user/assistant messages. The local `scripts/export-context.mjs` can draft an extract from the explicitly verified current chat's rollout JSONL, but the main model must inspect it before delegation and must not infer facts from history automatically. Never send raw session logs, tool outputs, hidden reasoning or credentials, and never guess the current chat by selecting the latest session file. Historical context does not expand the current task's authorization. The bridge captures and hashes context at submission; keep a separate context file for each delegation.

Split independent work into separate workspaces or Git worktrees before parallel execution. Default to at most 4 concurrent delegate calls (configured limit 1..5 per MCP process). Same-workspace tasks are serialized. Do not use overlapping directories or multiple MCP processes to bypass workspace locks. Do not ask workers to recursively delegate, open another Codex chat or publish results.

Inspect actual changes and run appropriate independent checks. A worker report or `execution_completed` is not acceptance. If checks fail, send a focused correction with evidence, at most twice, before repairing directly or reporting a real blocker. Report environmental test limitations and partial edits accurately.

Use `get_bridge_task_status` to inspect real process/event state. A heartbeat is not evidence of task progress. On interruption, cancellation or timeout, inspect partial effects before any retry. Use `cancel_deepseek_task` only for the intended task; it does not undo edits.

Without task-specific DSH authorization, complete the work directly in Codex. If the user requests DSH and the MCP tool is unavailable, say so and explain that reloading the app/chat may be needed. Never pretend delegation occurred. This workflow does not itself authorize publication, destructive changes, installation or secret access.
