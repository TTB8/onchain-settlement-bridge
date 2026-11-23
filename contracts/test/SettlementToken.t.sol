// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Vm} from "forge-std/Vm.sol";
import {ComplianceRegistry} from "../src/ComplianceRegistry.sol";
import {SettlementToken} from "../src/SettlementToken.sol";
import {IComplianceRegistry} from "../src/interfaces/IComplianceRegistry.sol";
import {ISettlementToken} from "../src/interfaces/ISettlementToken.sol";
import {BridgeTest} from "./BridgeTest.sol";

contract SettlementTokenTest is BridgeTest {
    event Minted(address indexed to, uint256 amount, bytes32 indexed ref);
    event Burned(address indexed from, uint256 amount, bytes32 indexed ref);
    event SettledTransfer(
        address indexed from, address indexed to, uint256 amount, bytes32 indexed ref
    );
    event Transfer(address indexed from, address indexed to, uint256 value);
    event HolderTransfersSet(bool enabled);

    uint256 internal constant ONE = 1_000_000; // one token, six decimals

    function setUp() public override {
        super.setUp();
        _verify(alice);
        _verify(bob);
    }

    /// @dev For tests of the holder-signed ERC-20 path, which is off by default.
    modifier holderTransfersOn() {
        _enableHolderTransfers();
        _;
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
        assertTrue(token.hasRole(defaultAdminRole, admin));
        assertFalse(token.hasRole(minterRole, admin));
        assertFalse(token.hasRole(settlerRole, admin));
        assertFalse(token.hasRole(pauserRole, admin));
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
        vm.expectRevert(_unauthorized(settler, minterRole));
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
        vm.expectRevert(_unauthorized(mallory, minterRole));
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
        vm.expectRevert(_unauthorized(minter, settlerRole));
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

    // --- plain ERC-20 transfers, once switched on, are compliance-checked too -------------------

    function test_holderTransferBetweenVerifiedAddressesWorks() public holderTransfersOn {
        _mint(alice, 3 * ONE);
        vm.prank(alice);
        token.transfer(bob, ONE);
        assertEq(token.balanceOf(bob), ONE);
    }

    function test_holderTransferEmitsNoReferenceEvent() public holderTransfersOn {
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

    function test_holderTransferToUnverifiedReverts() public holderTransfersOn {
        _mint(alice, ONE);
        vm.expectRevert(_notAllowed(carol));
        vm.prank(alice);
        token.transfer(carol, ONE);
    }

    function test_frozenHolderCannotSendOrReceive() public holderTransfersOn {
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

    function test_transferFromChecksBothEndsToo() public holderTransfersOn {
        _mint(alice, 2 * ONE);
        vm.prank(alice);
        token.approve(carol, 2 * ONE);
        _verify(carol); // the spender must be allowed too, as well as both holders

        vm.prank(carol);
        token.transferFrom(alice, bob, ONE);
        assertEq(token.balanceOf(bob), ONE);

        _freeze(bob);
        vm.expectRevert(_notAllowed(bob));
        vm.prank(carol);
        token.transferFrom(alice, bob, ONE);
    }

    function test_unfreezeRestoresAHoldersAbilityToSend() public holderTransfersOn {
        _mint(alice, 2 * ONE);
        _freeze(alice);
        _unfreeze(alice);

        vm.prank(alice);
        token.transfer(bob, ONE);
        assertEq(token.balanceOf(bob), ONE);
    }

    function test_removingVerificationBlocksMovementImmediately() public holderTransfersOn {
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
        vm.expectRevert(_unauthorized(minter, pauserRole));
        vm.prank(minter);
        token.pause();

        vm.prank(pauser);
        token.pause();
        vm.expectRevert(_unauthorized(admin, pauserRole));
        vm.prank(admin);
        token.unpause();
    }

    function test_pausedTokenStopsEveryMovement() public holderTransfersOn {
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

    function test_frozenStateSurvivesPause() public holderTransfersOn {
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

    // --- constructors --------------------------------------------------------------------------

    function test_tokenConstructorRejectsAZeroRegistry() public {
        vm.expectRevert(ISettlementToken.ZeroAddress.selector);
        new SettlementToken("T", "T", IComplianceRegistry(address(0)), admin);
    }

    function test_tokenConstructorRejectsAZeroAdmin() public {
        vm.expectRevert(ISettlementToken.ZeroAddress.selector);
        new SettlementToken("T", "T", registry, address(0));
    }

    function test_tokenConstructorRejectsARegistryWithoutCode() public {
        vm.expectRevert(abi.encodeWithSelector(ISettlementToken.NotAContract.selector, mallory));
        new SettlementToken("T", "T", IComplianceRegistry(mallory), admin);
    }

    function test_registryConstructorRejectsAZeroAdmin() public {
        vm.expectRevert(IComplianceRegistry.ZeroAddress.selector);
        new ComplianceRegistry(address(0));
    }

    // --- the holder-transfer switch ------------------------------------------------------------

    function test_holderTransfersAreOffAfterDeployment() public view {
        assertFalse(token.holderTransfersEnabled());
    }

    function test_adminTogglesHolderTransfersAndEachChangeEmits() public {
        vm.expectEmit(false, false, false, true, address(token));
        emit HolderTransfersSet(true);
        vm.prank(admin);
        token.setHolderTransfersEnabled(true);
        assertTrue(token.holderTransfersEnabled());

        vm.expectEmit(false, false, false, true, address(token));
        emit HolderTransfersSet(false);
        vm.prank(admin);
        token.setHolderTransfersEnabled(false);
        assertFalse(token.holderTransfersEnabled());
    }

    function test_onlyTheAdminCanToggleHolderTransfers() public {
        address[5] memory others = [minter, settler, pauser, compliance, alice];
        for (uint256 i; i < others.length; ++i) {
            vm.expectRevert(_unauthorized(others[i], defaultAdminRole));
            vm.prank(others[i]);
            token.setHolderTransfersEnabled(true);
        }
        assertFalse(token.holderTransfersEnabled());
    }

    function test_transferRevertsWhileHolderTransfersAreOff() public {
        _mint(alice, ONE);
        vm.expectRevert(ISettlementToken.HolderTransfersDisabled.selector);
        vm.prank(alice);
        token.transfer(bob, ONE);
        assertEq(token.balanceOf(alice), ONE);
    }

    function test_approveRevertsWhileHolderTransfersAreOff() public {
        vm.expectRevert(ISettlementToken.HolderTransfersDisabled.selector);
        vm.prank(alice);
        token.approve(carol, ONE);
        assertEq(token.allowance(alice, carol), 0);
    }

    function test_transferFromRevertsWhileHolderTransfersAreOff() public {
        // An allowance granted while the path was on cannot be spent once it is switched off.
        _mint(alice, ONE);
        _verify(carol);
        _enableHolderTransfers();
        vm.prank(alice);
        token.approve(carol, ONE);
        vm.prank(admin);
        token.setHolderTransfersEnabled(false);

        vm.expectRevert(ISettlementToken.HolderTransfersDisabled.selector);
        vm.prank(carol);
        token.transferFrom(alice, bob, ONE);
        assertEq(token.balanceOf(alice), ONE);
        assertEq(token.allowance(alice, carol), ONE);
    }

    function test_theSwitchIsCheckedBeforeAnythingElse() public {
        // Unverified callers, a paused token: the first error is still the switch.
        vm.prank(pauser);
        token.pause();

        vm.expectRevert(ISettlementToken.HolderTransfersDisabled.selector);
        vm.prank(mallory);
        token.transfer(bob, ONE);

        vm.expectRevert(ISettlementToken.HolderTransfersDisabled.selector);
        vm.prank(mallory);
        token.approve(carol, ONE);

        vm.expectRevert(ISettlementToken.HolderTransfersDisabled.selector);
        vm.prank(mallory);
        token.transferFrom(alice, bob, ONE);
    }

    function test_mintBurnAndSettleWorkWithHolderTransfersOff() public {
        assertFalse(token.holderTransfersEnabled());
        _mint(alice, 5 * ONE);

        vm.prank(settler);
        token.settleTransfer(alice, bob, 2 * ONE, _nextRef());

        bytes32 burnRef = _nextRef();
        vm.prank(minter);
        token.burn(bob, ONE, burnRef);

        assertEq(token.balanceOf(alice), 3 * ONE);
        assertEq(token.balanceOf(bob), ONE);
        assertEq(token.totalSupply(), 4 * ONE);
    }

    // --- holder-signed path, switched on: extra checks -----------------------------------------

    function test_anUnverifiedSpenderCannotTransferFrom() public holderTransfersOn {
        _mint(alice, ONE);
        vm.prank(alice);
        token.approve(carol, ONE); // carol is not verified

        vm.expectRevert(_notAllowed(carol));
        vm.prank(carol);
        token.transferFrom(alice, bob, ONE);
        assertEq(token.balanceOf(alice), ONE);
        assertEq(token.allowance(alice, carol), ONE, "a refused spend leaves the allowance");
    }

    function test_aFrozenSpenderCannotTransferFrom() public holderTransfersOn {
        _mint(alice, ONE);
        _verify(carol);
        vm.prank(alice);
        token.approve(carol, ONE);
        _freeze(carol);

        vm.expectRevert(_notAllowed(carol));
        vm.prank(carol);
        token.transferFrom(alice, bob, ONE);
    }

    function test_aVerifiedSpenderCanTransferFromAndSpendsTheAllowance() public holderTransfersOn {
        _mint(alice, 3 * ONE);
        _verify(carol);
        vm.prank(alice);
        token.approve(carol, 2 * ONE);

        vm.prank(carol);
        assertTrue(token.transferFrom(alice, bob, ONE));
        assertEq(token.balanceOf(alice), 2 * ONE);
        assertEq(token.balanceOf(bob), ONE);
        assertEq(token.balanceOf(carol), 0, "the spender receives nothing");
        assertEq(token.allowance(alice, carol), ONE);
    }

    function test_aFrozenOwnerCannotApprove() public holderTransfersOn {
        _freeze(alice);
        vm.expectRevert(_notAllowed(alice));
        vm.prank(alice);
        token.approve(carol, ONE);
        assertEq(token.allowance(alice, carol), 0);
    }

    function test_anUnverifiedOwnerCannotApprove() public holderTransfersOn {
        vm.expectRevert(_notAllowed(mallory));
        vm.prank(mallory);
        token.approve(carol, ONE);
    }

    function test_approveIsBlockedWhilePaused() public holderTransfersOn {
        vm.prank(pauser);
        token.pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(alice);
        token.approve(carol, ONE);

        vm.prank(pauser);
        token.unpause();
        vm.prank(alice);
        assertTrue(token.approve(carol, ONE));
        assertEq(token.allowance(alice, carol), ONE);
    }

    function test_approveChecksPauseBeforeTheOwner() public holderTransfersOn {
        vm.prank(pauser);
        token.pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(mallory);
        token.approve(carol, ONE);
    }

    function test_transferFromChecksTheSpenderBeforeTheAllowance() public holderTransfersOn {
        _mint(alice, ONE);
        vm.expectRevert(_notAllowed(mallory));
        vm.prank(mallory);
        token.transferFrom(alice, bob, ONE);
    }

    function test_transferFromStillNeedsAnAllowance() public holderTransfersOn {
        _mint(alice, ONE);
        _verify(carol);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, carol, 0, ONE)
        );
        vm.prank(carol);
        token.transferFrom(alice, bob, ONE);
    }

    // --- settleTransfer to self ----------------------------------------------------------------

    function test_settleTransferToSelfRevertsAndLeavesTheReferenceUnused() public {
        _mint(alice, 2 * ONE);
        bytes32 ref = _nextRef();
        vm.recordLogs();
        vm.expectRevert(ISettlementToken.SelfTransfer.selector);
        vm.prank(settler);
        token.settleTransfer(alice, alice, ONE, ref);

        assertEq(vm.getRecordedLogs().length, 0);
        assertFalse(token.referenceUsed(ref), "a refused self-settle does not consume the ref");
        assertEq(token.balanceOf(alice), 2 * ONE);

        // The same reference still settles a real transfer.
        vm.prank(settler);
        token.settleTransfer(alice, bob, ONE, ref);
        assertTrue(token.referenceUsed(ref));
    }

    function test_selfSettleIsCheckedAfterTheReferenceAndAmount() public {
        _mint(alice, ONE);
        vm.startPrank(settler);
        vm.expectRevert(ISettlementToken.InvalidReference.selector);
        token.settleTransfer(alice, alice, ONE, bytes32(0));

        bytes32 ref = _nextRef();
        vm.expectRevert(ISettlementToken.ZeroAmount.selector);
        token.settleTransfer(alice, alice, 0, ref);

        token.settleTransfer(alice, bob, ONE, ref);
        vm.expectRevert(abi.encodeWithSelector(ISettlementToken.ReferenceAlreadyUsed.selector, ref));
        token.settleTransfer(bob, bob, ONE, ref);
        vm.stopPrank();
    }

    // --- revoking an allowance is always possible ----------------------------------------------

    /// @dev Grants carol an allowance from alice while everything is permissive.
    function _grantCarol() internal {
        _verify(carol);
        _enableHolderTransfers();
        vm.prank(alice);
        token.approve(carol, ONE);
        assertEq(token.allowance(alice, carol), ONE);
    }

    function _revokeCarol() internal {
        vm.expectEmit(true, true, false, true, address(token));
        emit IERC20.Approval(alice, carol, 0);
        vm.prank(alice);
        assertTrue(token.approve(carol, 0));
        assertEq(token.allowance(alice, carol), 0);
    }

    function test_revokeWorksWithTheSwitchOff() public {
        _grantCarol();
        vm.prank(admin);
        token.setHolderTransfersEnabled(false);
        _revokeCarol();
    }

    function test_revokeWorksWhilePaused() public {
        _grantCarol();
        vm.prank(pauser);
        token.pause();
        _revokeCarol();
    }

    function test_revokeWorksForAFrozenOwner() public {
        _grantCarol();
        _freeze(alice);
        _revokeCarol();
    }

    function test_revokeWorksForAnUnverifiedOwner() public {
        _grantCarol();
        vm.prank(compliance);
        registry.setVerified(alice, false, _nextRef());
        _revokeCarol();
    }

    function test_revokeWorksInEveryRestrictedStateAtOnce() public {
        _grantCarol();
        _freeze(alice);
        vm.prank(pauser);
        token.pause();
        vm.prank(admin);
        token.setHolderTransfersEnabled(false);
        _revokeCarol();
    }

    function test_aZeroApprovalGrantsNothingAndStillRejectsAZeroSpender() public {
        // Revoking when nothing was granted is a harmless no-op.
        vm.prank(mallory);
        assertTrue(token.approve(carol, 0));
        assertEq(token.allowance(mallory, carol), 0);

        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InvalidSpender.selector, address(0))
        );
        vm.prank(alice);
        token.approve(address(0), 0);
    }

    function test_aNonZeroApprovalIsStillRefusedInEachRestrictedState() public {
        // The exemption is for zero only: one unit is refused with the switch off...
        vm.expectRevert(ISettlementToken.HolderTransfersDisabled.selector);
        vm.prank(alice);
        token.approve(carol, 1);
        // ...while paused...
        _enableHolderTransfers();
        vm.prank(pauser);
        token.pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(alice);
        token.approve(carol, 1);
        vm.prank(pauser);
        token.unpause();
        // ...and for a restricted owner.
        _freeze(alice);
        vm.expectRevert(_notAllowed(alice));
        vm.prank(alice);
        token.approve(carol, 1);
    }
}
