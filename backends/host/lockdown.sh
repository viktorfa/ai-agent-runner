#!/usr/bin/env bash
# Apply the nftables egress allowlist for the `agent` user. Run with sudo, AFTER
# the agent toolchain + repo are set up (setup needs open egress; this closes it
# down to the Squid allowlist). Idempotent. See README.md / AGENT_DEV_SYSTEM §6.
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "Run with sudo (root)." >&2; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"
AGENT_USER="${AGENT_USER:-agent}"
id "$AGENT_USER" >/dev/null 2>&1 || { echo "User '$AGENT_USER' not found — run provision.sh first." >&2; exit 1; }

install -D -m 0644 "$HERE/agent-egress.nft" /etc/nftables.d/agent-egress.nft

# Make the main nftables service load drop-ins from /etc/nftables.d/.
if ! grep -q 'include "/etc/nftables.d/\*\.nft"' /etc/nftables.conf 2>/dev/null; then
  echo 'include "/etc/nftables.d/*.nft"' >> /etc/nftables.conf
fi

nft -c -f /etc/nftables.d/agent-egress.nft   # syntax check (resolves the agent uid)
systemctl enable nftables
systemctl restart nftables

cat <<EOF
Egress lockdown applied. Verify (both should behave as noted):
  sudo -u $AGENT_USER curl -sS --max-time 5 https://example.com
      -> should FAIL (no direct egress)
  sudo -u $AGENT_USER env HTTPS_PROXY=http://127.0.0.1:3128 curl -sS https://api.github.com/zen
      -> should WORK (allowlisted, via Squid)
  sudo -u $AGENT_USER env HTTPS_PROXY=http://127.0.0.1:3128 curl -sS --max-time 5 https://example.com
      -> should FAIL (reachable proxy, but not on the allowlist)
EOF
