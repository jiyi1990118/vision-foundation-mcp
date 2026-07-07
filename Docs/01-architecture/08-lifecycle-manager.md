# 08 - Lifecycle Manager（生命周期与资源释放管理）

> GGUF-backed provider（SmolVLM2/SmolVLM/MiniCPM-V）加载后占用约 500MB-3GB 内存。Lifecycle Manager 是保证「用完即释、按需重载、不泄漏、不抖动」的核心机制。本文档是资源自动释放的完整设计。

> ⚠️ **实现状态**：当前实现中，生命周期管理内嵌在各个 Provider 类中（`load()`/`unload()`/`isLoaded()` + idle timeout + 内存监控），没有独立的 LifecycleManager 模块。`LlamaServerProcess`（`src/providers/llama-server/process.ts`）管理 `llama-server` 子进程的启动/复用/停止。Provider 间无统一的状态机或引用计数调度器——这是规划中的增强。

---

## 1. 设计目标

| 目标 | 说明 |
|------|------|
| 零内存启动 | 服务启动不预加载任何模型，内存占用趋近于零 |
| 按需加载 | 首次调用时自动加载，用户无感 |
| 自动释放 | 空闲超时自动卸载，释放内存给系统 |
| 内存保护 | 系统内存紧张时主动释放，防 OOM |
| 安全卸载 | 引用计数保护，推理中不卸载 |
| 防抖动 | 最小驻留时间 + 冷启动预热，避免频繁加载/卸载 |
| 进程安全退出 | 收到信号时清理资源，防泄漏 |

## 非目标
- ❌ 不做模型预热缓存策略优化（V1 用简单 LRU）
- ❌ 不做 GPU 显存精细管理（V1 以 CPU 为主）
- ❌ 不跨进程共享模型（V1 单进程）

---

## 2. SmolVLM 资源画像

设计释放机制前，必须明确 SmolVLM-500M Q4_K_M 的资源特征：

```
模型文件（磁盘）：    ~800MB（ONNX Q4_K_M）
加载后内存占用：      ~800MB - 1GB（含推理会话）
加载耗时：            ~2-5 秒（首次，含磁盘读取 + 会话创建）
卸载耗时：            ~0.5-1 秒（释放张量 + 销毁会话）
单次推理耗时：        ~0.5-3 秒（取决于图片复杂度）
推荐最大并发：        4（CPU 场景）
```

### 关键约束
1. **加载耗秒级** → 不能频繁卸载，否则用户感受到明显延迟
2. **内存占比大** → 800MB 在 8GB 机器上占 10%，必须能释放
3. **卸载非瞬时** → 卸载过程需 0.5-1 秒，期间不能接受推理
4. **ONNX 会话持有原生资源** → 必须显式释放，否则内存泄漏

---

## 3. 完整状态机

现有设计的 3 状态机过于简单，无法处理竞态。以下是完整的 **6 状态机**：

```
                        load() 触发
                          │
                          ▼
   ┌──────────────┐  ┌──────────────┐
   │  Unloaded    │─►│   Loading    │
   │ (零内存)      │  │ (加载中)      │
   └──────┬───────┘  └──────┬───────┘
          ▲                   │
          │                   │ load 成功
          │                   ▼
          │              ┌──────────────┐
          │              │    Loaded    │◄─────────┐
          │              │ (就绪可推理)  │          │
          │              └──────┬───────┘          │
          │                     │ refCount==0      │ 新请求到来
          │                     │ + 空闲计时开始    │ + refCount++
          │                     ▼                  │
          │              ┌──────────────┐          │
          │     unload() │     Idle     │──────────┘
          │   ┌──────────│ (空闲待卸载)  │
          │   │          └──────┬───────┘
          │   │                 │ 空闲超时
          │   │                 │ 或内存压力
          │   │                 ▼
          │   │          ┌──────────────┐
          │   └──────────│  Unloading   │
          │              │ (卸载中)      │
          │              └──────┬───────┘
          │                     │ unload 完成
          │                     ▼
          │              ┌──────────────┐
          └──────────────│  Unloaded    │
                         │ (零内存)      │
                         └──────────────┘

     任何状态 ──load 失败──► Error ──重试/修复──► Unloaded
```

### 状态定义

