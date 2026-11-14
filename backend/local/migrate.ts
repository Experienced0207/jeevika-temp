import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { integrationMigrationFiles } from "../../scripts/prepare-integration-migrations";
import type { LocalDatabase } from "./database";

/** Split our SQLite migration scripts while retaining complete trigger bodies. */
export function splitSqlScript(sql: string): string[] {
  const statements: string[] = [];
  let start = 0,
    index = 0,
    depth = 0;
  let trigger = false,
    prefix = "";
  while (index < sql.length) {
    const char = sql[index];
    if (char === "'" || char === '"' || char === "`") {
      const quote = char;
      index++;
      while (index < sql.length) {
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) {
            index += 2;
            continue;
          }
          index++;
          break;
        }
        index++;
      }
      continue;
    }
    if (char === "-" && sql[index + 1] === "-") {
      while (index < sql.length && sql[index] !== "\n") index++;
      continue;
    }
    if (char === "/" && sql[index + 1] === "*") {
      const end = sql.indexOf("*/", index + 2);
      if (end < 0) throw new Error("Unclosed migration comment");
      index = end + 2;
      continue;
    }
    if (char && /[a-zA-Z_]/.test(char)) {
      const tokenStart = index++;
      while (index < sql.length && /[a-zA-Z_0-9]/.test(sql[index] ?? ""))
        index++;
      const token = sql.slice(tokenStart, index).toUpperCase();
      if (prefix.length < 100) prefix += `${token} `;
      if (/^CREATE\s+(TEMP\s+)?TRIGGER\s/.test(prefix)) trigger = true;
      if (trigger && (token === "BEGIN" || token === "CASE")) depth++;
      if (trigger && token === "END") depth--;
      continue;
    }
    if (char === ";" && depth === 0) {
      const statement = sql.slice(start, index + 1).trim();
      if (statement) statements.push(statement);
      start = index + 1;
      prefix = "";
      trigger = false;
    }
    index++;
  }
  if (depth !== 0) throw new Error("Unclosed migration trigger");
  const remaining = sql.slice(start).trim();
  if (remaining) statements.push(remaining);
  return statements;
}
export function migrationScripts() {
  // Missing files are fatal, never silently omit a migration.
  return integrationMigrationFiles.map((path) => readFileSync(path, "utf8"));
}

const legacyColumns: Record<
  string,
  { type: string; defaultValue: string | null }
> = {
  "encounters.tier": { type: "INTEGER", defaultValue: "0" },
  "encounters.token_number": { type: "INTEGER", defaultValue: null },
  "patients.phone_hash": { type: "TEXT", defaultValue: null },
  "patients.dob": { type: "TEXT", defaultValue: null },
  "patients.sex": { type: "TEXT", defaultValue: null },
  "patients.preferred_lang": { type: "TEXT", defaultValue: null },
  "patients.abha_number": { type: "TEXT", defaultValue: null },
  "patients.abha_address": { type: "TEXT", defaultValue: null },
};

function alreadyAppliedLegacyColumn(db: LocalDatabase, sql: string) {
  const match =
    /^ALTER TABLE (patients|encounters) ADD COLUMN ([a-z_]+) (TEXT|INTEGER)( DEFAULT 0)?;$/i.exec(
      sql.trim().replace(/^(?:--[^\n]*\n\s*)+/, ""),
    );
  if (!match) return false;
  const [, table, column] = match;
  const expected = legacyColumns[`${table}.${column}`];
  if (!expected) return false;
  if (
    match[3]?.toUpperCase() !== expected.type ||
    (match[4] ? "0" : null) !== expected.defaultValue
  )
    return false;
  const rows = db.raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
  }>;
  const existing = rows.find((row) => row.name === column);
  if (!existing) return false;
  if (
    existing.type.toUpperCase() !== expected.type ||
    existing.notnull !== 0 ||
    existing.dflt_value !== expected.defaultValue
  )
    throw new Error(`Incompatible legacy column ${table}.${column}`);
  return true;
}

export function migrateLocal(db: LocalDatabase, scripts = migrationScripts()) {
  db.raw.exec("BEGIN IMMEDIATE");
  try {
    for (const [migrationIndex, script] of scripts.entries()) {
      const name = basename(
        integrationMigrationFiles[migrationIndex] ?? "unknown-migration",
      );
      for (const [statementIndex, sql] of splitSqlScript(script).entries()) {
        // Only 0009 promotes the exact eight columns previously added by the
        // local adapter. Introspection skips a documented, schema-checked legacy
        // duplicate; every other SQL/read/constraint error remains fatal.
        if (
          name === "0009_careops_reviews.sql" &&
          alreadyAppliedLegacyColumn(db, sql)
        )
          continue;
        try {
          db.raw.exec(sql);
        } catch (cause) {
          throw new Error(
            `Migration ${name} statement ${statementIndex + 1} failed`,
            { cause },
          );
        }
      }
    }
    db.raw.exec(`INSERT OR IGNORE INTO clinics (org_id,id,name) VALUES
      ('org-jeevika-primary','clinic-delhi-01','JEEVIKA Primary Health Centre'),
      ('org-jeevika-primary','clinic-delhi-02','JEEVIKA Urban Clinic'),
      ('org-jeevika-primary','north','North Clinic'),
      ('org-jeevika-primary','east','East Clinic');`);
    db.raw.exec("COMMIT");
  } catch (error) {
    db.raw.exec("ROLLBACK");
    throw error;
  }
}
