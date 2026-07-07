# llama-server 自动安装设计

**日期**: 2026-07-07  
**状态**: 设计中  
**作者**: AI Agent

## 概述

为 vision-foundation-mcp 添加 llama-server 自动下载和安装功能，当 MCP 启动时检测到 llama-server 未安装时，自动从 GitHub 官方 releases 或镜像站下载预编译二进制并安装到项目内目录，避免用户手动安装步骤。

## 目标

1. **零配置体验**：用户首次使用时无需手动安装 llama.cpp
2. **跨平台支持**：macOS（ARM64/x64）、Linux x64、Windows x64
3. **可靠性**：官方 releases + 镜像站自动降级，应对网络问题
4. **避免权限问题**：优先使用项目内目录，避免跨用户权限冲突
5. **透明可控**：下载进度日志，支持环境变量覆盖

## 背景和问题

### 当前状态

- 项目已有 `scripts/setup-llama.ts`，支持通过 `LLAMA_SERVER_DOWNLOAD_URL` 环境变量下载
- 需要用户**手动运行** `pnpm setup:llama` 或手动安装（Homebrew/编译）
- `resolveLlamaServerPath()` 只查找已存在的可执行文件，找不到时报错

### 用户痛点

1. 新用户不知道需要安装 llama.cpp
2. 手动安装步骤繁琐（Homebrew、编译、设置环境变量）
3. 跨平台安装指令不一致

### 解决方案选择

**选择：混合方案 C** - 首次失败时提示并自动下载

- MCP 启动时检测 llama-server
- 找不到时自动从官方 releases 下载（不静默，有日志提示）
- 失败时给出友好错误和手动安装指令

**理由**：
- 平衡用户体验和可控性
- 不违反"非运行时静默安装"原则（有明确日志提示）
- 保留手动安装和环境变量覆盖能力

## 系统架构

### 新增组件

```
src/providers/llama-server/
├── process.ts              (现有: 进程管理 + HTTP调用)
├── process-registry.ts     (现有: 进程发现)
├── resolver.ts             (新增: 路径解析 + 自动下载协调)
├── downloader.ts           (新增: 从GitHub releases 下载)
└── platform-detector.ts    (新增: 平台/架构检测)
```

### 核心流程

```
MCP 启动 → GGUFProvider 初始化 → LlamaServerProcess 初始化
  ↓
resolveLlamaServerPath()
  ├─ 找到已存在的 llama-server → 返回路径
  └─ 未找到 → 调用 autoInstallLlamaServer()
      ├─ 检测平台和架构 (platform-detector)
      ├─ 获取最新 release tag (GitHub API)
      ├─ 依次尝试下载源（带超时和重试）:
      │   1. 自定义 URL (LLAMA_SERVER_DOWNLOAD_URL)
      │   2. 官方 GitHub (60s 超时)
      │   3. 镜像站 1 (ghproxy.com, 30s 超时)
      │   4. 镜像站 2 (gh.api.99988866.xyz, 30s 超时)
      ├─ 下载到临时目录并解压
      ├─ 移动到目标目录 (项目内 bin/ 或 ~/.vision-mcp/bin/)
      ├─ 设置可执行权限 (Unix)
      └─ 返回安装后的路径
```

## 组件设计

### 1. platform-detector.ts - 平台检测器

**职责**：检测运行平台和架构，映射到 GitHub releases 的文件名。

**接口**：
```typescript
export interface PlatformInfo {
  platform: 'darwin' | 'linux' | 'win32';
  arch: 'arm64' | 'x64';
  releaseFilename: string; // e.g. "llama-{tag}-bin-macos-arm64.tar.gz"
}

export function detectPlatform(): PlatformInfo;
```

**平台映射**：
- macOS ARM64 → `macos-arm64`
- macOS x64 → `macos-x64`
- Linux x64 → `ubuntu-x64`
- Windows x64 → `win-cuda-cu12.4-x64`

**不支持平台**：抛出错误并给出手动安装指令。

### 2. downloader.ts - 下载器

**职责**：从 GitHub releases 或镜像站下载并解压 llama-server。

**接口**：
```typescript
export interface DownloadOptions {
  tag: string;                // release tag (e.g. "b9894")
  platform: string;           // e.g. "macos-arm64"
  destDir: string;            // 目标目录
  mirrorUrl?: string;         // 可选镜像站 URL
  timeout?: number;           // 下载超时（毫秒）
  onProgress?: (percent: number) => void;
}

export async function downloadLlamaServer(options: DownloadOptions): Promise<string>;
```

**镜像站支持**：
```typescript
// 官方 URL
const officialUrl = `https://github.com/ggml-org/llama.cpp/releases/download/${tag}/${filename}`;