| 状态 | 内存占用 | 可接受推理 | 说明 |
|------|---------|-----------|------|
| `Unloaded` | 0 | 否 | 模型未加载，零内存 |
| `Loading` | 上升中 | 否（请求等待） | 正在加载，拒绝/排队新推理 |
| `Loaded` | ~800MB | 是 | 就绪，refCount > 0 |
| `Idle` | ~800MB | 是（唤醒） | refCount == 0，空闲计时中 |
| `Unloading` | 下降中 | 否（请求等待重载） | 正在卸载，新推理触发重载 |
| `Error` | 不定 | 否 | 加载失败，待修复 |

### 状态转换规则

```
Unloaded ──load()──► Loading ──成功──► Loaded
                      Loading ──失败──► Error
Loaded   ──refCount降为0──► Idle
Idle     ──新请求──► Loaded          （唤醒，无需重载）
Idle     ──空闲超时──► Unloading ──► Unloaded
Idle     ──内存压力──► Unloading ──► Unloaded
Unloading──新请求──► 等待卸载完成 ──► Unloaded ──► Loading ──► Loaded
Error    ──修复后──► Unloaded
```

### 竞态处理

| 场景 | 处理 |
|------|------|
| Loading 中收到 unload 请求 | 标记 pendingUnload，加载完成后立即卸载 |
| Loading 中收到推理请求 | 请求等待加载完成（有超时） |
| Unloading 中收到推理请求 | 等待卸载完成 → 重新加载 → 推理 |
| Unloading 中收到 unload 请求 | 忽略（已在卸载） |
| Idle 中收到推理请求 | 立即转 Loaded（模型还在内存，无需重载） |
| 并发多个 load 请求 | 只执行一次加载，其余等待复用 |

---

## 4. 释放触发机制（三种触发器）

模型释放由三种独立机制触发，任一触发即执行卸载：

```
┌─────────────────────────────────────────────┐
│            Lifecycle Manager                 │
│                                              │
│  ┌─────────────┐  触发卸载                   │
│  │ 空闲超时检测  │──────────────┐             │
│  │ (Idle Timer) │              │             │
│  └─────────────┘              │             │
│                               │             │
│  ┌─────────────┐  触发卸载     ▼             │
│  │ 内存压力检测  │─────────► Unload Flow     │
│  │ (Mem Watch)  │              │             │
│  └─────────────┘              │             │
│                               │             │
│  ┌─────────────┐  触发卸载     │             │
│  │ 进程退出信号  │──────────────┘             │
│  │ (Signal Hook)│                            │
│  └─────────────┘                             │
└─────────────────────────────────────────────┘
```

### 4.1 触发器一：空闲超时检测（Idle Timer）

**机制**：Provider 的 refCount 降为 0 时启动计时器，超时后卸载。

```typescript
// 伪代码
function onRefCountZero(provider: VisionProvider) {
  provider.state = "Idle";
  provider.idleTimer = setTimeout(() => {
    if (provider.refCount === 0 && provider.state === "Idle") {
      unloadProvider(provider);
    }
  }, config.idleTimeout);  // 默认 10 分钟
}

function onNewRequest(provider: VisionProvider) {
  if (provider.idleTimer) {
    clearTimeout(provider.idleTimer);  // 取消待执行的卸载
    provider.idleTimer = null;
  }
  provider.refCount++;
  provider.state = "Loaded";
}
```

**关键参数**：
```yaml
idleTimeout: 600000        # 10 分钟（默认）
minIdleTime: 30000         # 最小空闲 30 秒才允许卸载（防抖动，见 §5）
```

**为什么 10 分钟**：见 [ADR-005](../04-decisions/ADR-005-lifecycle-strategy.md)。

### 4.2 触发器二：内存压力检测（Memory Watcher）

**机制**：定期检测系统可用内存，低于阈值时主动卸载空闲模型。

```typescript
// 伪代码
setInterval(() => {
  const available = getAvailableMemory();
  if (available < config.memoryThreshold) {
    // 按优先级卸载空闲模型
    const idleProviders = getProvidersByState("Idle");
    for (const p of sortByReleasePriority(idleProviders)) {
      unloadProvider(p);
      if (getAvailableMemory() >= config.memoryThreshold) break;
    }
  }
}, config.memoryCheckInterval);  // 默认每 30 秒检查
```

**关键参数**：
```yaml
memoryThreshold: 2048      # 可用内存低于 2GB 时触发卸载（MB）
memoryCheckInterval: 30000 # 每 30 秒检查一次
memoryCriticalThreshold: 1024  # 低于 1GB 时拒绝新请求（防 OOM）
```

