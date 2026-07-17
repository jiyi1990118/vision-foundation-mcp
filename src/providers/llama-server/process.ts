/**
 * LlamaServerProcess — shared subprocess + HTTP layer for llama.cpp `llama-server`.
 *
 * Both GGUF-backed vision providers (SmolVLM, MiniCPM-V) drive the same
 * `llama-server` binary over HTTP. This class encapsulates process lifecycle
 * (spawn / health-wait / stop) and the OpenAI-compatible inference call with
 * auto-restart, so providers only own identity, model-file acquisition, cache,
 * and resource policy.
 *
 * @see Docs/01-architecture/06-provider-runtime.md
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { logger } from '../../utils/logger.js';
import { ensureLlamaServer } from './resolver.js';

const SERVER_STARTUP_TIMEOUT = 60000;

export interface LlamaServerConfig {
  /** Provider name, for log attribution. */
  name: string;
  modelPath: string;
  mmprojPath: string;
  port: number;
  existingPid?: number | undefined;
  gpuLayers: number;
  threads: number;
  /** Total context window size in tokens. Default 8192. */
  contextSize?: number | undefined;
  /** Number of parallel slots. Each slot gets contextSize/slots tokens. Default 2. */
  parallelSlots?: number | undefined;
}

export interface ChatCompletionResponse {
  choices: Array<{ message: { content: string }; delta?: { content: string } }>;
  usage?: { completion_tokens: number; prompt_tokens: number };
}

export class LlamaServerProcess {
  private process: ChildProcess | null = null;
  private running = false;
  private baseUrl = '';
  private stderrLineCount = 0;
  private attachedPid: number | null = null;

  constructor(private readonly config: LlamaServerConfig) {
    if (typeof config.existingPid === 'number') {
      this.attachedPid = config.existingPid;
    }
  }

  get isRunning(): boolean {
    return this.running && this.process !== null && !this.process.killed;
  }

  get endpoint(): string {
    return this.baseUrl;
  }

