import { driftRadar } from "../../../packages/engine";
import {
  careopsTaskSchema,
  careopsTriggerSchema,
} from "../../../packages/shared/contracts";
import { tenantDb, type Database, type Statement } from "../database";

export type BpReading = { sampledAt: string; value: number };
type ObservationRow = {
  id: string;
  observed_start_utc: string;
  value_numeric: number;
};
type TaskRow = {
  id: string;
  patient_id: string;
  kind: string;
  priority: string;
  status: string;
  trigger_day: number;
  created_at: string;
  updated_at: string;
};
const patientId = "P-1042";
const dayMs = 86400000;
const dayOf = (date: string) => Math.floor(Date.parse(date) / dayMs);
const observationId = (at: string) => `careops:${patientId}:${at}`;

/** No raw D1 escape hatch: every statement passes through the :org adapter. */
export function careopsRepo(context: { db: Database; orgId: string }) {
  if (!/^[a-z0-9-]{1,80}$/.test(context.orgId))
    throw new Error("Invalid tenant");
  const db = tenantDb(context);
  const observations = async () =>
    (
      await db
        .statement(
          `SELECT id,observed_start_utc,value_numeric FROM vitalis_observations
     WHERE org_id = :org AND patient_id = ? AND metric_code = '8480-6'
       AND unit = 'mm[Hg]' AND quality = 'verified'
     ORDER BY observed_start_utc DESC,id DESC LIMIT 365`,
          patientId,
        )
        .all<ObservationRow>()
    ).results.reverse();

  return {
    async patientExists() {
      return !!(await db
        .statement(
          "SELECT id FROM patients WHERE org_id = :org AND id = ? AND synthetic = 1",
          patientId,
        )
        .first<{ id: string }>());
    },
    async record(readings: BpReading[]) {
      const now = new Date().toISOString();
      const ingestion: Statement[] = readings.map((r) =>
        db.statement(
          `INSERT INTO vitalis_observations
         (id,org_id,patient_id,metric_code,metric_name,value_numeric,unit,observed_start_utc,source_type,source_id,source_record_id,quality)
         VALUES (?,:org,?,'8480-6','Systolic blood pressure',?,'mm[Hg]',?,'manual','careops',?,'verified')
         ON CONFLICT(id) DO UPDATE SET value_numeric = CASE
           WHEN vitalis_observations.org_id = excluded.org_id
            AND vitalis_observations.patient_id = excluded.patient_id
            AND vitalis_observations.value_numeric = excluded.value_numeric
           THEN vitalis_observations.value_numeric ELSE NULL END`,
          // Observation PK is global in the existing Vitalis schema: include org.
          `${context.orgId}:${observationId(r.sampledAt)}`,
          patientId,
          r.value,
          r.sampledAt,
          observationId(r.sampledAt),
        ),
      );
      // Commit measurements before loading the engine snapshot: the last of
      // concurrent distinct ingestions must evaluate every committed sample.
      // Task/event/outbox writes form a separate atomic batch; failed delivery
      // persistence is recoverable by replaying the immutable measurements.
      await db.batch(ingestion);
      const stored = await observations();
      const drift = driftRadar({
        readings: stored.map((r) => ({
          day: dayOf(r.observed_start_utc),
          value: r.value_numeric,
        })),
      });
      // Daily averaging inside Drift Radar must not hide an individual absolute
      // threshold. Apply its unchanged single-reading rule to raw measurements.
      const absoluteReading = stored.find(
        (r) =>
          driftRadar({
            readings: [
              { day: dayOf(r.observed_start_utc), value: r.value_numeric },
            ],
          }).alert,
      );
      const urgent = absoluteReading !== undefined;
      const trigger = absoluteReading
        ? { day: dayOf(absoluteReading.observed_start_utc) }
        : drift.trace.find((r) => r.alert);
      const statements: Statement[] = [];
      let dedupeKey: string | null = null;
      if (trigger) {
        dedupeKey = `${patientId}:bp_drift:${urgent ? "urgent" : "review"}:${trigger.day}`;
        statements.push(
          db.statement(
            `INSERT INTO careops_tasks (org_id,id,patient_id,kind,priority,status,dedupe_key,trigger_day,created_at,updated_at)
           VALUES (:org,?,?,'bp_drift',?,'open',?,?,?,?) ON CONFLICT(org_id,dedupe_key) DO NOTHING`,
            crypto.randomUUID(),
            patientId,
            urgent ? "urgent" : "review",
            dedupeKey,
            trigger.day,
            now,
            now,
          ),
        );
        statements.push(
          db.statement(
            `INSERT INTO careops_events (org_id,id,task_id,event_type,created_at)
           SELECT org_id,?,id,'drift_detected',? FROM careops_tasks WHERE org_id = :org AND dedupe_key = ?
           ON CONFLICT(org_id,task_id,event_type) DO NOTHING`,
            crypto.randomUUID(),
            now,
            dedupeKey,
          ),
        );
        if (urgent) {
          statements.push(
            db.statement(
              `UPDATE careops_outbox SET state = 'cancelled' WHERE org_id = :org AND state = 'pending'
             AND task_id IN (SELECT id FROM careops_tasks t WHERE t.org_id = careops_outbox.org_id AND t.patient_id = ?)`,
              patientId,
            ),
          );
        } else {
          const payload = careopsTriggerSchema.parse({
            schemaVersion: 1,
            triggerId: crypto.randomUUID(),
          });
          // No JSON payload column: only the allowlisted opaque trigger UUID is stored.
          statements.push(
            db.statement(
              `INSERT INTO careops_outbox (org_id,id,task_id,event_type,created_at)
             SELECT org_id,?,id,'careops.trigger',? FROM careops_tasks WHERE org_id = :org AND dedupe_key = ?
             AND NOT EXISTS (SELECT 1 FROM careops_tasks urgent
               WHERE urgent.org_id = careops_tasks.org_id AND urgent.patient_id = careops_tasks.patient_id
               AND urgent.priority = 'urgent' AND urgent.status IN ('open','in_progress'))
             AND NOT EXISTS (SELECT 1 FROM vitalis_observations absolute_bp
               WHERE absolute_bp.org_id = careops_tasks.org_id AND absolute_bp.patient_id = careops_tasks.patient_id
               AND absolute_bp.metric_code = '8480-6' AND absolute_bp.unit = 'mm[Hg]'
               AND absolute_bp.quality = 'verified' AND absolute_bp.value_numeric >= 180)
             ON CONFLICT(org_id,task_id,event_type) DO NOTHING`,
              payload.triggerId,
              now,
              dedupeKey,
            ),
          );
        }
      }
      if (statements.length) await db.batch(statements);
      const task = dedupeKey
        ? await db
            .statement(
              "SELECT * FROM careops_tasks WHERE org_id = :org AND dedupe_key = ?",
              dedupeKey,
            )
            .first<TaskRow>()
        : null;
      return {
        drift,
        task: task ? mapTask(task) : null,
        readingId: `${context.orgId}:${observationId(readings.at(-1)?.sampledAt ?? now)}`,
      };
    },
    async queue() {
      const rows = (
        await db
          .statement(
            `SELECT * FROM careops_tasks WHERE org_id = :org AND patient_id = ? AND status IN ('open','in_progress')
         ORDER BY CASE priority WHEN 'urgent' THEN 0 ELSE 1 END,created_at,id LIMIT 100`,
            patientId,
          )
          .all<TaskRow>()
      ).results;
      const readings = await observations();
      const drift = readings.length
        ? driftRadar({
            readings: readings.map((r) => ({
              day: dayOf(r.observed_start_utc),
              value: r.value_numeric,
            })),
          })
        : null;
      return rows.map((row) => ({ ...mapTask(row), drift }));
    },
  };
}

function mapTask(row: TaskRow) {
  return careopsTaskSchema.parse({
    id: row.id,
    patientId: row.patient_id,
    kind: row.kind,
    priority: row.priority,
    status: row.status,
    triggerDay: row.trigger_day,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}