**内存检测方式**：
```typescript
// Node.js 获取系统内存
function getAvailableMemory(): number {
  const total = os.totalmem();
  const free = os.freemem();
  return Math.floor(free / 1024 / 1024);  // MB
}
```

**卸载优先级**（多模型场景）：
```
1. Idle 状态中最久未使用的（LRU）
2. 内存占用最大的（快速释放空间）
3. 非 default 的 Provider 优先（保 SmolVLM）
```

### 4.3 触发器三：进程退出信号（Signal Hook）

**机制**：监听 SIGTERM/SIGINT，进程退出前同步卸载所有模型。

```typescript
// 伪代码
async function gracefulShutdown(signal: string) {
  logger.info(`收到 ${signal}，开始清理模型资源...`);
  
  // 停止接受新请求
  stopAcceptingRequests();
  
  // 等待进行中的推理完成（有超时）
  await waitForPendingInferences({ timeout: 10000 });
  
  // 卸载所有已加载模型
  const loaded = getProvidersByState(["Loaded", "Idle"]);
  await Promise.all(loaded.map(p => p.unload()));
  
  logger.info("模型资源清理完成，退出进程");
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
```

**关键参数**：
```yaml
shutdownTimeout: 10000     # 退出前最多等待 10 秒
```

---

## 5. 防抖动机制（Anti-Thrashing）

**问题**：SmolVLM 加载需 2-5 秒。如果用户每隔 9 分钟调用一次（刚好低于 10 分钟超时），模型会不断卸载又重载，每次都让用户等 2-5 秒。

### 5.1 最小驻留时间（Min Dwell Time）

模型加载后，即使立即空闲，也至少驻留 N 秒，避免「加载完就卸载」的抖动：

```yaml
minDwellTime: 60000        # 加载后至少驻留 60 秒
```

```typescript
function onRefCountZero(provider) {
  const dwellTime = Date.now() - provider.loadedAt;
  if (dwellTime < config.minDwellTime) {
    // 不足最小驻留时间，延迟到剩余时间后检查
    const remaining = config.minDwellTime - dwellTime;
    provider.idleTimer = setTimeout(() => {
      if (provider.refCount === 0) unloadProvider(provider);
    }, Math.max(remaining, config.idleTimeout));
  } else {
    // 已过最小驻留时间，按正常超时
    provider.idleTimer = setTimeout(() => {
      if (provider.refCount === 0) unloadProvider(provider);
    }, config.idleTimeout);
  }
}
```

### 5.2 冷启动预热（Warmup）

模型加载后，执行一次空推理预热，避免首次真实推理的额外冷启动延迟：

```typescript
async function loadProvider(provider) {
  provider.state = "Loading";
  await provider.load();
  // 预热：用 1x1 像素图跑一次空推理
  await provider.infer({
    image: createWarmupImage(),
    prompt: "warmup",
    maxTokens: 1,
    temperature: 0,
  });
  provider.loadedAt = Date.now();
  provider.state = "Loaded";
}
```

### 5.3 频繁重载检测

若同一模型在短时间内被卸载又重载多次，自动延长超时时间（退避）：

```typescript
function onReload(provider) {
  provider.reloadCount++;
  if (provider.reloadCount > 2) {
    // 短时间内反复加载，延长空闲超时
    provider.currentIdleTimeout = config.idleTimeout * provider.reloadCount;
    logger.warn("模型频繁重载，延长空闲超时", {
      provider: provider.name,
      newTimeout: provider.currentIdleTimeout,
    });
  }
}

// 持续空闲 1 小时后重置计数
function resetReloadCount(provider) {
  if (Date.now() - provider.loadedAt > 3600000) {
    provider.reloadCount = 0;
    provider.currentIdleTimeout = config.idleTimeout;
  }
}
```

---

## 6. 引用计数（并发安全）

### 6.1 引用计数规则

```typescript
interface ProviderHandle {
  provider: VisionProvider;
  refCount: number;
  state: ProviderState;
  loadedAt: number;
  idleTimer: NodeJS.Timeout | null;
  reloadCount: number;
  currentIdleTimeout: number;
}
```

```
请求进入：
  acquire(providerName)
    → refCount++
    → 清除 idleTimer
    → 返回 Provider 引用

请求完成：
  release(providerName)
    → refCount--
    → if refCount == 0 → 启动 idleTimer
    → if refCount < 0 → 日志告警（计数错误）
```

