// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ComplianceRegistry} from "../../src/ComplianceRegistry.sol";
import {SettlementToken} from "../../src/SettlementToken.sol";

/// @notice Drives the contracts with random, often invalid, actions for the invariant tests.
/// @dev The handler never asserts inside an action. A reverted action is a rejected action, which
/// is expected (the invariant config sets `fail_on_revert = false`), so an assertion in here would
/// be swallowed. Instead, every action that SUCCEEDS is checked against the rules, and a breach is
/// counted in `violations`; an invariant then requires that counter to stay zero.
contract SettlementHandler is Test {
    ComplianceRegistry public registry;
    SettlementToken public token;
    address public minter;
    address public settler;
    address public compliance;
    address public pauser;

    address[] public actors;

    // Ghost state: what the contracts should add up to, kept independently of the contracts.
    uint256 public ghostMinted;
    uint256 public ghostBurned;
    uint256 public violations;
    uint256 public successes;
    mapping(address actor => uint256 balance) public frozenSnapshot;
    mapping(address actor => bool) public isSnapshotted;
    mapping(bytes32 ref => uint256 count) public successCount;
    bytes32[] public successfulRefs;

    uint256 private _registryRefs;

    constructor(
        ComplianceRegistry registry_,
        SettlementToken token_,
        address minter_,
        address settler_,
        address compliance_,
        address pauser_
    ) {
        registry = registry_;
        token = token_;
        minter = minter_;
        settler = settler_;
        compliance = compliance_;
        pauser = pauser_;
        for (uint256 i; i < 5; ++i) {
            address actor = makeAddr(string.concat("actor", vm.toString(i)));
            actors.push(actor);
            vm.prank(compliance);
            registry.setVerified(actor, true, bytes32(++_registryRefs));
        }
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function successfulRefCount() external view returns (uint256) {
        return successfulRefs.length;
    }

    // --- token actions -------------------------------------------------------------------------

    function mint(uint256 actorSeed, uint256 amount, uint256 refSeed) external {
        address to = _actor(actorSeed);
        amount = bound(amount, 0, 1e30);
        bytes32 ref = _ref(refSeed);
        bool ok =
            registry.isAllowed(to) && !token.paused() && !token.referenceUsed(ref) && amount > 0;

        vm.prank(minter);
        try token.mint(to, amount, ref) {
            if (!ok) ++violations;
            ghostMinted += amount;
            _recordSuccess(ref);
        } catch {}
    }

    function burn(uint256 actorSeed, uint256 amount, uint256 refSeed) external {
        address from = _actor(actorSeed);
        amount = bound(amount, 0, token.balanceOf(from) + 1e6);
        bytes32 ref = _ref(refSeed);
        bool ok = registry.isAllowed(from) && !token.paused() && !token.referenceUsed(ref)
            && amount > 0 && amount <= token.balanceOf(from);

        vm.prank(minter);
        try token.burn(from, amount, ref) {
            if (!ok) ++violations;
            ghostBurned += amount;
            _recordSuccess(ref);
        } catch {}
    }

    function settleTransfer(uint256 fromSeed, uint256 toSeed, uint256 amount, uint256 refSeed)
        external
    {
        address from = _actor(fromSeed);
        address to = _actor(toSeed);
        amount = bound(amount, 0, token.balanceOf(from) + 1e6);
        bytes32 ref = _ref(refSeed);
        bool ok = registry.isAllowed(from) && registry.isAllowed(to) && !token.paused()
            && !token.referenceUsed(ref) && amount > 0 && amount <= token.balanceOf(from);

        vm.prank(settler);
        try token.settleTransfer(from, to, amount, ref) {
            if (!ok) ++violations;
            _recordSuccess(ref);
        } catch {}
    }

    function holderTransfer(uint256 fromSeed, uint256 toSeed, uint256 amount) external {
        address from = _actor(fromSeed);
        address to = _actor(toSeed);
        amount = bound(amount, 0, token.balanceOf(from) + 1e6);
        bool ok = registry.isAllowed(from) && registry.isAllowed(to) && !token.paused()
            && amount <= token.balanceOf(from);

        vm.prank(from);
        try token.transfer(to, amount) returns (bool) {
            if (!ok) ++violations;
            ++successes;
        } catch {}
    }

    // --- compliance and pause actions ----------------------------------------------------------

    function setVerified(uint256 actorSeed, bool verified) external {
        vm.prank(compliance);
        registry.setVerified(_actor(actorSeed), verified, bytes32(++_registryRefs));
    }

    function freeze(uint256 actorSeed) external {
        address actor = _actor(actorSeed);
        if (registry.isFrozen(actor)) return;
        vm.prank(compliance);
        registry.setFrozen(actor, true, bytes32(++_registryRefs));
        frozenSnapshot[actor] = token.balanceOf(actor);
        isSnapshotted[actor] = true;
    }

    function unfreeze(uint256 actorSeed) external {
        address actor = _actor(actorSeed);
        if (!registry.isFrozen(actor)) return;
        vm.prank(compliance);
        registry.setFrozen(actor, false, bytes32(++_registryRefs));
        isSnapshotted[actor] = false;
    }

    function setPaused(bool paused) external {
        if (paused == token.paused()) return;
        vm.prank(pauser);
        if (paused) token.pause();
        else token.unpause();
    }

    // --- helpers -------------------------------------------------------------------------------

    function _actor(uint256 seed) private view returns (address) {
        return actors[seed % actors.length];
    }

    /// @dev A small pool of references, so the fuzzer keeps reusing them and tries replays often.
    function _ref(uint256 seed) private pure returns (bytes32) {
        return bytes32(uint256(1) + (seed % 24));
    }

    function _recordSuccess(bytes32 ref) private {
        ++successes;
        if (++successCount[ref] > 1) ++violations;
        successfulRefs.push(ref);
    }
}
