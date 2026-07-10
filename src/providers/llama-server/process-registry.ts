/**
 * Runtime process discovery for llama-server.
 *
 * We avoid writing a persistent port registry. Instead, we discover existing
 * llama-server processes by model path, extract the port from their command,
 * and attach to them. If none exists, the provider allocates a fresh free port.
 */
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';

export interface ExistingLlamaServerProcess {
  pid: number;
  port: number;
}

export interface FindProcessOptions {
  modelPath: string;
  listCommands?: () => string[];
}

export function extractPortFromCommand(command: string): number | null {
  const equals = command.match(/--port=(\d+)/);
  if (equals) return Number(equals[1]);

  const spaced = command.match(/--port\s+(\d+)/);
  if (spaced) return Number(spaced[1]);

  return null;
}

export function extractPidFromLsofLine(line: string): number | null {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 2 || parts[0] === 'COMMAND') return null;
  const pid = Number(parts[1]);
  return Number.isInteger(pid) ? pid : null;
}

export function findExistingLlamaServerProcess(
  options: FindProcessOptions,
): ExistingLlamaServerProcess | null {
  const commands = options.listCommands ?? listLlamaServerCommands;
  for (const line of commands()) {
    if (!line.includes('llama-server')) continue;
    if (!line.includes(options.modelPath)) continue;

    const pid = Number(line.trim().split(/\s+/, 1)[0]);
    const port = extractPortFromCommand(line);
    if (Number.isInteger(pid) && port !== null) {
      return { pid, port };
    }
  }
  return null;
}

export async function allocateRandomFreePort(
  randomPort: () => number = makeRandomPort,
  maxAttempts = 50,
): Promise<number> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const port = randomPort();
    if (await isPortAvailable(port)) return port;
  }
  throw new Error('Unable to allocate a free llama-server port');
}

function listLlamaServerCommands(): string[] {
  if (process.platform === 'win32') {
    return listLlamaServerCommandsWindows();
  }
  return listLlamaServerCommandsUnix();
}

function listLlamaServerCommandsUnix(): string[] {
  try {
    const out = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
    return out.split('\n').map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function listLlamaServerCommandsWindows(): string[] {
  try {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*llama-server*' } | ForEach-Object { \"$($_.ProcessId) $($_.CommandLine)\" }",
      ],
      { encoding: 'utf8' },
    );
    return out.split('\n').map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function makeRandomPort(): number {
  return 41000 + Math.floor(Math.random() * 20000);
}

async function isPortAvailable(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}
