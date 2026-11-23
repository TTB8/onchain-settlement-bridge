// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {ComplianceRegistry} from "../src/ComplianceRegistry.sol";
import {SettlementToken} from "../src/SettlementToken.sol";

/// @notice Exposes the script's internals, sends its output to a throwaway file chosen per test,
/// and lets a test pick whether the script believes it is broadcasting.
contract DeployHarness is Deploy {
    string public output = "./deployments/test-output.json";
    bool public broadcasting;

    function setOutput(string memory path) external {
        output = path;
    }

    function setBroadcasting(bool value) external {
        broadcasting = value;
    }

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

    function exposedAssertRoleSeparation(uint256 chainId, address deployer, Config memory cfg)
        external
        view
    {
        _assertRoleSeparation(chainId, deployer, cfg);
    }

    function exposedAssertWiring(
        address deployer,
        Config memory cfg,
        ComplianceRegistry r,
        SettlementToken t
    ) external view {
        _assertWiring(deployer, cfg, r, t);
    }

    function exposedReadConfig() external view returns (Config memory) {
        return _readConfig();
    }

    function exposedRecord(
        address deployer,
        Config memory cfg,
        ComplianceRegistry r,
        SettlementToken t
    ) external {
        _recordDeployment(deployer, cfg, r, t);
    }

    function exposedOutputPathOfTheRealScript() external view returns (string memory) {
        return Deploy._outputPath();
    }

    function _isBroadcast() internal view override returns (bool) {
        return broadcasting;
    }

    function _outputPath() internal view override returns (string memory) {
        return output;
    }
}

/// @notice Stands in for a multisig: an admin address that has code.
contract MultisigStub {}