### 6.2 acquire / release 伪代码

```typescript
class LifecycleManager {
  private handles = new Map<string, ProviderHandle>();

  async acquire(name: string): Promise<VisionProvider> {
    const handle = this.handles.get(name);
    
    if (!handle) {
      // 首次使用，创建并加载
      return this.loadNew(name);
    }
    
    switch (handle.state) {
      case "Loaded":
        clearTimeout(handle.idleTimer);
        handle.refCount++;
        return handle.provider;
        
      case "Idle":
        // 模型还在内存，直接唤醒
        clearTimeout(handle.idleTimer);
        handle.refCount++;
        handle.state = "Loaded";
        return handle.provider;
        
      case "Loading":
        // 等待加载完成
        await this.waitForState(handle, "Loaded", config.loadTimeout);
        return this.acquire(name);  // 递归
        
      case "Unloading":
        // 等待卸载完成，再重新加载
        await this.waitForState(handle, "Unloaded", config.unloadTimeout);
        return this.loadNew(name);
        
      case "Unloaded":
        return this.loadNew(name);
        
      case "Error":
        throw new VisionError("PROVIDER_UNAVAILABLE", "Provider in error state", false);
    }
  }

  release(name: string): void {
    const handle = this.handles.get(name);
    if (!handle) return;
    
    handle.refCount--;
    
    if (handle.refCount === 0) {
      this.startIdleTimer(handle);
    } else if (handle.refCount < 0) {
      logger.error("引用计数错误", { provider: name, refCount: handle.refCount });
      handle.refCount = 0;
      this.startIdleTimer(handle);
    }
  }
}
```

### 6.3 Skill Pipeline 的使用方式

```typescript
// Skill Pipeline 调用 Provider 时
async function runSkill(task, image) {
  const provider = await lifecycleManager.acquire(plan.provider);
  try {
    const response = await provider.infer({ image, prompt: task.prompt, ... });
    return response;
  } finally {
    lifecycleManager.release(plan.provider);  // 确保释放
  }
}
```

**关键**：`try...finally` 保证即使推理抛错也释放引用。

---

## 7. 多 Provider 释放优先级

当内存压力需要卸载模型但多个模型处于 Idle 时，按以下优先级释放：

```
优先级（从高到低，先释放优先级高的）：

1. 非 default Provider 且 Idle     （先卸载非默认模型）
   例：先卸载 minicpm，保 smolvlm2

2. Idle 时间最长的                  （LRU 策略）

3. 内存占用最大的                   （快速释放空间）
   例：minicpm 2GB > smolvlm2 500MB → 先卸载 minicpm

4. default Provider（SmolVLM）     （最后才卸载默认模型）
```

```typescript
function sortByReleasePriority(providers: ProviderHandle[]): ProviderHandle[] {
  return providers.sort((a, b) => {
    // 非 default 优先卸载
    if (a.name !== config.defaultProvider && b.name === config.defaultProvider) return -1;
    if (a.name === config.defaultProvider && b.name !== config.defaultProvider) return 1;
    // 内存占用大的优先
    if (a.requirements.modelSizeMB !== b.requirements.modelSizeMB) {
      return b.requirements.modelSizeMB - a.requirements.modelSizeMB;
    }
    // 空闲时间长的优先（LRU）
    return a.lastUsedAt - b.lastUsedAt;
  });
}
```

---

## 8. 与 Policy Engine 的联动

Policy Engine 的 `memory-guard` 策略与 Lifecycle Manager 协作：

```
请求进入
   │
   ▼
PolicyEngine.evaluate()
   │
   ├─ 命中 memory-guard（memory<1GB）
   │     │
   │     ▼
   │   Policy 通知 LifecycleManager.unloadIdleProviders()
   │     │
   │     ▼
    │   强制 provider=smolvlm2（降级）
   │
   └─ 未命中 → 正常流程
```

```typescript
// Policy Engine 中的 memory-guard 策略
{
  name: "memory-guard",
  when: { "memory.available": "< 1024" },
  override: { provider: "smolvlm2" },
  action: "warn",
  // 策略匹配时触发 Lifecycle 清理
  onMatch: async (ctx) => {
    await lifecycleManager.unloadIdleProviders();
  }
}
```

---

## 9. 完整配置

