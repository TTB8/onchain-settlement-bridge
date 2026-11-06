// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title ISettlementToken
/// @notice A compliance-gated ERC-20 whose supply changes are driven by an off-chain ledger.
/// @dev Every mint, burn and operator transfer carries a single-use `ref`, the identifier of the
/// ledger operation it settles, so each on-chain action maps to exactly one ledger operation. The
/// contract rejects a `ref` it has seen before, which makes submitting the same operation twice
/// harmless. Plain holder-signed ERC-20 transfers are still possible (and still compliance-checked);
/// they emit no reference event, which is how an off-chain reconciler recognizes them as
/// movements the ledger did not authorize.
interface ISettlementToken is IERC20 {
    /// @notice Tokens were minted to `to` to settle a ledger deposit.
    event Minted(address indexed to, uint256 amount, bytes32 indexed ref);

    /// @notice Tokens were burned from `from` to settle a ledger withdrawal.
    event Burned(address indexed from, uint256 amount, bytes32 indexed ref);

    /// @notice Tokens were moved between holders to settle a ledger transfer.
    event SettledTransfer(
        address indexed from, address indexed to, uint256 amount, bytes32 indexed ref
    );

    /// @notice The account is not verified, or is frozen.
    error NotAllowed(address account);

    /// @notice The reference was already used by an earlier operation.
    error ReferenceAlreadyUsed(bytes32 ref);

    /// @notice The reference is the zero value, which is reserved for "no reference".
    error InvalidReference();

    /// @notice The amount is zero; a zero-value operation has no ledger counterpart.
    error ZeroAmount();

    /// @notice Mints `amount` to `to`. Restricted to `MINTER_ROLE`. Consumes `ref`.
    function mint(address to, uint256 amount, bytes32 ref) external;

    /// @notice Burns `amount` from `from`. Restricted to `MINTER_ROLE`. Consumes `ref`.
    /// @dev The holder does not sign: the platform burns on a withdrawal. A frozen holder cannot
    /// be burned from, because a frozen account can neither send nor receive.
    function burn(address from, uint256 amount, bytes32 ref) external;

    /// @notice Moves `amount` from `from` to `to` on the platform's behalf. Restricted to
    /// `SETTLER_ROLE`. Consumes `ref`.
    /// @dev No allowance is needed: users do not hold keys in this model. Both ends are still
    /// checked against the compliance registry.
    function settleTransfer(address from, address to, uint256 amount, bytes32 ref) external;

    /// @notice Stops every mint, burn and transfer. Restricted to `PAUSER_ROLE`.
    function pause() external;

    /// @notice Resumes a paused token. Restricted to `PAUSER_ROLE`.
    function unpause() external;

    /// @notice Whether a reference has already been consumed.
    function referenceUsed(bytes32 ref) external view returns (bool);
}
