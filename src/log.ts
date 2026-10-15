type Level = "info" | "warn" | "error";

const MAX_CAUSES = 3;

/** One error as "CODE message", e.g. "ECONNRESET read ECONNRESET" (the code is skipped when the message has it). */
function describe(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  let msg = e.message;
  if (!msg && e instanceof AggregateError) msg = e.errors.map((x) => (x instanceof Error ? x.message : String(x))).join(", ");
  const code = (e as { code?: unknown }).code;
  if (typeof code === "string" && !msg.includes(code)) msg = `${code} ${msg}`;
  return msg.trim() || e.name;
}

/**
 * An error's message plus its Error.cause chain (up to 3 levels), so "fetch failed" shows the real reason:
 * "fetch failed (causa: UNABLE_TO_GET_ISSUER_CERT_LOCALLY unable to get local issuer certificate)".
 * Only messages and codes are printed, and a Telegram bot token is masked in case one shows up.
 */
export function errorText(err: unknown): string {
  const parts = [describe(err)];
  let e = err instanceof Error ? err.cause : undefined;
  for (let depth = 0; e !== undefined && e !== null && depth < MAX_CAUSES; depth++) {
    parts.push(`causa: ${describe(e)}`);
    e = e instanceof Error ? e.cause : undefined;
  }
  const text = parts.length > 1 ? `${parts[0]} (${parts.slice(1).join("; ")})` : parts[0];
  return text.replace(/bot\d+:[\w-]+/g, "bot***");
}

function write(level: Level, msg: string, extra?: unknown) {
  const ts = new Date().toISOString();
  const tail = extra === undefined ? "" : " " + (extra instanceof Error ? errorText(extra) : JSON.stringify(extra));
  const line = `${ts} ${level.toUpperCase().padEnd(5)} ${msg}${tail}`;
  if (level === "info") console.log(line);
  else console.error(line);
}

export const log = {
  info: (msg: string, extra?: unknown) => write("info", msg, extra),
  warn: (msg: string, extra?: unknown) => write("warn", msg, extra),
  error: (msg: string, extra?: unknown) => write("error", msg, extra),
};