```yaml
# config/lifecycle.yaml
lifecycle:
  # 空闲超时
  idleTimeout: 600000           # 10 分钟空闲后卸载
  minDwellTime: 60000           # 加载后至少驻留 60 秒
  
  # 内存保护
  memoryThreshold: 2048         # 可用内存<2GB 时卸载空闲模型
  memoryCriticalThreshold: 1024 # 可用内存<1GB 时拒绝新请求
  memoryCheckInterval: 30000    # 内存检查间隔 30 秒
  
  # 并发控制
  maxConcurrent: 4              # 最大并发推理数
  
  # 退出清理
  shutdownTimeout: 10000        # 进程退出最多等待 10 秒
  
  # 启动行为
  preloadOnStart: false         # 启动不预加载（零内存启动）
  
  # 防抖动
  maxReloadBeforeBackoff: 2     # 短时间重载超过此次数则退避
  backoffMultiplier: 2          # 退避倍数
```

---

## 10. 接口定义

### LifecycleManager
```typescript
interface LifecycleManager {
  /**
   * 获取已加载的 Provider 引用（refCount++）
   * 若未加载则触发加载，若 Idle 则唤醒
   */
  acquire(name: string): Promise<VisionProvider>;

  /**
   * 释放引用（refCount--）
   * refCount 降为 0 时启动空闲计时
   */
  release(name: string): void;

  /** 卸载所有空闲 Provider（内存压力时调用） */
  unloadIdleProviders(): Promise<void>;

  /** 卸载指定 Provider（强制） */
  forceUnload(name: string): Promise<void>;

  /** 获取所有 Provider 状态 */
  getStatus(): ProviderStatus[];

  /** 优雅关闭（进程退出时） */
  shutdown(): Promise<void>;
}

interface ProviderStatus {
  name: string;
  state: ProviderState;
  refCount: number;
  loadedAt: number | null;
  memoryUsage: number;        // MB
  idleTime: number;           // 已空闲毫秒数
  reloadCount: number;
}
```

### ProviderState（完整版）
```typescript
type ProviderState =
  | "Unloaded"    // 未加载（零内存）
  | "Loading"     // 加载中
  | "Loaded"      // 已加载就绪（refCount > 0）
  | "Idle"        // 空闲待卸载（refCount == 0）
  | "Unloading"   // 卸载中
  | "Error";      // 加载失败
```

> 注：此状态机取代 [领域模型](../02-contracts/01-domain-model.md) 中的简化版。以本文档为准。

---

## 11. 资源释放保障清单

### 11.1 ONNX Runtime 资源释放

SmolVLM 通过 ONNX Runtime 推理，需确保原生资源释放：

```typescript
class SmolVLMProvider implements VisionProvider {
  private session: ort.InferenceSession | null = null;

  async load() {
    this.session = await ort.InferenceSession.create(modelPath);
  }

  async unload() {
    // ONNX 会话必须显式 release
    if (this.session) {
      this.session.release();  // 释放原生资源
      this.session = null;
    }
    // 触发 GC（Node.js 中建议但不强制）
    if (global.gc) global.gc();
  }
}
```

**关键**：`session.release()` 必须调用，否则 ONNX 原生内存泄漏（Node GC 无法回收原生对象）。

### 11.2 释放保障矩阵

| 场景 | 保障机制 |
|------|---------|
| 正常空闲超时 | idleTimer → unload → session.release() |
| 内存压力 | memoryWatcher → unloadIdle → session.release() |
| 进程正常退出 | SIGTERM/SIGINT hook → shutdown → 全部 release |
| 进程异常崩溃 | OS 回收进程内存（最后兜底，但可能泄漏原生资源直到进程结束） |
| 推理异常 | try...finally → release refCount → idleTimer 兜底 |
| 引用计数错误 | refCount<0 告警 + 强制归零 + 启动 idleTimer |

### 11.3 泄漏检测

```typescript
// 定期检查：已加载但状态异常的 Provider
setInterval(() => {
  for (const [name, handle] of this.handles) {
    if (handle.state === "Idle" && handle.refCount > 0) {
      logger.error("检测到泄漏：Idle 状态但 refCount>0", {
        provider: name, refCount: handle.refCount,
      });
    }
    if (handle.state === "Loaded" && handle.refCount === 0) {
      // Loaded 但无引用，应转为 Idle
      handle.state = "Idle";
      this.startIdleTimer(handle);
    }
  }
}, 60000);  // 每分钟检查
```

---

## 12. 时序图：典型场景

### 场景一：首次调用 → 空闲 → 自动释放

