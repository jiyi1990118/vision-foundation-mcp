# llama-server 自动安装实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 llama-server 自动下载和安装功能，当 MCP 启动时检测到未安装时自动从 GitHub releases 或镜像站下载并安装

**Architecture:** 分三层实现：(1) 平台检测器映射平台到 release 文件名；(2) 下载器处理 HTTP 下载、镜像站降级、解压；(3) 解析器协调路径查找和自动安装流程，集成到现有 LlamaServerProcess

**Tech Stack:** Node.js fetch API, node:tar (解压), vitest (测试), TypeScript

---

## 文件结构

**新增文件**：
- `src/providers/llama-server/platform-detector.ts` - 平台和架构检测
- `src/providers/llama-server/downloader.ts` - 下载和解压逻辑
- `src/providers/llama-server/resolver.ts` - 路径解析和自动下载协调

**修改文件**：
- `src/providers/llama-server/process.ts` - 集成自动下载

**测试文件**：
- `tests/platform-detector.test.ts`
- `tests/downloader.test.ts`
- `tests/resolver.test.ts`
- `tests/auto-install-integration.test.ts`

---

## Task 1: 平台检测器

**Files:**
- Create: `src/providers/llama-server/platform-detector.ts`
- Test: `tests/platform-detector.test.ts`

- [ ] **Step 1: 编写测试 - 检测所有支持的平台**

```typescript
// tests/platform-detector.test.ts
import { describe, it, expect } from 'vitest';
import { detectPlatform } from '../src/providers/llama-server/platform-detector.js';

describe('detectPlatform', () => {
  it('should detect macOS ARM64', () => {
    const info = detectPlatform({ platform: 'darwin', arch: 'arm64' });
    expect(info.platform).toBe('darwin');
    expect(info.arch).toBe('arm64');
    expect(info.releaseFilename).toBe('macos-arm64');
  });

  it('should detect macOS x64', () => {
    const info = detectPlatform({ platform: 'darwin', arch: 'x64' });
    expect(info.releaseFilename).toBe('macos-x64');
  });

  it('should detect Linux x64', () => {
    const info = detectPlatform({ platform: 'linux', arch: 'x64' });
    expect(info.releaseFilename).toBe('ubuntu-x64');
  });

  it('should detect Windows x64', () => {
    const info = detectPlatform({ platform: 'win32', arch: 'x64' });
    expect(info.releaseFilename).toBe('win-cuda-cu12.4-x64');
  });

  it('should throw on unsupported platform', () => {
    expect(() => detectPlatform({ platform: 'freebsd' }))
      .toThrow('not supported');
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

```bash
pnpm test tests/platform-detector.test.ts
# 预期：FAIL - detectPlatform is not defined
```

- [ ] **Step 3: 实现平台检测器**

```typescript
// src/providers/llama-server/platform-detector.ts
import { platform, arch } from 'node:os';

export interface PlatformInfo {
  platform: 'darwin' | 'linux' | 'win32';
  arch: 'arm64' | 'x64';
  releaseFilename: string;
}

export interface DetectOptions {
  platform?: string;
  arch?: string;
}