// 镜像站 URL（如果指定）
const mirrorUrl = options.mirrorUrl 
  ? `${options.mirrorUrl}/https://github.com/ggml-org/llama.cpp/releases/download/${tag}/${filename}`
  : officialUrl;
```

**环境变量**：
- `LLAMA_DOWNLOAD_MIRROR`：镜像站前缀（如 `https://ghproxy.com`）
- `LLAMA_SERVER_DOWNLOAD_URL`：完整自定义 URL（优先级最高）

**常见镜像站**：
- `https://ghproxy.com`
- `https://gh.api.99988866.xyz`
- `https://mirror.ghproxy.com`

**临时文件管理**：
```
下载中：{destDir}/.downloading/llama-{tag}-{platform}.tar.gz.tmp
完成后：重命名为 .tar.gz（原子操作）
失败时：自动清理 .tmp 文件
```

### 3. resolver.ts - 智能协调器

**职责**：整合路径查找和自动下载，实现自动降级重试。

**接口**：
```typescript
export interface ResolverOptions {
  timeout?: number;        // 单次下载超时（默认 60s）
  maxRetries?: number;     // 最大重试次数（默认 3）
}

export async function ensureLlamaServer(options?: ResolverOptions): Promise<string>;
```

**路径查找优先级**（更新）：
```typescript
export function resolveLlamaServerCandidates(): string[] {
  const env = process.env;
  const home = homedir();
  const packageRoot = join(__dirname, '..', '..', '..'); 
  const exeName = platform() === 'win32' ? 'llama-server.exe' : 'llama-server';
  
  return [
    // 1. 用户显式指定（最高优先级）
    ...(env.LLAMA_SERVER_PATH ? [env.LLAMA_SERVER_PATH] : []),
    
    // 2. 项目内路径（新增，避免权限问题）
    join(packageRoot, 'bin', exeName),
    
    // 3. 用户目录（保留兼容）
    join(home, '.vision-mcp', 'bin', exeName),
    
    // 4. 系统路径（Homebrew/系统安装）
    '/opt/homebrew/bin/llama-server',
    '/usr/local/bin/llama-server',
    '/usr/bin/llama-server',
    
    // 5. PATH 查找
    exeName,
  ];
}
```

**自动下载目标目录**：
```typescript
function getDownloadDestination(): string {
  const packageRoot = join(__dirname, '..', '..', '..');
  const packageBinDir = join(packageRoot, 'bin');
  const userBinDir = join(homedir(), '.vision-mcp', 'bin');
  
  // 尝试创建项目内目录
  try {
    mkdirSync(packageBinDir, { recursive: true });
    // 测试写权限
    const testFile = join(packageBinDir, '.write-test');
    writeFileSync(testFile, '');
    unlinkSync(testFile);
    return packageBinDir; // 成功，使用项目内目录
  } catch {
    // 降级到用户目录
    mkdirSync(userBinDir, { recursive: true });
    return userBinDir;
  }
}
```

**下载源优先级和重试策略**：
```typescript
const downloadSources = [
  // 1. 用户自定义（如果设置）
  process.env.LLAMA_SERVER_DOWNLOAD_URL,
  
  // 2. 官方 GitHub（默认首选，60s 超时）
  {
    url: `https://github.com/ggml-org/llama.cpp/releases/download/${tag}/${filename}`,
    timeout: 60000,
  },
  
  // 3. 镜像站降级列表（30s 超时）
  {
    url: `https://ghproxy.com/https://github.com/ggml-org/llama.cpp/releases/download/${tag}/${filename}`,
    timeout: 30000,
  },
  {
    url: `https://gh.api.99988866.xyz/https://github.com/ggml-org/llama.cpp/releases/download/${tag}/${filename}`,
    timeout: 30000,
  },
].filter(Boolean);

