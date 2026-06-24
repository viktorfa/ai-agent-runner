import type { Assistant, Backend, LoopRole, RunOptions } from './types'

/** Parsed CLI arguments: a RunOptions plus launcher-level concerns. */
export interface CliArgs extends RunOptions {
	backend: Backend
	proxy?: string
	/** orchestrate: discard unmerged work on the work branch and reset anyway. */
	force: boolean
}

const ASSISTANTS = new Set<string>(['claude', 'codex'])
const BACKENDS = new Set<string>(['docker', 'host'])
const ROLES = new Set<string>(['dev', 'qa'])

export function parseArgs(argv: string[]): CliArgs {
	let assistant: Assistant = 'claude'
	let role: LoopRole = 'dev'
	let backend: Backend = 'docker'
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
			case '--backend': {
				const v = value()
				if (!BACKENDS.has(v)) throw new Error(`unsupported backend: ${v}`)
				backend = v as Backend
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
		assistant,
		role,
		backend,
		iterations,
		workspace,
		drain,
		noPush,
		force,
		...(task ? { task } : {}),
		...(model ? { model } : {}),
		...(effort ? { effort } : {}),
		...(proxy ? { proxy } : {}),
	}
}
