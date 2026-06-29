import { parseArgs, resolveRunOptions } from './args'
import { loadConfig } from './config'
import { taskBranch } from './git'
import { integrate } from './integrate'
import {
	loadRemoteConfig,
	makeDeps,
	makeIntegrateDeps,
	makeOrchestrateDeps,
	makeParallelDeps,
	makeStagingDeps,
	openSink,
} from './io'
import { runLogPath } from './log-path'
import { orchestrate } from './orchestrate'
import { runParallel } from './parallel'
import { type IterationOutcome, runLoop } from './run'
import { discardStaging, promoteStaging, statusStaging } from './staging'

const COMMANDS = new Set(['run', 'orchestrate', 'status', 'promote', 'discard'])

async function main(): Promise<void> {
	const [command, ...rest] = process.argv.slice(2)
	if (!command || !COMMANDS.has(command)) {
		process.stderr.write(
			'usage: agent-runner <run|orchestrate|status|promote|discard> [options]\n',
		)
		process.exit(1)
	}

	const args = parseArgs(rest)
	let config = await loadConfig(args.workspace)

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
		workspace: args.workspace,
		assistant: command,
		timestamp: new Date().toISOString(),
	})
	const { sink, close } = openSink(logFile)
	sink(`# agent-runner ${command}\n`)
	process.stderr.write(`transcript: ${logFile}\n`)

	if (command === 'status' || command === 'promote' || command === 'discard') {
		try {
			const deps = makeStagingDeps(args.workspace, sink)
			if (command === 'status') {
				await statusStaging(config, deps)
			} else if (command === 'promote') {
				await promoteStaging(config, deps)
			} else {
				await discardStaging(config, deps)
			}
			await close()
			process.exit(0)
		} catch (err) {
			sink(`\nERROR: ${err instanceof Error ? err.message : String(err)}\n`)
			await close()
			throw err
		}
	}

	// An executor run's config must reflect origin, not the workspace's stale working
	// tree — orchestrate only syncs the tree *after* startup, so a pushed config change
	// (maxParallel, model, gates, …) would otherwise take effect one run late. `run`
	// keeps the current-tree config by design (it operates on the local tree as-is).
	if (command === 'orchestrate') {
		const base = config.baseBranch
		const fresh = await loadRemoteConfig(args.workspace, base)
		if (fresh) {
			config = fresh
			sink(`# config loaded from origin/${base}\n`)
		}
	}

	// CLI flag wins, else the repo's .agent/config.json, else a default.
	const opts = resolveRunOptions(args, config)
	sink(`# assistant ${opts.assistant}/${opts.role}\n`)

	// A drain opts into parallel agents when the repo's config raises maxParallel;
	// otherwise it's the sequential drain (and `run` is always sequential).
	const parallel =
		command === 'orchestrate' && !!opts.drain && config.maxParallel > 1

	try {
		let count: number
		let ok: boolean
		let extra = ''
		if (parallel) {
			const results = await runParallel(
				config,
				makeParallelDeps(opts, config, sink),
			)
			// Fold every branch that built green into staging, one at a time, re-gating
			// the combined tree (docs/PARALLEL_AGENTS.md §5). A branch that conflicts or
			// turns the gates red is parked, never landed.
			const built = results
				.filter((r) => r.ok)
				.map((r) => ({ id: r.id, branch: taskBranch(r.id) }))
			const integration = built.length
				? await integrate(built, makeIntegrateDeps(opts, config, sink))
				: { staged: [], parked: [] }
			count = results.length
			ok = results.every((r) => r.ok) && integration.parked.length === 0
			extra = ` — staged ${integration.staged.length}, parked ${integration.parked.length}`
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
		}(s)${extra}, ${ok ? 'ok' : 'with failures'}.\n`
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
