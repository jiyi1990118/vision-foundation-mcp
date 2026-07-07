/**
 * Prompt Compiler — compiles a Skill's prompt template with variables.
 *
 * @see Docs/01-architecture/09-prompt-schema-registry.md (§5 Prompt 编译流程)
 */
import type { SkillManifest } from '../types/skills.js';
import type { ImageMetadata } from '../types/domain.js';

export interface PromptVars {
  intent: string;
  focus?: string | undefined;
  metadata: ImageMetadata;
}

/**
 * Compile a Skill's prompt template with the given variables.
 * Simple template substitution: {{variable}} → value.
 */
export function compilePrompt(
  manifest: SkillManifest,
  vars: PromptVars,
): string {
  let prompt = manifest.promptTemplate;

  // Simple variable substitution
  const replacements: Record<string, string> = {
    '{{intent}}': vars.intent,
    '{{focus}}': vars.focus ?? '',
    '{{metadata.width}}': String(vars.metadata.width),
    '{{metadata.height}}': String(vars.metadata.height),
    '{{metadata.format}}': vars.metadata.format,
    '{{metadata.complexity}}': vars.metadata.complexity,
    '{{metadata.estimatedType}}': vars.metadata.estimatedType ?? '',
  };

  for (const [key, value] of Object.entries(replacements)) {
    prompt = prompt.replaceAll(key, value);
  }

  // If user provided a focus, append it
  if (vars.focus && !prompt.includes(vars.focus)) {
    prompt += `\n\nFocus on: ${vars.focus}`;
  }

  return prompt;
}
