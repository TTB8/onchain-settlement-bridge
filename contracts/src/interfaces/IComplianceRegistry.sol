// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IComplianceRegistry
/// @notice The on-chain list of who may hold and move the settlement token.
/// @dev An address is *allowed* when it is verified and not frozen. Every state change carries a
/// single-use `ref`: the off-chain identifier of the compliance change that caused it. A `ref`
/// that was used once can never be used again, so replaying or double-submitting a change is
/// impossible, and every on-chain change maps to exactly one off-chain record.
interface IComplianceRegistry {
    /// @notice An account's verification status was set.
    /// @param account The account whose status changed.
    /// @param verified The new status.
    /// @param ref The off-chain reference of the compliance change.
    event VerificationSet(address indexed account, bool verified, bytes32 indexed ref);

    /// @notice An account's frozen status was set.
    /// @param account The account whose status changed.
    /// @param frozen The new status.
    /// @param ref The off-chain reference of the compliance change.
    event FrozenSet(address indexed account, bool frozen, bytes32 indexed ref);

    /// @notice The reference was already used by an earlier change.
    error ReferenceAlreadyUsed(bytes32 ref);

    /// @notice The reference is the zero value, which is reserved for "no reference".
    error InvalidReference();

    /// @notice The zero address cannot be verified or frozen.
    error ZeroAddress();

    /// @notice Marks an account as verified, or removes its verification.
    /// @dev Restricted to `COMPLIANCE_ROLE`. Consumes `ref`.
    function setVerified(address account, bool verified, bytes32 ref) external;

    /// @notice Freezes an account, or unfreezes it.
    /// @dev Restricted to `COMPLIANCE_ROLE`. Consumes `ref`. A frozen account can neither send nor
    /// receive, whatever its verification status.
    function setFrozen(address account, bool frozen, bytes32 ref) external;

    /// @notice Whether the account has been verified.
    function isVerified(address account) external view returns (bool);

    /// @notice Whether the account is frozen.
    function isFrozen(address account) external view returns (bool);

    /// @notice Whether the account may hold and move the token: verified and not frozen.
    function isAllowed(address account) external view returns (bool);

    /// @notice Whether a reference has already been consumed.
    function referenceUsed(bytes32 ref) external view returns (bool);
}
