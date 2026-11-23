/**
 * Unit tests of the pure parts of `pnpm setup:local` (`scripts/lib/local-env.ts`) and of the
 * scripts' JSON-RPC encoding (`scripts/lib/rpc.ts`): every refusal on its own, the record reader,
 * the `.env` rendering and the overwrite rule. No database, no chain.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { toFunctionSelector } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';

import {
  assertEnvIgnored,
  databaseNameOf,
  DEV_ROLE_ADDRESSES,
  deployEnv,
  endpointOf,
  isLoopbackUrl,
  maintenanceUrlOf,
  parseEnvFile,
  parseSetupFlags,
  planEnvWrite,
  readDeploymentRecord,
  renderEnv,
  SetupRefusal,
  targetProblems,
} from '../../scripts/lib/local-env';
import { calldata, SELECTORS, word } from '../../scripts/lib/rpc';

const REPO = join(__dirname, '..', '..');
const TEMPLATE = readFileSync(join(REPO, '.env.example'), 'utf8');

const local = {
  nodeChainId: 31337,
  envChainId: '31337',
  rpcUrl: 'http://127.0.0.1:8545',
  databaseUrl: 'postgresql://bridge:bridge@localhost:5434/bridge',
};

describe('targetProblems: setup only ever touches a local Anvil and a local database', () => {
  it('accepts the docker-compose stack', () => {
    expect(targetProblems(local)).toEqual([]);
    expect(targetProblems({ ...local, rpcUrl: 'http://localhost:8545' })).toEqual([]);
    expect(targetProblems({ ...local, rpcUrl: 'http://[::1]:8545' })).toEqual([]);
  });

  it.each([1, 11155111, 1337, 137, 31338])('refuses a node on chain %d', (chainId) => {
    const problems = targetProblems({ ...local, nodeChainId: chainId });
    expect(problems).toEqual([
      `the node reports chain id ${chainId}; setup:local only deploys to a local Anvil (31337)`,
    ]);
  });

  it('refuses CHAIN_ID other than 31337, even when the node is local', () => {
    expect(targetProblems({ ...local, envChainId: '1' })).toEqual([
      'CHAIN_ID must be 31337 for setup:local',
    ]);
    expect(targetProblems({ ...local, envChainId: undefined })).toHaveLength(1);
  });

  it('refuses a remote RPC or database, and reports every problem at once', () => {
    expect(targetProblems({ ...local, rpcUrl: 'https://rpc.example.org/v2/key' })).toEqual([
      'RPC_URL must point at this machine (localhost / 127.0.0.1) for setup:local',
    ]);
    expect(
      targetProblems({ ...local, databaseUrl: 'postgresql://u:p@db.example.org:5432/bridge' }),
    ).toEqual(['DATABASE_URL must point at this machine (localhost / 127.0.0.1) for setup:local']);
    const all = targetProblems({
      nodeChainId: 1,
      envChainId: '1',
      rpcUrl: 'not a url',
      databaseUrl: undefined,
    });
    expect(all).toHaveLength(4);
    // A refusal never echoes a URL (it can carry an API key or a password).
    expect(all.join(' ')).not.toMatch(/example\.org|not a url/);
  });

  it('endpointOf and isLoopbackUrl never return the value itself', () => {
    expect(endpointOf('postgresql://bridge:secret@localhost:5434/bridge', 5432)).toEqual({
      host: 'localhost',
      port: 5434,
    });
    expect(endpointOf('http://127.0.0.1', 8545)).toEqual({ host: '127.0.0.1', port: 8545 });
    expect(endpointOf('nonsense', 1)).toBeNull();
    expect(isLoopbackUrl('http://127.0.0.2:8545')).toBe(false);
    expect(isLoopbackUrl('http://localhost.example.org')).toBe(false);
    expect(isLoopbackUrl(undefined)).toBe(false);
  });
});

describe('the dev database name', () => {
  it('is read from DATABASE_URL and must be a plain identifier', () => {
    expect(databaseNameOf(local.databaseUrl)).toBe('bridge');
    expect(maintenanceUrlOf(local.databaseUrl)).toBe(
      'postgresql://bridge:bridge@localhost:5434/postgres',
    );
    for (const bad of [
      'postgresql://b:b@localhost:5434/Bridge',
      'postgresql://b:b@localhost:5434/br"idge',
      'postgresql://b:b@localhost:5434/',
      'postgresql://b:b@localhost:5434/a%22%3B%20DROP',
    ]) {
      expect(() => databaseNameOf(bad)).toThrow(SetupRefusal);
    }
    expect(() => databaseNameOf('postgresql://b:b@localhost:5434/postgres')).toThrow(
      /not a system database/,
    );
    expect(() => databaseNameOf('postgresql://b:b@localhost:5434/template1')).toThrow(
      /not a system database/,
    );
    expect(() => databaseNameOf('::')).toThrow(/not a URL/);
  });
});

describe('the dev accounts and the deploy environment', () => {
  it("are Anvil's public accounts #0-#3 and match the signer keys of .env.example", () => {
    const mnemonic = 'test test test test test test test test test test test junk';
    const at = (i: number) =>
      mnemonicToAccount(mnemonic, { addressIndex: i }).address.toLowerCase();
    expect(DEV_ROLE_ADDRESSES).toEqual({
      deployer: at(0),
      settlement: at(1),
      compliance: at(2),
      pauser: at(3),
    });
    // The template documents these two addresses next to the two DEV ONLY keys.
    expect(TEMPLATE.toLowerCase()).toContain(DEV_ROLE_ADDRESSES.settlement);
    expect(TEMPLATE.toLowerCase()).toContain(DEV_ROLE_ADDRESSES.compliance);
  });

  it('gives minter and settler to the settlement signer, compliance to its own account, and never allows a mainnet', () => {
    expect(deployEnv()).toEqual({
      COMPLIANCE_ADDRESS: DEV_ROLE_ADDRESSES.compliance,
      MINTER_ADDRESS: DEV_ROLE_ADDRESSES.settlement,
      SETTLER_ADDRESS: DEV_ROLE_ADDRESSES.settlement,
      PAUSER_ADDRESS: DEV_ROLE_ADDRESSES.pauser,
      TOKEN_NAME: 'Settlement Token',
      TOKEN_SYMBOL: 'STK',
      ALLOW_MAINNET: 'false',
      ALLOW_UNKNOWN_CHAIN: 'false',
      ALLOW_EOA_ADMIN: 'false',
      HOLDER_TRANSFERS_ENABLED: 'false',
    });
  });
});

/** A promoted record as promote-deployment.sh writes it (checksummed addresses). */
function record(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    chainId: 31337,
    deploymentBlock: 0,
    verifiedAtBlock: 12,
    confirmations: 1,
    complianceRegistry: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    settlementToken: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
    deployer: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    admin: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    compliance: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
    minter: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    settler: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    pauser: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
    holderTransfersEnabled: false,
    ...overrides,
  });
}