// 依次尝试，失败后自动切换下一个源
for (const source of downloadSources) {
  try {
    return await downloadWithTimeout(source.url, source.timeout);
  } catch (error) {
    logger.warn(`Download failed from ${source.url}: ${error.message}`);
    // 继续下一个源
  }
}
// 所有源失败后抛出错误
throw new Error('Failed to download llama-server from all sources');
```

## 错误处理

### 1. 平台不支持
- **场景**：Linux ARM64、FreeBSD 等非主流平台
- **处理**：立即抛出错误，给出手动编译指令
- **错误消息**：
  ```
  Platform linux-arm64 not supported for auto-install.
  Please build llama.cpp from source:
    git clone https://github.com/ggml-org/llama.cpp
    cd llama.cpp && cmake -B build && cmake --build build
    export LLAMA_SERVER_PATH=/path/to/llama-server
  ```

### 2. 网络完全不可达
- **场景**：无网络连接，所有下载源均失败
- **处理**：记录所有失败的 URL 和错误原因，给出手动安装指令
- **错误消息**：
  ```
  Failed to download llama-server from all sources:
    - GitHub official: Network timeout
    - ghproxy.com: Connection refused
    - gh.api.99988866.xyz: DNS lookup failed
  
  Manual install options:
    macOS: brew install llama.cpp
    Linux: Build from source (see above)
    Or set LLAMA_SERVER_PATH to existing binary
  ```

### 3. 磁盘空间不足
- **场景**：目标目录所在分区空间不足
- **处理**：下载前检查可用空间（需要约 200MB），不足时提前报错
- **错误消息**：
  ```
  Insufficient disk space for llama-server download
  Required: 200MB, Available: 50MB
  Please free up space or set LLAMA_SERVER_PATH to another location
  ```

### 4. 下载中断/校验失败
- **场景**：下载过程中网络中断，或下载的文件损坏
- **处理**：
  - 删除不完整的临时文件
  - 自动重试（切换到下一个下载源）
  - 重试 3 次后失败
- **临时文件清理**：失败时自动删除 `.tmp` 文件

### 5. 解压失败
- **场景**：tar.gz 文件损坏，或磁盘 I/O 错误
- **处理**：删除损坏的压缩包，记录错误，建议手动安装
- **错误消息**：
  ```
  Failed to extract llama-server from downloaded archive.
  The file may be corrupted. Retrying download...
  (Attempt 2/3)
  ```

### 6. 权限问题（已最小化）
- **策略**：优先使用项目内目录，自动降级到用户目录
- **极端情况处理**：如果两个目录都无法写入，给出清晰的权限错误提示

## 数据流

### 成功路径
```
1. MCP 启动
2. GGUFProvider 调用 ensureLlamaServer()
3. resolveLlamaServerPath() 查找
4. 未找到 → 调用 autoInstallLlamaServer()
5. detectPlatform() → macOS ARM64
6. 获取最新 tag → "b9894"
7. 尝试下载：
   - GitHub 官方（60s 超时）→ 成功
8. 下载到 ~/.vision-mcp/bin/.downloading/llama-b9894-bin-macos-arm64.tar.gz.tmp
9. 解压提取 llama-server
10. 移动到 <package-root>/bin/llama-server（项目内目录有权限）
11. chmod +x <package-root>/bin/llama-server
12. 返回路径给 LlamaServerProcess
13. MCP 正常启动
```

### 降级路径（官方慢/失败）
```
1-6. 同上
7. 尝试下载：
   - GitHub 官方（60s 超时）→ 超时
   - [自动切换] ghproxy.com 镜像（30s 超时）→ 成功
8-13. 同上
```

### 失败路径（所有源失败）
```
1-6. 同上
7. 尝试下载：
   - GitHub 官方 → 超时
   - ghproxy.com → 连接失败
   - gh.api.99988866.xyz → DNS 失败
8. 所有源失败
9. 抛出友好错误，包含：
   - 所有尝试过的 URL 和失败原因
   - 手动安装指令（Homebrew/编译）
   - 环境变量设置提示
