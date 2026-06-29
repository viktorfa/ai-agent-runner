import { parseArgs, resolveRunOptions } from './args'
import { loadConfig } from './config'
import { makeDeps, makeOrchestrateDeps, makeParallelDeps, openSink } from './io'
import { runLogPath } from './log-path'
import { orchestrate } from './orchestrate'
import { runParallel } from './parallel'
import { type IterationOutcome, runLoop } from './run'

async function main(): Promise<void> {
	const [command, ...rest] = process.argv.slice(2)
	if (command !== 'run' && command !== 'orchestrate') {
		process.stderr.write('usage: agent-runner <run|orchestrate> [options]\n')
		process.exit(1)
	}

	const args = parseArgs(rest)
	const config = await loadConfig(args.workspace)
	// CLI flag wins, else the repo's .agent/config.json, else a default.
	const opts = resolveRunOptions(args, config)

	// Route the agent (and its children) through the host egress proxy.
	if (args.proxy) {
		process.env.HTTPS_PROXY = args.proxy
		process.env.HTTP_PROXY = args.proxy
		process.env.https_proxy = args.proxy
		process.env.http_proxy = args.proxy
	}

	// Persist a transcript so unattended runs (and the watcher) are reviewable
	// after the fact, alongside the Squid access log.
	const logFile = runLogPath({
		workspace: opts.workspace,
		assistant: opts.assistant,
		timestamp: new Date().toISOString(),
	})
	const { sink, close } = openSink(logFile)
	sink(`# agent-runner ${command} — ${opts.assistant}/${opts.role}\n`)
	process.stderr.write(`transcript: ${logFile}\n`)

	// A drain opts into parallel agents when the repo's config raises maxParallel;
	// otherwise it's the sequential drain (and `run` is always sequential).
	const parallel =
		command === 'orchestrate' && !!opts.drain && config.maxParallel > 1

	try {
		let count: number
		let ok: boolean
		if (parallel) {
			const results = await runParallel(
				config,
				makeParallelDeps(opts, config, sink),
			)
			count = results.length
			ok = results.every((r) => r.ok)
		} else {
			const outcomes: IterationOutcome[] =
				command === 'orchestrate'
					? await orchestrate(
							opts,
							config,
							makeOrchestrateDeps(opts, config, sink),
							args.force,
						)
					: await runLoop(opts, makeDeps(opts, config, sink))
			count = outcomes.length
			ok = outcomes.every((o) => o.result.ok)
		}

		const summary = `\nDone: ${count} ${
			parallel ? 'parallel task' : 'iteration'
		}(s), ${ok ? 'ok' : 'with failures'}.\n`
		process.stderr.write(summary)
		sink(summary)
		await close()
		process.exit(ok ? 0 : 1)
	} catch (err) {
		sink(`\nERROR: ${err instanceof Error ? err.message : String(err)}\n`)
		await close()
		throw err
	}
}

main().catch((err: unknown) => {
	process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
	process.exit(1)
})
