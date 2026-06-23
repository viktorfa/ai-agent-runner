#!/usr/bin/env bash
# Provision the host-backend BASE on a dedicated executor (Ubuntu 24.04):
# the dedicated `agent` user and the Squid allowlist proxy. Run with sudo.
#
# Idempotent. This does NOT apply the nftables egress lockdown — run lockdown.sh
# for that AFTER the agent toolchain + repo are in place (those steps need open
# egress). See README.md and docs/AGENT_DEV_SYSTEM.md §6/§7.
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "Run with sudo (root)." >&2; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"
AGENT_USER="${AGENT_USER:-agent}"

if ! id "$AGENT_USER" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "$AGENT_USER"
  echo "Created user: $AGENT_USER"
else
  echo "User already exists: $AGENT_USER"
fi

# Let the owner monitor the agent's logs over SSH — one-directional (you read in;
# the agent can't reach out). Secret files (PAT in ~/.git-credentials, ~/.codex)
# stay 0600, so a traversable home does not expose them.
chmod 755 "/home/$AGENT_USER"

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends squid nftables

install -D -m 0644 "$HERE/squid.conf"         /etc/squid/squid.conf
install -D -m 0644 "$HERE/allowed-domains.txt" /etc/squid/allowed-domains.txt
mkdir -p /var/log/squid
chown proxy:proxy /var/log/squid 2>/dev/null || true

# Validate before (re)starting so a bad edit doesn't take the proxy down silently.
squid -k parse
systemctl enable squid
systemctl restart squid
echo "Squid configured and running on 127.0.0.1:3128."

cat <<EOF

BASE provisioning done (agent user + Squid). The egress lockdown is NOT yet
applied — the agent still has open network for setup. Next, see README.md:
  1. As '$AGENT_USER': install fnm + Node 24 + pnpm, then claude (+ claude login).
  2. Create the restricted PAT, clone the repo to ~/repos, pnpm install, browsers.
  3. THEN run lockdown.sh to close egress down to the Squid allowlist.
EOF
