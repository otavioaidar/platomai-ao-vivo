type Level = "info" | "warn" | "error";

function write(level: Level, msg: string, extra?: unknown) {
  const ts = new Date().toISOString();
  const tail = extra === undefined ? "" : " " + (extra instanceof Error ? extra.message : JSON.stringify(extra));
  const line = `${ts} ${level.toUpperCase().padEnd(5)} ${msg}${tail}`;
  if (level === "info") console.log(line);
  else console.error(line);
}

export const log = {
  info: (msg: string, extra?: unknown) => write("info", msg, extra),
  warn: (msg: string, extra?: unknown) => write("warn", msg, extra),
  error: (msg: string, extra?: unknown) => write("error", msg, extra),
};
