import { spawn } from 'node:child_process'
import { createWriteStream, mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { CliArgs } from './args'
import { type AgentConfig, promptPath } from './config'
import { workBranchPushArgs } from './git'
import type { OrchestrateDeps } from './orchestrate'
import type { RunDeps } from './run'

/** Mirrors everything the run prints to a transcript file. */
export type Sink = (text: string) => void

interface ExecOpts {
	/** Tee captured output to the transcript. */
	sink?: Sink
	/** Pipe this to the child's stdin. */
	stdin?: string
	/** Capture only — don't echo to this process's stdout/stderr or the sink. */
	quiet?: boolean
}

/** Spawn a command; capture stdout while (unless quiet) echoing + teeing it. */
function exec(
	cmd: string,
	args: string[],
	cwd: string,
	{ sink, stdin, quiet }: ExecOpts = {},
): Promise<{ code: number; stdout: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { cwd })
		let stdout = ''
		child.stdout?.on('data', (chunk: Buffer) => {
			const text = chunk.toString()
			stdout += text
			if (!quiet) {
				process.stdout.write(text)
				sink?.(text)
			}
		})
		child.stderr?.on('data', (chunk: Buffer) => {
			if (!quiet) {
				process.stderr.write(chunk)
				sink?.(chunk.toString())
			}
		})
		child.on('error', reject)
		child.on('close', (code) => resolve({ code: code ?? 1, stdout }))
		if (stdin !== undefined) child.stdin?.end(stdin)
	})
}

/**
 * Open an append-mode transcript file (creating its directory). The CLI owns the
 * lifecycle: pass `sink` into the dep factories, then `await close()` before exit
 * so buffered output is flushed.
 */
export function openSink(logFile: string): {
	sink: Sink
	close: () => Promise<void>
} {
	mkdirSync(dirname(logFile), { recursive: true })
	const stream = createWriteStream(logFile, { flags: 'a' })
	return {
		sink: (text) => {
			stream.write(text)
		},
		close: () => new Promise((resolve) => stream.end(resolve)),
	}
}

/** Count the To Do tasks on the Backlog board (the agent's ready work). */
async function readyCount(cwd: string): Promise<number> {
	const { stdout } = await exec(
		'pnpm',
		['exec', 'backlog', 'task', 'list', '--plain'],
		cwd,
		{ quiet: true },
	)
	// Scan the "To Do:" section up to the next "<Header>:" line, counting task ids.
	let inTodo = false
	let count = 0
	for (const line of stdout.split('\n')) {
		if (/^To Do:/.test(line)) {
			inTodo = true
			continue
		}
		if (inTodo && /^\S.*:\s*$/.test(line)) break
		if (inTodo && /\bTASK-\d+\b/i.test(line)) count += 1
	}
	return count
}

/** Real IO for `runLoop`: read the prompt, spawn the agent, push the branch. */
export function makeDeps(
	args: CliArgs,
	config: AgentConfig,
	sink?: Sink,
): RunDeps {
	const cwd = args.workspace
	return {
		readPrompt: () => readFile(promptPath(cwd, config, args.role), 'utf8'),

		spawnAgent: async (bin, argv, prompt) => {
			const { stdout } = await exec(bin, argv, cwd, { sink, stdin: prompt })
			return stdout
		},

		push: async () => {
			const head = await exec(
				'git',
				['rev-parse', '--abbrev-ref', 'HEAD'],
				cwd,
				{ sink },
			)
			const branch = head.stdout.trim()
			if (!branch || branch === 'HEAD') return false
			const { code } = await exec('git', workBranchPushArgs(branch), cwd, {
				sink,
			})
			return code === 0
		},

		readyCount: () => readyCount(cwd),

		log: (line) => {
			process.stderr.write(`${line}\n`)
			sink?.(`${line}\n`)
		},
	}
}

/** Real IO for `orchestrate`: the run deps plus git + the setup hook. */
export function makeOrchestrateDeps(
	args: CliArgs,
	config: AgentConfig,
	sink?: Sink,
): OrchestrateDeps {
	const cwd = args.workspace
	return {
		...makeDeps(args, config, sink),
		git: (gitArgs) => exec('git', gitArgs, cwd, { sink }),
		runSetup: async () => {
			await exec('bash', [config.setup], cwd, { sink })
		},
	}
}