describe('readDeploymentRecord: the addresses come from the VERIFIED record, or nothing does', () => {
  it('extracts the addresses (lowercase) and the deployment block', () => {
    expect(readDeploymentRecord(record({ deploymentBlock: 7 }), 31337)).toEqual({
      chainId: 31337,
      deploymentBlock: 7n,
      verifiedAtBlock: 12n,
      registry: '0x5fbdb2315678afecb367f032d93f642f64180aa3',
      token: '0xe7f1725e7734ce288f8367e1bb143e90bb3f0512',
      minter: DEV_ROLE_ADDRESSES.settlement,
      settler: DEV_ROLE_ADDRESSES.settlement,
      compliance: DEV_ROLE_ADDRESSES.compliance,
    });
  });

  it.each([
    ['not JSON', '{', /not valid JSON/],
    ['an array', '[]', /not a JSON object/],
    ['null', 'null', /not a JSON object/],
    ['a missing token', record({ settlementToken: undefined }), /settlementToken/],
    ['a short registry', record({ complianceRegistry: '0x1234' }), /complianceRegistry/],
    ['a string block', record({ deploymentBlock: '7' }), /deploymentBlock/],
    ['a negative block', record({ deploymentBlock: -1 }), /deploymentBlock/],
    ['a pending record (not verified)', record({ verifiedAtBlock: undefined }), /verifiedAtBlock/],
    ['another chain', record({ chainId: 1 }), /for chain 1, the node is chain 31337/],
    [
      'registry == token',
      record({ settlementToken: '0x5FbDB2315678afecb367f032d93F642f64180aa3' }),
      /same address/,
    ],
    [
      'a minter that is not the dev settlement signer',
      record({ minter: '0x90F79bf6EB2c4f870365E785982E1f101E93b906' }),
      /dev signers/,
    ],
    [
      'a settler that is not the dev settlement signer',
      record({ settler: '0x90F79bf6EB2c4f870365E785982E1f101E93b906' }),
      /dev signers/,
    ],
    [
      'a compliance role on the settlement signer',
      record({ compliance: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' }),
      /dev signers/,
    ],
  ])('refuses %s', (_name, json, why) => {
    expect(() => readDeploymentRecord(json, 31337)).toThrow(SetupRefusal);
    expect(() => readDeploymentRecord(json, 31337)).toThrow(why);
  });
});

describe('.env', () => {
  const values = {
    TOKEN_ADDRESS: '0x1111111111111111111111111111111111111111',
    REGISTRY_ADDRESS: '0x2222222222222222222222222222222222222222',
  };

  it('is the template with exactly the two addresses replaced, every other line kept', () => {
    const out = renderEnv(TEMPLATE, values);
    const parsed = parseEnvFile(out);
    const original = parseEnvFile(TEMPLATE);
    expect(parsed).toEqual({ ...original, ...values });
    const changed = out.split('\n').filter((l, i) => l !== TEMPLATE.split('\n')[i]);
    expect(changed).toEqual([
      `TOKEN_ADDRESS=${values.TOKEN_ADDRESS}`,
      `REGISTRY_ADDRESS=${values.REGISTRY_ADDRESS}`,
    ]);
    // The rendered file is still a valid environment for both apps (checked by their own suites);
    // here: same number of lines, comments untouched.
    expect(out.split('\n')).toHaveLength(TEMPLATE.split('\n').length);
  });

  it('refuses a key the template does not have, a duplicate key, and an unsafe value', () => {
    expect(() => renderEnv('A=1\n', { B: '2' })).toThrow(/no line for B/);
    expect(() => renderEnv('A=1\nA=2\n', { A: '3' })).toThrow(/twice/);
    expect(() => renderEnv('A=1\n', { A: 'x y' })).toThrow(/cannot hold/);
    expect(() => renderEnv('A=1\n', { A: 'x#y' })).toThrow(/cannot hold/);
  });

  it('planEnvWrite: create a missing file, leave a matching one alone, refuse to overwrite without --force', () => {
    const dep = {
      token: values.TOKEN_ADDRESS,
      registry: values.REGISTRY_ADDRESS,
    };
    expect(planEnvWrite(null, dep, false)).toBe('create');
    expect(planEnvWrite(null, dep, true)).toBe('create');
    const same = {
      TOKEN_ADDRESS: dep.token.toUpperCase().replace('0X', '0x'),
      REGISTRY_ADDRESS: dep.registry,
    };
    expect(planEnvWrite(same, dep, false)).toBe('unchanged');
    expect(planEnvWrite(same, dep, true)).toBe('unchanged');
    for (const other of [
      { ...same, TOKEN_ADDRESS: '0x3333333333333333333333333333333333333333' },
      { ...same, REGISTRY_ADDRESS: '0x3333333333333333333333333333333333333333' },
      {},
    ]) {
      let refusal: unknown;
      try {
        planEnvWrite(other, dep, false);
      } catch (err) {
        refusal = err;
      }
      expect(refusal).toBeInstanceOf(SetupRefusal);
      expect((refusal as SetupRefusal).exitCode).toBe(2);
      expect((refusal as SetupRefusal).message).toMatch(/--force/);
      expect(planEnvWrite(other, dep, true)).toBe('overwrite');
    }
  });

  it('is only written when git ignores it', () => {
    expect(() => assertEnvIgnored(0)).not.toThrow();
    expect(() => assertEnvIgnored(1)).toThrow(/not ignored by git/);
    expect(() => assertEnvIgnored(128)).toThrow(SetupRefusal);
    expect(() => assertEnvIgnored(null)).toThrow(SetupRefusal);
  });

  it('the repository ignores .env and .env.bak but tracks .env.example', () => {
    const gitignore = readFileSync(join(REPO, '.gitignore'), 'utf8').split('\n');
    expect(gitignore).toEqual(expect.arrayContaining(['.env', '.env.*', '!.env.example']));
  });
});

describe('command line', () => {
  it('knows --force, --reset-db and --help, and refuses anything else', () => {
    expect(parseSetupFlags([])).toEqual({ force: false, resetDb: false, help: false });
    expect(parseSetupFlags(['--force', '--reset-db'])).toEqual({
      force: true,
      resetDb: true,
      help: false,
    });
    expect(parseSetupFlags(['--', '-h']).help).toBe(true);
    expect(() => parseSetupFlags(['--forse'])).toThrow(/unknown argument "--forse"/);
    expect(() => parseSetupFlags(['--force=yes'])).toThrow(SetupRefusal);
  });
});

describe('the JSON-RPC encoding of the scripts', () => {
  it('hard-coded selectors are the ABI selectors', () => {
    expect(SELECTORS.balanceOf).toBe(toFunctionSelector('balanceOf(address)'));
    expect(SELECTORS.totalSupply).toBe(toFunctionSelector('totalSupply()'));
    expect(SELECTORS.mint).toBe(toFunctionSelector('mint(address,uint256,bytes32)'));
  });

  it('encodes addresses, integers and bytes32 as 32-byte words', () => {
    expect(word(10n)).toBe(`${'0'.repeat(63)}a`);
    expect(word('0x00000000000000000000000000000000000000Ff')).toBe(`${'0'.repeat(62)}ff`);
    expect(word(`0x${'ab'.repeat(32)}`)).toBe('ab'.repeat(32));
    expect(() => word(-1n)).toThrow(RangeError);
    expect(() => word(2n ** 256n)).toThrow(RangeError);
    expect(() => word('0x12')).toThrow(TypeError);
    expect(calldata('0x70a08231', '0x00000000000000000000000000000000000000Ff')).toBe(
      `0x70a08231${'0'.repeat(62)}ff`,
    );
  });
});
