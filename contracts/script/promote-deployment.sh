#!/usr/bin/env bash
# Promotes a pending deployment record to the real one, after checking it against the chain.
#
#   script/promote-deployment.sh <chainId> <rpcUrl> [confirmations]
#
# `forge script script/Deploy.s.sol --broadcast` writes deployments/<chainId>.pending.json while the
# transactions are still being sent, so the record is only a claim. This script checks that claim
# against ONE confirmed block B = head - confirmations (default 1), using `cast` for every read:
#
#   1. the RPC serves <chainId>, and head >= deploymentBlock + confirmations;
#   2. neither contract existed before deploymentBlock (so no event is missed), and both have
#      code at B whose runtime bytecode equals the build artifact in out/ (the token's immutable
#      slots are masked for the comparison and must each hold the registry address);
#   3. the token points at the registry, and the role ids match the expected names;
#   4. the role holders, rebuilt from every RoleGranted/RoleRevoked log since deploymentBlock, are
#      EXACTLY the ones in the record (one admin on each contract, compliance on the registry, and
#      minter, settler and pauser on the token): an extra grantee fails, a deployer that did not
#      renounce fails; no role event may be newer than B; hasRole at B must agree;
#   5. the holder-transfer switch at B matches the record.
#
# Only then is the VERIFIED content (re-serialised from the checked values, plus the block it was
# verified at) written to deployments/<chainId>.json through a temporary file and an atomic,
# no-clobber link. An existing <chainId>.json is never replaced, except on the throwaway local chain
# 31337 with PROMOTE_REPLACE=1. The pending file is removed only after success. Any failure exits
# non-zero and leaves every file as it was.
#
# The RPC URL can carry an API key, so it is never printed, and cast's own error output (which can
# repeat the URL) is discarded. Needs bash >= 4, cast (Foundry), python3, and the contracts built
# (`forge build`) from the commit that was deployed. PROMOTE_DEPLOYMENTS_DIR overrides the
# deployments directory (used by script/test-promote.sh).

