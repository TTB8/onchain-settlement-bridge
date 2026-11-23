// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ISettlementToken} from "../src/interfaces/ISettlementToken.sol";
import {BridgeTest} from "./BridgeTest.sol";

/// @notice Property tests over random inputs. The unit tests pin specific cases; these check that
/// the same rules hold for every amount, caller and reference the fuzzer can find.
contract SettlementTokenFuzzTest is BridgeTest {
    // Large enough to be realistic, small enough that sums of a few of them cannot overflow.
    uint256 internal constant MAX_AMOUNT = type(uint128).max;

    function setUp() public override {
        super.setUp();
        _verify(alice);
        _verify(bob);
    }

    /// @dev Maps any fuzzed value to a reference far above the counter the `_nextRef` helper uses,
    /// so a fuzzed reference can never collide with one a helper consumed in the same test. (The
    /// fuzzer found exactly that collision the first time round: the contract was right to reject it.)
    function _fuzzRef(bytes32 raw) internal pure returns (bytes32) {
        return bytes32(bound(uint256(raw), 1 << 128, type(uint256).max));
    }

    function testFuzz_mintThenBurnReturnsToZero(uint256 amount, bytes32 mintRef, bytes32 burnRef)
        public
    {
        amount = bound(amount, 1, MAX_AMOUNT);
        mintRef = _fuzzRef(mintRef);
        burnRef = _fuzzRef(burnRef);
        vm.assume(mintRef != burnRef);

        vm.startPrank(minter);
        token.mint(alice, amount, mintRef);
        assertEq(token.balanceOf(alice), amount);
        token.burn(alice, amount, burnRef);
        vm.stopPrank();

        assertEq(token.balanceOf(alice), 0);
        assertEq(token.totalSupply(), 0);
    }

    function testFuzz_settleTransferConservesSupply(uint256 minted, uint256 moved, bytes32 ref)
        public
    {
        minted = bound(minted, 1, MAX_AMOUNT);
        moved = bound(moved, 1, minted);
        ref = _fuzzRef(ref);
        _mint(alice, minted);

        vm.prank(settler);
        token.settleTransfer(alice, bob, moved, ref);

        assertEq(token.balanceOf(alice), minted - moved);
        assertEq(token.balanceOf(bob), moved);
        assertEq(token.totalSupply(), minted);
    }

    function testFuzz_cannotMoveMoreThanTheBalance(uint256 minted, uint256 extra) public {
        minted = bound(minted, 1, MAX_AMOUNT);
        extra = bound(extra, 1, MAX_AMOUNT);
        _mint(alice, minted);
        bytes32 ref = _nextRef();

        vm.expectRevert();
        vm.prank(settler);
        token.settleTransfer(alice, bob, minted + extra, ref);

        assertEq(token.balanceOf(alice), minted, "a failed transfer changes nothing");
        assertFalse(token.referenceUsed(ref), "and does not burn the reference");
    }

    function testFuzz_aReferenceWorksExactlyOnce(uint256 first, uint256 second, bytes32 ref)
        public
    {
        first = bound(first, 1, MAX_AMOUNT);
        second = bound(second, 1, MAX_AMOUNT);
        ref = _fuzzRef(ref);

        vm.startPrank(minter);
        token.mint(alice, first, ref);

        vm.expectRevert(abi.encodeWithSelector(ISettlementToken.ReferenceAlreadyUsed.selector, ref));
        token.mint(bob, second, ref);
        vm.stopPrank();

        assertEq(token.totalSupply(), first, "the replay minted nothing");
        assertEq(token.balanceOf(bob), 0);
    }

    function testFuzz_onlyTheMinterRoleCanMint(address caller, uint256 amount, bytes32 ref) public {
        amount = bound(amount, 1, MAX_AMOUNT);
        ref = _fuzzRef(ref);
        vm.assume(caller != minter);

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, caller, minterRole
            )
        );
        vm.prank(caller);
        token.mint(alice, amount, ref);
        assertEq(token.totalSupply(), 0);
    }

    function testFuzz_onlyTheSettlerRoleCanSettle(address caller, uint256 amount, bytes32 ref)
        public
    {
        amount = bound(amount, 1, MAX_AMOUNT);
        ref = _fuzzRef(ref);
        vm.assume(caller != settler);
        _mint(alice, MAX_AMOUNT);

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, caller, settlerRole
            )
        );
        vm.prank(caller);
        token.settleTransfer(alice, bob, amount, ref);
    }

    function testFuzz_mintToAnyUnverifiedAddressReverts(
        address stranger,
        uint256 amount,
        bytes32 ref
    ) public {
        amount = bound(amount, 1, MAX_AMOUNT);
        ref = _fuzzRef(ref);
        vm.assume(stranger != address(0) && !registry.isAllowed(stranger));

        vm.expectRevert(abi.encodeWithSelector(ISettlementToken.NotAllowed.selector, stranger));
        vm.prank(minter);
        token.mint(stranger, amount, ref);
    }

    function testFuzz_aFrozenBalanceCannotBeMovedByAnyone(
        address caller,
        uint256 amount,
        address to
    ) public {
        amount = bound(amount, 1, MAX_AMOUNT);
        // The zero address can be neither a spender (ERC-20 rejects the approval) nor a recipient.
        vm.assume(caller != address(0) && to != address(0));
        _enableHolderTransfers();
        _mint(alice, MAX_AMOUNT);
        // An allowed spender, approved before the freeze, so only the freeze can stop it.
        vm.prank(alice);
        token.approve(caller, amount);
        _verify(caller);
        _freeze(alice);
        bytes32 ref = _nextRef();

        // The platform cannot move it...
        vm.expectRevert(abi.encodeWithSelector(ISettlementToken.NotAllowed.selector, alice));
        vm.prank(settler);
        token.settleTransfer(alice, bob, amount, ref);

        // ...nor burn it...
        vm.expectRevert(abi.encodeWithSelector(ISettlementToken.NotAllowed.selector, alice));
        vm.prank(minter);
        token.burn(alice, amount, ref);

        // ...nor can any spender, even one approved before the freeze.
        vm.expectRevert(abi.encodeWithSelector(ISettlementToken.NotAllowed.selector, alice));
        vm.prank(caller);
        token.transferFrom(alice, to, amount);

        assertEq(token.balanceOf(alice), MAX_AMOUNT);
    }

    function testFuzz_holderTransferNeverExceedsOrCreatesSupply(uint256 minted, uint256 sent)
        public
    {
        minted = bound(minted, 1, MAX_AMOUNT);
        sent = bound(sent, 0, minted);
        _enableHolderTransfers();
        _mint(alice, minted);

        vm.prank(alice);
        token.transfer(bob, sent);

        assertEq(token.balanceOf(alice) + token.balanceOf(bob), minted);
        assertEq(token.totalSupply(), minted);
    }

    // --- the holder-transfer switch ------------------------------------------------------------

    function testFuzz_theHolderPathIsClosedByDefaultForEveryone(
        address caller,
        address from,
        address to,
        uint256 amount
    ) public {
        amount = bound(amount, 0, MAX_AMOUNT);
        _mint(alice, MAX_AMOUNT);

        vm.startPrank(caller);
        vm.expectRevert(ISettlementToken.HolderTransfersDisabled.selector);
        token.transfer(to, amount);
        vm.expectRevert(ISettlementToken.HolderTransfersDisabled.selector);
        token.approve(to, amount);
        vm.expectRevert(ISettlementToken.HolderTransfersDisabled.selector);
        token.transferFrom(from, to, amount);
        vm.stopPrank();

        assertEq(token.balanceOf(alice), MAX_AMOUNT);
        assertEq(token.allowance(caller, to), 0);
    }

    function testFuzz_theSwitchNeverAffectsThePlatformPaths(
        bool enabled,
        uint256 minted,
        uint256 moved,
        uint256 burned
    ) public {
        minted = bound(minted, 2, MAX_AMOUNT);
        moved = bound(moved, 1, minted - 1);
        burned = bound(burned, 1, minted - moved);
        vm.prank(admin);
        token.setHolderTransfersEnabled(enabled);

        _mint(alice, minted);
        bytes32 settleRef = _nextRef();
        vm.prank(settler);
        token.settleTransfer(alice, bob, moved, settleRef);
        bytes32 burnRef = _nextRef();
        vm.prank(minter);
        token.burn(alice, burned, burnRef);

        assertEq(token.balanceOf(alice), minted - moved - burned);
        assertEq(token.balanceOf(bob), moved);
        assertEq(token.totalSupply(), minted - burned);
        assertEq(token.holderTransfersEnabled(), enabled);
    }

    function testFuzz_transferFromSucceedsOnlyForAnAllowedSpender(
        address spender,
        bool verified,
        bool frozen,
        uint256 amount
    ) public {
        amount = bound(amount, 1, MAX_AMOUNT);
        vm.assume(spender != address(0) && spender != alice && spender != bob);
        _enableHolderTransfers();
        _mint(alice, MAX_AMOUNT);
        vm.prank(alice);
        token.approve(spender, amount);
        vm.startPrank(compliance);
        registry.setVerified(spender, verified, _nextRef());
        registry.setFrozen(spender, frozen, _nextRef());
        vm.stopPrank();

        bool allowed = verified && !frozen;
        if (!allowed) {
            vm.expectRevert(abi.encodeWithSelector(ISettlementToken.NotAllowed.selector, spender));
        }
        vm.prank(spender);
        token.transferFrom(alice, bob, amount);

        assertEq(token.balanceOf(bob), allowed ? amount : 0);
        assertEq(token.balanceOf(alice), MAX_AMOUNT - (allowed ? amount : 0));
        assertEq(token.allowance(alice, spender), allowed ? 0 : amount);
    }

    function testFuzz_approveSucceedsOnlyForAnAllowedOwnerWhileUnpaused(
        address owner,
        address spender,
        bool verified,
        bool frozen,
        bool paused,
        uint256 amount
    ) public {
        vm.assume(owner != address(0) && spender != address(0));
        _enableHolderTransfers();
        vm.startPrank(compliance);
        registry.setVerified(owner, verified, _nextRef());
        registry.setFrozen(owner, frozen, _nextRef());
        vm.stopPrank();
        if (paused) {
            vm.prank(pauser);
            token.pause();
        }

        bool ok = !paused && verified && !frozen;
        if (paused) {
            vm.expectRevert(Pausable.EnforcedPause.selector);
        } else if (!ok) {
            vm.expectRevert(abi.encodeWithSelector(ISettlementToken.NotAllowed.selector, owner));
        }
        vm.prank(owner);
        token.approve(spender, amount);

        assertEq(token.allowance(owner, spender), ok ? amount : 0);
    }

    function testFuzz_settlingToSelfAlwaysRevertsAndKeepsTheReference(
        address account,
        uint256 amount,
        bytes32 ref
    ) public {
        amount = bound(amount, 1, MAX_AMOUNT);
        ref = _fuzzRef(ref);
        _mint(alice, MAX_AMOUNT);

        vm.expectRevert(ISettlementToken.SelfTransfer.selector);
        vm.prank(settler);
        token.settleTransfer(account, account, amount, ref);

        assertFalse(token.referenceUsed(ref));
        assertEq(token.balanceOf(alice), MAX_AMOUNT);
    }
}
