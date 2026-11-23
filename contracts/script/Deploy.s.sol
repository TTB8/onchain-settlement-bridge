// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {console} from "forge-std/console.sol";
import {ComplianceRegistry} from "../src/ComplianceRegistry.sol";
import {SettlementToken} from "../src/SettlementToken.sol";

/// @title Deploy
/// @notice Deploys the compliance registry and the settlement token, wires their roles, checks the
/// wiring, and (only when broadcasting) writes the addresses to `deployments/<chainId>.pending.json`.
/// @dev Everything comes from environment variables, and the deployer key is passed to `forge
/// script` on the command line (`--private-key`, `--account` for a keystore, or `--unlocked` for
/// Anvil's built-in accounts). No key is ever read from the environment by this script.
///
/// Required: COMPLIANCE_ADDRESS, MINTER_ADDRESS, SETTLER_ADDRESS, PAUSER_ADDRESS, and on every chain
/// but local Anvil (31337) also ADMIN_ADDRESS.
/// Optional: ADMIN_ADDRESS on Anvil (final admin; the deployer hands over and steps down if it
/// differs), TOKEN_NAME, TOKEN_SYMBOL, ALLOW_MAINNET, ALLOW_UNKNOWN_CHAIN, ALLOW_EOA_ADMIN,
/// HOLDER_TRANSFERS_ENABLED (default false: the holder-signed ERC-20 path stays off).
///
/// Refuses to run on a known mainnet unless ALLOW_MAINNET=true, and on a chain it does not
/// recognize unless ALLOW_UNKNOWN_CHAIN=true. Local and the two documented testnets always work.
/// Off Anvil it also requires an admin with code (a multisig) unless ALLOW_EOA_ADMIN=true, a
/// compliance address different from the minter, and no service role held by the deployer.
///
/// A dry run writes nothing; a broadcast writes the PENDING record, because forge writes it while
/// the transactions are still being sent. `script/promote-deployment.sh` checks the record against
/// the chain and only then renames it to `deployments/<chainId>.json`.
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
        bool allowEoaAdmin;
        bool holderTransfersEnabled;
    }

    /// @notice The chain is a known production network and ALLOW_MAINNET is not set.
    error MainnetDeploymentBlocked(uint256 chainId);

    /// @notice The chain is not one this script recognizes and ALLOW_UNKNOWN_CHAIN is not set.
    error UnknownChain(uint256 chainId);

    /// @notice A required role address is the zero address.
    error ZeroRoleAddress(string role);

    /// @notice ADMIN_ADDRESS is unset or zero on a chain other than local Anvil.
    error AdminRequired(uint256 chainId);

    /// @notice The admin has no code (an EOA, not a multisig) and ALLOW_EOA_ADMIN is not set.
    error AdminHasNoCode(address admin);

    /// @notice The compliance address is also the minter: one key could then verify an address
    /// and mint to it.
    error ComplianceIsMinter(address account);

    /// @notice The deployer would keep a service role on a chain other than local Anvil.
    error DeployerHoldsServiceRole(string role);

    /// @notice The deployed contracts are not wired as configured; no record is produced.
    error DeploymentCheckFailed(string check);

    uint256 internal constant ANVIL = 31_337;
    uint256 internal constant SEPOLIA = 11_155_111;
    uint256 internal constant BASE_SEPOLIA = 84_532;

    /// @notice Deploys, wires and checks everything. Run with `--broadcast` to send the
    /// transactions and write the pending record.
    function run() external returns (ComplianceRegistry registry, SettlementToken token) {
        Config memory cfg = _readConfig();
        _assertChainAllowed(block.chainid, cfg.allowMainnet, cfg.allowUnknownChain);

        vm.startBroadcast();
        // After startBroadcast, msg.sender is the account that signs the transactions.
        (, address deployer,) = vm.readCallers();
        _assertRoleSeparation(block.chainid, deployer, cfg);
        (registry, token) = _deploy(deployer, cfg);
        _assertWiring(deployer, cfg, registry, token);
        vm.stopBroadcast();

        _recordDeployment(deployer, cfg, registry, token);
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
        cfg.allowEoaAdmin = vm.envOr("ALLOW_EOA_ADMIN", false);
        cfg.holderTransfersEnabled = vm.envOr("HOLDER_TRANSFERS_ENABLED", false);

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

    /// @dev Off local Anvil: a real admin is required and must have code unless ALLOW_EOA_ADMIN is
    /// set, compliance and minter are different keys, and the deployer keeps no service role.
    /// Minter and settler may be the same address (one settlement signer can hold both). On Anvil
    /// nothing here applies, so local development works with a single account.
    function _assertRoleSeparation(uint256 chainId, address deployer, Config memory cfg)
        internal
        view
    {
        if (chainId == ANVIL) return;
        if (cfg.admin == address(0)) revert AdminRequired(chainId);
        if (!cfg.allowEoaAdmin && cfg.admin.code.length == 0) revert AdminHasNoCode(cfg.admin);
        if (cfg.compliance == cfg.minter) revert ComplianceIsMinter(cfg.compliance);
        if (cfg.compliance == deployer) revert DeployerHoldsServiceRole("compliance");
        if (cfg.minter == deployer) revert DeployerHoldsServiceRole("minter");
        if (cfg.settler == deployer) revert DeployerHoldsServiceRole("settler");
        if (cfg.pauser == deployer) revert DeployerHoldsServiceRole("pauser");
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
    /// roles, switches the holder-signed path on if asked (while the deployer is still admin),
    /// then optionally hands the admin role to `cfg.admin` and steps down. Every call here is made
    /// by `deployer`, which is the broadcaster when run as a script.
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

        if (cfg.holderTransfersEnabled) token.setHolderTransfersEnabled(true);

        if (cfg.admin != address(0) && cfg.admin != deployer) {
            bytes32 adminRole = registry.DEFAULT_ADMIN_ROLE();
            registry.grantRole(adminRole, cfg.admin);
            token.grantRole(adminRole, cfg.admin);
            registry.renounceRole(adminRole, deployer);
            token.renounceRole(adminRole, deployer);
        }
    }

    /// @dev Reads the deployed state back and reverts on the first thing that is not as
    /// configured, so a mis-wired deployment never produces a record.
    function _assertWiring(
        address deployer,
        Config memory cfg,
        ComplianceRegistry registry,
        SettlementToken token
    ) internal view {
        if (address(token.registry()) != address(registry)) {
            revert DeploymentCheckFailed("token registry");
        }
        if (!registry.hasRole(registry.COMPLIANCE_ROLE(), cfg.compliance)) {
            revert DeploymentCheckFailed("compliance role");
        }
        if (!token.hasRole(token.MINTER_ROLE(), cfg.minter)) {
            revert DeploymentCheckFailed("minter role");
        }
        if (!token.hasRole(token.SETTLER_ROLE(), cfg.settler)) {
            revert DeploymentCheckFailed("settler role");
        }
        if (!token.hasRole(token.PAUSER_ROLE(), cfg.pauser)) {
            revert DeploymentCheckFailed("pauser role");
        }

        bytes32 adminRole = registry.DEFAULT_ADMIN_ROLE();
        address finalAdmin = _finalAdmin(deployer, cfg);
        if (!registry.hasRole(adminRole, finalAdmin)) {
            revert DeploymentCheckFailed("registry admin");
        }
        if (!token.hasRole(adminRole, finalAdmin)) revert DeploymentCheckFailed("token admin");
        if (finalAdmin != deployer) {
            if (registry.hasRole(adminRole, deployer)) {
                revert DeploymentCheckFailed("deployer kept registry admin");
            }
            if (token.hasRole(adminRole, deployer)) {
                revert DeploymentCheckFailed("deployer kept token admin");
            }
        }

        if (token.holderTransfersEnabled() != cfg.holderTransfersEnabled) {
            revert DeploymentCheckFailed("holder transfers switch");
        }
    }

    /// @dev The account that ends up with `DEFAULT_ADMIN_ROLE` on both contracts.
    function _finalAdmin(address deployer, Config memory cfg) internal pure returns (address) {
        return cfg.admin == address(0) ? deployer : cfg.admin;
    }

    /// @dev Whether forge is broadcasting (`forge script --broadcast`). Only then is a record
    /// written. Overridden in tests so both branches can be exercised.
    function _isBroadcast() internal view virtual returns (bool) {
        return vm.isContext(VmSafe.ForgeContext.ScriptBroadcast);
    }

    /// @dev Where the pending deployment record is written. Overridden in tests so they never
    /// touch it.
    function _outputPath() internal view virtual returns (string memory) {
        return string.concat("./deployments/", vm.toString(block.chainid), ".pending.json");
    }

    /// @dev Prints the addresses, and writes the pending record only when broadcasting: a dry run
    /// deployed nothing, so it must leave nothing behind that looks like a deployment.
    function _recordDeployment(
        address deployer,
        Config memory cfg,
        ComplianceRegistry registry,
        SettlementToken token
    ) internal {
        console.log("ComplianceRegistry:", address(registry));
        console.log("SettlementToken:", address(token));
        if (!_isBroadcast()) {
            console.log("Dry run: no deployment record written.");
            return;
        }
        _writeDeployment(deployer, cfg, registry, token);
        console.log("Pending record written; promote it with script/promote-deployment.sh.");
    }

    /// @dev Records what was deployed and who should hold each role, so the promotion step can
    /// check it against the chain. `deploymentBlock` is the chain head when the script started, a
    /// safe lower bound for where an indexer should begin reading events.
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
        vm.serializeAddress(key, "compliance", cfg.compliance);
        vm.serializeAddress(key, "minter", cfg.minter);
        vm.serializeAddress(key, "settler", cfg.settler);
        vm.serializeAddress(key, "pauser", cfg.pauser);
        vm.serializeBool(key, "holderTransfersEnabled", cfg.holderTransfersEnabled);
        string memory json = vm.serializeAddress(key, "admin", _finalAdmin(deployer, cfg));
        vm.writeJson(json, _outputPath());
    }
}
