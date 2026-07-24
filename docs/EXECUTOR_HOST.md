# Executor host — capabilities & provisioning

What the headless executor's machine can actually do, so task authors (the
orchestrator) don't file work the box can't complete, and so provisioning is
reproducible. The runner is host-agnostic; this file records the *specific* box the
loops run on. Update it when you provision a new capability.

Host: `t14s`, user `agent`. Egress is a deny-by-default Squid forward proxy
(`http://127.0.0.1:3128`); there is no direct internet.

## Shell contract (bit us twice — read this)

The runner is dispatched as `sudo -iu agent bash -lic '…'` — a **login+interactive**
shell — and the dispatch command injects `HTTPS_PROXY`/`NO_PROXY` inline. Two
consequences when you run anything by hand:

- **`node` is only on the PATH of an *interactive* shell.** fnm initialises in
  `~/.bashrc` (interactive-only), not `~/.profile`. So `bash -lc` (login,
  non-interactive) has no node — anything invoking the runner or a JS tool must use
  `bash -lic`.
- **The proxy is not in the agent's profile.** A manual `sudo -iu agent` session has
  no egress until you `export HTTPS_PROXY=http://127.0.0.1:3128 NO_PROXY=127.0.0.1,localhost`.
  Real drains get it from dispatch; ad-hoc commands don't.

## Capabilities

**Node / TypeScript — full.** Toolchain via fnm (`node`, `pnpm`), installed during
provisioning while egress was open. npm registry is allowlisted.

**Python — via uv, system interpreter only.** `uv` is on `~/.local/bin` (installed
from GitHub release assets, which are allowlisted). `UV_PYTHON_DOWNLOADS=never` is set
in the agent's `~/.profile`, so uv uses the **system CPython (3.12.x)** and never
downloads an interpreter. `pypi.org` + `pythonhosted.org` are allowlisted, so
`uv sync --frozen` / `uv run --frozen` resolve normally, and uv's download cache
(`~/.cache/uv`) is warm.

Limits, by construction:
- **Python 3.12 only.** An app pinned to a different minor (e.g. `==3.13.*`) will
  *fail* rather than download — deliberate. Provision a system 3.13 (or allowlist
  `python-build-standalone` and drop the `never` guard) before filing such work.
- **No heavy-ML installs.** `torch`/`whisperx`/`demucs` etc. live in optional
  dependency groups the gates don't install (they belong in container images). Don't
  file tasks whose *tests* import them on this box.
- **No custom package index.** Everything must resolve from PyPI; a task needing
  `download.pytorch.org` or a private index needs that host allowlisted first.

**Git hooks are neutralised for the agent** — `LEFTHOOK=0` in `~/.profile`. A repo's
`pre-push`/`pre-commit` lefthook jobs do not run during runner pushes (they otherwise
validate the staging checkout, not the pushed commits, and assume tools the box may
lack — a teksta `pre-push` calling `uv` once caused a 12-hour publish-fail loop). The
runner relies on each repo's own `config.gates` over the combined tree instead.

## Egress (Squid allowlist)

`/etc/squid/allowed-domains.txt` (root-owned; `dstdomain`, leading dot = subdomains).
Currently: GitHub, npm, Anthropic, OpenAI/ChatGPT, context7, PyPI+pythonhosted.
Adding a host is a **root** action + `systemctl reload squid`, and every entry is an
exfil channel with no TLS interception — keep it tight, enumerate per real need.

## Capability boundary for task authors

Safe to file for this box today: anything TypeScript, and Python-3.12 work whose gate
deps resolve from PyPI (ruff/ty/pytest/fastapi/numpy-class wheels). **Not** yet doable
(will block, like teksta TASK-107): container/Docker builds, non-3.12 Python, heavy-ML
installs, or anything needing a non-allowlisted host.

## Planned: rootless Docker (not yet provisioned)

Goal: let the box build/run images **without** the "docker group = host root" exposure
— a container escape or socket access lands on the unprivileged `agent` uid, because
the daemon and containers run as `agent` and container UID 0 maps to host `agent` via
subuid/subgid. `docker run -v /:/host` then only grants what `agent` already has.

Operator runbook (root unless noted; verify each on the box — kernel is 6.17, so
native `overlay2` rootless should work without `fuse-overlayfs`):

1. Packages: `uidmap` (setuid `newuidmap`/`newgidmap`), `dbus-user-session`,
   `slirp4netns` (rootless networking), `docker-ce-rootless-extras`.
2. Subordinate ranges: ensure `/etc/subuid` and `/etc/subgid` each hold
   `agent:100000:65536` (≥65536).
3. **Linger:** `loginctl enable-linger agent` — required so the agent's `systemd
   --user` instance (and `docker.service`) run with no active login session.
4. As `agent`: `dockerd-rootless-setuptool.sh install` → writes
   `~/.config/systemd/user/docker.service`; then `systemctl --user enable --now docker`.
5. Agent env (`~/.profile`): `export DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock`.
6. Egress: image pulls need registry hosts allowlisted (`registry-1.docker.io`,
   `auth.docker.io`, `production.cloudflare.docker.com`, plus any `ghcr.io`/other
   registries the target images use) — enumerate from the actual base images.

Residual risks to accept explicitly: kernel user-namespace vulnerabilities and the
`newuidmap`/`newgidmap` setuid surface; keep the egress allowlist tight regardless.
Ports <1024 and some cgroup features need extra config — unlikely to matter for CI
image builds.
