import { HTTPException } from "hono/http-exception";
import type { Database } from "../database";
import type { PruneBindings } from "../modules/ai/routes";
export type CareopsBindings = PruneBindings & {
  DB: Database;
  ENVIRONMENT: string;
  ENABLE_SYNTHETIC_CAREOPS_DEMO?: string;
  CAREOPS_SYNTHETIC_ORGS?: string;
  CAREOPS_EXTERNAL_DISPATCH_ENABLED?: string;
  MARITIME_AGENT_ID?: string;
  MARITIME_WEBHOOK_TOKEN?: string;
};
export function requireCareops(env: CareopsBindings, orgId: string) {
  if (
    !/^[a-z0-9-]{1,80}$/.test(orgId) ||
    env.ENABLE_SYNTHETIC_CAREOPS_DEMO !== "true" ||
    !(env.CAREOPS_SYNTHETIC_ORGS ?? "").split(",").includes(orgId)
  )
    throw new HTTPException(503, {
      message: "Synthetic CareOps is not enabled",
    });
}
export function maritimeConfigured(env: CareopsBindings) {
  return (
    env.CAREOPS_EXTERNAL_DISPATCH_ENABLED === "true" &&
    /^[a-zA-Z0-9_-]{1,128}$/.test(env.MARITIME_AGENT_ID ?? "") &&
    !!env.MARITIME_WEBHOOK_TOKEN &&
    env.MARITIME_WEBHOOK_TOKEN.length <= 1024
  );
}
