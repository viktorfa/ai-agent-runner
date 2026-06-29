/**
 * A FIFO async mutex. `serialize(fn)` runs `fn` only after every previously-serialized
 * call has settled, so operations that must not overlap — e.g. git plumbing on a shared
 * `.git` (worktree add/remove race on `.git/config.lock`) — execute one at a time, in
 * call order. A failing op doesn't break the chain; the next still runs.
 */
export function createSerializer(): <T>(fn: () => Promise<T>) => Promise<T> {
	let tail: Promise<unknown> = Promise.resolve()
	return <T>(fn: () => Promise<T>): Promise<T> => {
		const next = tail.then(fn, fn)
		tail = next.then(
			() => {},
			() => {},
		)
		return next
	}
}
