/**
 * @file The compliance submitter: the `OutboxHandler` for `compliance` outbox rows. It turns a
 * requested compliance change into a signed, recorded and then broadcast registry transaction,
 * with exactly the settlement submitter's discipline (and its machinery from `attempts.ts`):
 *
 * 1. Load the change, its user and its deployment; the deployment must be the gateway's own
 *    (`assertBound`, a retry otherwise, obligation 17). The row's call must be exactly the
 *    change's registry call (account = the user's wallet, flag and value from the action, the
 *    change's reference): anything else is refused, never "corrected".
 * 2. Idempotent per row: a row that already has an attempt rebroadcasts THAT attempt (same bytes,
 *    same nonce); a change no longer `submitted` (confirmed or failed meanwhile) is `done`.
 * 3. Otherwise: the gateway's COMPLIANCE key must be the deployment's recorded compliance signer
 *    (`assertSignerBound(..., 'compliance')`, else alarm and wait); the node's pending nonce and
 *    fee estimate are read first (no lock across a node call); then `commitWithFreshNonce` signs
 *    and verifies the bytes OUTSIDE any lock (`signAndVerify`: the registry as `to`, the registry
 *    call as calldata, the recorded compliance signer as sender), and in ONE transaction fences
 *    the outbox lease, locks `signer_state` (compliance), allocates the nonce, inserts the attempt
 *    and applies SUBMIT `first` through `moveComplianceChange` (version-fenced). Commit before
 *    broadcast (obligation 1).
 * 4. Broadcast with `sendForOutbox`: lease and abort re-checked first; sent / nonce used is
 *    `done`, a refusal by this node is recorded (the attempt still counts until its nonce is
 *    final) and an unknown outcome is thrown, so the dispatcher retries with the SAME bytes.
 */

import type { ChainGateway, ContractCall } from '@bridge/chain';
import type { ChainAttempt, OutboxMessage, PrismaClient } from '@bridge/db';
import { FeeCapExceededError, initialFees } from '@bridge/domain';

import type { AlarmSink } from './alarms';
import {
  commitWithFreshNonce,
  contractCallFromJson,
  fenceOutboxLease,
  insertAttempt,
  sendForOutbox,
} from './attempts';
import { moveComplianceChange } from './compliance-move';
import { registryCallFor } from './compliance-service';
import { SignerMismatchError } from './errors';
import type { HandlerContext, OutboxHandler, OutboxOutcome } from './outbox-dispatcher';
import type { Clock } from './ports';
import { describeError, type SanitizeOptions } from './redact';
import type { InitialFeePolicy } from './settlement-submitter';
import {
  assertBound,
  assertSignerBound,
  bindingOf,
  type DeploymentBinding,
  signingExpectationFor,
} from './signer-binding';
import type { RawTransactionInspector } from './signing';
import type { TransactionOptions } from './transaction';

/** Construction options for `ComplianceSubmitter`. */
export interface ComplianceSubmitterOptions {
  /** The database. */
  readonly prisma: PrismaClient;
  /** The chain; its own `deployment()` is the binding. */
  readonly gateway: ChainGateway;
  /** Decodes signed bytes so they are checked before they are stored. */
  readonly inspector: RawTransactionInspector;
  /** The time source. */
  readonly clock: Clock;
  /** First-attempt fees (the same cap as settlement). */
  readonly fees: InitialFeePolicy;
  /** Transaction settings. */
  readonly transactions?: TransactionOptions;
  /** Literal secrets removed from every error text written. */
  readonly secrets?: readonly string[];
  /** Where alarms go (a signer mismatch). */
  readonly alarms?: AlarmSink;
}

function sameCall(a: ContractCall, b: ContractCall): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Sends `compliance` outbox rows. See the file comment. */
export class ComplianceSubmitter implements OutboxHandler {
  private readonly prisma: PrismaClient;
  private readonly gateway: ChainGateway;
  private readonly inspector: RawTransactionInspector;
  private readonly clock: Clock;
  private readonly binding: DeploymentBinding;
  private readonly fees: InitialFeePolicy;
  private readonly transactions: TransactionOptions;
  private readonly redaction: SanitizeOptions;
  private readonly alarms: AlarmSink | undefined;