```
时间    Client     Tool      Lifecycle        Provider      Timer
 0s                                Unloaded
 1s     analyze()──►Tool──►acquire()
                              │
                              ▼ 检测到 Unloaded
                            Loading
                              │ load() + warmup
 4s                            │
                              Loaded ◄─── refCount=1
                      Tool◄───Provider
                      infer()
 6s                      release() ──► refCount=0
                              │
                              Idle ◄── 启动 idleTimer(10min)
 16m                           │ idleTimer 触发
                              Unloading
 16.5s                         │ unload + session.release()
                              Unloaded ◄── 内存归零
```

### 场景二：空闲中被唤醒（无需重载）

```
时间    Lifecycle        Provider
 0s     Idle              refCount=0 (模型在内存)
 3s     acquire() ──►     清除 timer, refCount=1, → Loaded
        立即返回（无加载延迟）
 5s     release() ──►     refCount=0, → Idle, 重启 timer
```

### 场景三：内存压力触发卸载

```
时间    MemoryWatcher     Lifecycle        Provider
 0s     检测可用=1.8GB
        (< threshold 2GB)
              │
              ▼
        unloadIdleProviders()
              │
              ▼ 找到 Idle 的 qwen
                            Unloading → Unloaded (释放 4GB)
        可用内存恢复到 5.8GB
        停止卸载（已够）
```

---

## 13. 测试要点

| 测试场景 | 预期 |
|----------|------|
| 首次调用 | Loading → Loaded，含 warmup 耗时 |
| 空闲 10 分钟后调用 | Unloading → Unloaded → 重新 Loading → Loaded |
| 空闲中（< 10 分钟）调用 | Idle → Loaded，无加载延迟 |
| 并发 4 个请求 | refCount=4，共享一个 Provider |
| 并发 5 个请求（max=4） | 4 执行 + 1 排队 |
| 内存 < 2GB | 卸载空闲 Provider |
| 内存 < 1GB | 拒绝新请求（RESOURCE_INSUFFICIENT） |
| 加载后立即空闲 30 秒 | 不卸载（minDwellTime=60s 未到） |
| 加载后空闲 60 秒 | 可卸载（minDwellTime 已到，但 idleTimeout 未到） |
| 短时间重载 3 次 | 第 3 次延长 idleTimeout（退避） |
| SIGTERM | 等待推理完成 → 卸载所有 → 退出 |
| 推理抛错 | finally 中 release，refCount 正确递减 |
| refCount 计数错误（<0） | 告警 + 归零 + 启动 timer |
| Idle 状态但 refCount>0 | 泄漏检测告警 |
| 多 Provider 内存压力 | 非 default 先卸载，default（SmolVLM）最后 |

---

## 14. 监控指标

Lifecycle Manager 应暴露以下指标供监控：

```
provider_state{provider="smolvlm"}  2     # 0=Unloaded 1=Loading 2=Loaded 3=Idle 4=Unloading
provider_refcount{provider="smolvlm"}  1
provider_memory_mb{provider="smolvlm"}  820
provider_reload_count{provider="smolvlm"}  3
provider_idle_seconds{provider="smolvlm"}  45
lifecycle_unload_total{reason="idle_timeout"}  12
lifecycle_unload_total{reason="memory_pressure"}  2
lifecycle_load_total  15
lifecycle_load_duration_seconds{provider="smolvlm"}  3.2
system_memory_available_mb  4520
```

---

## 15. 本文小结

SmolVLM-500M 资源自动释放机制核心要点：

1. **6 状态完整状态机** —— Unloaded/Loading/Loaded/Idle/Unloading/Error，覆盖所有竞态
2. **三种释放触发器** —— 空闲超时 / 内存压力 / 进程退出，三重保障
3. **引用计数并发安全** —— acquire/release + try...finally，推理中不卸载
4. **防抖动三件套** —— 最小驻留时间 + 预热 + 频繁重载退避
5. **多 Provider 释放优先级** —— 非默认先卸载、大模型先卸载、LRU
6. **ONNX 原生资源显式释放** —— session.release() 必须调用
7. **泄漏检测** —— 定期扫描 Idle+refCount>0 异常状态
8. **进程退出清理** —— SIGTERM/SIGINT hook 优雅关闭

> 相关决策记录：[ADR-005: 资源释放策略](../04-decisions/ADR-005-lifecycle-strategy.md)
> 
> 上一篇：[07 - 模型管理](./07-model-management.md)