if [ -z "${BASH_VERSINFO:-}" ] || [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
  echo "promote-deployment: bash >= 4 is required (this is ${BASH_VERSION:-not bash})" >&2
  exit 2
fi
set -euo pipefail
umask 077

usage() { echo "usage: $0 <chainId> <rpcUrl> [confirmations]" >&2; exit 2; }
bad_input() { echo "promote-deployment: $*" >&2; exit 2; }
fail() {
  echo "promote-deployment: $*" >&2
  echo "promote-deployment: refused; nothing was written and the pending record was left in place." >&2
  exit 1
}

[[ $# -eq 2 || $# -eq 3 ]] || usage
chain_id="$1"
rpc_url="$2"
confirmations="${3:-1}"
[[ "$chain_id" =~ ^[1-9][0-9]{0,19}$ ]] || bad_input "chain id must be digits only"
[[ -n "$rpc_url" ]] || bad_input "rpc url must not be empty"
[[ "$rpc_url" != *[[:space:]]* ]] || bad_input "rpc url must not contain whitespace"
[[ "$confirmations" =~ ^[1-9][0-9]{0,5}$ ]] || bad_input "confirmations must be digits only, at least 1"
replace="${PROMOTE_REPLACE:-0}"
[[ "$replace" == "0" || "$replace" == "1" ]] || bad_input "PROMOTE_REPLACE must be 0 or 1"

command -v cast >/dev/null 2>&1 || fail "cast not found (install Foundry)"
command -v python3 >/dev/null 2>&1 || fail "python3 not found"

contracts_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
deployments="${PROMOTE_DEPLOYMENTS_DIR:-$contracts_dir/deployments}"
[[ -d "$deployments" ]] || bad_input "deployments directory not found"
deployments="$(cd "$deployments" && pwd)"
pending="$deployments/$chain_id.pending.json"
final="$deployments/$chain_id.json"
[[ -f "$pending" ]] || fail "no pending record for chain $chain_id"

# Refuse up front to replace a live record: references are per contract, so an engine that followed a
# replaced record to a new token would find an empty referenceUsed guard and could pay twice.
if [[ -e "$final" ]]; then
  if [[ "$replace" != "1" ]]; then
    fail "deployments/$chain_id.json already exists; refusing to replace a live record"
  fi
  if [[ "$chain_id" != "31337" ]]; then
    fail "deployments/$chain_id.json already exists; PROMOTE_REPLACE=1 is only honoured on the local chain 31337"
  fi
  echo "promote-deployment: PROMOTE_REPLACE=1 on chain 31337: the existing record will be replaced"
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# All JSON and bytecode handling lives in this one helper, run isolated (-I) on files we wrote.
read -r -d '' PY <<'PY' || true
import json, re, sys

ADDR = re.compile(r"^0x[0-9a-fA-F]{40}$")

def die(msg):
    sys.exit(msg)

def record(path):
    try:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
    except (OSError, ValueError) as e:
        die(f"cannot read the pending record: {e.__class__.__name__}")
    if not isinstance(d, dict):
        die("the pending record is not a JSON object")
    out = []
    for k in ("complianceRegistry", "settlementToken", "deployer", "admin",
              "compliance", "minter", "settler", "pauser"):
        v = d.get(k)
        if not isinstance(v, str) or not ADDR.match(v):
            die(f"field {k} is missing or not an address")
        out.append(f"{k}={v.lower()}")
    for k in ("chainId", "deploymentBlock"):
        v = d.get(k)
        if not isinstance(v, int) or isinstance(v, bool) or v < 0:
            die(f"field {k} is missing or not a number")
        out.append(f"{k}={v}")
    v = d.get("holderTransfersEnabled")
    if not isinstance(v, bool):
        die("field holderTransfersEnabled is missing or not a boolean")
    out.append(f"holderTransfersEnabled={'true' if v else 'false'}")
    print("\n".join(out))

def hexbytes(s, what):
    s = s.strip()
    if not re.fullmatch(r"0x([0-9a-fA-F]{2})*", s):
        die(f"{what} is not hex")
    return bytes.fromhex(s[2:])

def code(artifact_path, onchain_path, registry, label):
    # Fails closed: a missing artifact or field is an error, never a pass.
    try:
        with open(artifact_path, encoding="utf-8") as f:
            art = json.load(f)
        deployed = art["deployedBytecode"]
        expected = hexbytes(deployed["object"], f"{label} artifact")
        refs = deployed.get("immutableReferences") or {}
    except (OSError, ValueError, KeyError, TypeError):
        die(f"cannot read the {label} build artifact; run `forge build` from the deployed commit")
    with open(onchain_path, encoding="utf-8") as f:
        actual = hexbytes(f.read(), f"{label} code")
    if not expected:
        die(f"the {label} artifact has no runtime bytecode")
    if len(actual) != len(expected):
        die(f"{label} runtime code differs from the build artifact (length)")
    want = bytes(12) + bytes.fromhex(registry[2:])
    a, e = bytearray(actual), bytearray(expected)
    for slots in refs.values():
        for r in slots:
            start, length = int(r["start"]), int(r["length"])
            if length != 32 or start < 0 or start + 32 > len(a):
                die(f"{label} has an immutable this check does not understand")
            # The token's only immutable is the registry; anything else fails here.
            if bytes(a[start:start + 32]) != want:
                die(f"{label} immutable does not hold the recorded registry")
            a[start:start + 32] = bytes(32)
            e[start:start + 32] = bytes(32)
    if a != e:
        die(f"{label} runtime code differs from the build artifact")

def roles(logs_path, block_b, granted, revoked, registry, token, *expected):
    # expected: groups of "contract:role:account" for every role that must exist.
    block_b = int(block_b)
    with open(logs_path, encoding="utf-8") as f:
        try:
            logs = json.load(f)
        except ValueError:
            die("the RPC returned unreadable logs")
    if isinstance(logs, dict) and "result" in logs:
        logs = logs["result"]
    if not isinstance(logs, list):
        die("the RPC returned unreadable logs")
    granted, revoked = granted.lower(), revoked.lower()
    holders = {}
    events = []
    for log in logs:
        try:
            addr = log["address"].lower()
            topics = [t.lower() for t in log["topics"]]
            bn = int(log["blockNumber"], 16)
            li = int(log["logIndex"], 16)
        except (KeyError, TypeError, ValueError, AttributeError):
            die("the RPC returned a malformed log")
        if addr not in (registry, token) or not topics or topics[0] not in (granted, revoked):
            continue
        if log.get("removed"):
            continue
        if len(topics) != 4:
            die("a role event has an unexpected shape")
        if bn > block_b:
            die(f"a role changed after the confirmed block {block_b}; wait for more confirmations "
                "or investigate")
        events.append((bn, li, addr, topics[0], topics[1], "0x" + topics[2][-40:]))
    for _, _, addr, kind, role, account in sorted(events):
        s = holders.setdefault((addr, role), set())
        (s.add if kind == granted else s.discard)(account)
    want = {}
    for item in expected:
        c, role, account = item.split(":")
        want.setdefault((c, role.lower()), set()).add(account.lower())
    names = {registry: "registry", token: "token"}
    for key in sorted(set(holders) | set(want)):
        have, need = holders.get(key, set()), want.get(key, set())
        if have != need:
            extra = sorted(have - need)
            missing = sorted(need - have)
            die(f"role {key[1]} on the {names[key[0]]}: holders from logs differ from the record"
                f" (extra: {', '.join(extra) or 'none'}; missing: {', '.join(missing) or 'none'})")

def write(path, block_b, confirmations, *pairs):
    d = {}
    for p in pairs:
        k, v = p.split("=", 1)
        d[k] = v
    out = {
        "chainId": int(d["chainId"]),
        "deploymentBlock": int(d["deploymentBlock"]),
        "verifiedAtBlock": int(block_b),
        "confirmations": int(confirmations),
        "complianceRegistry": d["complianceRegistry"],
        "settlementToken": d["settlementToken"],
        "deployer": d["deployer"],
        "admin": d["admin"],
        "compliance": d["compliance"],
        "minter": d["minter"],
        "settler": d["settler"],
        "pauser": d["pauser"],
        "holderTransfersEnabled": d["holderTransfersEnabled"] == "true",
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2)
        f.write("\n")

{"record": record, "code": code, "roles": roles, "write": write}[sys.argv[1]](*sys.argv[2:])
PY
py() { python3 -I -c "$PY" "$@"; }

fields="$(py record "$pending")" || fail "the pending record is malformed"
declare -A rec
while IFS='=' read -r k v; do rec["$k"]="$v"; done <<<"$fields"

# cast, with the URL kept out of every message.
c() { cast "$@" --rpc-url "$rpc_url" 2>/dev/null; }
lower() { tr '[:upper:]' '[:lower:]'; }

[[ "${rec[chainId]}" == "$chain_id" ]] || fail "the record is for chain ${rec[chainId]}, not $chain_id"
rpc_chain="$(c chain-id)" || fail "the RPC did not answer"
[[ "$rpc_chain" == "$chain_id" ]] || fail "the RPC serves chain $rpc_chain, not $chain_id"

# --- one pinned, confirmed block ------------------------------------------------------------------
head="$(c block-number)" || fail "could not read the chain head"
[[ "$head" =~ ^[0-9]+$ ]] || fail "the RPC returned an invalid block number"
deployment_block="${rec[deploymentBlock]}"
if (( head < deployment_block + confirmations )); then
  fail "the deployment is not $confirmations block(s) deep yet (head $head, deploymentBlock $deployment_block)"
fi
block=$(( head - confirmations ))
echo "promote-deployment: checking chain $chain_id at block $block (head $head, $confirmations confirmation(s))"

registry="${rec[complianceRegistry]}"
token="${rec[settlementToken]}"
[[ "$registry" != "$token" ]] || fail "the registry and the token have the same address"

# --- code: none before the deployment, the built code at B -----------------------------------------
for pair in "registry:$registry:ComplianceRegistry" "token:$token:SettlementToken"; do
  IFS=: read -r label addr name <<<"$pair"
  if (( deployment_block > 0 )); then
    before="$(c code --block "$(( deployment_block - 1 ))" "$addr")" || fail "could not read $label code"
    [[ "$before" == "0x" ]] || fail "the $label existed before deploymentBlock; the record's deploymentBlock is wrong"
  fi
  c code --block "$block" "$addr" >"$work/$label.code" || fail "could not read $label code"
  [[ "$(cat "$work/$label.code")" != "0x" ]] || fail "no contract at the $label address $addr at block $block"
  py code "$contracts_dir/out/$name.sol/$name.json" "$work/$label.code" "$registry" "$label" \
    || fail "the $label code check failed"
done

linked="$(c call --block "$block" "$token" "registry()(address)" | lower)" || fail "token registry() call failed"
[[ "$linked" == "$registry" ]] || fail "the token points at $linked, not the registry $registry"

# --- role ids: computed here, cross-checked with the contracts -------------------------------------
admin_role="$(printf '0x%064x' 0)"
role_id() { cast keccak "$1" | lower; }
check_getter() { # contract getter expected
  local got
  got="$(c call --block "$block" "$1" "$2()(bytes32)" | lower)" || fail "$2() call failed"
  [[ "$got" == "$3" ]] || fail "$2() on $1 is $got, expected $3"
}
compliance_role="$(role_id COMPLIANCE_ROLE)"
minter_role="$(role_id MINTER_ROLE)"
settler_role="$(role_id SETTLER_ROLE)"
pauser_role="$(role_id PAUSER_ROLE)"
check_getter "$registry" COMPLIANCE_ROLE "$compliance_role"
check_getter "$registry" DEFAULT_ADMIN_ROLE "$admin_role"
check_getter "$token" MINTER_ROLE "$minter_role"
check_getter "$token" SETTLER_ROLE "$settler_role"
check_getter "$token" PAUSER_ROLE "$pauser_role"
check_getter "$token" DEFAULT_ADMIN_ROLE "$admin_role"

# --- role holders rebuilt from the logs must equal the record exactly ------------------------------
granted_topic="$(cast keccak "RoleGranted(bytes32,address,address)" | lower)"
revoked_topic="$(cast keccak "RoleRevoked(bytes32,address,address)" | lower)"
filter="$(printf '[{"fromBlock":"0x%x","toBlock":"0x%x","address":["%s","%s"]}]' \
  "$deployment_block" "$head" "$registry" "$token")"
c rpc --raw eth_getLogs "$filter" >"$work/logs.json" || fail "could not read the role logs"
py roles "$work/logs.json" "$block" "$granted_topic" "$revoked_topic" "$registry" "$token" \
  "$registry:$admin_role:${rec[admin]}" \
  "$registry:$compliance_role:${rec[compliance]}" \
  "$token:$admin_role:${rec[admin]}" \
  "$token:$minter_role:${rec[minter]}" \
  "$token:$settler_role:${rec[settler]}" \
  "$token:$pauser_role:${rec[pauser]}" \
  || fail "the role holders do not match the record"

# The same answer from hasRole at B, so the log reading cannot silently drift from the state.
expect_role() { # label contract role account
  local got
  got="$(c call --block "$block" "$2" "hasRole(bytes32,address)(bool)" "$3" "$4")" || fail "hasRole call failed"
  [[ "$got" == "true" ]] || fail "$1 is not held by $4 at block $block"
}
expect_role "compliance role" "$registry" "$compliance_role" "${rec[compliance]}"
expect_role "minter role" "$token" "$minter_role" "${rec[minter]}"
expect_role "settler role" "$token" "$settler_role" "${rec[settler]}"
expect_role "pauser role" "$token" "$pauser_role" "${rec[pauser]}"
expect_role "registry admin" "$registry" "$admin_role" "${rec[admin]}"
expect_role "token admin" "$token" "$admin_role" "${rec[admin]}"

switch="$(c call --block "$block" "$token" "holderTransfersEnabled()(bool)")" \
  || fail "holderTransfersEnabled() call failed"
[[ "$switch" == "${rec[holderTransfersEnabled]}" ]] \
  || fail "holderTransfersEnabled is $switch on chain, ${rec[holderTransfersEnabled]} in the record"

# --- write the verified content atomically ---------------------------------------------------------
checksummed=()
for k in complianceRegistry settlementToken deployer admin compliance minter settler pauser; do
  v="$(cast to-check-sum-address "${rec[$k]}" 2>/dev/null)" || fail "could not checksum $k"
  checksummed+=("$k=$v")
done
tmp="$(mktemp "$deployments/.promote.$chain_id.XXXXXX")"
trap 'rm -rf "$work"; rm -f "$tmp"' EXIT
py write "$tmp" "$block" "$confirmations" "chainId=${rec[chainId]}" \
  "deploymentBlock=$deployment_block" "holderTransfersEnabled=${rec[holderTransfersEnabled]}" \
  "${checksummed[@]}" || fail "could not write the verified record"
chmod 644 "$tmp"

if [[ -e "$final" ]]; then
  # Only reachable with PROMOTE_REPLACE=1 on 31337 (checked above); rename is atomic.
  mv -f "$tmp" "$final"
  echo "promote-deployment: replaced the existing record (PROMOTE_REPLACE=1, chain 31337)"
else
  # A hard link never overwrites: if the record appeared meanwhile, this fails and nothing changes.
  ln "$tmp" "$final" 2>/dev/null || fail "deployments/$chain_id.json appeared during the checks; refusing to replace it"
  rm -f "$tmp"
fi
rm -f "$pending"
echo "promote-deployment: chain $chain_id verified at block $block; registry $registry, token $token."
echo "promote-deployment: wrote deployments/$chain_id.json and removed the pending record"
