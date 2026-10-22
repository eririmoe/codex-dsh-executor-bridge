# Source attribution

This project derives from [Aloneswork/deepseek-harness-codex-bridge](https://github.com/Aloneswork/deepseek-harness-codex-bridge), MIT licensed, at commit `b17d6d9774f558fa724a9d04823a305c6554364a`. The original copyright and MIT license are retained in LICENSE.

This distribution adds a portable DSH Desktop / JavaScript CLI setup flow, model-route reference selection, isolated worker persistence, bounded concurrency with same-workspace serialization, structured headless completion monitoring, cancellation, and independent fixture tests. It removes workstation-specific configuration and deployment evidence from the distributable source.

[oil-oil/codex-deepseek-subagent](https://github.com/oil-oil/codex-deepseek-subagent) was an initial project evaluated during setup; this bridge uses a separate DSH process instead of replacing the main Codex model or patching Codex's internal agent implementation.
