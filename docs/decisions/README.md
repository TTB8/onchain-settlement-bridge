# Design decisions

Short records of the choices that shape this bridge, and why. Each says what the alternative was and
what it costs, so a reader can disagree with the reasoning and not only with the result.

| #                                                | Decision                                                              |
| ------------------------------------------------ | --------------------------------------------------------------------- |
| [0001](0001-database-is-authoritative.md)        | The database stays the source of truth; the chain enforces and records |
| [0002](0002-transactional-outbox.md)             | A transactional outbox; the chain is never called inside a transaction |
| [0003](0003-single-use-references.md)            | Every on-chain action carries a single-use reference                   |
| [0004](0004-pure-domain-package.md)              | All bridge rules live in a pure domain package                         |
| [0005](0005-chain-gateway-fake-and-parity.md)    | One chain interface, a faithful fake, and a parity test                |
| [0006](0006-settle-on-final-evidence.md)         | Decide on final evidence, never on the head                            |
| [0007](0007-never-reverse-on-absence-of-evidence.md) | Never release held funds because something was not seen            |
| [0008](0008-compliance-in-the-contract.md)       | Compliance is enforced by the contracts, in a custodial model          |
| [0009](0009-unknown-outcomes-fail-safe.md)       | An unknown outcome is not a rejection                                  |
| [0010](0010-amounts-and-time.md)                 | Integer amounts in the smallest unit, UTC everywhere                   |
| [0011](0011-deployment-binding.md)               | Operations are bound to one deployment; a record is never silently replaced |
| [0012](0012-engine-obligations.md)               | What the engine must do for the safety properties to hold              |

Format: context, decision, consequences. A decision that is replaced is marked superseded, not
edited away.
