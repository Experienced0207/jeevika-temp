import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Single clinical whitelist shared with the local runner. Never glob/mix the
// operational 0001_initial_schema / 0004_identity / 0006_patient_auth family.
export const integrationMigrationFiles = [
  "backend/migrations/0001_intake.sql",
  "backend/migrations/0002_pharmacy.sql",
  "backend/migrations/0002_ayusetu_her.sql",
  "backend/migrations/0003_ayusetu_vitalis.sql",
  "backend/migrations/0005_clinic_token_sequences.sql",
  "backend/cbc-migrations/0006_cbc.sql",
  "backend/migrations/0007_careops_prune_maritime.sql",
  "backend/migrations/0008_prune_audit_receipts.sql",
  "backend/migrations/0009_careops_reviews.sql",
  "backend/migrations/0010_careops_workflow.sql",
] as const;

export function prepareIntegrationMigrations(
  destination = resolve(".local/integration-migrations"),
) {
  mkdirSync(destination, { recursive: true });
  const allowed = new Set(
    integrationMigrationFiles.map((path) => basename(path)),
  );
  if (
    readdirSync(destination).some(
      (name) => name.endsWith(".sql") && !allowed.has(name),
    )
  )
    throw new Error("Unexpected SQL file in clinical migration destination");
  for (const path of integrationMigrationFiles)
    copyFileSync(path, resolve(destination, basename(path)));
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  prepareIntegrationMigrations();
  console.log(
    "Prepared the canonical clinical migration set (including CBC and reviews).",
  );
}
