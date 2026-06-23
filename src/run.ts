import { claudeAdapter } from './adapters/claude'
import { codexAdapter } from './adapters/codex'
import { assemblePrompt } from './prompt'
import type { AgentAdapter, AgentResult, Assistant, RunOptions } from './types'

const adapters: Record<Assistant, AgentAdapter> = {
	claude: claudeAdapter,
	codex: codexAdapter,
}

/**
 * IO the run loop needs, injected so the orchestration is unit-testable without
 * spawning real agents, touching the filesystem, or pushing to a remote.
 */
export interface RunDeps {
	/** Read the base prompt for this assistant + role. */
	readPrompt(): Promise<string>
	/** Spawn the agent, pipe `prompt` to stdin, resolve with captured stdout. */
	spawnAgent(bin: string, argv: string[], prompt: string): Promise<string>
	/** Push the work branch; resolve true on success. */
	push(): Promise<boolean>
	/** Progress logging. */
	log(line: string): void
}

export interface IterationOutcome {
	iteration: number
	result: AgentResult
	pushed: boolean
}

/**
 * Run one agent session: assemble the prompt (+ optional task directive), build
 * the adapter argv, then for each iteration spawn the agent, interpret its
 * output, and push the work branch when it succeeded.
 */
export async function runLoop(
	opts: RunOptions,
	deps: RunDeps,
): Promise<IterationOutcome[]> {
	const adapter = adapters[opts.assistant]
	const prompt = assemblePrompt(await deps.readPrompt(), opts.task)
	const argv = adapter.buildArgv(opts)
	const outcomes: IterationOutcome[] = []

	for (let i = 1; i <= opts.iterations; i++) {
		deps.log(`=== iteration ${i}/${opts.iterations} ===`)
		const stdout = await deps.spawnAgent(adapter.bin, argv, prompt)
		const result = adapter.parseResult(stdout)

		let pushed = false
		if (result.ok && !opts.noPush) {
			pushed = await deps.push()
		}
		outcomes.push({ iteration: i, result, pushed })

		if (result.authFailed) {
			deps.log('authentication failed — stopping')
			break
		}
	}
	return outcomes
}
