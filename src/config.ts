import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Assistant, LoopRole } from './types'

/** Per-repo runner config (the typed successor to .agent/config.sh). */
export interface AgentConfig {
	/** Docker image for the docker backend. */
	image: string
	/**
	 * How to drive the agent for this repo. These live here (versioned, portable)
	 * rather than in the operator registry: the model id is assistant-specific, so
	 * the three travel together. A `--model`/`--effort`/`--assistant` CLI flag still
	 * overrides for a one-off run.
	 */
	assistant: Assistant
	model?: string
	effort?: string
	/** Branch new work is based on. */
	baseBranch: string
	/** Branch the runner commits + pushes to. */
	workBranch: string
	/**
	 * How the work branch is prepared each run:
	 * - `reset` — discard + reset to base every run (one reviewable diff per run,
	 *   guarded against unmerged work). For repos that review per PR.
	 * - `accumulate` — keep the long-lived work branch and merge base in, so many
	 *   tasks pile up across runs; you merge the branch to base periodically.
	 */
	workBranchMode: 'reset' | 'accumulate'
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
		assistant: 'claude',
		baseBranch: 'master',
		workBranch: 'auto/work',
		workBranchMode: 'reset',
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
		assistant: partial.assistant ?? d.assistant,
		baseBranch: partial.baseBranch ?? d.baseBranch,
		workBranch: partial.workBranch ?? d.workBranch,
		workBranchMode: partial.workBranchMode ?? d.workBranchMode,
		setup: partial.setup ?? d.setup,
		prompts: { ...d.prompts, ...partial.prompts },
		hooks: { ...d.hooks, ...partial.hooks },
		...(partial.model !== undefined ? { model: partial.model } : {}),
		...(partial.effort !== undefined ? { effort: partial.effort } : {}),
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
