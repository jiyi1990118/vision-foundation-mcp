/**
 * Skill Registry — auto-discovers and loads Skill manifests from src/skills/.
 *
 * @see Docs/01-architecture/05-skill-engine.md (§7 Skill 注册与发现)
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SkillManifest } from '../types/skills.js';
import { logger } from '../utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(__dirname, '..', 'skills');

let registry: Map<string, SkillManifest> | null = null;

export function getSkillRegistry(): Map<string, SkillManifest> {
  if (registry) return registry;

  registry = new Map();
  loadSkills();
  return registry;
}

function loadSkills(): void {
  if (!existsSync(SKILLS_DIR)) {
    logger.warn('Skills directory not found', { path: SKILLS_DIR });
    return;
  }

  const entries = readdirSync(SKILLS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const skillDir = join(SKILLS_DIR, entry.name);
    const manifestPath = join(skillDir, 'skill.json');
    const promptPath = join(skillDir, 'prompt.md');
    const schemaPath = join(skillDir, 'schema.json');

    if (!existsSync(manifestPath)) {
      logger.warn('Skill missing skill.json', { skill: entry.name });
      continue;
    }

    try {
      const skillJson = JSON.parse(readFileSync(manifestPath, 'utf8'));
      const promptTemplate = existsSync(promptPath)
        ? readFileSync(promptPath, 'utf8')
        : '';
      const schema = existsSync(schemaPath)
        ? JSON.parse(readFileSync(schemaPath, 'utf8'))
        : {};

      const manifest: SkillManifest = {
        ...skillJson,
        promptTemplate,
        schema,
      };

      registry!.set(manifest.name, manifest);
      logger.debug('Skill registered', { name: manifest.name, version: manifest.version });
    } catch (e) {
      logger.warn('Failed to load skill', { skill: entry.name, error: (e as Error).message });
    }
  }

  logger.info('Skill registry loaded', { count: registry!.size });
}

export function getSkill(name: string): SkillManifest | undefined {
  return getSkillRegistry().get(name);
}

export function listSkills(): SkillManifest[] {
  return Array.from(getSkillRegistry().values());
}

export function hasSkill(name: string): boolean {
  return getSkillRegistry().has(name);
}
