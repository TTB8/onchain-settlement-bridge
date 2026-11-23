---
name: Bug report
about: Something does not behave as the code, the tests or the docs say it should
title: 'bug: '
labels: bug
---

<!--
Security problems (anything that could move money, mint, skip a compliance check or leak a
secret) do NOT belong here. Report them privately, see SECURITY.md.
-->

## What happened

## What you expected

## How to reproduce

Steps from a clean clone (for example `docker compose up -d`, `pnpm setup:local`, `pnpm demo`),
or the failing test.

## Where

- Package or app (`packages/domain`, `packages/engine`, `apps/api`, `contracts`, ...):
- Commit (`git rev-parse --short HEAD`):

## Environment

- OS:
- Node (`node --version`):
- pnpm (`pnpm --version`):
- Foundry (`forge --version`):

## Logs

Paste the relevant lines. Remove anything that is not a local development value (RPC URLs with
keys, real addresses, tokens).
