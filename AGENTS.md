# Planner / executor / reviewer workflow

Keep the user's selected strong main model responsible for understanding, task boundaries, planning, integration, independent acceptance and final decisions. Never change the selected model automatically.

For substantial local implementation, repair or test work, use the `deepseek_harness` MCP tool `delegate_to_deepseek` for bounded execution. Include the absolute workspace, allowed files/actions, constraints and meaningful checks. Never put credentials in task text. Delegation does not expand the user's authorization or the worker's workspace permissions.

Split independent work into separate workspaces or Git worktrees before parallel execution. Default to at most 4 concurrent delegate calls (configured limit 1..5 per MCP process). Same-workspace tasks are serialized. Do not use overlapping directories or multiple MCP processes to bypass workspace locks. Do not ask workers to recursively delegate, open another Codex chat or publish results.

Inspect actual changes and run appropriate independent checks. A worker report or `execution_completed` is not acceptance. If checks fail, send a focused correction with evidence, at most twice, before repairing directly or reporting a real blocker. Report environmental test limitations and partial edits accurately.

Use `get_bridge_task_status` to inspect real process/event state. A heartbeat is not evidence of task progress. On interruption, cancellation or timeout, inspect partial effects before any retry. Use `cancel_deepseek_task` only for the intended task; it does not undo edits.

Simple questions and work the user explicitly assigns to the main model can be handled directly. If the MCP tool is unavailable, say so and explain that reloading the app/chat may be needed. Never pretend delegation occurred. This workflow does not itself authorize publication, destructive changes, installation or secret access.