  /** @param options Database, gateway, inspector, clock, fee policy and alarm sink. */
  constructor(options: ComplianceSubmitterOptions) {
    this.prisma = options.prisma;
    this.gateway = options.gateway;
    this.inspector = options.inspector;
    this.clock = options.clock;
    this.binding = bindingOf(options.gateway);
    this.fees = options.fees;
    this.transactions = options.transactions ?? {};
    this.redaction = { secrets: [...(options.secrets ?? [])] };
    this.alarms = options.alarms;
  }

  /** @inheritdoc */
  async handle(row: OutboxMessage, context: HandlerContext): Promise<OutboxOutcome> {
    if (row.signer !== 'compliance' || row.complianceChangeId === null) {
      return { failed: 'not_a_compliance_row' };
    }
    const change = await this.prisma.complianceChange.findUnique({
      where: { id: row.complianceChangeId },
      include: { deployment: true, user: { select: { walletAddress: true } } },
    });
    if (change === null) return { failed: 'compliance_change_missing' };
    assertBound(change.deployment, this.binding);
    let call: ContractCall;
    try {
      call = contractCallFromJson(row.call);
    } catch (err) {
      return { failed: 'invalid_call', detail: describeError(err, this.redaction) };
    }
    // The row must ask for exactly this change: never sign a call that writes something else.
    const expected = registryCallFor(change.action, change.user.walletAddress, change.ref);
    if (row.ref !== change.ref || !sameCall(call, expected)) return { failed: 'call_mismatch' };

    const [existing] = await this.prisma.chainAttempt.findMany({
      where: { outboxId: row.id },
      orderBy: [{ nonce: 'desc' }, { bumpsSoFar: 'desc' }, { submittedAt: 'desc' }, { id: 'desc' }],
      take: 1,
    });
    if (existing !== undefined) {
      if (change.status !== 'submitted') return 'done';
      return this.send(change.id, existing, context);
    }
    if (change.status !== 'requested') return 'done';

    try {
      await assertSignerBound(
        this.prisma,
        this.gateway,
        change.deploymentId,
        (detail) =>
          this.alarms?.raise({
            kind: 'signer_mismatch',
            detail,
            complianceChangeId: change.id,
            at: this.clock.now(),
          }),
        'compliance',
      );
    } catch (err) {
      if (err instanceof SignerMismatchError) {
        return { retryAt: new Date(this.clock.now().getTime() + this.fees.feeWaitMs) };
      }
      throw err;
    }
    const signerAddress = this.gateway.signerAddress('compliance');
    const { pending } = await this.gateway.getNonce('compliance');
    const estimate = await this.gateway.estimateFees();
    let fees;
    try {
      fees = initialFees(estimate, { marginBps: this.fees.marginBps, cap: this.fees.feeCap });
    } catch (err) {
      if (err instanceof FeeCapExceededError) {
        return { retryAt: new Date(this.clock.now().getTime() + this.fees.feeWaitMs) };
      }
      throw err;
    }
    const signing = await signingExpectationFor(this.prisma, change.deployment, 'compliance');
    const attempt = await commitWithFreshNonce({
      prisma: this.prisma,
      gateway: this.gateway,
      inspector: this.inspector,
      expected: signing,
      allocation: {
        deploymentId: change.deploymentId,
        signer: 'compliance',
        signerAddress,
        chainPending: pending,
      },
      build: (nonce) => ({ signer: 'compliance', call, nonce, fees }),
      fence: (tx) => fenceOutboxLease(tx, row, this.clock.now()),
      commit: async (tx, request, signed) => {
        const at = this.clock.now();
        const inserted = await insertAttempt(tx, {
          deploymentId: change.deploymentId,
          outboxId: row.id,
          request,
          signed,
          contractAddress: change.deployment.registryAddress,
          bumpsSoFar: 0,
          at,
        });
        await moveComplianceChange(tx, {
          changeId: change.id,
          from: 'requested',
          version: change.version,
          move: { event: 'SUBMIT', kind: 'first' },
          at,
          txHash: signed.hash,
          note: `first attempt signed with compliance nonce ${request.nonce}, recorded before broadcast`,
        });
        return inserted;
      },
      transactions: this.transactions,
    });
    return this.send(change.id, attempt, context);
  }

  private send(
    changeId: string,
    attempt: ChainAttempt,
    context: HandlerContext,
  ): Promise<OutboxOutcome> {
    return sendForOutbox({
      gateway: this.gateway,
      prisma: this.prisma,
      attempt,
      context,
      subject: { entity: 'compliance_change', id: changeId, state: 'submitted' },
      at: () => this.clock.now(),
      redaction: this.redaction,
    });
  }
}
