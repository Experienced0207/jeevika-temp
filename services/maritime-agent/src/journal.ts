import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  type CoordinationEnvelope,
  coordinationEnvelopeSchema,
  coordinationResultSchema,
} from "../../../packages/shared/maritime-coordination";
import type { AgentConfig } from "./config";

const entrySchema = z.strictObject({
  envelope: coordinationEnvelopeSchema,
  attempts: z.number().int().min(1).max(3),
  result: coordinationResultSchema,
});
export type JournalEntry = z.infer<typeof entrySchema>;
export function envelopeKey(value: CoordinationEnvelope) {
  return [
    value.schemaVersion,
    value.triggerId,
    value.handoffId,
    value.taskRef,
    value.eventId,
    value.action,
  ].join(":");
}
export class Journal {
  private records = new Map<string, JournalEntry>();
  private loaded?: Promise<void>;
  private writing = Promise.resolve();
  private path: string;
  constructor(private config: AgentConfig) {
    // Namespace caches by credential/origin without storing or logging either.
    const namespace = createHash("sha256")
      .update(`${config.origin ?? ""}\0${config.machineToken ?? ""}`)
      .digest("hex");
    this.path = join(config.dataDir, `journal-${namespace}.json`);
  }
  private async load() {
    if (!this.loaded)
      this.loaded = (async () => {
        let raw: Buffer;
        try {
          const file = await open(this.path, "r");
          try {
            if ((await file.stat()).size > 262144)
              throw new Error("Journal limit");
            raw = await file.readFile();
          } finally {
            await file.close();
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
          throw error;
        }
        if (raw.length > 262144) throw new Error("Journal limit");
        const entries = z
          .array(entrySchema)
          .max(128)
          .parse(JSON.parse(raw.toString("utf8")));
        for (const entry of entries) {
          if (
            entry.envelope.handoffId !== entry.result.handoffId ||
            entry.envelope.eventId !== entry.result.eventId ||
            this.records.has(entry.envelope.handoffId)
          )
            throw new Error("Journal invalid");
          this.records.set(entry.envelope.handoffId, entry);
        }
      })();
    await this.loaded;
  }
  async get(handoffId: string) {
    await this.load();
    return structuredClone(this.records.get(handoffId));
  }
  async hasCapacity() {
    await this.load();
    return this.records.size < 128;
  }
  async put(entry: JournalEntry) {
    const parsed = entrySchema.parse(entry);
    const pending = this.writing.then(async () => {
      await this.load();
      if (
        !this.records.has(parsed.envelope.handoffId) &&
        this.records.size >= 128
      )
        throw new Error("Journal full");
      const records = new Map(this.records);
      records.set(parsed.envelope.handoffId, parsed);
      const body = JSON.stringify([...records.values()]);
      if (Buffer.byteLength(body) > 262144) throw new Error("Journal full");
      await mkdir(this.config.dataDir, { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, body, { mode: 0o600 });
        await rename(temporary, this.path);
        this.records = records;
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
    });
    // Keep the mutex usable after failure, while returning the original failure
    // to this caller. C4 remains the authoritative idempotency boundary.
    this.writing = pending.catch(() => undefined);
    await pending;
  }
}
