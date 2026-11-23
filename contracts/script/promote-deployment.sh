#!/usr/bin/env bash
# Promotes a pending deployment record to the real one, after checking it against the chain.
#
#   script/promote-deployment.sh <chainId> <rpcUrl>
#
# `forge script script/Deploy.s.sol --broadcast` writes deployments/<chainId>.pending.json while the
# transactions are still being sent, so the record is only a claim. This script checks that claim
# with `cast`: the RPC is the chain the record names, both addresses have code, the token points at
# the registry, every role (compliance on the registry; minter, settler, pauser on the token; admin
# on both) is held by the address the record names, a deployer that handed over admin kept none,
# and the holder-transfer switch matches. Only then is the file renamed to deployments/<chainId>.json.
# On any failure it exits non-zero and leaves the pending file where it is.
#
# The RPC URL can carry an API key, so it is never printed, and cast's own error output (which can
# repeat the URL) is discarded. Needs: cast (Foundry) and python3 (to read the JSON record).
set -euo pipefail
umask 077

fail() {
  echo "promote-deployment: $*" >&2
  echo "promote-deployment: refused; the pending record was left in place." >&2
  exit 1
}

[[ $# -eq 2 ]] || { echo "usage: $0 <chainId> <rpcUrl>" >&2; exit 2; }
chain_id="$1"
rpc_url="$2"
[[ "$chain_id" =~ ^[0-9]+$ ]] || { echo "promote-deployment: chain id must be digits only" >&2; exit 2; }
[[ -n "$rpc_url" ]] || { echo "promote-deployment: rpc url must not be empty" >&2; exit 2; }

command -v cast >/dev/null 2>&1 || fail "cast not found (install Foundry)"
command -v python3 >/dev/null 2>&1 || fail "python3 not found"

deployments="$(cd "$(dirname "${BASH_SOURCE[0]}")/../deployments" && pwd)"
pending="$deployments/$chain_id.pending.json"
final="$deployments/$chain_id.json"
[[ -f "$pending" ]] || fail "no pending record for chain $chain_id"

# Read every field the checks need. Anything missing or malformed refuses the promotion.
fields="$(python3 -I - "$pending" <<'PY'
import json, re, sys
try:
    with open(sys.argv[1], encoding="utf-8") as f:
        d = json.load(f)
except (OSError, ValueError) as e:
    sys.exit(f"cannot read the pending record: {e.__class__.__name__}")
addr = re.compile(r"^0x[0-9a-fA-F]{40}$")
out = []
for k in ("complianceRegistry", "settlementToken", "deployer", "admin",
          "compliance", "minter", "settler", "pauser"):
    v = d.get(k)
    if not isinstance(v, str) or not addr.match(v):
        sys.exit(f"field {k} is missing or not an address")
    out.append(f"{k}={v.lower()}")
for k in ("chainId", "deploymentBlock"):
    v = d.get(k)
    if not isinstance(v, int) or isinstance(v, bool) or v < 0:
        sys.exit(f"field {k} is missing or not a number")
    out.append(f"{k}={v}")
v = d.get("holderTransfersEnabled")
if not isinstance(v, bool):
    sys.exit("field holderTransfersEnabled is missing or not a boolean")
out.append(f"holderTransfersEnabled={'true' if v else 'false'}")
print("\n".join(out))
PY
)" || fail "the pending record is malformed"

declare -A rec
while IFS='=' read -r k v; do rec["$k"]="$v"; done <<<"$fields"

# cast, with the URL kept out of every message.
c() { cast "$@" --rpc-url "$rpc_url" 2>/dev/null; }
lower() { tr '[:upper:]' '[:lower:]'; }

[[ "${rec[chainId]}" == "$chain_id" ]] || fail "the record is for chain ${rec[chainId]}, not $chain_id"
rpc_chain="$(c chain-id)" || fail "the RPC did not answer"
[[ "$rpc_chain" == "$chain_id" ]] || fail "the RPC serves chain $rpc_chain, not $chain_id"

registry="${rec[complianceRegistry]}"
token="${rec[settlementToken]}"
for a in "$registry" "$token"; do
  code="$(c code "$a")" || fail "could not read code at $a"
  [[ -n "$code" && "$code" != "0x" ]] || fail "no contract at $a"
done

linked="$(c call "$token" "registry()(address)" | lower)" || fail "token registry() call failed"
[[ "$linked" == "$registry" ]] || fail "the token points at $linked, not the registry $registry"

# Expected role ids are computed here, not trusted from the contracts, then cross-checked with them.
admin_role="$(printf '0x%064x' 0)"
role_id() { cast keccak "$1" | lower; }
check_getter() { # contract getter expected
  local got
  got="$(c call "$1" "$2()(bytes32)" | lower)" || fail "$2() call failed"
  [[ "$got" == "$3" ]] || fail "$2() on $1 is $got, expected $3"
}
compliance_role="$(role_id COMPLIANCE_ROLE)"
minter_role="$(role_id MINTER_ROLE)"
settler_role="$(role_id SETTLER_ROLE)"
pauser_role="$(role_id PAUSER_ROLE)"
check_getter "$registry" COMPLIANCE_ROLE "$compliance_role"
check_getter "$token" MINTER_ROLE "$minter_role"
check_getter "$token" SETTLER_ROLE "$settler_role"
check_getter "$token" PAUSER_ROLE "$pauser_role"
check_getter "$token" DEFAULT_ADMIN_ROLE "$admin_role"

has_role() { # contract role account -> prints true/false
  c call "$1" "hasRole(bytes32,address)(bool)" "$2" "$3" || fail "hasRole call failed"
}
expect_role() { # label contract role account
  [[ "$(has_role "$2" "$3" "$4")" == "true" ]] || fail "$1 is not held by $4"
}
expect_role "compliance role" "$registry" "$compliance_role" "${rec[compliance]}"
expect_role "minter role" "$token" "$minter_role" "${rec[minter]}"
expect_role "settler role" "$token" "$settler_role" "${rec[settler]}"
expect_role "pauser role" "$token" "$pauser_role" "${rec[pauser]}"
expect_role "registry admin" "$registry" "$admin_role" "${rec[admin]}"
expect_role "token admin" "$token" "$admin_role" "${rec[admin]}"

if [[ "${rec[admin]}" != "${rec[deployer]}" ]]; then
  for contract in "$registry" "$token"; do
    [[ "$(has_role "$contract" "$admin_role" "${rec[deployer]}")" == "false" ]] \
      || fail "the deployer still holds admin on $contract"
  done
fi

switch="$(c call "$token" "holderTransfersEnabled()(bool)")" || fail "holderTransfersEnabled() call failed"
[[ "$switch" == "${rec[holderTransfersEnabled]}" ]] \
  || fail "holderTransfersEnabled is $switch on chain, ${rec[holderTransfersEnabled]} in the record"

if [[ -e "$final" ]]; then
  echo "promote-deployment: replacing the existing record for chain $chain_id"
fi
mv -f "$pending" "$final"
echo "promote-deployment: chain $chain_id verified; registry $registry, token $token."
echo "promote-deployment: wrote deployments/$chain_id.json"