  async start(): Promise<void> {
    const { name, modelPath, mmprojPath, port, gpuLayers, threads, existingPid } = this.config;
    const contextSize = this.config.contextSize ?? 8192;
    const parallelSlots = this.config.parallelSlots ?? 2;
    const bin = await ensureLlamaServer();
    this.attachedPid = existingPid ?? null;

    const args = [
      '-m', modelPath,
      '--mmproj', mmprojPath,
      '-ngl', String(gpuLayers),
      '-c', String(contextSize),
      '--port', String(port),
      '--host', '127.0.0.1',
      '--temp', '0',
      '-t', String(threads),
      '-np', String(parallelSlots),
      '-b', '512',
      '-ub', '512',
    ];

    logger.info('Starting llama-server', {
      provider: name, bin, port, gpuLayers, threads, contextSize, parallelSlots,
    });

    this.baseUrl = `http://127.0.0.1:${port}`;
    if (await this.isServerHealthy()) {
      logger.info('Reusing existing llama-server', { provider: name, url: this.baseUrl });
      this.running = true;
      return;
    }

    this.process = spawn(bin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    this.attachStreams();

    await this.waitForServer();
    this.running = true;
  }

  private async isServerHealthy(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 500);
      const resp = await fetch(`${this.baseUrl}/health`, { signal: controller.signal });
      clearTimeout(timer);
      return resp.ok;
    } catch {
      return false;
    }
  }

  private attachStreams(): void {
    const proc = this.process;
    if (!proc) return;

    proc.stderr?.on('data', (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (!line) return;
      if (this.stderrLineCount < 5) {
        logger.info('llama-server', { msg: line.slice(0, 200) });
      } else if (/error|fatal|abort/i.test(line)) {
        logger.error('llama-server', { msg: line.slice(0, 200) });
      }
      this.stderrLineCount++;
    });

    proc.stdout?.on('data', (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line) logger.debug('llama-server:stdout', { msg: line.slice(0, 200) });
    });

    proc.on('exit', (code, signal) => {
      if (this.running) {
        logger.warn('llama-server exited, will restart on next request', {
          provider: this.config.name, code, signal,
        });
      }
      this.running = false;
      this.process = null;
    });

    proc.on('error', (err) => {
      logger.error('llama-server spawn error', {
        provider: this.config.name, error: err.message,
      });
    });
  }

  async waitForServer(): Promise<void> {
    const deadline = Date.now() + SERVER_STARTUP_TIMEOUT;
    let attempt = 0;

    while (Date.now() < deadline) {
      attempt++;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 3000);
        const resp = await fetch(`${this.baseUrl}/health`, { signal: controller.signal });
        clearTimeout(timer);

        if (resp.ok) {
          logger.info('llama-server ready', {
            provider: this.config.name, url: this.baseUrl, attempt,
          });
          return;
        }
      } catch {
        if (attempt === 1) logger.debug('Waiting for llama-server to start...', {});
      }
      await sleep(500);
    }

    throw new Error(
      `llama-server failed to start within ${SERVER_STARTUP_TIMEOUT / 1000}s. ` +
      `Check if port ${this.config.port} is available and model files are valid.`,
    );
  }

  async inferOnce(body: object, signal?: AbortSignal): Promise<ChatCompletionResponse> {
    const timeoutSignal = AbortSignal.timeout(120000);
    const abortSignal = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;
    const resp = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: abortSignal,
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`llama-server HTTP ${resp.status}: ${errText.slice(0, 200)}`);
    }

    return (await resp.json()) as ChatCompletionResponse;
  }

  async *streamOnce(body: object, signal?: AbortSignal): AsyncGenerator<string> {
    const timeoutSignal = AbortSignal.timeout(120000);
    const abortSignal = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;
    const resp = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, stream: true }),
      signal: abortSignal,
    });

    if (!resp.ok || !resp.body) {
      throw new Error(`Stream failed: HTTP ${resp.status}`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split('\n')) {
          if (line.startsWith('data: ')) {
            const jsonStr = line.slice(6);
            if (jsonStr === '[DONE]') return;
            try {
              const parsed = JSON.parse(jsonStr);
              const content = parsed.choices?.[0]?.delta?.content;
              if (content) yield content;
            } catch {
              // Skip malformed chunks
            }
          }
        }
      }
    } finally {
      // Cancel the reader so the underlying HTTP connection is not left
      // dangling on abort, early return, or consumer break-out.
      await reader.cancel().catch(() => {});
    }
  }

  /**
   * Run inference with auto-restart on failure. `restart` is a provider-supplied
   * callback that re-acquires the model + calls start() again.
   */
  async inferWithRetry(
    body: object,
    restart: () => Promise<void>,
    maxRetries = 2,
    signal?: AbortSignal,
  ): Promise<ChatCompletionResponse> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // If the caller aborted (e.g. request timeout), fail fast without
      // retrying or restarting - the server is healthy, the request was cancelled.
      if (signal?.aborted) {
        throw new Error('Inference aborted by caller');
      }
      if (!this.isRunning) {
        logger.warn('llama-server not running, restarting', {
          provider: this.config.name, attempt,
        });
        await restart();
      }

      try {
        return await this.inferOnce(body, signal);
      } catch (e) {
        // Cancellation (abort) must not trigger server restart/retry.
        if (signal?.aborted || isAbortError(e)) {
          throw e;
        }
        if (attempt < maxRetries) {
          logger.warn('Inference failed, restarting server', {
            provider: this.config.name,
            attempt,
            error: (e as Error).message?.slice(0, 100),
          });
          await this.stop();
          await restart();
        } else {
          throw e;
        }
      }
    }
    throw new Error('Inference failed after retries');
  }

  async stop(): Promise<void> {
    // Case 1: attached to an external existing PID (we did not spawn it).
    // Send SIGTERM gently and do NOT wait for exit (we are not the parent,
    // so we cannot reliably listen for 'exit'). Never SIGKILL an external
    // process — that risks corrupting llama.cpp Metal/CUDA state.
    if (this.process === null && this.attachedPid !== null) {
      const pid = this.attachedPid;
      logger.info('Stopping attached llama-server (external PID)', {
        provider: this.config.name, pid,
      });
      try {
        if (platform() === 'win32') {
          killProcessTreeWindows(pid);
        } else {
          process.kill(pid, 'SIGTERM');
        }
      } catch (err) {
        // Process may have already exited.
        logger.debug('Attached llama-server already exited', {
          pid, error: (err as Error).message,
        });
      }
      this.attachedPid = null;
      this.running = false;
      return;
    }

    // Case 2: we spawned the process ourselves — full lifecycle control.
    const proc = this.process;
    if (!proc) {
      this.running = false;
      return;
    }

    logger.info('Stopping llama-server', { provider: this.config.name });

    if (platform() === 'win32') {
      const winPid = proc.pid;
      if (winPid) {
        try {
          killProcessTreeWindows(winPid);
        } catch {
          proc.kill();
        }
      } else {
        proc.kill();
      }
    } else {
      proc.kill('SIGTERM');
    }

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (!proc.killed) {
          if (platform() === 'win32') {
            try { killProcessTreeWindows(proc.pid!, true); } catch { proc.kill(); }
          } else {
            proc.kill('SIGKILL');
          }
        }
        resolve();
      }, 5000);

      proc.on('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    this.process = null;
    this.running = false;
    this.attachedPid = null;
    this.stderrLineCount = 0;
  }
}

