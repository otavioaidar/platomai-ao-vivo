import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("the process exits with an error when its port is taken, so Docker or systemd can restart it", async (t) => {
  const blocker = net.createServer();
  await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
  t.after(() => blocker.close());
  const port = (blocker.address() as net.AddressInfo).port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aovivo-main-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "src/main.ts"], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", DB_PATH: path.join(dir, "t.db"), ANTHROPIC_API_KEY: "", AI_ENABLED: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const code = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(null);
    }, 8_000);
    child.on("exit", (c) => {
      clearTimeout(timer);
      resolve(c);
    });
  });
  assert.equal(code, 1, `expected exit 1, got ${code}; stderr: ${stderr.slice(0, 300)}`);
  assert.match(stderr, /não abriu a porta/);
});
