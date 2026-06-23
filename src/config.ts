import { join } from 'node:path'
import type { LoopRole } from './types'

/**
 * Convention: the unified loop prompts live at .agent/prompts/<role>-loop.md
 * (both assistants read the same file). When we migrate config.sh → a typed
 * .agent/config.json, this becomes config-driven instead of conventional.
 */
export function resolvePromptPath(workspace: string, role: LoopRole): string {
	return join(workspace, '.agent', 'prompts', `${role}-loop.md`)
}
