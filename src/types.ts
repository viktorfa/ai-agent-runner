/** Core domain types for the agent runner. */

export type Assistant = 'claude' | 'codex'
export type Backend = 'docker' | 'host'
export type LoopRole = 'dev' | 'qa'

/** Everything one agent session (`run`) needs to know. */
export interface RunOptions {
	assistant: Assistant
	role: LoopRole
	iterations: number
	/** Absolute path to the repo the agent operates on. */
	workspace: string
	/**
	 * When set, the agent works only this task instead of choosing from the
	 * board (an explicit assignment directive is appended to the prompt).
	 * Mutually exclusive with `drain`.
	 */
	task?: string
	/**
	 * Drain the board: keep running iterations (the agent picks the next ready
	 * task each time) until no ready tasks remain, bounded by a safety cap.
	 * Mutually exclusive with `task`; ignores `iterations`.
	 */
	drain?: boolean
	model?: string
	effort?: string
	/** Skip pushing the work branch after each iteration. */
	noPush?: boolean
}

/** Outcome of one agent run, parsed from its output stream. */
export interface AgentResult {
	/** The agent finished its turn without a fatal/auth error. */
	ok: boolean
	/** A short human summary, when the agent emitted one. */
	summary?: string
	/** The agent reported an authentication failure (stop the loop). */
	authFailed?: boolean
}

/**
 * How to invoke a specific agent CLI and read its result. Adding OpenCode (or any
 * other tool) means implementing this — not editing the run loop.
 */
export interface AgentAdapter {
	/** Binary to spawn (e.g. `claude`, `codex`). */
	readonly bin: string
	/** Argv for one non-interactive run. The prompt is piped on stdin. */
	buildArgv(opts: RunOptions): string[]
	/** Interpret the agent's stdout (newline-delimited JSON). */
	parseResult(stdout: string): AgentResult
}
