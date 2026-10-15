import { escapeHtml, truncate } from "../text.ts";
import { log } from "../log.ts";
import type { Config } from "../config.ts";
import type { Headline, Urgency } from "../types.ts";

export interface Publisher {
  readonly name: string;
  /** False = dry run: the post is only logged. */
  readonly live: boolean;
  publish(h: Headline): Promise<void>;
}

const RANK: Record<Urgency, number> = { normal: 0, alta: 1, urgente: 2 };

export function meetsUrgency(h: Headline, min: Urgency): boolean {
  // An unknown level (e.g. an unvalidated setting) falls back to "alta" instead of silently matching nothing.
  return (RANK[h.urgency] ?? 0) >= (RANK[min] ?? RANK.alta);
}

function label(h: Headline): string {
  return h.urgency === "urgente" ? `URGENTE · ${h.tag}` : h.tag;
}

export function headlineUrl(siteUrl: string, h: Headline): string {
  return `${siteUrl}/#${encodeURIComponent(h.id)}`;
}

/** Telegram channel via the Bot API (free). */
export class TelegramPublisher implements Publisher {
  readonly name = "telegram";
  readonly live: boolean;
  private readonly token: string;
  private readonly chatId: string;
  private readonly siteUrl: string;

  constructor(opts: { token: string; chatId: string; siteUrl: string }) {
    this.token = opts.token;
    this.chatId = opts.chatId;
    this.siteUrl = opts.siteUrl;
    this.live = Boolean(opts.token && opts.chatId);
  }

  format(h: Headline): string {
    const lines = [`<b>${escapeHtml(label(h))}</b>`, h.urgency === "urgente" ? `<b>${escapeHtml(h.headline)}</b>` : escapeHtml(h.headline)];
    if (h.explainer) lines.push(`<i>PlatomAI explica:</i> ${escapeHtml(h.explainer)}`);
    lines.push(`<a href="${escapeHtml(headlineUrl(this.siteUrl, h))}">PlatomAI Ao Vivo</a>`);
    return lines.join("\n");
  }

  async publish(h: Headline): Promise<void> {
    const text = this.format(h);
    if (!this.live) {
      log.info("[telegram: simulação]", { text });
      return;
    }
    const res = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: this.chatId, text, parse_mode: "HTML", link_preview_options: { is_disabled: true } }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Telegram HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

/** Bluesky via the AT Protocol (free). Uses an app password, never the account password. */
export class BlueskyPublisher implements Publisher {
  readonly name = "bluesky";
  readonly live: boolean;
  private readonly service: string;
  private readonly handle: string;
  private readonly appPassword: string;
  private session: { accessJwt: string; did: string } | null = null;

  constructor(opts: { service: string; handle: string; appPassword: string }) {
    this.service = opts.service.replace(/\/$/, "");
    this.handle = opts.handle;
    this.appPassword = opts.appPassword;
    this.live = Boolean(opts.handle && opts.appPassword);
  }

  format(h: Headline): string {
    const prefix = h.urgency === "urgente" ? `URGENTE | ${h.tag}: ` : `${h.tag}: `;
    return truncate(prefix + h.headline, 300);
  }

  private async login(): Promise<{ accessJwt: string; did: string }> {
    const res = await fetch(`${this.service}/xrpc/com.atproto.server.createSession`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier: this.handle, password: this.appPassword }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Bluesky login HTTP ${res.status}`);
    this.session = (await res.json()) as { accessJwt: string; did: string };
    return this.session;
  }

  async publish(h: Headline): Promise<void> {
    const text = this.format(h);
    if (!this.live) {
      log.info("[bluesky: simulação]", { text });
      return;
    }
    const post = async (s: { accessJwt: string; did: string }) =>
      fetch(`${this.service}/xrpc/com.atproto.repo.createRecord`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${s.accessJwt}` },
        body: JSON.stringify({
          repo: s.did,
          collection: "app.bsky.feed.post",
          record: { $type: "app.bsky.feed.post", text, langs: ["pt"], createdAt: new Date().toISOString() },
        }),
        signal: AbortSignal.timeout(10_000),
      });
    let res = await post(this.session ?? (await this.login()));
    if (res.status === 400 || res.status === 401) res = await post(await this.login()); // expired session
    if (!res.ok) throw new Error(`Bluesky HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

export function buildPublishers(cfg: Config): Publisher[] {
  return [
    new TelegramPublisher({ ...cfg.social.telegram, siteUrl: cfg.siteUrl }),
    new BlueskyPublisher(cfg.social.bluesky),
  ];
}
