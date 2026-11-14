import { isIP } from "node:net";
import { z } from "zod";

const hostnameSchema = z
  .string()
  .min(3)
  .max(253)
  .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/);
export type AgentConfig = {
  port: number;
  origin?: string;
  machineToken?: string;
  dataDir: string;
  timeoutMs: number;
};
export function loadAgentConfig(
  env: Record<string, string | undefined>,
): AgentConfig {
  const port = z.coerce.number().int().min(1).max(65535).parse(env.PORT);
  const dataDir = z
    .string()
    .regex(/^\/[a-zA-Z0-9/_-]+$/)
    .max(300)
    .parse(env.JEEVIKA_AGENT_DATA_DIR ?? "/data/jeevika");
  const timeoutMs = z.coerce
    .number()
    .int()
    .min(100)
    .max(5000)
    .parse(env.JEEVIKA_TOOL_TIMEOUT_MS ?? "3000");
  const config: AgentConfig = { port, dataDir, timeoutMs };
  if (env.JEEVIKA_MACHINE_TOKEN)
    config.machineToken = z
      .string()
      .min(32)
      .max(512)
      .regex(/^[A-Za-z0-9._-]+$/)
      .parse(env.JEEVIKA_MACHINE_TOKEN);
  if (env.JEEVIKA_API_ORIGIN || env.JEEVIKA_ALLOWED_HOSTNAME) {
    const hostname = hostnameSchema.parse(env.JEEVIKA_ALLOWED_HOSTNAME);
    const url = new URL(z.string().min(1).parse(env.JEEVIKA_API_ORIGIN));
    if (
      url.protocol !== "https:" ||
      url.hostname !== hostname ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      isIP(hostname) ||
      !hostname.includes(".") ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".") ||
      hostname.includes("..")
    )
      throw new Error("Invalid JEEVIKA origin");
    config.origin = url.origin;
  }
  return config;
}
