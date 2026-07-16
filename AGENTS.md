# AGENTS.md

## Commands

- Install with `pnpm install`; this repo uses pnpm 11 build approvals in `pnpm-workspace.yaml` for native deps (`sharp`, `onnxruntime-node`, `node-llama-cpp`, `esbuild`, `protobufjs`).
- Use `pnpm setup:llama` to detect/prepare llama.cpp explicitly. It checks `LLAMA_SERVER_PATH`, `~/.vision-mcp/bin/llama-server(.exe)`, system/Homebrew paths, and PATH. Runtime auto-installs llama-server from GitHub releases on first use if not found; supports mirror fallback via `LLAMA_DOWNLOAD_MIRROR`.
- Build with `pnpm build`. Do not replace it with bare `tsc`: the script also copies `src/skills/*/{skill.json,prompt.md,schema.json}` into `dist/skills/`, which runtime loading requires.
- Use `pnpm typecheck` for TypeScript verification.
- Use `pnpm test` for the default stable suite. It runs Vitest with `--fileParallelism=false` to avoid `llama-server` port conflicts.
- Use `pnpm test:slow` only when explicitly validating older ONNX/Transformers.js or GGUF model-download/inference paths; it can take minutes locally and may download models.
- Run a focused test with `npx vitest run --fileParallelism=false <test-file>` when it touches GGUF/llama-server.
- `pnpm lint` exists and now passes (flat `eslint.config.js`, `@typescript-eslint/recommended`). Two pre-existing `any` warnings in `src/providers/smolvlm/provider.ts` remain (non-blocking); fixing them needs a real ONNX runtime-types fix, deferred.
- `pnpm test:unit` runs the non-inference suite (router, planner, model-manager, providers skeleton, routing, config, options, errors, runtime-detector) — ~1.7s, no GPU/model/llama-server needed; safe for CI.

## Runtime Prerequisites

- Default runtime is `VISION_PROVIDER=smolvlm2`, selected in `src/index.ts` — SmolVLM2-500M-Video-Instruct (better description quality). `VISION_PROVIDER=gguf` selects the SmolVLM-500M-Instruct fast candidate; `VISION_PROVIDER=onnx` selects the legacy Transformers.js provider.
- GGUF-backed providers discover existing `llama-server` processes by matching the model path in `ps -axo pid=,command=` and extracting `--port`; if a matching healthy process exists, `LlamaServerProcess` reuses it. If none exists, providers allocate a random free high port at runtime. No port registry is written to disk.
- **Runtime依赖**：GGUF-backed providers需要`llama-server`（来自llama.cpp）
- **自动安装**：首次运行时自动从GitHub releases下载，支持镜像站降级（`LLAMA_DOWNLOAD_MIRROR`）
- **路径优先级**：
  1. `LLAMA_SERVER_PATH`环境变量
  2. 项目内`<package-root>/bin/llama-server`
  3. 用户目录`~/.vision-mcp/bin/llama-server(.exe)`
  4. 系统路径（`/opt/homebrew/bin`、`/usr/local/bin`、`/usr/bin`）
  5. PATH查找`llama-server`或`llama-server.exe`
- GGUF model files are expected under `~/.vision-mcp/models/ggml-org/SmolVLM-500M-Instruct-GGUF/` with both `SmolVLM-500M-Instruct-Q8_0.gguf` and `mmproj-SmolVLM-500M-Instruct-Q8_0.gguf` present.
- SmolVLM2 fast candidate files are expected under `~/.vision-mcp/models/ggml-org/SmolVLM2-500M-Video-Instruct-GGUF/` with `SmolVLM2-500M-Video-Instruct-Q4_K_M.gguf` and `mmproj-SmolVLM2-500M-Video-Instruct-Q8_0.gguf` present. `ensureSmolVLM2Model()` can download them when `VISION_PROVIDER=smolvlm2` is used.
- The ONNX provider downloads/cache models under `~/.vision-mcp/models` and uses `HF_ENDPOINT` if set; README defaults to `https://hf-mirror.com`.

## Architecture

- MCP entrypoint is `src/index.ts`; it exposes one stdio tool, `vision.analyze`.
- Request flow is `vision-analyze.ts` -> normalizer -> metadata extractor -> execution planner -> policy engine -> `SkillPipeline` -> provider -> `composeResult`.
- Skills are data-driven folders under `src/skills/<name>/`; each runtime skill needs `skill.json`, `prompt.md`, and `schema.json`.
- `src/skills/registry.ts` loads skills relative to compiled output, so missing copied skill assets in `dist/skills` causes runtime failures even when TypeScript passes.
- `SkillPipeline` currently contains parsing, repair, minimal required-field validation, retry prompt enhancement, and result composition; there is no separate ResponseValidator module yet.
- Logs must stay off stdout for MCP stdio. Use the existing logger; it writes to stderr.


