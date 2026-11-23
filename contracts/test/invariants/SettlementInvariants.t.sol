// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BridgeTest} from "../BridgeTest.sol";
import {SettlementHandler} from "../handlers/SettlementHandler.sol";

/// @notice Properties that must hold after ANY sequence of actions, valid or not.
/// @dev Foundry calls random sequences of the handler's functions and checks every `invariant_`
/// function after each call. The handler holds all the accounts and roles, so the fuzzer can only
/// reach the contracts through it.
contract SettlementInvariantsTest is BridgeTest {
    SettlementHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new SettlementHandler(registry, token, minter, settler, compliance, pauser);
        targetContract(address(handler));
    }

    /// @dev Every token that exists is held by exactly one of the accounts the handler uses.
    function invariant_totalSupplyEqualsSumOfBalances() public view {
        uint256 sum;
        for (uint256 i; i < handler.actorCount(); ++i) {
            sum += token.balanceOf(handler.actors(i));
        }
        assertEq(token.totalSupply(), sum);
    }

    /// @dev Supply only ever changes through a successful mint or burn.
    function invariant_totalSupplyEqualsMintedMinusBurned() public view {
        assertEq(token.totalSupply(), handler.ghostMinted() - handler.ghostBurned());
    }

    /// @dev A frozen address can never send or receive, so its balance cannot change while frozen.
    function invariant_aFrozenAddressBalanceNeverMoves() public view {
        for (uint256 i; i < handler.actorCount(); ++i) {
            address actor = handler.actors(i);
            if (registry.isFrozen(actor) && handler.isSnapshotted(actor)) {
                assertEq(token.balanceOf(actor), handler.frozenSnapshot(actor));
            }
        }
    }

    /// @dev No action succeeded that the rules say must fail: wrong party, paused, replayed
    /// reference, zero amount or insufficient balance.
    function invariant_noActionBrokeARule() public view {
        assertEq(handler.violations(), 0);
    }

    /// @dev Every reference that settled something is marked used, and none settled twice.
    function invariant_everyReferenceSettledAtMostOnce() public view {
        for (uint256 i; i < handler.successfulRefCount(); ++i) {
            bytes32 ref = handler.successfulRefs(i);
            assertTrue(token.referenceUsed(ref));
            assertEq(handler.successCount(ref), 1);
        }
    }
}