/**
 * Kill a process and its children on Windows using `taskkill`.
 * @param force - If true, use /F for forceful termination (equivalent to SIGKILL).
 */
function killProcessTreeWindows(pid: number, force = false): void {
  const args = ['/pid', String(pid), '/T'];
  if (force) args.push('/F');
  spawnSync('taskkill', args, { stdio: 'ignore', shell: false });
}

export interface LlamaServerResolverOptions {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  homeDir?: string;
  exists?: (path: string) => boolean;
}

export function resolveLlamaServerCandidates(options: LlamaServerResolverOptions = {}): string[] {
  const env = options.env ?? process.env;
  const currentPlatform = options.platform ?? platform();
  const home = options.homeDir ?? homedir();
  const exeName = currentPlatform === 'win32' ? 'llama-server.exe' : 'llama-server';
  const userBin = join(home, '.vision-mcp', 'bin', exeName);

  // Platform-specific system search paths
  const systemPaths: string[] =
    currentPlatform === 'win32'
      ? [
          join(home, 'AppData', 'Local', 'llama.cpp', exeName),
          join(home, 'AppData', 'Local', 'Programs', 'llama.cpp', exeName),
        ]
      : [
          '/opt/homebrew/bin/llama-server',
          '/usr/local/bin/llama-server',
          '/usr/bin/llama-server',
        ];

  const candidates = [
    ...(env.LLAMA_SERVER_PATH ? [env.LLAMA_SERVER_PATH] : []),
    userBin,
    ...systemPaths,
    exeName,
  ];

  return [...new Set(candidates)];
}

export function resolveLlamaServerPath(options: LlamaServerResolverOptions = {}): string {
  const exists = options.exists ?? existsSync;
  const currentPlatform = options.platform ?? platform();
  const candidates = resolveLlamaServerCandidates(options);

  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }

  const pathCandidate = currentPlatform === 'win32' ? 'llama-server.exe' : 'llama-server';
  if (candidates.includes(pathCandidate)) return pathCandidate;

  const hints: Record<string, string> = {
    darwin: 'brew install llama.cpp',
    linux: 'See https://github.com/ggml-org/llama.cpp#build',
    win32: 'See https://github.com/ggml-org/llama.cpp#build',
  };

  throw new Error(`llama-server not found. Install:\n  ${hints[currentPlatform] ?? ''}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True for fetch/AbortController cancellation errors (must not retry/restart). */
function isAbortError(e: unknown): boolean {
  if (e instanceof Error) {
    if (e.name === 'AbortError') return true;
    return /aborted/i.test(e.message);
  }
  return false;
}
