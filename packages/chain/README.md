# @bridge/chain

All chain access for the bridge goes through one interface, `ChainGateway` (`src/types.ts`). It
has two implementations:

- **`ViemChainGateway`**: the real one. It talks JSON-RPC to a node with viem and signs locally
  with the two bridge signers.
- **`FakeChainGateway`**: an in-memory chain that follows the same rules as the two contracts
  (`ComplianceRegistry`, `SettlementToken`) and a node's transaction pool. Every other package's
  unit tests use it.

A parity test (`test/parity.anvil.test.ts`) runs one scenario script against both gateways, the
real one on Anvil with the real contracts. It checks that the outcomes, revert reasons, events,
balances, flags, nonces and historical reads all match.

## The interface

| Method                                                      | Returns                                                                                                         |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `getChainId()`                                              | The chain id the node reports.                                                                                  |
| `getHeadBlock()`                                            | The newest block number.                                                                                        |
| `getBlock(n)`                                               | `{ number, hash, parentHash, timestamp }`, or `null` if there is no block `n` (for example after a reorg).      |
| `signerAddress(signer)`                                     | The lowercase address of `settlement` or `compliance`.                                                          |
| `getNonce(signer)`                                          | `{ confirmed, pending }`. The next free nonce is `pending`.                                                     |
| `estimateFees()`                                            | `{ maxFeePerGas, maxPriorityFeePerGas }`: twice the base fee plus the tip.                                      |
| `submit({ signer, call, nonce, fees })`                     | The tx hash, or a typed `ChainError` (see `src/errors.ts`). A call sent with the wrong signer is rejected.      |
| `getReceipt(hash)`                                          | `{ status, blockNumber, blockHash, revertReason? }`, or `null` while not mined. A revert is a receipt, not an error. |
| `getTransaction(hash)`                                      | `{ signer, nonce, fees, blockNumber \| null }`, or `null` if the node does not know the hash (or it is not ours). |
| `getEvents({ fromBlock, toBlock })`                         | `Minted`, `Burned`, `SettledTransfer`, `Transfer`, `VerificationSet` and `FrozenSet` from both contracts, in chain order. |
| `readBalance` / `readTotalSupply` / `readCompliance`        | Token and registry state at the head, or at a given block number.                                               |

The five calls are `mint`, `burn` and `settleTransfer` (sent by `settlement`), and `setVerified`
and `setFrozen` (sent by `compliance`). `SIGNER_FOR_CALL` maps each call to its signer.

## The fake's controls

The fake starts at block 0 with automine on and a base fee of 1 gwei. Its hashes are
deterministic: a transaction hash depends on its signer, nonce, call and fees, so a re-fee'd
replacement gets a new hash. The controls are synchronous, and `setUnavailable` does not affect
them.

```ts
const chain = new FakeChainGateway({ automine: false });
const call = { kind: 'mint', to: alice, amount: 5_000_000n, ref } as const;
const fees = { maxFeePerGas: 10n ** 10n, maxPriorityFeePerGas: 10n ** 9n };
const tx = await chain.submit({ signer: 'settlement', call, nonce: 0, fees });
chain.setBaseFee(2n * 10n ** 10n); // above the fee cap: the transaction is stuck
chain.mine(3); // still pending
chain.setBaseFee(10n ** 9n);
chain.mine(); // mined (here reverted with NotAllowed: alice is not verified)
chain.reorg({ depth: 1 }); // the block vanishes and the tx goes back to the pool
chain.mine(); // mined again, in a block with a different hash
chain.reorg({ depth: 1, dropTransactions: [tx] }); // the tx is forgotten and nonce 0 is free again
chain.dropTransaction(tx); // evicts a pooled transaction (false here: it is already gone)
chain.injectTransfer(alice, bob, 1n); // a holder-signed transfer: emits Transfer and no reference event
chain.setPaused(true); // the pauser pauses the token in the next block
chain.failNextSubmit(new ChainUnavailableError('timeout'), { accept: true }); // the node took it, the answer was lost
chain.setUnavailable(true); // every gateway call now throws ChainUnavailableError
```

The fake also has read-only accessors for test assertions: `balanceOf`, `totalSupply`,
`complianceOf`, `isPaused`, `tokenReferenceUsed`, `registryReferenceUsed`, `mempoolSize` and
`mempoolHashes`. To change what the affordability check sees, use `setSignerBalance`.

These are the rules the fake follows, and the parity test proves each one against Anvil:

- **Reverts:** a reverted transaction is mined. It uses up its nonce, changes nothing, and its
  receipt is `reverted` with the custom error's name.
- **References:** each contract keeps its own set of used references, and a reference works only
  once in each. On the token, `mint`, `burn` and `settleTransfer` share one set.
- **Compliance:** every balance change needs both ends to be verified and not frozen.

On a few points the fake follows the spec and geth rather than Anvil:

- **Replacements:** the fake requires both fee fields to rise by at least 12.5%. Anvil accepts any
  increase.
- **Fee cap below the base fee:** the fake pools the transaction and leaves it stuck until the
  base fee drops. Anvil refuses it at submission (the gateway throws `SubmissionRejectedError`),
  and evicts a pooled transaction when the base fee rises above its fee cap.

## Running the tests

```sh
pnpm --filter @bridge/chain test       # all tests
pnpm --filter @bridge/chain test:cov   # with the coverage thresholds
pnpm --filter @bridge/chain abi:check  # the committed ABIs match `forge inspect`
```

The `*.anvil.test.ts` files need Foundry, with `anvil` and `forge` on `PATH` or in `~/.foundry/bin`.
Each file starts its own `anvil` on a free port and stops it when it finishes. It deploys the
contracts from `contracts/out/`, running `forge build` first if the artifacts are missing. It
grants the roles the way `contracts/script/Deploy.s.sol` does.

To regenerate the ABIs after a contract change, run `pnpm --filter @bridge/chain abi:generate`
and commit the result.

## Dev keys

The only keys in the tests are Anvil's public development accounts. They are derived at runtime
from the standard test mnemonic (`test/support/dev-accounts.ts`) and are valid only on a local
chain. No key literal appears anywhere in the repository, and no `.env` is used. The gateway
never puts key material in an error message, cause or `JSON.stringify`/`inspect` output, and a
test checks this.
