#!/usr/bin/env bash
# End-to-end test of script/promote-deployment.sh against a real chain.
#
#   script/test-promote.sh
#
# Starts its own native anvil on a free port, deploys with
# `forge script script/Deploy.s.sol --broadcast --unlocked --sender <anvil account 0>`, then checks
# that promotion succeeds for the genuine record and refuses every tampered or unsafe case, each for
# the reason it should. Uses only Anvil's public dev accounts (addresses, never keys). Promotion runs
# in a temporary deployments directory (PROMOTE_DEPLOYMENTS_DIR), so it never touches
# contracts/deployments; it refuses to start if a 31337.pending.json is already there, because the
# deploy script writes one. The anvil and every temporary file are removed on exit.
if [ -z "${BASH_VERSINFO:-}" ] || [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
  echo "test-promote: bash >= 4 is required" >&2
  exit 2
fi
set -uo pipefail

contracts_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
promote="$contracts_dir/script/promote-deployment.sh"
deploy_pending="$contracts_dir/deployments/31337.pending.json"
for tool in anvil forge cast python3; do
  command -v "$tool" >/dev/null 2>&1 || { echo "test-promote: $tool not found" >&2; exit 2; }
done
if [[ -e "$deploy_pending" ]]; then
  echo "test-promote: contracts/deployments/31337.pending.json exists; move it away first" >&2
  exit 2
fi

T="$(mktemp -d)"
anvil_pid=""
created_pending=0
cleanup() {
  if [[ -n "$anvil_pid" ]]; then
    kill "$anvil_pid" 2>/dev/null
    wait "$anvil_pid" 2>/dev/null
  fi
  [[ "$created_pending" == 1 ]] && rm -f "$deploy_pending"
  rm -rf "$T"
}
trap cleanup EXIT

port="$(python3 -I -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
rpc="http://127.0.0.1:$port"
anvil --port "$port" --silent >"$T/anvil.log" 2>&1 &
anvil_pid=$!
for _ in $(seq 1 100); do
  cast chain-id --rpc-url "$rpc" >/dev/null 2>&1 && break
  sleep 0.1
done
[[ "$(cast chain-id --rpc-url "$rpc" 2>/dev/null)" == "31337" ]] || { echo "test-promote: anvil did not start" >&2; exit 1; }

mapfile -t acct < <(cast rpc eth_accounts --rpc-url "$rpc" | python3 -I -c 'import json,sys; print("\n".join(json.load(sys.stdin)))')
deployer="${acct[0]}" compliance="${acct[1]}" minter="${acct[2]}" settler="${acct[3]}"
pauser="${acct[4]}" admin="${acct[5]}" stranger="${acct[6]}" eoa="${acct[7]}"

passed=0
failed=0
ok() { echo "  PASS  $1"; passed=$((passed + 1)); }
bad() { echo "  FAIL  $1"; failed=$((failed + 1)); }
mine() { cast rpc anvil_mine "$(printf '0x%x' "$1")" --rpc-url "$rpc" >/dev/null; }
sha() { [[ -e "$1" ]] && sha256sum "$1" | cut -d' ' -f1 || echo absent; }

D="$T/deployments"
mkdir -p "$D"
P="$D/31337.pending.json"
F="$D/31337.json"
run_promote() { PROMOTE_DEPLOYMENTS_DIR="$D" "$promote" "$@" >"$T/out" 2>&1; }

# expect_refusal <name> <expected message part> <promote args...>: must exit non-zero, for the
# expected reason, and leave every file in the deployments directory exactly as it was.
expect_refusal() {
  local name="$1" want="$2"
  shift 2
  local before after
  before="$(cd "$D" && ls -A | sort | while read -r f; do echo "$f $(sha "$f")"; done)"
  if run_promote "$@"; then
    bad "$name (promotion succeeded)"
  elif ! grep -qF -- "$want" "$T/out"; then
    bad "$name (wrong reason: $(tr '\n' ' ' <"$T/out"))"
  else
    after="$(cd "$D" && ls -A | sort | while read -r f; do echo "$f $(sha "$f")"; done)"
    if [[ "$before" == "$after" ]]; then ok "$name"; else bad "$name (files changed)"; fi
  fi
}
# tampered <field> <value>: the pristine record with one field changed, as the pending file.
tampered() {
  python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); d[sys.argv[3]]=sys.argv[4]; json.dump(d,open(sys.argv[2],"w"),indent=2)' \
    "$T/pristine.json" "$P" "$1" "$2"
}

echo "test-promote: anvil on port $port; deploying"
(
  cd "$contracts_dir" &&
    ADMIN_ADDRESS="$admin" COMPLIANCE_ADDRESS="$compliance" MINTER_ADDRESS="$minter" \
      SETTLER_ADDRESS="$settler" PAUSER_ADDRESS="$pauser" TOKEN_NAME="Settlement Token" \
      TOKEN_SYMBOL="STK" ALLOW_MAINNET=false ALLOW_UNKNOWN_CHAIN=false ALLOW_EOA_ADMIN=false \
      HOLDER_TRANSFERS_ENABLED=false \
      forge script script/Deploy.s.sol --rpc-url "$rpc" --sender "$deployer" --unlocked --broadcast
) >"$T/deploy.log" 2>&1
created_pending=1
if [[ ! -f "$deploy_pending" ]]; then
  echo "test-promote: the broadcast wrote no pending record" >&2
  tail -20 "$T/deploy.log" >&2
  exit 1
