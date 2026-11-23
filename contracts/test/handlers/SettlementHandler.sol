// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ComplianceRegistry} from "../../src/ComplianceRegistry.sol";
import {SettlementToken} from "../../src/SettlementToken.sol";

/// @notice Drives the contracts with random, often invalid, actions for the invariant tests.
/// @dev The handler keeps its OWN model of the system (who is verified or frozen, whether the token
/// is paused, whether holder transfers are on, every balance and allowance, every used reference).
/// The model is only ever changed when a call to the contracts SUCCEEDS, and the contracts are never
/// read to decide what an action should do: expectations come from the model alone. That way a bug
/// in the code under test (for example a registry that ignores verification) cannot also bend the
/// expectation it is checked against.
///
/// The handler never asserts inside an action: a reverted action is expected (`fail_on_revert =
/// false`), so an assertion here would be swallowed. Instead it counts, and invariants require the
/// counters to stay zero:
/// - `violations`: an action succeeded that the model says must fail, or a successful action moved
///   the wrong amount, to the wrong account, or changed the supply wrongly;
/// - `wrongfulReverts`: an action reverted that the model says must succeed.
contract SettlementHandler is Test {
    ComplianceRegistry public registry;
    SettlementToken public token;
    address public admin;
    address public minter;
    address public settler;
    address public compliance;
    address public pauser;

    /// @dev The first `VERIFIED_AT_START` actors start verified; the rest start as strangers.
    address[] public actors;
    uint256 internal constant VERIFIED_AT_START = 5;
    uint256 internal constant STRANGERS = 3;

    // --- the model -----------------------------------------------------------------------------
    mapping(address => bool) public ghostVerified;
    mapping(address => bool) public ghostFrozen;
    bool public ghostPaused;
    bool public ghostHolderTransfers;
    mapping(address => uint256) public ghostBalance;
    mapping(address owner => mapping(address spender => uint256)) public ghostAllowance;
    mapping(bytes32 => bool) public ghostTokenRefUsed;
    mapping(bytes32 => bool) public ghostRegistryRefUsed;
    bytes32[] internal _usedRegistryRefs;
    uint256 public ghostMinted;
    uint256 public ghostBurned;

    /// @dev Balance of each account at the moment the model last saw it become not allowed
    /// (unverified OR frozen). While it stays not allowed, its balance must not move.
    mapping(address => uint256) public restrictedSnapshot;

    // --- counters ------------------------------------------------------------------------------
    uint256 public violations;
    uint256 public wrongfulReverts;
    uint256 public successes;
    mapping(bytes32 ref => uint256 count) public successCount;
    bytes32[] public successfulRefs;

    uint256 private _registryRefs = 1 << 128; // far from the token's small reference pool

    constructor(
        ComplianceRegistry registry_,
        SettlementToken token_,
        address admin_,
        address minter_,
        address settler_,
        address compliance_,
        address pauser_
    ) {
        registry = registry_;
        token = token_;
        admin = admin_;
        minter = minter_;
        settler = settler_;
        compliance = compliance_;
        pauser = pauser_;
        for (uint256 i; i < VERIFIED_AT_START + STRANGERS; ++i) {
            address actor = makeAddr(string.concat("actor", vm.toString(i)));
            actors.push(actor);
            if (i < VERIFIED_AT_START) {
                bytes32 ref = bytes32(++_registryRefs);
                vm.prank(compliance);
                registry.setVerified(actor, true, ref);
                ghostVerified[actor] = true;
                _markRegistryRef(ref);
            }
        }
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function successfulRefCount() external view returns (uint256) {
        return successfulRefs.length;
    }

    /// @notice Whether the MODEL says the account may hold and move the token.
    function ghostAllowed(address account) public view returns (bool) {
        return ghostVerified[account] && !ghostFrozen[account];
    }

    // --- platform actions ----------------------------------------------------------------------

    function mint(uint256 actorSeed, uint256 amount, uint256 refSeed) external {
        address to = _actor(actorSeed);
        amount = bound(amount, 0, 1e30);
        bytes32 ref = _ref(refSeed);
        bool expected = ghostAllowed(to) && !ghostPaused && !ghostTokenRefUsed[ref] && amount > 0;
        uint256 supplyBefore = token.totalSupply();
        uint256 toBefore = token.balanceOf(to);

        vm.prank(minter);
        try token.mint(to, amount, ref) {
            if (!expected) ++violations;
            if (token.balanceOf(to) != toBefore + amount) ++violations;
            if (token.totalSupply() != supplyBefore + amount) ++violations;
            ghostBalance[to] += amount;
            ghostMinted += amount;
            _recordSuccess(ref);
        } catch {
            if (expected) ++wrongfulReverts;
        }
        _checkTokenRef(ref);
    }

    function burn(uint256 actorSeed, uint256 amount, uint256 refSeed) external {
        address from = _actor(actorSeed);
        amount = bound(amount, 0, ghostBalance[from] + 1e6);
        bytes32 ref = _ref(refSeed);
        bool expected = ghostAllowed(from) && !ghostPaused && !ghostTokenRefUsed[ref] && amount > 0
            && amount <= ghostBalance[from];
        uint256 supplyBefore = token.totalSupply();
        uint256 fromBefore = token.balanceOf(from);

        vm.prank(minter);
        try token.burn(from, amount, ref) {
            if (!expected) ++violations;
            if (token.balanceOf(from) + amount != fromBefore) ++violations;
            if (token.totalSupply() + amount != supplyBefore) ++violations;
            ghostBalance[from] -= amount;
            ghostBurned += amount;
            _recordSuccess(ref);
        } catch {
            if (expected) ++wrongfulReverts;
        }
        _checkTokenRef(ref);
    }

    function settleTransfer(uint256 fromSeed, uint256 toSeed, uint256 amount, uint256 refSeed)
        external
    {
        _settle(_actor(fromSeed), _actor(toSeed), amount, refSeed);
    }

    /// @dev Kept as its own action so the fuzzer tries self-settlement often; it must always fail.
    function settleToSelf(uint256 actorSeed, uint256 amount, uint256 refSeed) external {
        address account = _actor(actorSeed);
        _settle(account, account, amount, refSeed);
    }

    function _settle(address from, address to, uint256 amount, uint256 refSeed) private {
        amount = bound(amount, 0, ghostBalance[from] + 1e6);
        bytes32 ref = _ref(refSeed);
        bool expected = from != to && ghostAllowed(from) && ghostAllowed(to) && !ghostPaused
            && !ghostTokenRefUsed[ref] && amount > 0 && amount <= ghostBalance[from];
        uint256 fromBefore = token.balanceOf(from);
        uint256 toBefore = token.balanceOf(to);
        uint256 supplyBefore = token.totalSupply();

        vm.prank(settler);
        try token.settleTransfer(from, to, amount, ref) {
            if (!expected) ++violations;
            _checkMove(from, to, amount, fromBefore, toBefore, supplyBefore);
            _recordSuccess(ref);
        } catch {
            if (expected) ++wrongfulReverts;
        }
        _checkTokenRef(ref);
    }

    // --- holder-signed actions -----------------------------------------------------------------

    function holderTransfer(uint256 fromSeed, uint256 toSeed, uint256 amount) external {
        address from = _actor(fromSeed);
        address to = _actor(toSeed);
        amount = bound(amount, 0, ghostBalance[from] + 1e6);
        bool expected = ghostHolderTransfers && !ghostPaused && ghostAllowed(from)
            && ghostAllowed(to) && amount <= ghostBalance[from];
        uint256 fromBefore = token.balanceOf(from);
        uint256 toBefore = token.balanceOf(to);
        uint256 supplyBefore = token.totalSupply();

        vm.prank(from);
        try token.transfer(to, amount) returns (bool ok) {
            if (!expected || !ok) ++violations;
            _checkMove(from, to, amount, fromBefore, toBefore, supplyBefore);
            ++successes;
        } catch {
            if (expected) ++wrongfulReverts;
        }
    }

    function approve(uint256 ownerSeed, uint256 spenderSeed, uint256 amount) external {
        address owner = _actor(ownerSeed);
        address spender = _actor(spenderSeed);
        // Sometimes an infinite approval, which transferFrom must not decrease.
        amount = amount % 8 == 0 ? type(uint256).max : bound(amount, 0, 1e30);
        bool expected = ghostHolderTransfers && !ghostPaused && ghostAllowed(owner);

        vm.prank(owner);
        try token.approve(spender, amount) returns (bool ok) {
            if (!expected || !ok) ++violations;
            if (token.allowance(owner, spender) != amount) ++violations;
            ghostAllowance[owner][spender] = amount;
            ++successes;
        } catch {
            if (expected) ++wrongfulReverts;
        }
    }

    function transferFrom(uint256 spenderSeed, uint256 fromSeed, uint256 toSeed, uint256 amount)
        external
    {
        address spender = _actor(spenderSeed);
        address from = _actor(fromSeed);
        address to = _actor(toSeed);
        uint256 allowance = ghostAllowance[from][spender];
        uint256 cap = allowance < ghostBalance[from] ? allowance : ghostBalance[from];
        amount = bound(amount, 0, cap + 1e6);
        bool expected = ghostHolderTransfers && ghostAllowed(spender) && amount <= allowance
            && !ghostPaused && ghostAllowed(from) && ghostAllowed(to)
            && amount <= ghostBalance[from];
        uint256 fromBefore = token.balanceOf(from);
        uint256 toBefore = token.balanceOf(to);
        uint256 supplyBefore = token.totalSupply();

        vm.prank(spender);
        try token.transferFrom(from, to, amount) returns (bool ok) {
            if (!expected || !ok) ++violations;
            _checkMove(from, to, amount, fromBefore, toBefore, supplyBefore);
            if (allowance != type(uint256).max) ghostAllowance[from][spender] = allowance - amount;
            if (token.allowance(from, spender) != ghostAllowance[from][spender]) ++violations;
            ++successes;
        } catch {
            if (expected) ++wrongfulReverts;
        }
    }

    // --- admin, compliance and pause actions ---------------------------------------------------

    function setHolderTransfers(bool enabled) external {
        vm.prank(admin);
        try token.setHolderTransfersEnabled(enabled) {
            ghostHolderTransfers = enabled;
        } catch {
            ++wrongfulReverts;
        }
    }

    /// @dev `replaySeed` picks a fresh reference most of the time, and replays a used one otherwise.
    function setVerified(uint256 actorSeed, bool verified, uint256 replaySeed) external {
        address actor = _actor(actorSeed);
        bytes32 ref = _registryRef(replaySeed);
        bool expected = !ghostRegistryRefUsed[ref];
        bool wasAllowed = ghostAllowed(actor);

        vm.prank(compliance);
        try registry.setVerified(actor, verified, ref) {
            if (!expected) ++violations;
            ghostVerified[actor] = verified;
            _markRegistryRef(ref);
        } catch {
            if (expected) ++wrongfulReverts;
        }
        _afterRegistryChange(actor, wasAllowed, ref);
    }

    function setFrozen(uint256 actorSeed, bool frozen, uint256 replaySeed) external {
        address actor = _actor(actorSeed);
        bytes32 ref = _registryRef(replaySeed);
        bool expected = !ghostRegistryRefUsed[ref];
        bool wasAllowed = ghostAllowed(actor);

        vm.prank(compliance);
        try registry.setFrozen(actor, frozen, ref) {
            if (!expected) ++violations;
            ghostFrozen[actor] = frozen;
            _markRegistryRef(ref);
        } catch {
            if (expected) ++wrongfulReverts;
        }
        _afterRegistryChange(actor, wasAllowed, ref);
    }

    function setPaused(bool paused) external {
        vm.prank(pauser);
        if (paused == ghostPaused) {
            // Pausing twice (or unpausing an unpaused token) must fail.
            if (paused) {
                try token.pause() {
                    ++violations;
                } catch {}
            } else {
                try token.unpause() {
                    ++violations;
                } catch {}
            }
            return;
        }
        if (paused) {
            try token.pause() {
                ghostPaused = true;
            } catch {
                ++wrongfulReverts;
            }
        } else {
            try token.unpause() {
                ghostPaused = false;
            } catch {
                ++wrongfulReverts;
            }
        }
    }

    // --- helpers -------------------------------------------------------------------------------

    function _actor(uint256 seed) private view returns (address) {
        return actors[seed % actors.length];
    }

    /// @dev A small pool of references, so the fuzzer keeps reusing them and tries replays often.
    function _ref(uint256 seed) private pure returns (bytes32) {
        return bytes32(uint256(1) + (seed % 24));
    }

    function _registryRef(uint256 seed) private returns (bytes32) {
        if (_usedRegistryRefs.length > 0 && seed % 4 == 0) {
            return _usedRegistryRefs[(seed / 4) % _usedRegistryRefs.length];
        }
        return bytes32(++_registryRefs);
    }

    function _markRegistryRef(bytes32 ref) private {
        ghostRegistryRefUsed[ref] = true;
        _usedRegistryRefs.push(ref);
    }

    /// @dev Takes a balance snapshot when the model sees an account become not allowed, and checks
    /// the registry recorded exactly the references the model did.
    function _afterRegistryChange(address actor, bool wasAllowed, bytes32 ref) private {
        if (wasAllowed && !ghostAllowed(actor)) restrictedSnapshot[actor] = ghostBalance[actor];
        if (registry.referenceUsed(ref) != ghostRegistryRefUsed[ref]) ++violations;
    }

    /// @dev Checks a successful movement shifted exactly `amount` from `from` to `to` (nothing for
    /// a self-transfer) and left the supply alone, against balances read just before the call; then
    /// applies it to the model.
    function _checkMove(
        address from,
        address to,
        uint256 amount,
        uint256 fromBefore,
        uint256 toBefore,
        uint256 supplyBefore
    ) private {
        if (from == to) {
            if (token.balanceOf(from) != fromBefore) ++violations;
        } else {
            if (token.balanceOf(from) + amount != fromBefore) ++violations;
            if (token.balanceOf(to) != toBefore + amount) ++violations;
        }
        if (token.totalSupply() != supplyBefore) ++violations;
        ghostBalance[from] -= amount;
        ghostBalance[to] += amount;
    }

    function _checkTokenRef(bytes32 ref) private {
        if (token.referenceUsed(ref) != ghostTokenRefUsed[ref]) ++violations;
    }

    function _recordSuccess(bytes32 ref) private {
        ++successes;
        ghostTokenRefUsed[ref] = true;
        if (++successCount[ref] > 1) ++violations;
        successfulRefs.push(ref);
    }
}