contract DeployTest is Test {
    DeployHarness internal harness;
    address internal admin = makeAddr("admin");
    address internal compliance = makeAddr("compliance");
    address internal minter = makeAddr("minter");
    address internal settler = makeAddr("settler");
    address internal pauser = makeAddr("pauser");
    address internal deployer = makeAddr("deployer");

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
            allowUnknownChain: false,
            allowEoaAdmin: false,
            holderTransfersEnabled: false
        });
    }

    function _checkFailed(string memory check) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(Deploy.DeploymentCheckFailed.selector, check);
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

    function test_holderTransfersStayOffUnlessAsked() public {
        (, SettlementToken token) = harness.exposedDeploy(address(harness), _config(admin));
        assertFalse(token.holderTransfersEnabled());
    }

    function test_holderTransfersAreSwitchedOnBeforeTheAdminHandover() public {
        // If the switch were flipped after the handover, the deployer would no longer be admin and
        // the call would revert; so success with a handover proves the order.
        Deploy.Config memory cfg = _config(admin);
        cfg.holderTransfersEnabled = true;
        (ComplianceRegistry registry, SettlementToken token) =
            harness.exposedDeploy(address(harness), cfg);
        assertTrue(token.holderTransfersEnabled());
        assertFalse(token.hasRole(token.DEFAULT_ADMIN_ROLE(), address(harness)));
        harness.exposedAssertWiring(address(harness), cfg, registry, token);
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

    // --- role separation off local Anvil -------------------------------------------------------

    function _multisigAdmin() internal returns (address) {
        return address(new MultisigStub());
    }

    function test_localAnvilSkipsEveryRoleSeparationRule() public view {
        // One account for everything, no admin: fine for local development.
        Deploy.Config memory cfg = _config(address(0));
        cfg.compliance = deployer;
        cfg.minter = deployer;
        cfg.settler = deployer;
        cfg.pauser = deployer;
        harness.exposedAssertRoleSeparation(31_337, deployer, cfg);
    }

    function test_aWellSeparatedTestnetConfigPasses() public {
        Deploy.Config memory cfg = _config(_multisigAdmin());
        harness.exposedAssertRoleSeparation(84_532, deployer, cfg);

        cfg.settler = cfg.minter; // one settlement signer may hold both
        harness.exposedAssertRoleSeparation(84_532, deployer, cfg);
    }

    function test_offAnvilTheAdminIsRequired() public {
        vm.expectRevert(abi.encodeWithSelector(Deploy.AdminRequired.selector, 84_532));
        harness.exposedAssertRoleSeparation(84_532, deployer, _config(address(0)));
        vm.expectRevert(abi.encodeWithSelector(Deploy.AdminRequired.selector, 1));
        harness.exposedAssertRoleSeparation(1, deployer, _config(address(0)));
    }

    function test_offAnvilTheAdminMustHaveCodeUnlessEoaIsAllowed() public {
        Deploy.Config memory cfg = _config(admin); // admin is an EOA here
        vm.expectRevert(abi.encodeWithSelector(Deploy.AdminHasNoCode.selector, admin));
        harness.exposedAssertRoleSeparation(11_155_111, deployer, cfg);

        cfg.allowEoaAdmin = true;
        harness.exposedAssertRoleSeparation(11_155_111, deployer, cfg);
    }

    function test_offAnvilComplianceMustDifferFromTheMinter() public {
        Deploy.Config memory cfg = _config(_multisigAdmin());
        cfg.minter = compliance;
        vm.expectRevert(abi.encodeWithSelector(Deploy.ComplianceIsMinter.selector, compliance));
        harness.exposedAssertRoleSeparation(84_532, deployer, cfg);
    }

    function test_offAnvilTheDeployerHoldsNoServiceRole() public {
        address multisig = _multisigAdmin();
        string[4] memory roles = ["compliance", "minter", "settler", "pauser"];
        for (uint256 i; i < 4; ++i) {
            Deploy.Config memory cfg = _config(multisig);
            if (i == 0) cfg.compliance = deployer;
            if (i == 1) cfg.minter = deployer;
            if (i == 2) cfg.settler = deployer;
            if (i == 3) cfg.pauser = deployer;
            vm.expectRevert(
                abi.encodeWithSelector(Deploy.DeployerHoldsServiceRole.selector, roles[i])
            );
            harness.exposedAssertRoleSeparation(84_532, deployer, cfg);
        }
    }

    // --- wiring assertions ---------------------------------------------------------------------

    function test_wiringCheckPassesOnACorrectDeployment() public {
        Deploy.Config memory cfg = _config(address(0));
        (ComplianceRegistry registry, SettlementToken token) =
            harness.exposedDeploy(address(harness), cfg);
        harness.exposedAssertWiring(address(harness), cfg, registry, token);

        cfg = _config(admin);
        (registry, token) = harness.exposedDeploy(address(harness), cfg);
        harness.exposedAssertWiring(address(harness), cfg, registry, token);
    }

    function test_wiringCheckCatchesEachMissingServiceRole() public {
        string[4] memory checks = ["compliance role", "minter role", "settler role", "pauser role"];
        for (uint256 i; i < 4; ++i) {
            Deploy.Config memory cfg = _config(address(0));
            (ComplianceRegistry registry, SettlementToken token) =
                harness.exposedDeploy(address(harness), cfg);
            vm.startPrank(address(harness));
            if (i == 0) registry.revokeRole(registry.COMPLIANCE_ROLE(), compliance);
            if (i == 1) token.revokeRole(token.MINTER_ROLE(), minter);
            if (i == 2) token.revokeRole(token.SETTLER_ROLE(), settler);
            if (i == 3) token.revokeRole(token.PAUSER_ROLE(), pauser);
            vm.stopPrank();
            vm.expectRevert(_checkFailed(checks[i]));
            harness.exposedAssertWiring(address(harness), cfg, registry, token);
        }
    }

    function test_wiringCheckCatchesAMissingAdmin() public {
        Deploy.Config memory cfg = _config(admin);
        (ComplianceRegistry registry, SettlementToken token) =
            harness.exposedDeploy(address(harness), cfg);
        bytes32 adminRole = registry.DEFAULT_ADMIN_ROLE();

        vm.prank(admin);
        registry.renounceRole(adminRole, admin);
        vm.expectRevert(_checkFailed("registry admin"));
        harness.exposedAssertWiring(address(harness), cfg, registry, token);

        (registry, token) = harness.exposedDeploy(address(harness), cfg);
        vm.prank(admin);
        token.renounceRole(adminRole, admin);
        vm.expectRevert(_checkFailed("token admin"));
        harness.exposedAssertWiring(address(harness), cfg, registry, token);
    }

    function test_wiringCheckCatchesADeployerThatKeptAdmin() public {
        Deploy.Config memory cfg = _config(admin);
        (ComplianceRegistry registry, SettlementToken token) =
            harness.exposedDeploy(address(harness), cfg);
        bytes32 adminRole = registry.DEFAULT_ADMIN_ROLE();

        vm.prank(admin);
        registry.grantRole(adminRole, address(harness));
        vm.expectRevert(_checkFailed("deployer kept registry admin"));
        harness.exposedAssertWiring(address(harness), cfg, registry, token);

        (registry, token) = harness.exposedDeploy(address(harness), cfg);
        vm.prank(admin);
        token.grantRole(adminRole, address(harness));
        vm.expectRevert(_checkFailed("deployer kept token admin"));
        harness.exposedAssertWiring(address(harness), cfg, registry, token);
    }

    function test_wiringCheckCatchesAWrongRegistryAndAWrongSwitch() public {
        Deploy.Config memory cfg = _config(address(0));
        (ComplianceRegistry registry, SettlementToken token) =
            harness.exposedDeploy(address(harness), cfg);
        (ComplianceRegistry other,) = harness.exposedDeploy(address(harness), cfg);

        vm.expectRevert(_checkFailed("token registry"));
        harness.exposedAssertWiring(address(harness), cfg, other, token);

        cfg.holderTransfersEnabled = true;
        vm.expectRevert(_checkFailed("holder transfers switch"));
        harness.exposedAssertWiring(address(harness), cfg, registry, token);
    }

    // --- the deployment record -----------------------------------------------------------------

    function test_theRealScriptWritesOnlyAPendingRecord() public view {
        assertEq(harness.exposedOutputPathOfTheRealScript(), "./deployments/31337.pending.json");
    }

    function test_aDryRunWritesNoRecord() public {
        string memory path = "./deployments/test-dry-run.json";
        harness.setOutput(path);
        harness.setBroadcasting(false);
        (ComplianceRegistry registry, SettlementToken token) =
            harness.exposedDeploy(address(harness), _config(admin));
        harness.exposedRecord(address(harness), _config(admin), registry, token);
        assertFalse(vm.exists(path), "a dry run must leave no record");
    }

    function test_aBroadcastWritesTheRecordWithTheRealAddresses() public {
        string memory path = "./deployments/test-output.json";
        harness.setOutput(path);
        harness.setBroadcasting(true);
        vm.chainId(84_532);
        vm.roll(1234);
        Deploy.Config memory cfg = _config(admin);
        cfg.holderTransfersEnabled = true;
        (ComplianceRegistry registry, SettlementToken token) =
            harness.exposedDeploy(address(harness), cfg);
        harness.exposedRecord(address(harness), cfg, registry, token);

        string memory json = vm.readFile(path);
        assertEq(vm.parseJsonUint(json, ".chainId"), 84_532);
        assertEq(vm.parseJsonUint(json, ".deploymentBlock"), 1234);
        assertEq(vm.parseJsonAddress(json, ".complianceRegistry"), address(registry));
        assertEq(vm.parseJsonAddress(json, ".settlementToken"), address(token));
        assertEq(vm.parseJsonAddress(json, ".deployer"), address(harness));
        assertEq(vm.parseJsonAddress(json, ".admin"), admin);
        assertEq(vm.parseJsonAddress(json, ".compliance"), compliance);
        assertEq(vm.parseJsonAddress(json, ".minter"), minter);
        assertEq(vm.parseJsonAddress(json, ".settler"), settler);
        assertEq(vm.parseJsonAddress(json, ".pauser"), pauser);
        assertTrue(vm.parseJsonBool(json, ".holderTransfersEnabled"));

        vm.removeFile(path);
    }

    function test_theRecordNamesTheDeployerAsAdminWhenNoneIsGiven() public {
        string memory path = "./deployments/test-output-local.json";
        harness.setOutput(path);
        harness.setBroadcasting(true);
        (ComplianceRegistry registry, SettlementToken token) =
            harness.exposedDeploy(address(harness), _config(address(0)));
        harness.exposedRecord(address(harness), _config(address(0)), registry, token);
        assertEq(vm.parseJsonAddress(vm.readFile(path), ".admin"), address(harness));
        assertFalse(vm.parseJsonBool(vm.readFile(path), ".holderTransfersEnabled"));
        vm.removeFile(path);
    }

    // --- environment and the real run() --------------------------------------------------------

    function _setEnv(
        address admin_,
        address compliance_,
        address minter_,
        address settler_,
        address pauser_
    ) internal {
        vm.setEnv("ADMIN_ADDRESS", vm.toString(admin_));
        vm.setEnv("COMPLIANCE_ADDRESS", vm.toString(compliance_));
        vm.setEnv("MINTER_ADDRESS", vm.toString(minter_));
        vm.setEnv("SETTLER_ADDRESS", vm.toString(settler_));
        vm.setEnv("PAUSER_ADDRESS", vm.toString(pauser_));
    }

    function _assertRoles(
        ComplianceRegistry registry,
        SettlementToken token,
        address expectedAdmin,
        address compliance_,
        address minter_,
        address settler_,
        address pauser_
    ) internal view {
        bytes32 adminRole = registry.DEFAULT_ADMIN_ROLE();
        assertEq(address(token.registry()), address(registry), "token wired to registry");
        assertTrue(registry.hasRole(registry.COMPLIANCE_ROLE(), compliance_), "compliance");
        assertTrue(token.hasRole(token.MINTER_ROLE(), minter_), "minter");
        assertTrue(token.hasRole(token.SETTLER_ROLE(), settler_), "settler");
        assertTrue(token.hasRole(token.PAUSER_ROLE(), pauser_), "pauser");
        assertTrue(registry.hasRole(adminRole, expectedAdmin), "registry admin");
        assertTrue(token.hasRole(adminRole, expectedAdmin), "token admin");
    }

    /// @dev One test on purpose. `vm.setEnv` changes the whole process, and forge runs tests in
    /// parallel, so two tests that set the same variable would race each other. It covers both
    /// `_readConfig` and the real, unmodified `run()`.
    function test_environmentDrivesReadConfigAndTheRealRun() public {
        // Set every variable the script reads, so nothing depends on the developer's own shell.
        _setEnv(address(0), compliance, minter, settler, pauser);
        vm.setEnv("TOKEN_NAME", "Settlement Token");
        vm.setEnv("TOKEN_SYMBOL", "STK");
        vm.setEnv("ALLOW_MAINNET", "false");
        vm.setEnv("ALLOW_UNKNOWN_CHAIN", "false");
        vm.setEnv("ALLOW_EOA_ADMIN", "false");
        vm.setEnv("HOLDER_TRANSFERS_ENABLED", "false");

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
        assertFalse(cfg.allowEoaAdmin);
        assertFalse(cfg.holderTransfersEnabled);

        // Optional values are honoured.
        vm.setEnv("ADMIN_ADDRESS", vm.toString(admin));
        vm.setEnv("TOKEN_NAME", "Test Dollar");
        vm.setEnv("ALLOW_MAINNET", "true");
        vm.setEnv("ALLOW_EOA_ADMIN", "true");
        vm.setEnv("HOLDER_TRANSFERS_ENABLED", "true");
        cfg = harness.exposedReadConfig();
        assertEq(cfg.admin, admin);
        assertEq(cfg.tokenName, "Test Dollar");
        assertTrue(cfg.allowMainnet);
        assertTrue(cfg.allowEoaAdmin);
        assertTrue(cfg.holderTransfersEnabled);

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

        _runOnLocalAnvil();
        _runOnATestnet();
    }

    /// @dev The real script on 31337, one account for everything: it deploys, the broadcaster is
    /// the admin, and because this is not a broadcast no record is written.
    function _runOnLocalAnvil() internal {
        string memory pending = "./deployments/31337.pending.json";
        assertFalse(vm.exists(pending), "remove the stale deployments/31337.pending.json first");
        _setEnv(address(0), DEFAULT_SENDER, DEFAULT_SENDER, DEFAULT_SENDER, DEFAULT_SENDER);
        vm.setEnv("ALLOW_MAINNET", "false");
        vm.setEnv("ALLOW_EOA_ADMIN", "false");
        vm.setEnv("HOLDER_TRANSFERS_ENABLED", "false");

        // run() must check the wiring itself: make the token that is about to be deployed (its
        // address follows from the broadcaster's nonce) deny that the minter holds its role.
        Deploy script = new Deploy();
        address nextToken = vm.computeCreateAddress(DEFAULT_SENDER, vm.getNonce(DEFAULT_SENDER) + 1);
        vm.mockCall(
            nextToken,
            abi.encodeWithSignature(
                "hasRole(bytes32,address)", keccak256("MINTER_ROLE"), DEFAULT_SENDER
            ),
            abi.encode(false)
        );
        vm.etch(nextToken, ""); // a mock gives an empty address stub code; the CREATE needs none
        vm.expectRevert(
            abi.encodeWithSelector(Deploy.DeploymentCheckFailed.selector, "minter role")
        );
        script.run();
        vm.stopBroadcast(); // a reverted run leaves its broadcast open in a test
        vm.clearMockedCalls();

        (ComplianceRegistry registry, SettlementToken token) = new Deploy().run();
        _assertRoles(
            registry,
            token,
            DEFAULT_SENDER,
            DEFAULT_SENDER,
            DEFAULT_SENDER,
            DEFAULT_SENDER,
            DEFAULT_SENDER
        );
        assertFalse(token.holderTransfersEnabled());
        assertFalse(vm.exists(pending), "a run outside a broadcast must write no record");
    }

    /// @dev The real script on a testnet: role separation, a multisig admin, the holder switch.
    function _runOnATestnet() internal {
        vm.chainId(84_532);
        string memory pending = "./deployments/84532.pending.json";
        assertFalse(vm.exists(pending), "remove the stale deployments/84532.pending.json first");
        address multisig = _multisigAdmin();

        // An EOA admin is refused off Anvil...
        _setEnv(admin, compliance, minter, settler, pauser);
        Deploy script = new Deploy();
        vm.expectRevert(abi.encodeWithSelector(Deploy.AdminHasNoCode.selector, admin));
        script.run();
        vm.stopBroadcast(); // a reverted run leaves its broadcast open in a test

        // ...the deployer may not keep a service role...
        _setEnv(multisig, compliance, DEFAULT_SENDER, settler, pauser);
        script = new Deploy();
        vm.expectRevert(abi.encodeWithSelector(Deploy.DeployerHoldsServiceRole.selector, "minter"));
        script.run();
        vm.stopBroadcast(); // a reverted run leaves its broadcast open in a test

        // ...and a well separated config deploys, hands admin to the multisig and turns the
        // holder-signed path on because it was asked to.
        _setEnv(multisig, compliance, minter, minter, pauser);
        vm.setEnv("HOLDER_TRANSFERS_ENABLED", "true");
        (ComplianceRegistry registry, SettlementToken token) = new Deploy().run();
        _assertRoles(registry, token, multisig, compliance, minter, minter, pauser);
        bytes32 adminRole = registry.DEFAULT_ADMIN_ROLE();
        assertFalse(registry.hasRole(adminRole, DEFAULT_SENDER), "deployer stepped down");
        assertFalse(token.hasRole(adminRole, DEFAULT_SENDER), "deployer stepped down");
        assertFalse(token.hasRole(token.MINTER_ROLE(), DEFAULT_SENDER));
        assertTrue(token.holderTransfersEnabled());
        assertFalse(vm.exists(pending), "a run outside a broadcast must write no record");
    }
}
