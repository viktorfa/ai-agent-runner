/** Core domain types for the agent runner. */

export type Assistant = 'claude' | 'codex'
/**
 * A loop role. Not a fixed enum — each repo defines its own roles via the prompts
 * it ships in `.agent/config.json` (`dev` and `qa` are the built-in defaults; a
 * repo can add e.g. `steward`). A role is valid iff that repo has a prompt for it.
 */
export type LoopRole = string

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
