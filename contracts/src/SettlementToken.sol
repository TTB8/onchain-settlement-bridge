// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
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
///
/// The system is custodial (users hold no keys), so the holder-signed ERC-20 path (`transfer`,
/// `transferFrom`, `approve`) is OFF by default and reverts `HolderTransfersDisabled` before any
/// other check. The admin may switch it on with `setHolderTransfersEnabled`. When on, it is
/// compliance-checked like every other movement, plus the `transferFrom` spender and the `approve`
/// owner must be allowed and `approve` refuses while paused; it emits no reference event, which is
/// how a reconciler recognizes it as a movement the ledger did not authorize. The one exception is
/// `approve(spender, 0)`: revoking an allowance is always accepted from the owner, in every state. `mint`, `burn` and
/// `settleTransfer` use the internal `_mint`, `_burn` and `_transfer` and ignore the switch.
///
/// Role blast radius: `DEFAULT_ADMIN_ROLE` grants and revokes every role and toggles the
/// holder-signed path; `MINTER_ROLE` creates and destroys supply for allowed holders;
/// `SETTLER_ROLE` moves any allowed holder's balance to another allowed holder; `PAUSER_ROLE`
/// halts every movement. None of them can move a frozen or unverified balance.
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

    /// @inheritdoc ISettlementToken
    bool public holderTransfersEnabled;

    /// @param name_ Token name.
    /// @param symbol_ Token symbol.
    /// @param registry_ The compliance registry consulted on every balance change. Must be a
    /// deployed contract.
    /// @param admin Receives `DEFAULT_ADMIN_ROLE`, which grants and revokes every other role. Must
    /// not be the zero address.
    constructor(
        string memory name_,
        string memory symbol_,
        IComplianceRegistry registry_,
        address admin
    ) ERC20(name_, symbol_) {
        if (address(registry_) == address(0) || admin == address(0)) {
            revert ZeroAddress();
        }
        if (address(registry_).code.length == 0) revert NotAContract(address(registry_));
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
        if (from == to) revert SelfTransfer();
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

    /// @inheritdoc ISettlementToken
    function setHolderTransfersEnabled(bool enabled) external onlyRole(DEFAULT_ADMIN_ROLE) {
        holderTransfersEnabled = enabled;
        emit HolderTransfersSet(enabled);
    }

    /// @notice Holder-signed transfer. Reverts `HolderTransfersDisabled` unless the admin switched
    /// the holder-signed path on; then behaves as ERC-20 `transfer`, checked by `_update`.
    function transfer(address to, uint256 value) public override(ERC20, IERC20) returns (bool) {
        _requireHolderTransfersEnabled();
        return super.transfer(to, value);
    }

    /// @notice Holder-approved transfer by a spender. Reverts `HolderTransfersDisabled` unless the
    /// holder-signed path is on, then `NotAllowed(spender)` unless the spender (the caller) is
    /// allowed by the registry; then behaves as ERC-20 `transferFrom`, checked by `_update`.
    function transferFrom(address from, address to, uint256 value)
        public
        override(ERC20, IERC20)
        returns (bool)
    {
        _requireHolderTransfersEnabled();
        address spender = _msgSender();
        if (!registry.isAllowed(spender)) revert NotAllowed(spender);
        return super.transferFrom(from, to, value);
    }

    /// @notice Sets the caller's allowance for `spender`. A non-zero `value` reverts
    /// `HolderTransfersDisabled` unless the holder-signed path is on, then `EnforcedPause` while
    /// paused, then `NotAllowed(owner)` unless the owner (the caller) is allowed by the registry.
    /// A zero `value` (revoking) is always accepted from the owner, whatever the switch, the pause
    /// or the owner's status, so a stale allowance can always be withdrawn; revoking grants nothing.
    /// @dev The spender is checked when it spends, in `transferFrom`, not here. A zero spender still
    /// reverts `ERC20InvalidSpender`.
    function approve(address spender, uint256 value) public override(ERC20, IERC20) returns (bool) {
        if (value != 0) {
            _requireHolderTransfersEnabled();
            _requireNotPaused();
            address owner = _msgSender();
            if (!registry.isAllowed(owner)) revert NotAllowed(owner);
        }
        return super.approve(spender, value);
    }

    /// @dev The single choke point for every balance change, so no path can skip the checks.
    function _update(address from, address to, uint256 value) internal override {
        _requireNotPaused();
        if (from != address(0) && !registry.isAllowed(from)) revert NotAllowed(from);
        if (to != address(0) && !registry.isAllowed(to)) revert NotAllowed(to);
        super._update(from, to, value);
    }

    /// @dev Reverts unless the admin switched the holder-signed ERC-20 path on.
    function _requireHolderTransfersEnabled() private view {
        if (!holderTransfersEnabled) revert HolderTransfersDisabled();
    }

    /// @dev Rejects a zero amount, the zero reference and any reference seen before, then records it.
    function _consume(bytes32 ref, uint256 amount) private {
        if (ref == bytes32(0)) revert InvalidReference();
        if (amount == 0) revert ZeroAmount();
        if (referenceUsed[ref]) revert ReferenceAlreadyUsed(ref);
        referenceUsed[ref] = true;
    }
}
