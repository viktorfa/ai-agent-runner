import { describe, expect, it } from 'vitest'
import {
	fetchArgs,
	mergeAbortArgs,
	mergeBaseArgs,
	remoteBranchExistsArgs,
	resetWorkBranchArgs,
	unmergedCountArgs,
	workBranchPushArgs,
} from './git'

describe('workBranchPushArgs', () => {
	it('force-with-leases the current HEAD to the named origin branch', () => {
		expect(workBranchPushArgs('auto/work')).toEqual([
			'push',
			'--force-with-lease',
			'origin',
			'HEAD:auto/work',
		])
	})
})

describe('prep args', () => {
	it('fetchArgs fetches origin', () => {
		expect(fetchArgs()).toEqual(['fetch', 'origin'])
	})

	it('resetWorkBranchArgs resets the work branch to origin/base', () => {
		expect(resetWorkBranchArgs('auto/work', 'master')).toEqual([
			'checkout',
			'-B',
			'auto/work',
			'origin/master',
		])
	})

	it('unmergedCountArgs counts work-branch commits not in base', () => {
		expect(unmergedCountArgs('master', 'auto/work')).toEqual([
			'rev-list',
			'--count',
			'origin/master..origin/auto/work',
		])
	})
})

describe('accumulate args', () => {
	it('remoteBranchExistsArgs verifies the origin ref quietly', () => {
		expect(remoteBranchExistsArgs('auto/work')).toEqual([
			'rev-parse',
			'--verify',
			'--quiet',
			'refs/remotes/origin/auto/work',
		])
	})

	it('mergeBaseArgs merges origin/base without opening an editor', () => {
		expect(mergeBaseArgs('master')).toEqual([
			'merge',
			'--no-edit',
			'origin/master',
		])
	})

	it('mergeAbortArgs aborts an in-progress merge', () => {
		expect(mergeAbortArgs()).toEqual(['merge', '--abort'])
	})
})
