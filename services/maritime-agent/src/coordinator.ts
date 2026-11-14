import {
  type CoordinationContext,
  type CoordinationDraft,
  type CoordinationEnvelope,
  type CoordinationResult,
  type CoordinationTool,
  coordinationContextSchema,
  coordinationDraftSchema,
  coordinationEventAckSchema,
} from "../../../packages/shared/maritime-coordination";
import type { AgentConfig } from "./config";
import { envelopeKey, Journal, type JournalEntry } from "./journal";
import { type MachineTools, ToolFailure } from "./transport";

export class AgentFailure extends Error {
  constructor(
    readonly status: 409 | 503,
    readonly code:
      | "HANDOFF_CONFLICT"
      | "NOT_CONFIGURED"
      | "JOURNAL_UNAVAILABLE"
      | "CAPACITY_LIMIT"
      | "TIME_BUDGET",
  ) {
    super(code);
  }
}
export class Coordinator {
  private journal: Journal;
  private inFlight = new Map<
    string,
    { key: string; promise: Promise<CoordinationResult> }
  >();
  constructor(
    private config: AgentConfig,
    private tools: MachineTools,
  ) {
    this.journal = new Journal(config);
  }
  async run(envelope: CoordinationEnvelope): Promise<CoordinationResult> {
    if (!this.config.origin || !this.config.machineToken)
      throw new AgentFailure(503, "NOT_CONFIGURED");
    const active = this.inFlight.get(envelope.handoffId);
    if (active) {
      if (active.key !== envelopeKey(envelope))
        throw new AgentFailure(409, "HANDOFF_CONFLICT");
      return active.promise;
    }
    if (this.inFlight.size >= 8) throw new AgentFailure(503, "CAPACITY_LIMIT");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = this.execute(envelope, controller.signal);
    const promise = Promise.race([
      work,
      new Promise<CoordinationResult>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new AgentFailure(503, "TIME_BUDGET"));
        }, 22000);
        timer.unref();
      }),
    ]);
    this.inFlight.set(envelope.handoffId, {
      key: envelopeKey(envelope),
      promise,
    });
    try {
      return await promise;
    } finally {
      clearTimeout(timer);
      if (controller.signal.aborted)
        void work
          .finally(() => this.inFlight.delete(envelope.handoffId))
          .catch(() => undefined);
      else this.inFlight.delete(envelope.handoffId);
    }
  }
  private async execute(
    envelope: CoordinationEnvelope,
    signal: AbortSignal,
  ): Promise<CoordinationResult> {
    let existing: JournalEntry | undefined;
    try {
      existing = await this.journal.get(envelope.handoffId);
    } catch {
      throw new AgentFailure(503, "JOURNAL_UNAVAILABLE");
    }
    if (existing) {
      if (envelopeKey(existing.envelope) !== envelopeKey(envelope))
        throw new AgentFailure(409, "HANDOFF_CONFLICT");
      if (existing.result.state !== "retryable") return existing.result;
    } else if (!(await this.journal.hasCapacity()))
      throw new AgentFailure(503, "CAPACITY_LIMIT");
    const attempts = (existing?.attempts ?? 0) + 1;
    if (existing && attempts > 3)
      return { ...existing.result, state: "failed", code: "ATTEMPT_LIMIT" };
    const completedTools: CoordinationTool[] = [];
    let currentTool: CoordinationTool = "fetch_context";
    let context: CoordinationContext | undefined;
    let draft: CoordinationDraft | undefined;
    let calls = 0;
    const post = async (
      tool: CoordinationTool,
      payload: unknown,
      key: string,
    ) => {
      if (signal.aborted) throw new ToolFailure("TOOL_TIMEOUT", true);
      if (++calls > 4) throw new ToolFailure("ATTEMPT_LIMIT", false);
      return this.tools.post(tool, payload, key);
    };
    const matches = (value: CoordinationEnvelope & { leaseId?: string }) => {
      if (
        envelopeKey(value) !== envelopeKey(envelope) ||
        (context && value.leaseId !== context.leaseId)
      )
        throw new ToolFailure("REFERENCE_MISMATCH", false);
    };
    const checkExpiry = () => {
      if (context && Date.parse(context.expiresAt) <= Date.now())
        throw new ToolFailure("CONTEXT_EXPIRED", false);
    };
    try {
      await this.journal.put({
        envelope,
        attempts,
        result: {
          schemaVersion: 1,
          handoffId: envelope.handoffId,
          eventId: envelope.eventId,
          state: "retryable",
          completedTools: [],
          diagnosticRecorded: false,
        },
      });
      const parsed = coordinationContextSchema.safeParse(
        await post("fetch_context", envelope, `${envelope.eventId}:context`),
      );
      if (!parsed.success) throw new ToolFailure("UPSTREAM_INVALID", false);
      matches(parsed.data);
      if (Date.parse(parsed.data.expiresAt) > Date.now() + 300000)
        throw new ToolFailure("CONTEXT_EXPIRED", false);
      context = parsed.data;
      checkExpiry();
      completedTools.push("fetch_context");
      await this.journal.put({
        envelope,
        attempts,
        result: {
          schemaVersion: 1,
          handoffId: envelope.handoffId,
          eventId: envelope.eventId,
          state: "retryable",
          completedTools: [...completedTools],
          diagnosticRecorded: false,
        },
      });
      currentTool = "request_draft";
      checkExpiry();
      const response = coordinationDraftSchema.safeParse(
        await post(
          "request_draft",
          {
            ...envelope,
            leaseId: context.leaseId,
            workflow: "careops_followup",
            language: context.language,
          },
          `${envelope.eventId}:draft`,
        ),
      );
      if (!response.success) throw new ToolFailure("UPSTREAM_INVALID", false);
      matches(response.data);
      draft = response.data;
      completedTools.push("request_draft");
      currentTool = "propose_review";
      checkExpiry();
      const ack = coordinationEventAckSchema.safeParse(
        await post(
          "propose_review",
          { ...draft, state: "proposed_for_nurse_review" },
          `${envelope.eventId}:proposal`,
        ),
      );
      if (!ack.success || ack.data.state !== "accepted_for_review")
        throw new ToolFailure("UPSTREAM_INVALID", false);
      if (ack.data.draftRef !== draft.draftRef)
        throw new ToolFailure("REFERENCE_MISMATCH", false);
      matches(ack.data);
      completedTools.push("propose_review");
      const result: CoordinationResult = {
        schemaVersion: 1,
        handoffId: envelope.handoffId,
        eventId: envelope.eventId,
        state: "proposed_for_nurse_review",
        completedTools,
        diagnosticRecorded: true,
        provider: draft.provider,
        receiptStatus: draft.receiptStatus,
      };
      await this.journal.put({ envelope, attempts, result });
      return result;
    } catch (error) {
      const failure =
        error instanceof ToolFailure
          ? error
          : new ToolFailure("JOURNAL_UNAVAILABLE", true);
      const result: CoordinationResult = {
        schemaVersion: 1,
        handoffId: envelope.handoffId,
        eventId: envelope.eventId,
        state: failure.retryable && attempts < 3 ? "retryable" : "failed",
        completedTools: [...completedTools],
        failedTool: currentTool,
        code:
          failure.retryable && attempts >= 3 ? "ATTEMPT_LIMIT" : failure.code,
        diagnosticRecorded: false,
        ...(draft
          ? { provider: draft.provider, receiptStatus: draft.receiptStatus }
          : {}),
      };
      if (
        context &&
        currentTool === "request_draft" &&
        failure.code !== "JOURNAL_UNAVAILABLE"
      ) {
        try {
          checkExpiry();
          const ack = coordinationEventAckSchema.safeParse(
            await post(
              "propose_review",
              {
                ...envelope,
                leaseId: context.leaseId,
                state: result.state,
                failedTool: currentTool,
                code: result.code,
              },
              `${envelope.eventId}:diagnostic:${result.state}`,
            ),
          );
          if (ack.success && ack.data.state === "diagnostic_recorded") {
            matches(ack.data);
            result.diagnosticRecorded = true;
          }
        } catch {
          /* A failed diagnostic is not claimed as delivered. */
        }
      }
      try {
        await this.journal.put({ envelope, attempts, result });
      } catch {
        throw new AgentFailure(503, "JOURNAL_UNAVAILABLE");
      }
      return result;
    }
  }
}