10. MCP 启动失败，用户看到清晰的错误消息
```

## 日志输出

**所有日志写入 stderr**（避免污染 MCP 的 JSON-RPC stdout）：

```
[vision-mcp] llama-server not found, downloading...
[vision-mcp] Platform: macOS ARM64
[vision-mcp] Latest release: b9894
[vision-mcp] Trying: GitHub official (60s timeout)
[vision-mcp] Downloading: 45MB / 78MB (58%)...
[vision-mcp] Download complete: 78MB in 12.3s
[vision-mcp] Extracting to <package-root>/bin/
[vision-mcp] Installation complete: <package-root>/bin/llama-server
```

**降级日志**：
```
[vision-mcp] Trying: GitHub official (60s timeout)
[vision-mcp] Download timeout, switching to mirror...
[vision-mcp] Trying: ghproxy.com mirror (30s timeout)
[vision-mcp] Downloading: 45MB / 78MB (58%)...
```

## 测试策略

### 单元测试

**1. platform-detector.test.ts**
```typescript
describe('detectPlatform', () => {
  it('should detect macOS ARM64', () => {
    const info = detectPlatform({ platform: 'darwin', arch: 'arm64' });
    expect(info.releaseFilename).toContain('macos-arm64');
  });
  
  it('should detect Windows x64', () => {
    const info = detectPlatform({ platform: 'win32', arch: 'x64' });
    expect(info.releaseFilename).toContain('win-cuda');
  });
  
  it('should throw on unsupported platform', () => {
    expect(() => detectPlatform({ platform: 'freebsd' }))
      .toThrow('Platform freebsd not supported');
  });
});
```

**2. downloader.test.ts**
- Mock `fetch()` 返回假数据
- 测试超时逻辑（使用 fake timers）
- 测试镜像站 URL 构建
- 测试临时文件管理
- 测试解压逻辑

**3. resolver.test.ts**
- 测试路径查找优先级
- 测试自动下载触发条件
- Mock 下载函数，验证降级逻辑
- 测试目标目录选择（项目内优先）

### 集成测试

**auto-install-integration.test.ts**
```typescript
describe('llama-server auto-install', () => {
  it('should download and install llama-server', async () => {
    // 清理现有安装
    const binPath = join(__dirname, '..', 'bin', 'llama-server');
    if (existsSync(binPath)) unlinkSync(binPath);
    
    // 触发自动安装
    const path = await ensureLlamaServer({ timeout: 120000 });
    
    // 验证安装
    expect(existsSync(path)).toBe(true);
    expect(isExecutable(path)).toBe(true);
    
    // 验证可运行
    const result = spawnSync(path, ['--version']);
    expect(result.status).toBe(0);
    expect(result.stdout.toString()).toContain('llama');
  }, 180000); // 3 分钟超时
  
  it('should handle network timeout gracefully', async () => {
    // Mock fetch 超时
    jest.spyOn(global, 'fetch').mockImplementation(() => 
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('timeout')), 100)
      )
    );
    
    await expect(ensureLlamaServer({ timeout: 200 }))
      .rejects.toThrow('Failed to download');
  });
});
```

**MCP 启动测试**
```typescript
it('should start MCP with auto-installed llama-server', async () => {
  // 清理环境
  delete process.env.LLAMA_SERVER_PATH;
  
  // 启动 MCP（触发自动安装）
  const mcp = spawn('node', ['dist/index.js']);
  
  // 等待初始化完成
  await waitForMcpReady(mcp);
  
  // 验证 llama-server 已安装
  const binPath = join(__dirname, '..', 'bin', 'llama-server');
  expect(existsSync(binPath)).toBe(true);
  
  // 清理
  mcp.kill();
});
```

## 实现注意事项

### 1. 进度反馈
- 使用 `response.body.getReader()` 流式读取，计算进度百分比
- 每 5% 或每秒输出一次进度日志（避免日志刷屏）

### 2. 原子操作
- 下载到 `.tmp` 临时文件
- 完成后重命名为最终文件名（原子操作，避免半成品）
- 失败时确保清理临时文件

### 3. 并发控制
- 多个 provider 同时初始化时，可能触发多次下载
- 使用文件锁或内存锁（AsyncLock）确保只下载一次

### 4. 版本管理
- 当前设计自动下载最新版本（`/releases/latest`）
- 未来可扩展：缓存版本信息，避免每次启动都查询 API
- 支持固定版本：`LLAMA_SERVER_VERSION=b9894`

### 5. 跨平台兼容性
- Windows: 使用 `.exe` 扩展名，解压 zip 而非 tar.gz
- Unix: 解压后需要 `chmod +x`
- 路径分隔符: 使用 `path.join()` 而非硬编码 `/`

### 6. 安全性
- 下载的文件来自官方 GitHub releases（可信）
- 镜像站只是代理，不修改内容
- 未来可扩展：校验 SHA256 hash（如果 releases 提供）

## 向后兼容性

- 保留所有现有的查找逻辑和环境变量支持
- `LLAMA_SERVER_PATH` 仍然是最高优先级
- `~/.vision-mcp/bin/` 仍然被检查（兼容已有安装）
- 不破坏现有的 `scripts/setup-llama.ts`（可继续使用）

## 文档更新

需要更新的文档：
1. **README.md** - 简化安装步骤，说明自动下载功能
2. **AGENTS.md** - 更新实现说明，移除"不自动安装"的限制
3. **Docs/01-architecture/06-provider-runtime.md** - 添加自动下载架构说明

## 未来扩展

1. **版本锁定**：支持 `LLAMA_SERVER_VERSION` 固定版本
2. **校验和验证**：下载后校验 SHA256（需要 releases 提供）
3. **增量更新**：检测已安装版本，仅在有新版本时更新
4. **离线安装包**：提供预打包的 npm 包，包含常见平台的二进制
5. **多版本共存**：支持安装多个版本，按需切换

## 成功标准

1. ✅ 用户无需手动安装 llama.cpp，首次运行自动完成
2. ✅ 支持 macOS ARM64/x64, Linux x64, Windows x64
3. ✅ 官方下载慢时自动切换镜像站
4. ✅ 无权限问题（优先项目内目录）
5. ✅ 所有错误场景有清晰的错误消息和手动安装指令
6. ✅ 所有日志输出到 stderr，不污染 stdout
7. ✅ 单元测试覆盖率 > 80%
8. ✅ 集成测试验证端到端流程
