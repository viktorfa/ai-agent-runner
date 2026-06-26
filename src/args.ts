import type { AgentConfig } from './config'
import type { Assistant, LoopRole, RunOptions } from './types'

/**
 * Parsed CLI flags. `assistant`/`model`/`effort`/`role` are optional one-off
 * overrides — when absent they fall back to the repo's `.agent/config.json`
 * (see `resolveRunOptions`). `proxy` is a machine concern the launcher (dispatch)
 * supplies.
 */
export interface CliArgs {
	assistant?: Assistant
	role?: LoopRole
	iterations: number
	workspace: string
	task?: string
	drain: boolean
	model?: string
	effort?: string
	proxy?: string
	noPush: boolean
	/** orchestrate: discard unmerged work on the work branch and reset anyway. */
	force: boolean
}

const ASSISTANTS = new Set<string>(['claude', 'codex'])
const ROLES = new Set<string>(['dev', 'qa'])

export function parseArgs(argv: string[]): CliArgs {
	let assistant: Assistant | undefined
	let role: LoopRole | undefined
	let iterations = 1
	let workspace = '.'
	let task: string | undefined
	let drain = false
	let model: string | undefined
	let effort: string | undefined
	let proxy: string | undefined
	let noPush = false
	let force = false

	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i]
		const value = (): string => {
			const v = argv[i + 1]
			if (v === undefined) throw new Error(`missing value for ${flag}`)
			i += 1
			return v
		}
		switch (flag) {
			case '--assistant': {
				const v = value()
				if (!ASSISTANTS.has(v)) throw new Error(`unsupported assistant: ${v}`)
				assistant = v as Assistant
				break
			}
			case '--loop': {
				const v = value()
				if (!ROLES.has(v)) throw new Error(`unsupported loop: ${v}`)
				role = v as LoopRole
				break
			}
			case '--iterations':
				iterations = Number.parseInt(value(), 10)
				break
			case '--workspace':
				workspace = value()
				break
			case '--task':
				task = value()
				break
			case '--drain':
				drain = true
				break
			case '--model':
				model = value()
				break
			case '--effort':
				effort = value()
				break
			case '--proxy':
				proxy = value()
				break
			case '--no-push':
				noPush = true
				break
			case '--force':
				force = true
				break
			default:
				throw new Error(`unknown argument: ${flag}`)
		}
	}

	if (task && drain) {
		throw new Error('--task and --drain are mutually exclusive')
	}

	return {
		iterations,
		workspace,
		drain,
		noPush,
		force,
		...(assistant ? { assistant } : {}),
		...(role ? { role } : {}),
		...(task ? { task } : {}),
		...(model ? { model } : {}),
		...(effort ? { effort } : {}),
		...(proxy ? { proxy } : {}),
	}
}

/**
 * Resolve the effective run options: CLI flag wins, else the repo's config
 * (`.agent/config.json`), else a built-in default. Role is per-dispatch and
 * defaults to `dev` (qa is opt-in via `--loop qa`).
 */
export function resolveRunOptions(
	args: CliArgs,
	config: AgentConfig,
): RunOptions {
	const model = args.model ?? config.model
	const effort = args.effort ?? config.effort
	return {
		assistant: args.assistant ?? config.assistant,
		role: args.role ?? 'dev',
		iterations: args.iterations,
		workspace: args.workspace,
		drain: args.drain,
		noPush: args.noPush,
		...(args.task ? { task: args.task } : {}),
		...(model ? { model } : {}),
		...(effort ? { effort } : {}),
	}
}
