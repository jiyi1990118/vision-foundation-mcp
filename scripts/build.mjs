/**
 * Cross-platform build script.
 *
 * Replaces the Unix-only build command (rm -rf, bash for-loop, cp -r)
 * with pure Node.js fs operations so it works on Windows, macOS, and Linux.
 */
import { execSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const projectRoot = join(__dirname, '..');
const srcSkillsDir = join(projectRoot, 'src', 'skills');
const distSkillsDir = join(projectRoot, 'dist', 'skills');

// 1. Clean dist/
rmSync(join(projectRoot, 'dist'), { recursive: true, force: true });

// 2. Compile TypeScript
execSync('tsc', { stdio: 'inherit', cwd: projectRoot });

// 3. Copy skill assets (skill.json, prompt.md, schema.json) into dist/skills/
if (!existsSync(distSkillsDir)) {
  mkdirSync(distSkillsDir, { recursive: true });
}

const skillDirs = readdirSync(srcSkillsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

for (const skillName of skillDirs) {
  const src = join(srcSkillsDir, skillName);
  const dest = join(distSkillsDir, skillName);
  cpSync(src, dest, { recursive: true });
}

console.log(`Build complete: ${skillDirs.length} skills copied to dist/skills/`);
