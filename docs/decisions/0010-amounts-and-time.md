# 0010. Integer amounts in the token's smallest unit, UTC everywhere

**Status:** accepted

## Context

Floating point cannot hold token amounts exactly, and local-time arithmetic misplaces events twice a
year.

## Decision

Amounts are `bigint` in the token's smallest unit (6 decimals: one token is 1,000,000 units) in code,
and `uint256` on chain. The ledger stores amounts as Postgres `bigint`, so a single amount is capped
at 2^63 - 1 units (about 9.2 trillion tokens); the domain rejects anything above
`MAX_LEDGER_AMOUNT` and uses checked addition, so a total that would overflow is refused instead of
wrapping. Every timestamp is UTC (`timestamptz` in Postgres), and time is always passed into domain
functions as an argument.

## Consequences

- Totals are exact and overflow is an error, not a wrong number.
- The cap is far above any realistic balance; widening it would mean `numeric` columns.
- API JSON carries amounts as strings, never numbers.
