// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ComplianceRegistry} from "../src/ComplianceRegistry.sol";
import {SettlementToken} from "../src/SettlementToken.sol";

/// @notice Shared setup for the contract tests: a deployed registry and token, one account per
/// role, and helpers that always use a fresh reference.
abstract contract BridgeTest is Test {
    ComplianceRegistry internal registry;
    SettlementToken internal token;

    address internal admin = makeAddr("admin");
    address internal compliance = makeAddr("compliance");
    address internal minter = makeAddr("minter");
    address internal settler = makeAddr("settler");
    address internal pauser = makeAddr("pauser");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal mallory = makeAddr("mallory");

    // Role identifiers are read once, so a `vm.expectRevert` is never consumed by a getter call.
    bytes32 internal complianceRole;
    bytes32 internal minterRole;
    bytes32 internal settlerRole;
    bytes32 internal pauserRole;
    bytes32 internal defaultAdminRole;

    uint256 internal refCounter;

    function setUp() public virtual {
        vm.startPrank(admin);
        registry = new ComplianceRegistry(admin);
        token = new SettlementToken("Settlement Token", "STK", registry, admin);
        complianceRole = registry.COMPLIANCE_ROLE();
        minterRole = token.MINTER_ROLE();
        settlerRole = token.SETTLER_ROLE();
        pauserRole = token.PAUSER_ROLE();
        defaultAdminRole = registry.DEFAULT_ADMIN_ROLE();
        registry.grantRole(complianceRole, compliance);
        token.grantRole(minterRole, minter);
        token.grantRole(settlerRole, settler);
        token.grantRole(pauserRole, pauser);
        vm.stopPrank();
    }

    /// @dev A reference that has never been used in this test.
    function _nextRef() internal returns (bytes32) {
        return bytes32(++refCounter);
    }

    function _verify(address account) internal {
        bytes32 ref = _nextRef();
        vm.prank(compliance);
        registry.setVerified(account, true, ref);
    }

    function _freeze(address account) internal {
        bytes32 ref = _nextRef();
        vm.prank(compliance);
        registry.setFrozen(account, true, ref);
    }

    function _unfreeze(address account) internal {
        bytes32 ref = _nextRef();
        vm.prank(compliance);
        registry.setFrozen(account, false, ref);
    }

    /// @dev Switches the holder-signed ERC-20 path on, as the admin. It is off after deployment.
    function _enableHolderTransfers() internal {
        vm.prank(admin);
        token.setHolderTransfersEnabled(true);
    }

    /// @dev Verifies `to` if needed is the caller's job; this only mints.
    function _mint(address to, uint256 amount) internal {
        bytes32 ref = _nextRef();
        vm.prank(minter);
        token.mint(to, amount, ref);
    }
}
