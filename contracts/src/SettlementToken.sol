// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IComplianceRegistry} from "./interfaces/IComplianceRegistry.sol";
import {ISettlementToken} from "./interfaces/ISettlementToken.sol";

/// @title SettlementToken
/// @notice ERC-20 with six decimals where every balance change is checked against a compliance
/// registry, and where every platform-driven change carries a single-use off-chain reference.
/// @dev Mint, burn and platform transfers all end in OpenZeppelin's `_update`, which is overridden
/// to (1) refuse while paused and (2) require the sender and the receiver to be allowed by the
/// registry. Minting skips the sender check and burning skips the receiver check, because the zero
/// address is not a holder. The registry is fixed at deployment: swapping it would change who may
/// hold the token, which should be a new deployment, not a setting.
contract SettlementToken is ISettlementToken, ERC20, AccessControl, Pausable {
    /// @notice Role allowed to mint and burn.
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    /// @notice Role allowed to move tokens between holders on the platform's behalf.
    bytes32 public constant SETTLER_ROLE = keccak256("SETTLER_ROLE");

    /// @notice Role allowed to pause and unpause the token.
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /// @notice The registry that decides who may hold and move the token.
    /// @dev Kept lowercase on purpose: it is a public getter that integrators call as `registry()`.
    // forge-lint: disable-next-line(screaming-snake-case-immutable)
    IComplianceRegistry public immutable registry;

    /// @inheritdoc ISettlementToken
    mapping(bytes32 ref => bool) public referenceUsed;

    /// @param name_ Token name.
    /// @param symbol_ Token symbol.
    /// @param registry_ The compliance registry consulted on every balance change.
    /// @param admin Receives `DEFAULT_ADMIN_ROLE`, which grants and revokes every other role.
    constructor(
        string memory name_,
        string memory symbol_,
        IComplianceRegistry registry_,
        address admin
    ) ERC20(name_, symbol_) {
        registry = registry_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @notice Six decimals, so one token is 1_000_000 base units (like a cent-precision currency).
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @inheritdoc ISettlementToken
    function mint(address to, uint256 amount, bytes32 ref) external onlyRole(MINTER_ROLE) {
        _consume(ref, amount);
        _mint(to, amount);
        emit Minted(to, amount, ref);
    }

    /// @inheritdoc ISettlementToken
    function burn(address from, uint256 amount, bytes32 ref) external onlyRole(MINTER_ROLE) {
        _consume(ref, amount);
        _burn(from, amount);
        emit Burned(from, amount, ref);
    }

    /// @inheritdoc ISettlementToken
    function settleTransfer(address from, address to, uint256 amount, bytes32 ref)
        external
        onlyRole(SETTLER_ROLE)
    {
        _consume(ref, amount);
        _transfer(from, to, amount);
        emit SettledTransfer(from, to, amount, ref);
    }

    /// @inheritdoc ISettlementToken
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @inheritdoc ISettlementToken
    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    /// @dev The single choke point for every balance change, so no path can skip the checks.
    function _update(address from, address to, uint256 value) internal override {
        _requireNotPaused();
        if (from != address(0) && !registry.isAllowed(from)) revert NotAllowed(from);
        if (to != address(0) && !registry.isAllowed(to)) revert NotAllowed(to);
        super._update(from, to, value);
    }

    /// @dev Rejects a zero amount, the zero reference and any reference seen before, then records it.
    function _consume(bytes32 ref, uint256 amount) private {
        if (ref == bytes32(0)) revert InvalidReference();
        if (amount == 0) revert ZeroAmount();
        if (referenceUsed[ref]) revert ReferenceAlreadyUsed(ref);
        referenceUsed[ref] = true;
    }
}
