// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {ComplianceRegistry} from "../src/ComplianceRegistry.sol";
import {SettlementToken} from "../src/SettlementToken.sol";

/// @notice Exposes the script's internals, and sends its output to a throwaway file.
contract DeployHarness is Deploy {
    string public constant OUTPUT = "./deployments/test-output.json";

    function exposedDeploy(address deployer, Config memory cfg)
        external
        returns (ComplianceRegistry, SettlementToken)
    {
        return _deploy(deployer, cfg);
    }

    function exposedAssertChain(uint256 chainId, bool allowMainnet, bool allowUnknown)
        external
        pure
    {
        _assertChainAllowed(chainId, allowMainnet, allowUnknown);
    }

    function exposedReadConfig() external view returns (Config memory) {
        return _readConfig();
    }

    function exposedWrite(
        address deployer,
        Config memory cfg,
        ComplianceRegistry r,
        SettlementToken t
    ) external {
        _writeDeployment(deployer, cfg, r, t);
    }

    function _outputPath() internal pure override returns (string memory) {
        return OUTPUT;
    }
}

contract DeployTest is Test {
    DeployHarness internal harness;
    address internal admin = makeAddr("admin");
    address internal compliance = makeAddr("compliance");
    address internal minter = makeAddr("minter");
    address internal settler = makeAddr("settler");
    address internal pauser = makeAddr("pauser");

    function setUp() public {
        harness = new DeployHarness();
    }

    function _config(address finalAdmin) internal view returns (Deploy.Config memory cfg) {
        cfg = Deploy.Config({
            admin: finalAdmin,
            compliance: compliance,
            minter: minter,
            settler: settler,
            pauser: pauser,
            tokenName: "Settlement Token",
            tokenSymbol: "STK",
            allowMainnet: false,
            allowUnknownChain: false
        });
    }

    // The harness plays the deployer, because the calls the script makes come from the deployer.

    function test_deployGrantsEachServiceRoleToItsAccountOnly() public {
        (ComplianceRegistry registry, SettlementToken token) =
            harness.exposedDeploy(address(harness), _config(address(0)));

        assertTrue(registry.hasRole(registry.COMPLIANCE_ROLE(), compliance));
        assertTrue(token.hasRole(token.MINTER_ROLE(), minter));
        assertTrue(token.hasRole(token.SETTLER_ROLE(), settler));
        assertTrue(token.hasRole(token.PAUSER_ROLE(), pauser));

        assertFalse(token.hasRole(token.MINTER_ROLE(), settler));
        assertFalse(token.hasRole(token.SETTLER_ROLE(), minter));
        assertFalse(registry.hasRole(registry.COMPLIANCE_ROLE(), minter));
    }

    function test_deployWiresTheTokenToTheRegistryWithTheRequestedMetadata() public {
        Deploy.Config memory cfg = _config(address(0));
        cfg.tokenName = "Test Dollar";
        cfg.tokenSymbol = "TUSD";
        (ComplianceRegistry registry, SettlementToken token) =
            harness.exposedDeploy(address(harness), cfg);

        assertEq(address(token.registry()), address(registry));
        assertEq(token.name(), "Test Dollar");
        assertEq(token.symbol(), "TUSD");
    }

    function test_deployerKeepsAdminWhenNoOtherAdminIsGiven() public {
        (ComplianceRegistry registry, SettlementToken token) =
            harness.exposedDeploy(address(harness), _config(address(0)));
        assertTrue(registry.hasRole(registry.DEFAULT_ADMIN_ROLE(), address(harness)));
        assertTrue(token.hasRole(token.DEFAULT_ADMIN_ROLE(), address(harness)));
    }

    function test_adminIsHandedOverAndTheDeployerStepsDown() public {
        (ComplianceRegistry registry, SettlementToken token) =
            harness.exposedDeploy(address(harness), _config(admin));

        assertTrue(registry.hasRole(registry.DEFAULT_ADMIN_ROLE(), admin));
        assertTrue(token.hasRole(token.DEFAULT_ADMIN_ROLE(), admin));
        assertFalse(
            registry.hasRole(registry.DEFAULT_ADMIN_ROLE(), address(harness)),
            "deployer must step down"
        );
        assertFalse(
            token.hasRole(token.DEFAULT_ADMIN_ROLE(), address(harness)), "deployer must step down"
        );

        // The service roles survive the handover.
        assertTrue(token.hasRole(token.MINTER_ROLE(), minter));
    }

    function test_adminEqualToTheDeployerChangesNothing() public {
        (ComplianceRegistry registry,) =
            harness.exposedDeploy(address(harness), _config(address(harness)));
        assertTrue(registry.hasRole(registry.DEFAULT_ADMIN_ROLE(), address(harness)));
    }

    // --- chain guard ---------------------------------------------------------------------------

    function test_localAndTheTwoTestnetsAlwaysPass() public view {
        harness.exposedAssertChain(31_337, false, false);
        harness.exposedAssertChain(11_155_111, false, false);
        harness.exposedAssertChain(84_532, false, false);
    }

    function test_everyKnownMainnetIsBlockedByDefault() public {
        uint256[13] memory mainnets =
            [uint256(1), 10, 56, 100, 137, 250, 324, 8453, 42_161, 42_220, 43_114, 59_144, 534_352];
        for (uint256 i; i < mainnets.length; ++i) {
            vm.expectRevert(
                abi.encodeWithSelector(Deploy.MainnetDeploymentBlocked.selector, mainnets[i])
            );
            harness.exposedAssertChain(mainnets[i], false, true);
        }
    }

    function test_aMainnetNeedsTheExplicitFlag() public view {
        harness.exposedAssertChain(1, true, false);
        harness.exposedAssertChain(8453, true, false);
    }

    function test_allowUnknownDoesNotUnlockAMainnet() public {
        vm.expectRevert(abi.encodeWithSelector(Deploy.MainnetDeploymentBlocked.selector, 1));
        harness.exposedAssertChain(1, false, true);
    }

    function test_anUnrecognizedChainNeedsItsOwnFlag() public {
        vm.expectRevert(abi.encodeWithSelector(Deploy.UnknownChain.selector, 999_999));
        harness.exposedAssertChain(999_999, false, false);
        harness.exposedAssertChain(999_999, false, true);
    }

    function testFuzz_noChainOutsideTheAllowlistPassesWithoutFlags(uint256 chainId) public {
        vm.assume(chainId != 31_337 && chainId != 11_155_111 && chainId != 84_532);
        vm.expectRevert();
        harness.exposedAssertChain(chainId, false, false);
    }

    // --- environment ---------------------------------------------------------------------------

    /// @dev One test on purpose. `vm.setEnv` changes the whole process, and forge runs tests in
    /// parallel, so two tests that set the same variable would race each other.
    function test_readsAndValidatesTheEnvironment() public {
        // Set every variable the script reads, so nothing depends on the developer's own shell.
        vm.setEnv("ADMIN_ADDRESS", vm.toString(address(0)));
        vm.setEnv("COMPLIANCE_ADDRESS", vm.toString(compliance));
        vm.setEnv("MINTER_ADDRESS", vm.toString(minter));
        vm.setEnv("SETTLER_ADDRESS", vm.toString(settler));
        vm.setEnv("PAUSER_ADDRESS", vm.toString(pauser));
        vm.setEnv("TOKEN_NAME", "Settlement Token");
        vm.setEnv("TOKEN_SYMBOL", "STK");
        vm.setEnv("ALLOW_MAINNET", "false");
        vm.setEnv("ALLOW_UNKNOWN_CHAIN", "false");

        Deploy.Config memory cfg = harness.exposedReadConfig();
        assertEq(cfg.compliance, compliance);
        assertEq(cfg.minter, minter);
        assertEq(cfg.settler, settler);
        assertEq(cfg.pauser, pauser);
        assertEq(cfg.admin, address(0));
        assertEq(cfg.tokenName, "Settlement Token");
        assertEq(cfg.tokenSymbol, "STK");
        assertFalse(cfg.allowMainnet);
        assertFalse(cfg.allowUnknownChain);

        // Optional values are honoured.
        vm.setEnv("ADMIN_ADDRESS", vm.toString(admin));
        vm.setEnv("TOKEN_NAME", "Test Dollar");
        vm.setEnv("ALLOW_MAINNET", "true");
        cfg = harness.exposedReadConfig();
        assertEq(cfg.admin, admin);
        assertEq(cfg.tokenName, "Test Dollar");
        assertTrue(cfg.allowMainnet);

        // A zero role address is rejected, whichever role it is.
        string[4] memory names =
            ["COMPLIANCE_ADDRESS", "MINTER_ADDRESS", "SETTLER_ADDRESS", "PAUSER_ADDRESS"];
        string[4] memory roles = ["compliance", "minter", "settler", "pauser"];
        address[4] memory good = [compliance, minter, settler, pauser];
        for (uint256 i; i < 4; ++i) {
            vm.setEnv(names[i], vm.toString(address(0)));
            vm.expectRevert(abi.encodeWithSelector(Deploy.ZeroRoleAddress.selector, roles[i]));
            harness.exposedReadConfig();
            vm.setEnv(names[i], vm.toString(good[i]));
        }
    }

    // --- the deployment record -----------------------------------------------------------------

    function test_writesTheDeploymentRecordWithTheRealAddresses() public {
        vm.chainId(84_532);
        vm.roll(1234);
        (ComplianceRegistry registry, SettlementToken token) =
            harness.exposedDeploy(address(harness), _config(admin));
        harness.exposedWrite(address(harness), _config(admin), registry, token);

        string memory json = vm.readFile(harness.OUTPUT());
        assertEq(vm.parseJsonUint(json, ".chainId"), 84_532);
        assertEq(vm.parseJsonUint(json, ".deploymentBlock"), 1234);
        assertEq(vm.parseJsonAddress(json, ".complianceRegistry"), address(registry));
        assertEq(vm.parseJsonAddress(json, ".settlementToken"), address(token));
        assertEq(vm.parseJsonAddress(json, ".deployer"), address(harness));
        assertEq(vm.parseJsonAddress(json, ".admin"), admin);

        vm.removeFile(harness.OUTPUT());
    }
}
