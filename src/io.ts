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

/** Spawn a command (optionally piping stdin); capture stdout while echoing + teeing it. */
function exec(
	cmd: string,
	args: string[],
	cwd: string,
	sink?: Sink,
	stdin?: string,
): Promise<{ code: number; stdout: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { cwd })
		let stdout = ''
		child.stdout?.on('data', (chunk: Buffer) => {
			const text = chunk.toString()
			stdout += text
			process.stdout.write(text)
			sink?.(text)
		})
		child.stderr?.on('data', (chunk: Buffer) => {
			process.stderr.write(chunk)
			sink?.(chunk.toString())
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
			const { stdout } = await exec(bin, argv, cwd, sink, prompt)
			return stdout
		},

		push: async () => {
			const head = await exec(
				'git',
				['rev-parse', '--abbrev-ref', 'HEAD'],
				cwd,
				sink,
			)
			const branch = head.stdout.trim()
			if (!branch || branch === 'HEAD') return false
			const { code } = await exec('git', workBranchPushArgs(branch), cwd, sink)
			return code === 0
		},

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
		git: (gitArgs) => exec('git', gitArgs, cwd, sink),
		runSetup: async () => {
			await exec('bash', [config.setup], cwd, sink)
		},
	}
}
