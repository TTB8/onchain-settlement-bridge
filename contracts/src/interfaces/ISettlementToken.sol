// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title ISettlementToken
/// @notice A compliance-gated ERC-20 whose supply changes are driven by an off-chain ledger.
/// @dev Every mint, burn and operator transfer carries a single-use `ref`, the identifier of the
/// ledger operation it settles, so each on-chain action maps to exactly one ledger operation. The
/// contract rejects a `ref` it has seen before, which makes submitting the same operation twice
/// harmless.
///
/// The system is custodial: users hold no keys, and the platform moves balances only through
/// `mint`, `burn` and `settleTransfer`. The holder-signed ERC-20 path (`transfer`, `transferFrom`,
/// `approve`) is therefore OFF by default, and each of the three reverts `HolderTransfersDisabled`
/// before any other check until the admin calls `setHolderTransfersEnabled(true)`. When enabled,
/// that path is compliance-checked (not paused; sender, receiver, `transferFrom` spender and
/// `approve` owner all allowed by the registry) but emits no reference event, which is how an
/// off-chain reconciler recognizes it as a movement the ledger did not authorize.
interface ISettlementToken is IERC20 {
    /// @notice Tokens were minted to `to` to settle a ledger deposit.
    event Minted(address indexed to, uint256 amount, bytes32 indexed ref);

    /// @notice Tokens were burned from `from` to settle a ledger withdrawal.
    event Burned(address indexed from, uint256 amount, bytes32 indexed ref);

    /// @notice Tokens were moved between holders to settle a ledger transfer.
    event SettledTransfer(
        address indexed from, address indexed to, uint256 amount, bytes32 indexed ref
    );

    /// @notice The admin switched the holder-signed ERC-20 path on or off.
    /// @param enabled The new state of `holderTransfersEnabled`.
    event HolderTransfersSet(bool enabled);

    /// @notice The account is not verified, or is frozen.
    error NotAllowed(address account);

    /// @notice The reference was already used by an earlier operation.
    error ReferenceAlreadyUsed(bytes32 ref);

    /// @notice The reference is the zero value, which is reserved for "no reference".
    error InvalidReference();

    /// @notice The amount is zero; a zero-value operation has no ledger counterpart.
    error ZeroAmount();

    /// @notice `transfer`, `transferFrom` or `approve` was called while the holder-signed path is
    /// switched off (the default).
    error HolderTransfersDisabled();

    /// @notice `settleTransfer` was asked to move tokens from an account to itself, which has no
    /// ledger meaning and would only burn a reference.
    error SelfTransfer();

    /// @notice A constructor argument (the registry or the admin) is the zero address.
    error ZeroAddress();

    /// @notice The registry given to the constructor has no code, so it cannot be a registry.
    /// @param account The address that was passed as the registry.
    error NotAContract(address account);

    /// @notice Mints `amount` to `to`. Restricted to `MINTER_ROLE`. Consumes `ref`.
    /// @dev Not affected by `holderTransfersEnabled`.
    function mint(address to, uint256 amount, bytes32 ref) external;

    /// @notice Burns `amount` from `from`. Restricted to `MINTER_ROLE`. Consumes `ref`.
    /// @dev The holder does not sign: the platform burns on a withdrawal. A frozen holder cannot
    /// be burned from, because a frozen account can neither send nor receive. Not affected by
    /// `holderTransfersEnabled`.
    function burn(address from, uint256 amount, bytes32 ref) external;

    /// @notice Moves `amount` from `from` to `to` on the platform's behalf. Restricted to
    /// `SETTLER_ROLE`. Consumes `ref`.
    /// @dev No allowance is needed: users do not hold keys in this model. Both ends are still
    /// checked against the compliance registry. Not affected by `holderTransfersEnabled`. Reverts
    /// `SelfTransfer` when `from == to` (after the reference and amount checks); a reverted call
    /// never consumes its reference.
    function settleTransfer(address from, address to, uint256 amount, bytes32 ref) external;

    /// @notice Stops every mint, burn and transfer. Restricted to `PAUSER_ROLE`.
    function pause() external;

    /// @notice Resumes a paused token. Restricted to `PAUSER_ROLE`.
    function unpause() external;

    /// @notice Switches the holder-signed ERC-20 path (`transfer`, `transferFrom`, `approve`) on or
    /// off. Restricted to `DEFAULT_ADMIN_ROLE`. Emits `HolderTransfersSet`.
    /// @dev Does not affect `mint`, `burn` or `settleTransfer`. Allowances granted while the path
    /// was on survive a switch off and become usable again if it is switched back on.
    function setHolderTransfersEnabled(bool enabled) external;

    /// @notice Whether the holder-signed ERC-20 path is on. False after deployment.
    function holderTransfersEnabled() external view returns (bool);

    /// @notice Whether a reference has already been consumed.
    function referenceUsed(bytes32 ref) external view returns (bool);
}
