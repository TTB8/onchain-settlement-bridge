// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";
import {ComplianceRegistry} from "../src/ComplianceRegistry.sol";
import {SettlementToken} from "../src/SettlementToken.sol";

/// @title Deploy
/// @notice Deploys the compliance registry and the settlement token, wires their roles, and writes
/// the addresses to `deployments/<chainId>.json`.
/// @dev Everything comes from environment variables, and the deployer key is passed to `forge
/// script` on the command line (`--private-key`, `--account` for a keystore, or `--unlocked` for
/// Anvil's built-in accounts). No key is ever read from the environment by this script.
///
/// Required: COMPLIANCE_ADDRESS, MINTER_ADDRESS, SETTLER_ADDRESS, PAUSER_ADDRESS.
/// Optional: ADMIN_ADDRESS (final admin; the deployer hands over and steps down if it differs),
/// TOKEN_NAME, TOKEN_SYMBOL, ALLOW_MAINNET, ALLOW_UNKNOWN_CHAIN.
///
/// Refuses to run on a known mainnet unless ALLOW_MAINNET=true, and on a chain it does not
/// recognize unless ALLOW_UNKNOWN_CHAIN=true. Local and the two documented testnets always work.
contract Deploy is Script {
    /// @notice Everything the deployment needs, read from the environment.
    struct Config {
        address admin;
        address compliance;
        address minter;
        address settler;
        address pauser;
        string tokenName;
        string tokenSymbol;
        bool allowMainnet;
        bool allowUnknownChain;
    }

    /// @notice The chain is a known production network and ALLOW_MAINNET is not set.
    error MainnetDeploymentBlocked(uint256 chainId);

    /// @notice The chain is not one this script recognizes and ALLOW_UNKNOWN_CHAIN is not set.
    error UnknownChain(uint256 chainId);

    /// @notice A required role address is the zero address.
    error ZeroRoleAddress(string role);

    uint256 internal constant ANVIL = 31_337;
    uint256 internal constant SEPOLIA = 11_155_111;
    uint256 internal constant BASE_SEPOLIA = 84_532;

    /// @notice Deploys and wires everything. Run with `--broadcast` to send the transactions.
    function run() external returns (ComplianceRegistry registry, SettlementToken token) {
        Config memory cfg = _readConfig();
        _assertChainAllowed(block.chainid, cfg.allowMainnet, cfg.allowUnknownChain);

        vm.startBroadcast();
        // After startBroadcast, msg.sender is the account that signs the transactions.
        (, address deployer,) = vm.readCallers();
        (registry, token) = _deploy(deployer, cfg);
        vm.stopBroadcast();

        _writeDeployment(deployer, cfg, registry, token);
    }

    /// @dev Reads and validates the environment.
    function _readConfig() internal view returns (Config memory cfg) {
        cfg.admin = vm.envOr("ADMIN_ADDRESS", address(0));
        cfg.compliance = vm.envAddress("COMPLIANCE_ADDRESS");
        cfg.minter = vm.envAddress("MINTER_ADDRESS");
        cfg.settler = vm.envAddress("SETTLER_ADDRESS");
        cfg.pauser = vm.envAddress("PAUSER_ADDRESS");
        cfg.tokenName = vm.envOr("TOKEN_NAME", string("Settlement Token"));
        cfg.tokenSymbol = vm.envOr("TOKEN_SYMBOL", string("STK"));
        cfg.allowMainnet = vm.envOr("ALLOW_MAINNET", false);
        cfg.allowUnknownChain = vm.envOr("ALLOW_UNKNOWN_CHAIN", false);

        if (cfg.compliance == address(0)) revert ZeroRoleAddress("compliance");
        if (cfg.minter == address(0)) revert ZeroRoleAddress("minter");
        if (cfg.settler == address(0)) revert ZeroRoleAddress("settler");
        if (cfg.pauser == address(0)) revert ZeroRoleAddress("pauser");
    }

    /// @dev Refuses production networks and unrecognized chains unless explicitly allowed.
    function _assertChainAllowed(uint256 chainId, bool allowMainnet, bool allowUnknown)
        internal
        pure
    {
        if (chainId == ANVIL || chainId == SEPOLIA || chainId == BASE_SEPOLIA) return;
        if (_isKnownMainnet(chainId)) {
            if (!allowMainnet) revert MainnetDeploymentBlocked(chainId);
            return;
        }
        if (!allowUnknown) revert UnknownChain(chainId);
    }

    /// @dev Production networks this script refuses by default. Not exhaustive on purpose: the
    /// unknown-chain guard covers the rest.
    function _isKnownMainnet(uint256 chainId) internal pure returns (bool) {
        return chainId == 1 // Ethereum
            || chainId == 10 // OP Mainnet
            || chainId == 56 // BNB Smart Chain
            || chainId == 100 // Gnosis
            || chainId == 137 // Polygon
            || chainId == 250 // Fantom
            || chainId == 324 // zkSync Era
            || chainId == 8453 // Base
            || chainId == 42_161 // Arbitrum One
            || chainId == 42_220 // Celo
            || chainId == 43_114 // Avalanche C-Chain
            || chainId == 59_144 // Linea
            || chainId == 534_352; // Scroll
    }

    /// @dev Creates both contracts with `deployer` as the temporary admin, grants the service
    /// roles, then optionally hands the admin role to `cfg.admin` and steps down. Every call here
    /// is made by `deployer`, which is the broadcaster when run as a script.
    function _deploy(address deployer, Config memory cfg)
        internal
        returns (ComplianceRegistry registry, SettlementToken token)
    {
        registry = new ComplianceRegistry(deployer);
        token = new SettlementToken(cfg.tokenName, cfg.tokenSymbol, registry, deployer);

        registry.grantRole(registry.COMPLIANCE_ROLE(), cfg.compliance);
        token.grantRole(token.MINTER_ROLE(), cfg.minter);
        token.grantRole(token.SETTLER_ROLE(), cfg.settler);
        token.grantRole(token.PAUSER_ROLE(), cfg.pauser);

        if (cfg.admin != address(0) && cfg.admin != deployer) {
            bytes32 adminRole = registry.DEFAULT_ADMIN_ROLE();
            registry.grantRole(adminRole, cfg.admin);
            token.grantRole(adminRole, cfg.admin);
            registry.renounceRole(adminRole, deployer);
            token.renounceRole(adminRole, deployer);
        }
    }

    /// @dev Where the deployment record is written. Overridden in tests so they never touch it.
    function _outputPath() internal view virtual returns (string memory) {
        return string.concat("./deployments/", vm.toString(block.chainid), ".json");
    }

    /// @dev Records what was deployed. `deploymentBlock` is the chain head when the script started,
    /// a safe lower bound for where an indexer should begin reading events.
    function _writeDeployment(
        address deployer,
        Config memory cfg,
        ComplianceRegistry registry,
        SettlementToken token
    ) internal {
        string memory key = "deployment";
        vm.serializeUint(key, "chainId", block.chainid);
        vm.serializeUint(key, "deploymentBlock", block.number);
        vm.serializeAddress(key, "complianceRegistry", address(registry));
        vm.serializeAddress(key, "settlementToken", address(token));
        vm.serializeAddress(key, "deployer", deployer);
        string memory json =
            vm.serializeAddress(key, "admin", cfg.admin == address(0) ? deployer : cfg.admin);
        vm.writeJson(json, _outputPath());
    }
}
