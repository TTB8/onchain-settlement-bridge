// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Vm} from "forge-std/Vm.sol";
import {ISettlementToken} from "../src/interfaces/ISettlementToken.sol";
import {BridgeTest} from "./BridgeTest.sol";

contract SettlementTokenTest is BridgeTest {
    event Minted(address indexed to, uint256 amount, bytes32 indexed ref);
    event Burned(address indexed from, uint256 amount, bytes32 indexed ref);
    event SettledTransfer(
        address indexed from, address indexed to, uint256 amount, bytes32 indexed ref
    );
    event Transfer(address indexed from, address indexed to, uint256 value);

    uint256 internal constant ONE = 1_000_000; // one token, six decimals

    function setUp() public override {
        super.setUp();
        _verify(alice);
        _verify(bob);
    }

    function _notAllowed(address account) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(ISettlementToken.NotAllowed.selector, account);
    }

    function _unauthorized(address account, bytes32 role) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(
            IAccessControl.AccessControlUnauthorizedAccount.selector, account, role
        );
    }

    // --- metadata ------------------------------------------------------------------------------

    function test_metadata() public view {
        assertEq(token.name(), "Settlement Token");
        assertEq(token.symbol(), "STK");
        assertEq(token.decimals(), 6);
        assertEq(address(token.registry()), address(registry));
        assertEq(token.totalSupply(), 0);
    }

    function test_adminHoldsOnlyTheAdminRole() public view {
        assertTrue(token.hasRole(DEFAULT_ADMIN_ROLE, admin));
        assertFalse(token.hasRole(MINTER_ROLE, admin));
        assertFalse(token.hasRole(SETTLER_ROLE, admin));
        assertFalse(token.hasRole(PAUSER_ROLE, admin));
    }

    // --- mint ----------------------------------------------------------------------------------

    function test_mintCreditsAndEmitsBothEvents() public {
        bytes32 ref = _nextRef();
        vm.expectEmit(true, true, false, true, address(token));
        emit Transfer(address(0), alice, 5 * ONE);
        vm.expectEmit(true, true, false, true, address(token));
        emit Minted(alice, 5 * ONE, ref);
        vm.prank(minter);
        token.mint(alice, 5 * ONE, ref);

        assertEq(token.balanceOf(alice), 5 * ONE);
        assertEq(token.totalSupply(), 5 * ONE);
        assertTrue(token.referenceUsed(ref));
    }

    function test_mintRequiresMinterRole() public {
        bytes32 ref = _nextRef();
        vm.expectRevert(_unauthorized(settler, MINTER_ROLE));
        vm.prank(settler);
        token.mint(alice, ONE, ref);
    }

    function test_mintToUnverifiedReverts() public {
        bytes32 ref = _nextRef();
        vm.expectRevert(_notAllowed(mallory));
        vm.prank(minter);
        token.mint(mallory, ONE, ref);
    }

    function test_mintToFrozenReverts() public {
        _freeze(alice);
        bytes32 ref = _nextRef();
        vm.expectRevert(_notAllowed(alice));
        vm.prank(minter);
        token.mint(alice, ONE, ref);
    }

    function test_mintZeroAmountReverts() public {
        bytes32 ref = _nextRef();
        vm.expectRevert(ISettlementToken.ZeroAmount.selector);
        vm.prank(minter);
        token.mint(alice, 0, ref);
    }

    function test_mintZeroReferenceReverts() public {
        vm.expectRevert(ISettlementToken.InvalidReference.selector);
        vm.prank(minter);
        token.mint(alice, ONE, bytes32(0));
    }

    function test_mintingTheSameReferenceTwiceReverts() public {
        bytes32 ref = _nextRef();
        vm.startPrank(minter);
        token.mint(alice, ONE, ref);

        vm.expectRevert(abi.encodeWithSelector(ISettlementToken.ReferenceAlreadyUsed.selector, ref));
        token.mint(alice, ONE, ref);
        vm.stopPrank();

        assertEq(token.balanceOf(alice), ONE, "the duplicate minted nothing");
        assertEq(token.totalSupply(), ONE);
    }

    function test_failedMintDoesNotConsumeTheReference() public {
        bytes32 ref = _nextRef();
        vm.prank(minter);
        vm.expectRevert(_notAllowed(mallory));
        token.mint(mallory, ONE, ref);

        assertFalse(token.referenceUsed(ref));
        vm.prank(minter);
        token.mint(alice, ONE, ref); // the same operation can still be retried once it can succeed
    }

    // --- burn ----------------------------------------------------------------------------------

    function test_burnDebitsAndEmitsBothEvents() public {
        _mint(alice, 5 * ONE);
        bytes32 ref = _nextRef();
        vm.expectEmit(true, true, false, true, address(token));
        emit Transfer(alice, address(0), 2 * ONE);
        vm.expectEmit(true, true, false, true, address(token));
        emit Burned(alice, 2 * ONE, ref);
        vm.prank(minter);
        token.burn(alice, 2 * ONE, ref);

        assertEq(token.balanceOf(alice), 3 * ONE);
        assertEq(token.totalSupply(), 3 * ONE);
    }

    function test_burnRequiresMinterRole() public {
        _mint(alice, ONE);
        bytes32 ref = _nextRef();
        vm.expectRevert(_unauthorized(mallory, MINTER_ROLE));
        vm.prank(mallory);
        token.burn(alice, ONE, ref);
    }

    function test_burnBeyondBalanceReverts() public {
        _mint(alice, ONE);
        bytes32 ref = _nextRef();
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientBalance.selector, alice, ONE, ONE + 1
            )
        );
        vm.prank(minter);
        token.burn(alice, ONE + 1, ref);
    }

    function test_cannotBurnFromAFrozenHolder() public {
        _mint(alice, ONE);
        _freeze(alice);
        bytes32 ref = _nextRef();
        vm.expectRevert(_notAllowed(alice));
        vm.prank(minter);
        token.burn(alice, ONE, ref);
        assertEq(token.balanceOf(alice), ONE, "a frozen balance is untouchable");
    }

    function test_cannotBurnFromAnUnverifiedHolder() public {
        _mint(alice, ONE);
        bytes32 ref = _nextRef();
        vm.prank(compliance);
        registry.setVerified(alice, false, _nextRef());

        vm.expectRevert(_notAllowed(alice));
        vm.prank(minter);
        token.burn(alice, ONE, ref);
    }

    function test_burnZeroAmountAndReusedReferenceRevert() public {
        _mint(alice, 2 * ONE);
        bytes32 ref = _nextRef();
        vm.startPrank(minter);
        vm.expectRevert(ISettlementToken.ZeroAmount.selector);
        token.burn(alice, 0, ref);

        token.burn(alice, ONE, ref);
        vm.expectRevert(abi.encodeWithSelector(ISettlementToken.ReferenceAlreadyUsed.selector, ref));
        token.burn(alice, ONE, ref);
        vm.stopPrank();
    }

    function test_referenceIsSharedAcrossOperationTypes() public {
        _mint(alice, 2 * ONE);
        bytes32 ref = _nextRef();
        vm.prank(minter);
        token.mint(alice, ONE, ref);

        vm.expectRevert(abi.encodeWithSelector(ISettlementToken.ReferenceAlreadyUsed.selector, ref));
        vm.prank(minter);
        token.burn(alice, ONE, ref);

        vm.expectRevert(abi.encodeWithSelector(ISettlementToken.ReferenceAlreadyUsed.selector, ref));
        vm.prank(settler);
        token.settleTransfer(alice, bob, ONE, ref);
    }

    // --- settleTransfer ------------------------------------------------------------------------

    function test_settleTransferMovesTokensAndEmitsBothEvents() public {
        _mint(alice, 5 * ONE);
        bytes32 ref = _nextRef();
        vm.expectEmit(true, true, false, true, address(token));
        emit Transfer(alice, bob, 2 * ONE);
        vm.expectEmit(true, true, true, true, address(token));
        emit SettledTransfer(alice, bob, 2 * ONE, ref);
        vm.prank(settler);
        token.settleTransfer(alice, bob, 2 * ONE, ref);

        assertEq(token.balanceOf(alice), 3 * ONE);
        assertEq(token.balanceOf(bob), 2 * ONE);
        assertEq(token.totalSupply(), 5 * ONE, "a transfer never changes the supply");
    }

    function test_settleTransferNeedsNoAllowance() public {
        _mint(alice, ONE);
        assertEq(token.allowance(alice, settler), 0);
        bytes32 ref = _nextRef();
        vm.prank(settler);
        token.settleTransfer(alice, bob, ONE, ref);
        assertEq(token.balanceOf(bob), ONE);
    }

    function test_settleTransferRequiresSettlerRole() public {
        _mint(alice, ONE);
        bytes32 ref = _nextRef();
        vm.expectRevert(_unauthorized(minter, SETTLER_ROLE));
        vm.prank(minter);
        token.settleTransfer(alice, bob, ONE, ref);
    }

    function test_settleTransferFromFrozenSenderReverts() public {
        _mint(alice, ONE);
        _freeze(alice);
        bytes32 ref = _nextRef();
        vm.expectRevert(_notAllowed(alice));
        vm.prank(settler);
        token.settleTransfer(alice, bob, ONE, ref);
    }

    function test_settleTransferToFrozenReceiverReverts() public {
        _mint(alice, ONE);
        _freeze(bob);
        bytes32 ref = _nextRef();
        vm.expectRevert(_notAllowed(bob));
        vm.prank(settler);
        token.settleTransfer(alice, bob, ONE, ref);
    }

    function test_settleTransferToUnverifiedReceiverReverts() public {
        _mint(alice, ONE);
        bytes32 ref = _nextRef();
        vm.expectRevert(_notAllowed(carol));
        vm.prank(settler);
        token.settleTransfer(alice, carol, ONE, ref);
    }

    function test_settleTransferBeyondBalanceReverts() public {
        _mint(alice, ONE);
        bytes32 ref = _nextRef();
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientBalance.selector, alice, ONE, ONE + 1
            )
        );
        vm.prank(settler);
        token.settleTransfer(alice, bob, ONE + 1, ref);
    }

    function test_settleTransferZeroAmountAndReusedReferenceRevert() public {
        _mint(alice, 2 * ONE);
        bytes32 ref = _nextRef();
        vm.startPrank(settler);
        vm.expectRevert(ISettlementToken.ZeroAmount.selector);
        token.settleTransfer(alice, bob, 0, ref);

        token.settleTransfer(alice, bob, ONE, ref);
        vm.expectRevert(abi.encodeWithSelector(ISettlementToken.ReferenceAlreadyUsed.selector, ref));
        token.settleTransfer(alice, bob, ONE, ref);
        vm.stopPrank();
        assertEq(token.balanceOf(bob), ONE, "the duplicate moved nothing");
    }

    // --- plain ERC-20 transfers are compliance-checked too -------------------------------------

    function test_holderTransferBetweenVerifiedAddressesWorks() public {
        _mint(alice, 3 * ONE);
        vm.prank(alice);
        token.transfer(bob, ONE);
        assertEq(token.balanceOf(bob), ONE);
    }

    function test_holderTransferEmitsNoReferenceEvent() public {
        // This is what makes an unauthorized movement recognizable to the reconciler: only the
        // standard Transfer event is emitted, with no Minted, Burned or SettledTransfer beside it.
        _mint(alice, 3 * ONE);
        vm.recordLogs();
        vm.prank(alice);
        token.transfer(bob, ONE);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].topics[0], Transfer.selector);
    }

    function test_holderTransferToUnverifiedReverts() public {
        _mint(alice, ONE);
        vm.expectRevert(_notAllowed(carol));
        vm.prank(alice);
        token.transfer(carol, ONE);
    }

    function test_frozenHolderCannotSendOrReceive() public {
        _mint(alice, 2 * ONE);
        _mint(bob, ONE);
        _freeze(alice);

        vm.expectRevert(_notAllowed(alice));
        vm.prank(alice);
        token.transfer(bob, ONE);

        vm.expectRevert(_notAllowed(alice));
        vm.prank(bob);
        token.transfer(alice, ONE);
    }

    function test_transferFromChecksBothEndsToo() public {
        _mint(alice, 2 * ONE);
        vm.prank(alice);
        token.approve(carol, 2 * ONE);
        _verify(carol); // the spender is not a party to the transfer, only the two holders are

        vm.prank(carol);
        token.transferFrom(alice, bob, ONE);
        assertEq(token.balanceOf(bob), ONE);

        _freeze(bob);
        vm.expectRevert(_notAllowed(bob));
        vm.prank(carol);
        token.transferFrom(alice, bob, ONE);
    }

    function test_unfreezeRestoresAHoldersAbilityToSend() public {
        _mint(alice, 2 * ONE);
        _freeze(alice);
        _unfreeze(alice);

        vm.prank(alice);
        token.transfer(bob, ONE);
        assertEq(token.balanceOf(bob), ONE);
    }

    function test_removingVerificationBlocksMovementImmediately() public {
        _mint(alice, ONE);
        vm.prank(compliance);
        registry.setVerified(alice, false, _nextRef());

        vm.expectRevert(_notAllowed(alice));
        vm.prank(alice);
        token.transfer(bob, ONE);
        assertEq(token.balanceOf(alice), ONE, "the balance stays; it just cannot move");
    }

    // --- pause ---------------------------------------------------------------------------------

    function test_pauserCanPauseAndUnpause() public {
        vm.prank(pauser);
        token.pause();
        assertTrue(token.paused());

        vm.prank(pauser);
        token.unpause();
        assertFalse(token.paused());
    }

    function test_pauseRequiresPauserRole() public {
        vm.expectRevert(_unauthorized(minter, PAUSER_ROLE));
        vm.prank(minter);
        token.pause();

        vm.prank(pauser);
        token.pause();
        vm.expectRevert(_unauthorized(admin, PAUSER_ROLE));
        vm.prank(admin);
        token.unpause();
    }

    function test_pausedTokenStopsEveryMovement() public {
        _mint(alice, 3 * ONE);
        vm.prank(pauser);
        token.pause();

        bytes32 mintRef = _nextRef();
        bytes32 burnRef = _nextRef();
        bytes32 settleRef = _nextRef();

        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(minter);
        token.mint(alice, ONE, mintRef);

        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(minter);
        token.burn(alice, ONE, burnRef);

        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(settler);
        token.settleTransfer(alice, bob, ONE, settleRef);

        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(alice);
        token.transfer(bob, ONE);
    }

    function test_unpausedTokenWorksAgainAndPausedAttemptsLeftNoTrace() public {
        _mint(alice, 3 * ONE);
        vm.prank(pauser);
        token.pause();

        bytes32 ref = _nextRef();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(minter);
        token.mint(alice, ONE, ref);
        assertFalse(token.referenceUsed(ref));

        vm.prank(pauser);
        token.unpause();
        vm.prank(minter);
        token.mint(alice, ONE, ref);
        assertEq(token.balanceOf(alice), 4 * ONE);
    }

    function test_frozenStateSurvivesPause() public {
        _mint(alice, ONE);
        _freeze(alice);
        vm.prank(pauser);
        token.pause();
        vm.prank(pauser);
        token.unpause();

        vm.expectRevert(_notAllowed(alice));
        vm.prank(alice);
        token.transfer(bob, ONE);
    }
}
