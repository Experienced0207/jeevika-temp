import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import { LocalDatabase } from "../backend/local/database";
import {
  migrateLocal,
  migrationScripts,
  splitSqlScript,
} from "../backend/local/migrate";
import { seedDemo } from "../backend/local/seed";
import { careopsRepo } from "../backend/src/db/careopsRepo";
import { careopsReviewRepo } from "../backend/src/db/careopsReviewRepo";
import {
  integrationMigrationFiles,
  prepareIntegrationMigrations,
} from "../scripts/prepare-integration-migrations";

const databases: LocalDatabase[] = [];
const directories: string[] = [];
const db = () => {
  const value = new LocalDatabase();
  databases.push(value);
  return value;
};
afterEach(() => {
  for (const value of databases.splice(0)) value.close();
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
});
function schema(value: LocalDatabase) {
  return value.raw
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
    )
    .all();
}
describe("canonical clinical migration safety", () => {
  it("applies canonical SQL and concurrent reviews on real local workerd/D1", async () => {
    const worker = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: 'export default { fetch() { return new Response("ok"); } }',
        compatibilityDate: "2026-10-17",
        d1Databases: ["DB"],
      }),
    );
    try {
      const cloudDb = await worker.getD1Database("DB");
      for (const script of migrationScripts())
        await cloudDb.batch(
          splitSqlScript(script)
            .filter((sql) => !/^\s*PRAGMA/i.test(sql))
            .map((sql) => cloudDb.prepare(sql)),
        );
      await seedDemo(cloudDb);
      await cloudDb.batch(
        splitSqlScript(readFileSync("scripts/seed-demo-p1042.sql", "utf8")).map(
          (sql) => cloudDb.prepare(sql),
        ),
      );
      const created = await careopsRepo({ db: cloudDb, orgId: "demo" }).record([
        { sampledAt: "2026-10-08T00:00:00.000Z", value: 150 },
      ]);
      if (!created.task) throw new Error("Missing D1 task");
      const taskId = created.task.id;
      const repo = careopsReviewRepo({ db: cloudDb, orgId: "demo" });
      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          repo.decide(taskId, "nurse", { action: "approve" }),
        ),
      );
      expect(new Set(results.map((r) => r.review.id)).size).toBe(1);
      expect(results[0]?.authorization.agentDispatchPermitted).toBe(false);
      expect(
        (await repo.decide(taskId, "nurse", { action: "complete" })).review
          .toStatus,
      ).toBe("completed");
      expect(
        await cloudDb
          .prepare(
            "SELECT COUNT(*) AS n FROM careops_task_reviews WHERE org_id='demo'",
          )
          .first(),
      ).toMatchObject({ n: 2 });
    } finally {
      await worker.dispose();
    }
  });

  it("produces the same fresh schema through preparation and local execution", () => {
    const directory = mkdtempSync(join(tmpdir(), "clinical-migrations-"));
    directories.push(directory);
    prepareIntegrationMigrations(directory);
    const names = readdirSync(directory).sort();
    expect(names).toEqual(
      integrationMigrationFiles.map((name) => name.split("/").at(-1)).sort(),
    );
    expect(names).toContain("0005_clinic_token_sequences.sql");
    const prepared = db();
    for (const name of names)
      prepared.raw.exec(readFileSync(join(directory, name), "utf8"));
    const local = db();
    migrateLocal(local);
    expect(schema(local)).toEqual(schema(prepared));
    expect(local.raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    migrateLocal(local);
    expect(schema(local)).toEqual(schema(prepared));
  });
  it("preserves an upgraded C2 database and its data", () => {
    const value = db();
    const scripts = migrationScripts();
    for (const sql of scripts.slice(
      0,
      integrationMigrationFiles.findIndex((path) =>
        path.endsWith("0009_careops_reviews.sql"),
      ),
    ))
      value.raw.exec(sql);
    const legacyColumns = scripts[
      integrationMigrationFiles.findIndex((path) =>
        path.endsWith("0009_careops_reviews.sql"),
      )
    ]?.split("-- Human administrative")[0];
    if (!legacyColumns) throw new Error("Missing compatibility migration");
    value.raw.exec(legacyColumns);
    value.raw.exec(
      "INSERT INTO patients (org_id,id,name,birth_date,gender,language,synthetic,phone_hash) VALUES ('demo','P-1042','Synthetic','1974-01-01','female','en-IN',1,'synthetic-hash')",
    );
    migrateLocal(value);
    migrateLocal(value);
    expect(
      value.raw
        .prepare(
          "SELECT phone_hash FROM patients WHERE org_id='demo' AND id='P-1042'",
        )
        .get(),
    ).toMatchObject({ phone_hash: "synthetic-hash" });
    const fresh = db();
    migrateLocal(fresh);
    expect(schema(value)).toEqual(schema(fresh));
  });
  it("upgrades a C3 database with persisted approved CareOps data without rewriting legacy rows", async () => {
    const value = db();
    for (const sql of migrationScripts().slice(0, -1)) value.raw.exec(sql);
    await seedDemo(value);
    value.raw.exec(readFileSync("scripts/seed-demo-p1042.sql", "utf8"));
    const created = await careopsRepo({ db: value, orgId: "demo" }).record([
      { sampledAt: "2026-10-08T00:00:00.000Z", value: 150 },
    ]);
    if (!created.task) throw new Error("Missing C3 task");
    await careopsReviewRepo({ db: value, orgId: "demo" }).decide(
      created.task.id,
      "nurse",
      { action: "approve" },
    );
    const before = value.raw.prepare("SELECT * FROM careops_tasks").all();
    migrateLocal(value);
    migrateLocal(value);
    expect(value.raw.prepare("SELECT * FROM careops_tasks").all()).toEqual(
      before,
    );
    expect(
      value.raw.prepare("SELECT COUNT(*) n FROM careops_task_reviews").get(),
    ).toMatchObject({ n: 1 });
    expect(
      value.raw.prepare("SELECT COUNT(*) n FROM careops_workflows").get(),
    ).toMatchObject({ n: 0 });
    expect(value.raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
  it("fails loudly and rolls back deliberate invalid SQL", () => {
    const value = db();
    expect(() =>
      migrateLocal(value, [
        "CREATE TABLE before_error(id TEXT); THIS IS INVALID SQL;",
      ]),
    ).toThrow("statement 2 failed");
    expect(
      value.raw
        .prepare("SELECT name FROM sqlite_master WHERE name='before_error'")
        .get(),
    ).toBeUndefined();
    migrateLocal(value);
    const before = schema(value);
    expect(() =>
      migrateLocal(value, [...migrationScripts(), "INVALID SQL;"]),
    ).toThrow("unknown-migration");
    expect(schema(value)).toEqual(before);
  });
  it("rejects incompatible legacy columns rather than masking SQL errors", () => {
    const value = db();
    for (const sql of migrationScripts().slice(
      0,
      integrationMigrationFiles.findIndex((path) =>
        path.endsWith("0009_careops_reviews.sql"),
      ),
    ))
      value.raw.exec(sql);
    value.raw.exec("ALTER TABLE patients ADD COLUMN phone_hash INTEGER");
    expect(() => migrateLocal(value)).toThrow(
      "Incompatible legacy column patients.phone_hash",
    );
    expect(
      value.raw
        .prepare(
          "SELECT name FROM pragma_table_info('encounters') WHERE name='tier'",
        )
        .get(),
    ).toBeUndefined();
  });
  it("rejects an unexpected operational migration in the prepared directory", () => {
    const directory = mkdtempSync(join(tmpdir(), "clinical-migrations-"));
    directories.push(directory);
    writeFileSync(join(directory, "0001_initial_schema.sql"), "INVALID SQL;");
    expect(() => prepareIntegrationMigrations(directory)).toThrow(
      "Unexpected SQL file",
    );
  });
});