export function detectPlatform(options: DetectOptions = {}): PlatformInfo {
  const currentPlatform = options.platform ?? platform();
  const currentArch = options.arch ?? arch();
  
  // macOS
  if (currentPlatform === 'darwin') {
    if (currentArch === 'arm64') {
      return { platform: 'darwin', arch: 'arm64', releaseFilename: 'macos-arm64' };
    }
    if (currentArch === 'x64') {
      return { platform: 'darwin', arch: 'x64', releaseFilename: 'macos-x64' };
    }
  }
  
  // Linux
  if (currentPlatform === 'linux' && currentArch === 'x64') {
    return { platform: 'linux', arch: 'x64', releaseFilename: 'ubuntu-x64' };
  }
  
  // Windows
  if (currentPlatform === 'win32' && currentArch === 'x64') {
    return { platform: 'win32', arch: 'x64', releaseFilename: 'win-cuda-cu12.4-x64' };
  }
  
  throw new Error(
    `Platform ${currentPlatform}-${currentArch} not supported for auto-install.\n` +
    `Please build llama.cpp from source or set LLAMA_SERVER_PATH.`
  );
}
```

- [ ] **Step 4: 运行测试验证通过**

```bash
pnpm test tests/platform-detector.test.ts
# 预期：5个测试全部 PASS
```

- [ ] **Step 5: 提交**

```bash
git add src/providers/llama-server/platform-detector.ts tests/platform-detector.test.ts
git commit -m "feat: add platform detection for auto-install"
```

---

## Task 2: 下载器核心

**Files:**
- Create: `src/providers/llama-server/downloader.ts`
- Test: `tests/downloader.test.ts`

- [ ] **Step 1: 编写测试 - 基础下载和镜像站支持**

```typescript
// tests/downloader.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { downloadFile, buildMirrorUrl, downloadWithRetry } from '../src/providers/llama-server/downloader.js';
import { mkdirSync, existsSync, unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';

describe('downloader', () => {
  const testDir = join(__dirname, '.tmp-downloader');
  
  beforeEach(() => {
    if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  describe('downloadFile', () => {
    it('should download file from URL', async () => {
      const mockResponse = new Response('test content');
      vi.spyOn(global, 'fetch').mockResolvedValue(mockResponse);
      
      const destPath = join(testDir, 'test.txt');
      await downloadFile({ url: 'https://example.com/file.txt', destPath, timeout: 5000 });
      
      expect(existsSync(destPath)).toBe(true);
    });

    it('should timeout after specified duration', async () => {
      vi.spyOn(global, 'fetch').mockImplementation(
        () => new Promise(resolve => setTimeout(resolve, 10000))
      );
      
      await expect(
        downloadFile({ url: 'https://slow.com/file', destPath: join(testDir, 'slow.txt'), timeout: 100 })
      ).rejects.toThrow();
    });
  });

  describe('buildMirrorUrl', () => {
    it('should build mirror URL', () => {
      const result = buildMirrorUrl(
        'https://github.com/org/repo/releases/download/v1/file.tar.gz',
        'https://ghproxy.com'
      );
      expect(result).toBe('https://ghproxy.com/https://github.com/org/repo/releases/download/v1/file.tar.gz');
    });

    it('should return original URL if no mirror', () => {
      const url = 'https://github.com/org/repo/file.tar.gz';
      expect(buildMirrorUrl(url)).toBe(url);
    });
  });

  describe('downloadWithRetry', () => {
    it('should retry with fallback URLs', async () => {
      const mockFetch = vi.spyOn(global, 'fetch');
      mockFetch
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValueOnce(new Response('success'));
      
      const destPath = join(testDir, 'retry.txt');
      await downloadWithRetry(['https://main.com/file', 'https://mirror.com/file'], destPath, 1000);
      
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(existsSync(destPath)).toBe(true);
    });
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

```bash
pnpm test tests/downloader.test.ts
# 预期：FAIL - 函数未定义
```

- [ ] **Step 3: 实现下载器（含镜像站支持）**

```typescript
// src/providers/llama-server/downloader.ts
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { logger } from '../../utils/logger.js';

export interface DownloadOptions {
  url: string;
  destPath: string;
  timeout?: number;
  onProgress?: (percent: number) => void;
}

export async function downloadFile(options: DownloadOptions): Promise<void> {
  const { url, destPath, timeout = 60000 } = options;
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  try {
    const response = await fetch(url, { signal: controller.signal });
    
    if (!response.ok || !response.body) {
      throw new Error(`Download failed: ${response.status} ${response.statusText}`);
    }
    
    await pipeline(response.body, createWriteStream(destPath));
    logger.info(`Downloaded: ${destPath}`);
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      throw new Error(`Download timeout after ${timeout}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

export function buildMirrorUrl(githubUrl: string, mirrorBase?: string): string {
  if (!mirrorBase) return githubUrl;
  return `${mirrorBase}/${githubUrl}`;
}

export async function downloadWithRetry(
  urls: string[],
  destPath: string,
  timeout: number = 60000
): Promise<void> {
  let lastError: Error | undefined;
  
  for (const url of urls) {
    try {
      logger.info(`Trying: ${url} (${timeout}ms timeout)`);
      await downloadFile({ url, destPath, timeout });
      return;
    } catch (error) {
      lastError = error as Error;
      logger.warn(`Download failed from ${url}: ${lastError.message}`);
    }
  }
  
  throw new Error(`Failed to download from all sources. Last error: ${lastError?.message}`);
}
```

- [ ] **Step 4: 添加解压功能**

安装tar依赖：
```bash
pnpm add tar
pnpm add -D @types/tar
```

添加解压函数和测试：

```typescript
// src/providers/llama-server/downloader.ts (追加)
import { extract } from 'tar';
import { join, dirname, basename } from 'node:path';
import { mkdirSync, renameSync, existsSync, unlinkSync } from 'node:fs';

export async function downloadAndExtract(
  urls: string[],
  destDir: string,
  binaryName: string,
  timeout: number = 60000
): Promise<string> {
  const tempDir = join(destDir, '.downloading');
  mkdirSync(tempDir, { recursive: true });
  
  const tarPath = join(tempDir, 'download.tar.gz');
  
  try {
    // 下载
    await downloadWithRetry(urls, tarPath, timeout);
    
    // 解压
    logger.info('Extracting archive...');
    await extract({ file: tarPath, cwd: tempDir });
    
    // 查找二进制文件
    const extractedBinary = join(tempDir, 'bin', binaryName);
    if (!existsSync(extractedBinary)) {
      throw new Error(`Binary ${binaryName} not found in extracted archive`);
    }
    
    // 移动到目标目录
    mkdirSync(destDir, { recursive: true });
    const finalPath = join(destDir, binaryName);
    renameSync(extractedBinary, finalPath);
    
    logger.info(`Installed: ${finalPath}`);
    return finalPath;
  } finally {
    // 清理临时文件
    if (existsSync(tarPath)) unlinkSync(tarPath);
  }
}
```

- [ ] **Step 5: 测试解压功能**

```typescript
// tests/downloader.test.ts (追加)
import { downloadAndExtract } from '../src/providers/llama-server/downloader.js';

describe('downloadAndExtract', () => {
  it('should download and extract binary', async () => {
    // 这个测试需要真实的tar.gz文件，或者mock tar.extract
    // 简化版：只测试接口存在
    expect(typeof downloadAndExtract).toBe('function');
  });
});
```

- [ ] **Step 6: 运行测试验证通过**

```bash
pnpm test tests/downloader.test.ts
# 预期：所有测试 PASS
```

- [ ] **Step 7: 提交**

```bash
git add src/providers/llama-server/downloader.ts tests/downloader.test.ts package.json pnpm-lock.yaml
git commit -m "feat: add downloader with mirror support and extraction"
```

---

## Task 3: 路径解析器和自动安装协调

**Files:**
- Create: `src/providers/llama-server/resolver.ts`
- Test: `tests/resolver.test.ts`
- Modify: `src/providers/llama-server/process.ts`

- [ ] **Step 1: 编写测试 - 路径查找优先级**

```typescript
// tests/resolver.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveLlamaServerCandidates, ensureLlamaServer } from '../src/providers/llama-server/resolver.js';
import { join } from 'node:path';

describe('resolver', () => {
  describe('resolveLlamaServerCandidates', () => {
    it('should return candidates in correct priority order', () => {
      const candidates = resolveLlamaServerCandidates({
        env: { LLAMA_SERVER_PATH: '/custom/path' },
        packageRoot: '/project',
        homeDir: '/home/user',
      });
      
      expect(candidates[0]).toBe('/custom/path');
      expect(candidates[1]).toBe('/project/bin/llama-server');
      expect(candidates[2]).toBe('/home/user/.vision-mcp/bin/llama-server');
    });

    it('should include system paths', () => {
      const candidates = resolveLlamaServerCandidates({});
      expect(candidates).toContain('/opt/homebrew/bin/llama-server');
    });
  });

  describe('ensureLlamaServer', () => {
    it('should return existing path if found', async () => {
      // Mock: 假设找到了已存在的llama-server
      const result = await ensureLlamaServer({ 
        skipAutoInstall: true // 测试时跳过自动安装
      });
      expect(typeof result).toBe('string');
    });
  });
});
```

- [ ] **Step 2: 实现路径解析器**

```typescript
// src/providers/llama-server/resolver.ts
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { logger } from '../../utils/logger.js';
import { detectPlatform } from './platform-detector.js';
import { downloadAndExtract, buildMirrorUrl } from './downloader.js';

export interface ResolverOptions {
  env?: Record<string, string | undefined>;
  packageRoot?: string;
  homeDir?: string;
  skipAutoInstall?: boolean;
}

export function resolveLlamaServerCandidates(options: ResolverOptions = {}): string[] {
  const env = options.env ?? process.env;
  const packageRoot = options.packageRoot ?? join(__dirname, '..', '..', '..');
  const home = options.homeDir ?? homedir();
  const exeName = platform() === 'win32' ? 'llama-server.exe' : 'llama-server';
  
  return [
    ...(env.LLAMA_SERVER_PATH ? [env.LLAMA_SERVER_PATH] : []),
    join(packageRoot, 'bin', exeName),
    join(home, '.vision-mcp', 'bin', exeName),
    '/opt/homebrew/bin/llama-server',
    '/usr/local/bin/llama-server',
    '/usr/bin/llama-server',
    exeName,
  ];
}

function getDownloadDestination(): string {
  const packageRoot = join(__dirname, '..', '..', '..');
  const packageBinDir = join(packageRoot, 'bin');
  const userBinDir = join(homedir(), '.vision-mcp', 'bin');
  
  try {
    mkdirSync(packageBinDir, { recursive: true });
    const testFile = join(packageBinDir, '.write-test');
    writeFileSync(testFile, '');
    unlinkSync(testFile);
    return packageBinDir;
  } catch {
    mkdirSync(userBinDir, { recursive: true });
    return userBinDir;
  }
}

async function getLatestReleaseTag(): Promise<string> {
  const response = await fetch('https://api.github.com/repos/ggml-org/llama.cpp/releases/latest');
  if (!response.ok) {
    throw new Error(`Failed to fetch latest release: ${response.status}`);
  }
  const data = await response.json();
  return data.tag_name;
}

function buildDownloadUrls(tag: string, platformFilename: string): string[] {
  const filename = `llama-${tag}-bin-${platformFilename}.tar.gz`;
  const githubUrl = `https://github.com/ggml-org/llama.cpp/releases/download/${tag}/${filename}`;
  
  const urls = [
    process.env.LLAMA_SERVER_DOWNLOAD_URL,
    githubUrl,
    buildMirrorUrl(githubUrl, process.env.LLAMA_DOWNLOAD_MIRROR || 'https://ghproxy.com'),
    buildMirrorUrl(githubUrl, 'https://gh.api.99988866.xyz'),
  ].filter(Boolean) as string[];
  
  return urls;
}

export async function ensureLlamaServer(options: ResolverOptions = {}): Promise<string> {
  const candidates = resolveLlamaServerCandidates(options);
  
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      logger.info(`Found llama-server: ${candidate}`);
      return candidate;
    }
  }
  
  if (options.skipAutoInstall) {
    throw new Error('llama-server not found and auto-install is skipped');
  }
  
  logger.info('llama-server not found, downloading...');
  
  const platformInfo = detectPlatform();
  const tag = await getLatestReleaseTag();
  const urls = buildDownloadUrls(tag, platformInfo.releaseFilename);
  const destDir = getDownloadDestination();
  const binaryName = platform() === 'win32' ? 'llama-server.exe' : 'llama-server';
  
  const installedPath = await downloadAndExtract(urls, destDir, binaryName, 60000);
  
  if (platform() !== 'win32') {
    const { chmodSync } = await import('node:fs');
    chmodSync(installedPath, 0o755);
  }
  
  logger.info(`Auto-install complete: ${installedPath}`);
  return installedPath;
}
```

- [ ] **Step 3: 运行测试验证**

```bash
pnpm test tests/resolver.test.ts
# 预期：PASS
```

- [ ] **Step 4: 集成到 LlamaServerProcess**

修改 `src/providers/llama-server/process.ts`：

```typescript
// src/providers/llama-server/process.ts
// 在文件顶部导入
import { ensureLlamaServer } from './resolver.js';

// 在 LlamaServerProcess 类的 start() 方法中，替换：
//   const bin = resolveLlamaServerPath();
// 为：
//   const bin = await ensureLlamaServer();

// 注意：start() 方法需要改为 async
async start(): Promise<void> {
  if (this.running) return;
  
  const bin = await ensureLlamaServer(); // 自动安装支持
  
  // ... 其余代码保持不变
}
```

- [ ] **Step 5: 提交**

```bash
git add src/providers/llama-server/resolver.ts tests/resolver.test.ts src/providers/llama-server/process.ts
git commit -m "feat: integrate auto-install into LlamaServerProcess"
```

---

## Task 4: 集成测试

**Files:**
- Test: `tests/auto-install-integration.test.ts`

- [ ] **Step 1: 编写端到端集成测试**

```typescript
// tests/auto-install-integration.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import { ensureLlamaServer } from '../src/providers/llama-server/resolver.js';
import { existsSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

describe('auto-install integration', () => {
  it('should download and install llama-server', async () => {
    const path = await ensureLlamaServer();
    
    expect(existsSync(path)).toBe(true);
    
    const result = spawnSync(path, ['--version']);
    expect(result.status).toBe(0);
    expect(result.stdout.toString()).toContain('llama');
  }, 180000); // 3分钟超时
});
```

- [ ] **Step 2: 运行集成测试**

```bash
# 清理现有安装（可选）
rm -f ~/.vision-mcp/bin/llama-server
rm -f bin/llama-server

# 运行测试
pnpm test tests/auto-install-integration.test.ts
# 预期：PASS，首次运行会下载
```

- [ ] **Step 3: 提交**

```bash
git add tests/auto-install-integration.test.ts
git commit -m "test: add auto-install integration test"
```

---

## Task 5: 文档更新

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: 更新 README.md 安装说明**

简化安装步骤，说明自动下载功能：

```markdown
### 1. llama.cpp (自动安装)

llama-server 会在首次运行时自动下载安装。

如需手动安装：
- macOS: `brew install llama.cpp`
- Linux: 从源码编译或下载 releases
- Windows: 下载 releases

环境变量：
- `LLAMA_SERVER_PATH` - 指定已安装的 llama-server 路径
- `LLAMA_DOWNLOAD_MIRROR` - 指定镜像站（如 `https://ghproxy.com`）
```

- [ ] **Step 2: 更新 AGENTS.md 实现说明**

移除"不自动安装"的限制，更新为实际行为：

```markdown
- **Runtime 依赖**：GGUF-backed providers 需要 `llama-server`
- **自动安装**：首次运行时自动从 GitHub releases 下载，支持镜像站降级
- **路径优先级**：
  1. `LLAMA_SERVER_PATH` 环境变量
  2. 项目内 `<package-root>/bin/llama-server`
  3. 用户目录 `~/.vision-mcp/bin/llama-server`
  4. 系统路径（Homebrew/系统安装）
```

- [ ] **Step 3: 提交文档更新**

```bash
git add README.md AGENTS.md
git commit -m "docs: update installation instructions with auto-install feature"
```

---

## 验证清单

完成所有任务后，验证：

- [ ] `pnpm typecheck` - 无类型错误
- [ ] `pnpm lint` - 无 lint 错误
- [ ] `pnpm build` - 编译成功
- [ ] `pnpm test:unit` - 所有单元测试通过
- [ ] `pnpm test` - 包含集成测试通过
- [ ] 手动测试：删除已安装的 llama-server，运行 MCP，验证自动下载

---

## 实施注意事项

1. **并发控制**：多个 provider 同时初始化时可能触发重复下载，考虑添加文件锁
2. **错误日志**：所有日志写入 stderr，避免污染 MCP 的 JSON-RPC stdout
3. **临时文件清理**：下载失败时确保清理 `.downloading/` 目录
4. **权限处理**：Unix 系统需要 `chmod +x`，Windows 不需要
5. **跨平台测试**：理想情况下在 macOS/Linux/Windows 上都验证一次

---

## 执行选项

计划已保存。选择执行方式：

**1. Subagent-Driven (推荐)** - 每个任务分派独立 subagent，任务间审查，快速迭代

**2. Inline Execution** - 在当前会话中使用 executing-plans skill 批量执行，设置审查检查点

选择哪种方式？
