// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IComplianceRegistry} from "../src/interfaces/IComplianceRegistry.sol";
import {BridgeTest} from "./BridgeTest.sol";

/// @notice Property tests for the registry over random accounts, flags and references.
contract ComplianceRegistryFuzzTest is BridgeTest {
    function testFuzz_allowedIsExactlyVerifiedAndNotFrozen(
        address account,
        bool verified,
        bool frozen
    ) public {
        vm.assume(account != address(0));
        vm.startPrank(compliance);
        registry.setVerified(account, verified, _nextRef());
        registry.setFrozen(account, frozen, _nextRef());
        vm.stopPrank();

        assertEq(registry.isVerified(account), verified);
        assertEq(registry.isFrozen(account), frozen);
        assertEq(registry.isAllowed(account), verified && !frozen);
    }

    function testFuzz_onlyTheComplianceRoleCanChangeAnything(
        address caller,
        address account,
        bool flag,
        bytes32 ref
    ) public {
        vm.assume(caller != compliance && account != address(0) && ref != bytes32(0));

        vm.startPrank(caller);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, caller, complianceRole
            )
        );
        registry.setVerified(account, flag, ref);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, caller, complianceRole
            )
        );
        registry.setFrozen(account, flag, ref);
        vm.stopPrank();

        assertFalse(registry.isVerified(account));
        assertFalse(registry.isFrozen(account));
        assertFalse(registry.referenceUsed(ref));
    }

    function testFuzz_aReferenceWorksExactlyOnceAcrossBothActions(
        address first,
        address second,
        bool verifiedFirst,
        bytes32 ref
    ) public {
        vm.assume(first != address(0) && second != address(0) && ref != bytes32(0));

        vm.startPrank(compliance);
        if (verifiedFirst) registry.setVerified(first, true, ref);
        else registry.setFrozen(first, true, ref);

        vm.expectRevert(
            abi.encodeWithSelector(IComplianceRegistry.ReferenceAlreadyUsed.selector, ref)
        );
        registry.setVerified(second, true, ref);
        vm.expectRevert(
            abi.encodeWithSelector(IComplianceRegistry.ReferenceAlreadyUsed.selector, ref)
        );
        registry.setFrozen(second, true, ref);
        vm.stopPrank();
    }
}
