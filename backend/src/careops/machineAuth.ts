import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { tenantDb } from "../database";
import { tokenHash } from "../security";
import { type CareopsBindings, requireCareops } from "./config";
export async function machineAuthenticate(
  request: Request,
  env: CareopsBindings,
  body: string,
) {
  if (request.headers.has("Origin"))
    throw new HTTPException(403, { message: "Machine channel only" });
  const token = (request.headers.get("Authorization") ?? "").replace(
    /^Bearer /,
    "",
  );
  if (!/^[a-z0-9-]{1,80}\.mch_[a-zA-Z0-9_-]{32,256}$/.test(token))
    throw new HTTPException(401, { message: "Machine credential required" });
  const orgId = token.split(".")[0] ?? "";
  const db = tenantDb({ db: env.DB, orgId });
  const now = new Date().toISOString();
  const row = await db
    .statement(
      `SELECT id FROM careops_machine_credentials WHERE org_id = :org AND token_hash=? AND expires_at>? AND revoked_at IS NULL`,
      await tokenHash(token),
      now,
    )
    .first<{ id: string }>();
  if (!row)
    throw new HTTPException(401, {
      message: "Machine credential expired or revoked",
    });
  requireCareops(env, orgId);
  const timestamp = request.headers.get("X-Jeevika-Timestamp") ?? "";
  const nonce = z.uuid().safeParse(request.headers.get("X-Jeevika-Nonce"));
  if (
    !/^\d{10}$/.test(timestamp) ||
    Math.abs(Date.now() - Number(timestamp) * 1000) > 300000 ||
    !nonce.success
  )
    throw new HTTPException(401, {
      message: "Machine replay headers required",
    });
  const hash = await tokenHash(
    `${timestamp}\n${new URL(request.url).pathname}\n${body}`,
  );
  await db
    .statement(
      `INSERT INTO careops_machine_nonces(org_id,credential_id,nonce,request_hash,created_at)
 VALUES(:org,?,?,?,?) ON CONFLICT DO NOTHING`,
      row.id,
      nonce.data,
      hash,
      now,
    )
    .run();
  const stored = await db
    .statement(
      `SELECT request_hash FROM careops_machine_nonces WHERE org_id = :org AND credential_id=? AND nonce=?`,
      row.id,
      nonce.data,
    )
    .first<{ request_hash: string }>();
  if (stored?.request_hash !== hash)
    throw new HTTPException(409, {
      message: "Nonce already bound to another request",
    });
  return orgId;
}
