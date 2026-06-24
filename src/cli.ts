import { parseArgs } from './args'
import { loadConfig } from './config'
import { makeDeps, makeOrchestrateDeps, openSink } from './io'
import { runLogPath } from './log-path'
import { orchestrate } from './orchestrate'
import { type IterationOutcome, runLoop } from './run'

async function main(): Promise<void> {
	const [command, ...rest] = process.argv.slice(2)
	if (command !== 'run' && command !== 'orchestrate') {
		process.stderr.write('usage: agent-runner <run|orchestrate> [options]\n')
		process.exit(1)
	}

	const args = parseArgs(rest)
	const config = await loadConfig(args.workspace)

	// Route the agent (and its children) through the host egress proxy.
	if (args.proxy) {
		process.env.HTTPS_PROXY = args.proxy
		process.env.HTTP_PROXY = args.proxy
		process.env.https_proxy = args.proxy
		process.env.http_proxy = args.proxy
	}

	// Persist a transcript so unattended runs (and the future watcher) are
	// reviewable after the fact, alongside the Squid access log.
	const logFile = runLogPath({
		workspace: args.workspace,
		assistant: args.assistant,
		timestamp: new Date().toISOString(),
	})
	const { sink, close } = openSink(logFile)
	sink(`# agent-runner ${command} — ${args.assistant}/${args.role}\n`)
	process.stderr.write(`transcript: ${logFile}\n`)

	try {
		const outcomes: IterationOutcome[] =
			command === 'orchestrate'
				? await orchestrate(
						args,
						config,
						makeOrchestrateDeps(args, config, sink),
						args.force,
					)
				: await runLoop(args, makeDeps(args, config, sink))

		const ok = outcomes.every((o) => o.result.ok)
		const summary = `\nDone: ${outcomes.length} iteration(s), ${
			ok ? 'ok' : 'with failures'
		}.\n`
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