fi
mv "$deploy_pending" "$T/pristine.json"
created_pending=0
cp "$T/pristine.json" "$P"
token="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["settlementToken"])' "$T/pristine.json")"

echo "test-promote: running cases"

# Inputs.
expect_refusal "chain id must be digits" "chain id must be digits only" "31a37" "$rpc"
expect_refusal "rpc url must not be empty" "rpc url must not be empty" 31337 ""
expect_refusal "confirmations must be digits >= 1" "confirmations must be digits only" 31337 "$rpc" 0

# Too early: the last deployment transaction is the chain head, so block head-1 misses it.
expect_refusal "promotion before the confirmation depth (role change after B)" \
  "a role changed after the confirmed block" 31337 "$rpc"
expect_refusal "promotion before the confirmation depth (head too low)" \
  "is not 1000 block(s) deep yet" 31337 "$rpc" 1000
mine 2

# Tampered records.
tampered minter "$stranger"
expect_refusal "pending file with a swapped minter" "differ from the record" 31337 "$rpc"
tampered admin "$eoa"
expect_refusal "record pointing the admin role at an EOA that does not hold it" \
  "differ from the record" 31337 "$rpc"
python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); d["deploymentBlock"]=5; json.dump(d,open(sys.argv[2],"w"))' \
  "$T/pristine.json" "$P"
expect_refusal "record with a deploymentBlock after the contracts existed" \
  "existed before deploymentBlock" 31337 "$rpc"
cp "$T/pristine.json" "$P"

# An extra MINTER_ROLE grantee on chain.
minter_role="$(cast keccak MINTER_ROLE)"
cast send --unlocked --from "$admin" "$token" "grantRole(bytes32,address)" "$minter_role" "$stranger" \
  --rpc-url "$rpc" >/dev/null
mine 2
expect_refusal "an extra MINTER_ROLE grant on chain" "extra: $(echo "$stranger" | tr '[:upper:]' '[:lower:]')" 31337 "$rpc"
cast send --unlocked --from "$admin" "$token" "revokeRole(bytes32,address)" "$minter_role" "$stranger" \
  --rpc-url "$rpc" >/dev/null
mine 2

# Tampered runtime code at the token address (one byte flipped, same length).
original_code="$(cast code "$token" --rpc-url "$rpc")"
flipped="$(python3 -I -c 'import sys; c=bytearray(bytes.fromhex(sys.argv[1][2:])); c[100]^=1; print("0x"+c.hex())' "$original_code")"
cast rpc anvil_setCode "$token" "$flipped" --rpc-url "$rpc" >/dev/null
mine 2
expect_refusal "a tampered runtime code hash" "token runtime code differs from the build artifact" 31337 "$rpc"
cast rpc anvil_setCode "$token" "$original_code" --rpc-url "$rpc" >/dev/null
mine 2

# The genuine record.
if run_promote 31337 "$rpc"; then
  if [[ ! -e "$P" ]] && python3 -I - "$F" "$T/pristine.json" <<'PY'; then
import json, sys
got, want = json.load(open(sys.argv[1])), json.load(open(sys.argv[2]))
for k, v in want.items():
    g = got.get(k)
    assert (g.lower() if isinstance(g, str) else g) == (v.lower() if isinstance(v, str) else v), k
assert isinstance(got.get("verifiedAtBlock"), int) and got["confirmations"] == 1
PY
    ok "genuine promotion writes the verified record and removes the pending one"
  else
    bad "genuine promotion (record content or pending file wrong)"
  fi
else
  bad "genuine promotion ($(tr '\n' ' ' <"$T/out"))"
fi

# An existing record is never replaced...
cp "$T/pristine.json" "$P"
expect_refusal "an existing record is refused" "already exists; refusing to replace a live record" 31337 "$rpc"
# ...unless PROMOTE_REPLACE=1 on chain 31337...
final_before="$(sha "$F")"
if PROMOTE_REPLACE=1 run_promote 31337 "$rpc" && grep -qF "replaced the existing record" "$T/out" \
  && [[ ! -e "$P" ]] && [[ -e "$F" ]]; then
  ok "PROMOTE_REPLACE=1 replaces the record on chain 31337"
else
  bad "PROMOTE_REPLACE=1 on 31337 ($(tr '\n' ' ' <"$T/out")) before=$final_before"
fi
# ...and never on another chain.
cp "$F" "$D/84532.json"
cp "$T/pristine.json" "$D/84532.pending.json"
PROMOTE_REPLACE=1 expect_refusal "PROMOTE_REPLACE=1 is ignored off chain 31337" \
  "only honoured on the local chain 31337" 84532 "$rpc"
rm -f "$D/84532.json" "$D/84532.pending.json"

echo "test-promote: $passed passed, $failed failed"
[[ "$failed" -eq 0 ]]
