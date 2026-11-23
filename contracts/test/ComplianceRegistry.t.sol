// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IComplianceRegistry} from "../src/interfaces/IComplianceRegistry.sol";
import {BridgeTest} from "./BridgeTest.sol";

contract ComplianceRegistryTest is BridgeTest {
    event VerificationSet(address indexed account, bool verified, bytes32 indexed ref);
    event FrozenSet(address indexed account, bool frozen, bytes32 indexed ref);

    // --- roles ---------------------------------------------------------------------------------

    function test_adminHoldsAdminRoleOnly() public view {
        assertTrue(registry.hasRole(defaultAdminRole, admin));
        assertFalse(registry.hasRole(complianceRole, admin));
    }

    function test_onlyComplianceRoleCanVerify() public {
        bytes32 ref = _nextRef();
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, mallory, complianceRole
            )
        );
        vm.prank(mallory);
        registry.setVerified(alice, true, ref);
    }

    function test_onlyComplianceRoleCanFreeze() public {
        bytes32 ref = _nextRef();
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, admin, complianceRole
            )
        );
        vm.prank(admin);
        registry.setFrozen(alice, true, ref);
    }

    function test_adminCanRevokeComplianceRole() public {
        vm.prank(admin);
        registry.revokeRole(complianceRole, compliance);

        bytes32 ref = _nextRef();
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, compliance, complianceRole
            )
        );
        vm.prank(compliance);
        registry.setVerified(alice, true, ref);
    }

    function test_nonAdminCannotGrantRoles() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, mallory, defaultAdminRole
            )
        );
        vm.prank(mallory);
        registry.grantRole(complianceRole, mallory);
    }

    // --- verification --------------------------------------------------------------------------

    function test_newAddressIsNeitherVerifiedNorAllowed() public view {
        assertFalse(registry.isVerified(alice));
        assertFalse(registry.isFrozen(alice));
        assertFalse(registry.isAllowed(alice));
    }

    function test_verifyEmitsEventAndAllowsAddress() public {
        bytes32 ref = _nextRef();
        vm.expectEmit(true, true, false, true, address(registry));
        emit VerificationSet(alice, true, ref);
        vm.prank(compliance);
        registry.setVerified(alice, true, ref);

        assertTrue(registry.isVerified(alice));
        assertTrue(registry.isAllowed(alice));
    }

    function test_unverifyRemovesAllowance() public {
        _verify(alice);
        bytes32 ref = _nextRef();
        vm.expectEmit(true, true, false, true, address(registry));
        emit VerificationSet(alice, false, ref);
        vm.prank(compliance);
        registry.setVerified(alice, false, ref);

        assertFalse(registry.isVerified(alice));
        assertFalse(registry.isAllowed(alice));
    }

    function test_verifyingOneAddressDoesNotAffectOthers() public {
        _verify(alice);
        assertFalse(registry.isAllowed(bob));
    }

    // --- freezing ------------------------------------------------------------------------------

    function test_freezeEmitsEventAndBlocksVerifiedAddress() public {
        _verify(alice);
        bytes32 ref = _nextRef();
        vm.expectEmit(true, true, false, true, address(registry));
        emit FrozenSet(alice, true, ref);
        vm.prank(compliance);
        registry.setFrozen(alice, true, ref);

        assertTrue(registry.isFrozen(alice));
        assertTrue(registry.isVerified(alice), "verification is kept while frozen");
        assertFalse(registry.isAllowed(alice));
    }

    function test_unfreezeRestoresAllowance() public {
        _verify(alice);
        _freeze(alice);
        _unfreeze(alice);

        assertFalse(registry.isFrozen(alice));
        assertTrue(registry.isAllowed(alice));
    }

    function test_canFreezeAnUnverifiedAddressInAdvance() public {
        _freeze(mallory);
        assertTrue(registry.isFrozen(mallory));

        // Verifying later does not unfreeze: allowed needs both conditions.
        _verify(mallory);
        assertFalse(registry.isAllowed(mallory));
    }

    function test_allowedTruthTable() public {
        // unverified, not frozen
        assertFalse(registry.isAllowed(alice));
        // unverified, frozen
        _freeze(alice);
        assertFalse(registry.isAllowed(alice));
        // verified, frozen
        _verify(alice);
        assertFalse(registry.isAllowed(alice));
        // verified, not frozen
        _unfreeze(alice);
        assertTrue(registry.isAllowed(alice));
    }

    // --- single-use references -----------------------------------------------------------------

    function test_referenceIsMarkedUsed() public {
        bytes32 ref = _nextRef();
        assertFalse(registry.referenceUsed(ref));
        vm.prank(compliance);
        registry.setVerified(alice, true, ref);
        assertTrue(registry.referenceUsed(ref));
    }

    function test_replayedVerifyReverts() public {
        bytes32 ref = _nextRef();
        vm.startPrank(compliance);
        registry.setVerified(alice, true, ref);

        vm.expectRevert(
            abi.encodeWithSelector(IComplianceRegistry.ReferenceAlreadyUsed.selector, ref)
        );
        registry.setVerified(alice, true, ref);
        vm.stopPrank();
    }

    function test_referenceCannotBeReusedOnAnotherAccountOrAction() public {
        bytes32 ref = _nextRef();
        vm.startPrank(compliance);
        registry.setVerified(alice, true, ref);

        vm.expectRevert(
            abi.encodeWithSelector(IComplianceRegistry.ReferenceAlreadyUsed.selector, ref)
        );
        registry.setFrozen(bob, true, ref);
        vm.stopPrank();
    }

    function test_staleReplayCannotUndoALaterChange() public {
        // freeze, unfreeze, then a replay of the original freeze: it must not take effect.
        _verify(alice);
        bytes32 freezeRef = _nextRef();
        vm.prank(compliance);
        registry.setFrozen(alice, true, freezeRef);
        _unfreeze(alice);

        vm.expectRevert(
            abi.encodeWithSelector(IComplianceRegistry.ReferenceAlreadyUsed.selector, freezeRef)
        );
        vm.prank(compliance);
        registry.setFrozen(alice, true, freezeRef);
        assertTrue(registry.isAllowed(alice));
    }

    function test_zeroReferenceReverts() public {
        vm.startPrank(compliance);
        vm.expectRevert(IComplianceRegistry.InvalidReference.selector);
        registry.setVerified(alice, true, bytes32(0));
        vm.expectRevert(IComplianceRegistry.InvalidReference.selector);
        registry.setFrozen(alice, true, bytes32(0));
        vm.stopPrank();
    }

    function test_zeroAddressReverts() public {
        bytes32 ref = _nextRef();
        vm.startPrank(compliance);
        vm.expectRevert(IComplianceRegistry.ZeroAddress.selector);
        registry.setVerified(address(0), true, ref);
        vm.expectRevert(IComplianceRegistry.ZeroAddress.selector);
        registry.setFrozen(address(0), true, _nextRef());
        vm.stopPrank();
    }

    function test_failedCallDoesNotConsumeTheReference() public {
        bytes32 ref = _nextRef();
        vm.prank(compliance);
        vm.expectRevert(IComplianceRegistry.ZeroAddress.selector);
        registry.setVerified(address(0), true, ref);

        assertFalse(registry.referenceUsed(ref), "a reverted call leaves no trace");
        vm.prank(compliance);
        registry.setVerified(alice, true, ref);
    }
}
