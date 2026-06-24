import { describe, expect, it } from 'vitest'
import { defaultConfig, promptPath, resolveConfig } from './config'

describe('resolveConfig', () => {
	it('returns defaults for an empty partial', () => {
		expect(resolveConfig({})).toEqual(defaultConfig())
	})

	it('overrides only the provided fields', () => {
		const c = resolveConfig({ image: 'custom-img', baseBranch: 'main' })
		expect(c.image).toBe('custom-img')
		expect(c.baseBranch).toBe('main')
		expect(c.workBranch).toBe('auto/work')
	})

	it('merges nested prompts/hooks without dropping siblings', () => {
		const c = resolveConfig({ prompts: { dev: 'x.md' } as never })
		expect(c.prompts.dev).toBe('x.md')
		expect(c.prompts.qa).toBe('.agent/prompts/qa-loop.md')
	})

	it('defaults workBranchMode to reset and lets it be overridden', () => {
		expect(defaultConfig().workBranchMode).toBe('reset')
		expect(resolveConfig({ workBranchMode: 'accumulate' }).workBranchMode).toBe(
			'accumulate',
		)
	})
})

describe('promptPath', () => {
	it('joins the workspace with the role prompt', () => {
		expect(promptPath('/repo', defaultConfig(), 'dev')).toBe(
			'/repo/.agent/prompts/dev-loop.md',
		)
	})
})
