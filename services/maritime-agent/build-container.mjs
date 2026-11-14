import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const contextFiles = [
  "services/maritime-agent/Dockerfile",
  "services/maritime-agent/package.json",
  "services/maritime-agent/package-lock.json",
  "services/maritime-agent/src/config.ts",
  "services/maritime-agent/src/transport.ts",
  "services/maritime-agent/src/journal.ts",
  "services/maritime-agent/src/coordinator.ts",
  "services/maritime-agent/src/server.ts",
  "packages/shared/maritime-coordination.ts",
];
export function stageContainerContext(destination) {
  let size = 0;
  for (const relative of contextFiles) {
    const source = join(root, relative);
    const stat = lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error("Invalid build context entry");
    size += stat.size;
    if (size > 2097152) throw new Error("Build context exceeds limit");
    const content = readFileSync(source, "utf8");
    if (
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk-proj-|prune_)[A-Za-z0-9_-]{20,}/.test(
        content,
      )
    )
      throw new Error("Build context secret scan failed");
    mkdirSync(dirname(join(destination, relative)), { recursive: true });
    copyFileSync(source, join(destination, relative));
  }
  return { files: contextFiles.length, bytes: size };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const temporary = mkdtempSync(join(tmpdir(), "jeevika-c3-docker-context-"));
  try {
    const tag = process.argv[2] ?? "jeevika-maritime-agent:local";
    const platform = process.argv[3] ?? "linux/amd64";
    if (!/^[a-z0-9][a-z0-9._/-]*:[a-z0-9._-]+$/.test(tag))
      throw new Error("Invalid local image tag");
    if (!["linux/amd64", "linux/arm64"].includes(platform))
      throw new Error("Invalid image platform");
    const scan = stageContainerContext(temporary);
    console.log(
      `Allowlisted build context: ${scan.files} files, ${scan.bytes} bytes; secret scan passed`,
    );
    const result = spawnSync(
      "docker",
      [
        "buildx",
        "build",
        "--load",
        "--platform",
        platform,
        "-f",
        join(temporary, "services/maritime-agent/Dockerfile"),
        "--tag",
        tag,
        temporary,
      ],
      { stdio: "inherit" },
    );
    process.exitCode = result.status ?? 1;
  } catch {
    console.error("Local container build failed");
    process.exitCode = 1;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
