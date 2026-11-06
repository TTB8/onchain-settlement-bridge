// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IComplianceRegistry} from "./interfaces/IComplianceRegistry.sol";

/// @title ComplianceRegistry
/// @notice Allowlist of verified addresses with a freeze switch, managed by a compliance role.
/// @dev Roles use OpenZeppelin `AccessControl`. The admin grants `COMPLIANCE_ROLE` to the
/// account (or service) that mirrors the off-chain verification state. Compliance lives in the
/// contract, not only in the API, so an address that is frozen cannot move tokens even if the
/// off-chain system is bypassed.
contract ComplianceRegistry is IComplianceRegistry, AccessControl {
    /// @notice Role allowed to verify, unverify, freeze and unfreeze addresses.
    bytes32 public constant COMPLIANCE_ROLE = keccak256("COMPLIANCE_ROLE");

    mapping(address account => bool) private _verified;
    mapping(address account => bool) private _frozen;

    /// @inheritdoc IComplianceRegistry
    mapping(bytes32 ref => bool) public referenceUsed;

    /// @param admin Receives `DEFAULT_ADMIN_ROLE`, which grants and revokes every other role.
    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @inheritdoc IComplianceRegistry
    function setVerified(address account, bool verified, bytes32 ref)
        external
        onlyRole(COMPLIANCE_ROLE)
    {
        _consume(ref);
        if (account == address(0)) revert ZeroAddress();
        _verified[account] = verified;
        emit VerificationSet(account, verified, ref);
    }

    /// @inheritdoc IComplianceRegistry
    function setFrozen(address account, bool frozen, bytes32 ref)
        external
        onlyRole(COMPLIANCE_ROLE)
    {
        _consume(ref);
        if (account == address(0)) revert ZeroAddress();
        _frozen[account] = frozen;
        emit FrozenSet(account, frozen, ref);
    }

    /// @inheritdoc IComplianceRegistry
    function isVerified(address account) external view returns (bool) {
        return _verified[account];
    }

    /// @inheritdoc IComplianceRegistry
    function isFrozen(address account) external view returns (bool) {
        return _frozen[account];
    }

    /// @inheritdoc IComplianceRegistry
    function isAllowed(address account) external view returns (bool) {
        return _verified[account] && !_frozen[account];
    }

    /// @dev Rejects the zero reference and any reference seen before, then records it.
    function _consume(bytes32 ref) private {
        if (ref == bytes32(0)) revert InvalidReference();
        if (referenceUsed[ref]) revert ReferenceAlreadyUsed(ref);
        referenceUsed[ref] = true;
    }
}
