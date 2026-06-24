import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { LoopRole } from './types'

/** Per-repo runner config (the typed successor to .agent/config.sh). */
export interface AgentConfig {
	/** Docker image for the docker backend. */
	image: string
	/** Branch new work is based on. */
	baseBranch: string
	/** Branch the runner commits + pushes to. */
	workBranch: string
	/** Workspace-prep hook (pnpm install, skillshare sync, …). */
	setup: string
	/** Loop prompt per role (workspace-relative). */
	prompts: Record<LoopRole, string>
	/** Repo-specific lifecycle hooks (workspace-relative). */
	hooks: { devServer: string; preview: string; audit: string }
}

export function defaultConfig(): AgentConfig {
	return {
		image: 'room-planner-claude',
		baseBranch: 'master',
		workBranch: 'auto/work',
		setup: '.agent/setup.sh',
		prompts: {
			dev: '.agent/prompts/dev-loop.md',
			qa: '.agent/prompts/qa-loop.md',
		},
		hooks: {
			devServer: '.agent/hooks/dev-server.sh',
			preview: '.agent/hooks/qa-preview.sh',
			audit: '.agent/hooks/3d-audit.sh',
		},
	}
}

/** Merge a partial config (from config.json) over the defaults. Pure. */
export function resolveConfig(partial: Partial<AgentConfig>): AgentConfig {
	const d = defaultConfig()
	return {
		image: partial.image ?? d.image,
		baseBranch: partial.baseBranch ?? d.baseBranch,
		workBranch: partial.workBranch ?? d.workBranch,
		setup: partial.setup ?? d.setup,
		prompts: { ...d.prompts, ...partial.prompts },
		hooks: { ...d.hooks, ...partial.hooks },
	}
}

/** Load .agent/config.json merged over defaults; defaults if absent/invalid. */
export async function loadConfig(workspace: string): Promise<AgentConfig> {
	try {
		const path = join(workspace, '.agent', 'config.json')
		const partial = JSON.parse(
			await readFile(path, 'utf8'),
		) as Partial<AgentConfig>
		return resolveConfig(partial)
	} catch {
		return defaultConfig()
	}
}

/** Absolute path to the loop prompt for a role. */
export function promptPath(
	workspace: string,
	config: AgentConfig,
	role: LoopRole,
): string {
	return join(workspace, config.prompts[role])
}