## Recent Optimizations

### Image Classification (Phase 1-7)

Phase 1-7优化实现了"媒介优先"分类逻辑，确保AI生成/绘制图片正确分类为illustration。

详细文档: [Docs/classification-optimization.md](Docs/classification-optimization.md)

**关键改进**:
- 媒介优先原则（Prompt层引导）
- Screenshot反向exclusion rule（规则层修正）
- 次级artwork信号检测（逻辑层补充）
- Dashboard排除规则 + 动物关键词扩展（Phase 7）

**测试结果**: 
- anime编程场景 screenshot(0.7) → illustration(0.65) ✅
- 墨水企鹅插画 dashboard(0.7) → illustration(0.75) ✅


## Testing Gotchas

- GGUF tests start local `llama-server` instances on persisted provider ports; kill stale servers with `pkill -f "llama-server"` if tests fail with bind/port errors.
- `tests/mcp-integration.test.ts` expects `dist/index.js`; run `pnpm build` before that test after source or skill changes.
- Default `pnpm test` excludes the slow ONNX tests in `tests/m1-skeleton.test.ts`, `tests/m1.5-real-inference.test.ts`, and `tests/m2-core-engine.test.ts`.
- The MCP integration test sends real JSON-RPC over stdio and checks `initialize`, `tools/list`, and `tools/call`; prefer it for end-to-end server regressions.

## Current Gaps To Keep In Mind

- `ExecutionPlan.provider/runtime` defaults are driven by `PlannerInput.activeProvider`/`activeRuntime`, which `vision-analyze.ts` populates from the loaded provider. Callers that build `PlannerInput` without these fields still get the legacy `smolvlm`/`onnx` fallback (e.g. slow m2 tests that explicitly use `SmolVLMProvider`). Do not assume `plan.provider` matches the real server unless `activeProvider` was passed.
- `VisionResult.metadata.runtime` IS populated (`composeResult` receives `provider.runtime`); the earlier "missing runtime" note is resolved.
- M5 routing IS wired into `vision-analyze`: `selectProvider()` builds candidates from the registered providers via `providerToCandidate`, runs `chooseProvider` with the request's `options.quality`/`options.provider` + detected resources + requested skills, and returns the provider instance whose `infer()` the pipeline runs. The default/active provider is still `providers[0]` (`SmolVLM2Provider` unless `VISION_PROVIDER` overrides to `gguf` or `onnx`). `VISION_HIGH_QUALITY=1` registers `MiniCPMProvider` so `quality=high` requests can route to it (lazy-loaded on first such request, ~2GB download on first run).
- M5 high-quality provider `MiniCPMProvider` (`src/providers/minicpm/provider.ts`) is fully wired for inference via `LlamaServerProcess` (shared with `GGUFProvider`), model files via `ensureMiniCPMModel`. `load()` throws on GPU-less hosts; `infer()` works when the ~2GB MiniCPM-V model is present. Real validation requires `pnpm test:slow` (downloads model on first run).
- Subprocess/HTTP logic shared by GGUF providers lives in `src/providers/llama-server/process.ts` (`LlamaServerProcess`); `GGUFProvider`, `MiniCPMProvider`, and `SmolVLM2Provider` delegate to it.
- Planner honours the router's choice: `ExecutionPlan.provider`/`runtime` are set from `PlannerInput.activeProvider`/`activeRuntime` (populated by `vision-analyze` to the `selectProvider`-chosen instance). The planner no longer rewrites the provider to a hardcoded `smolvlm` on low memory — router feasibility filtering already handled that. The `PolicyEngine` `memory-guard` rule now only warns on low memory (no provider override); router is the sole authority on provider selection.
- ModelManager (`src/core/model-manager.ts`) now supports: streaming download to disk (avoids OOM on 2GB models), HTTP Range resume (断点续传) for interrupted downloads, SHA-256 checksum verification via `.meta.json` sidecar (enable with `VISION_VERIFY_CHECKSUMS=1` to detect corruption and auto re-download), and atomic `.tmp`→rename. Config YAML remains a roadmap item.
- CI workflow at `.github/workflows/ci.yml`: two parallel jobs (`lint-typecheck` on Node 20, `build-test` matrix on Node 20+22) with concurrency cancellation. Inference-dependent tests (`pnpm test`, `pnpm test:slow`) need a GPU host + llama-server + model files and are NOT run in CI.
