// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BridgeTest} from "../BridgeTest.sol";
import {SettlementHandler} from "../handlers/SettlementHandler.sol";

/// @notice Properties that must hold after ANY sequence of actions, valid or not.
/// @dev Foundry calls random sequences of the handler's actions and checks every `invariant_`
/// function after each call. The handler holds all the accounts and roles, so the fuzzer can only
/// reach the contracts through it. Expectations come from the handler's own model, never from the
/// contracts under test.
contract SettlementInvariantsTest is BridgeTest {
    SettlementHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new SettlementHandler(registry, token, admin, minter, settler, compliance, pauser);
        targetContract(address(handler));

        bytes4[] memory selectors = new bytes4[](13);
        selectors[0] = SettlementHandler.mint.selector;
        selectors[1] = SettlementHandler.burn.selector;
        selectors[2] = SettlementHandler.settleTransfer.selector;
        selectors[3] = SettlementHandler.settleToSelf.selector;
        selectors[4] = SettlementHandler.holderTransfer.selector;
        selectors[5] = SettlementHandler.approve.selector;
        selectors[6] = SettlementHandler.transferFrom.selector;
        selectors[7] = SettlementHandler.setHolderTransfers.selector;
        selectors[8] = SettlementHandler.setVerified.selector;
        selectors[9] = SettlementHandler.setFrozen.selector;
        selectors[10] = SettlementHandler.setPaused.selector;
        selectors[11] = SettlementHandler.setHolderTransfers.selector; // weighted: toggled often
        selectors[12] = SettlementHandler.revoke.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
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

    /// @dev Every balance and allowance is exactly what the model says.
    function invariant_balancesAndAllowancesMatchTheModel() public view {
        uint256 n = handler.actorCount();
        for (uint256 i; i < n; ++i) {
            address a = handler.actors(i);
            assertEq(token.balanceOf(a), handler.ghostBalance(a), "balance");
            for (uint256 j; j < n; ++j) {
                address s = handler.actors(j);
                assertEq(token.allowance(a, s), handler.ghostAllowance(a, s), "allowance");
            }
        }
    }

    /// @dev An account the model says is not allowed (unverified or frozen) can neither send nor
    /// receive, so its balance stays what it was when it lost that status.
    function invariant_aRestrictedBalanceNeverMoves() public view {
        for (uint256 i; i < handler.actorCount(); ++i) {
            address actor = handler.actors(i);
            if (!handler.ghostAllowed(actor)) {
                assertEq(token.balanceOf(actor), handler.restrictedSnapshot(actor));
            }
        }
    }

    /// @dev The registry, the pause and the holder switch agree with the model.
    function invariant_complianceStateMatchesTheModel() public view {
        for (uint256 i; i < handler.actorCount(); ++i) {
            address a = handler.actors(i);
            assertEq(registry.isAllowed(a), handler.ghostAllowed(a), "isAllowed");
            assertEq(registry.isVerified(a), handler.ghostVerified(a), "isVerified");
            assertEq(registry.isFrozen(a), handler.ghostFrozen(a), "isFrozen");
        }
        assertEq(token.paused(), handler.ghostPaused(), "paused");
        assertEq(token.holderTransfersEnabled(), handler.ghostHolderTransfers(), "switch");
    }

    /// @dev No action succeeded that the model says must fail, and every success moved exactly the
    /// right amount between exactly the right accounts.
    function invariant_noActionBrokeARule() public view {
        assertEq(handler.violations(), 0);
    }

    /// @dev No action the model says must succeed was refused.
    function invariant_noValidActionWasRefused() public view {
        assertEq(handler.wrongfulReverts(), 0);
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
