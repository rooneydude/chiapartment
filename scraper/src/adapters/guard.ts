import { SiteBlockedError } from "./types";

/**
 * Shared guards for the site adapters: telling a bot-protection refusal from
 * the site's own content, and keeping long notices instead of dropping them.
 */

const CHALLENGE =
  /imunify360|bot-protection|access denied|just a moment|one moment, please|verif(y|ying) you are (a )?human|captcha|attention required|request blocked|cf-chl|cloudflare ray id/i;
/** A real leasing page is hundreds of KB; challenge and refusal pages are a few KB. */
const SMALL_BODY = 20_000;

/** A flat refusal status, or a small page that reads like a challenge. */
export function looksLikeChallenge(body: string, status = 200): boolean {
  if (status === 401 || status === 403 || status === 429) return true;
  return body.length < SMALL_BODY && CHALLENGE.test(body);
}

function titleOf(body: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body);
  return m ? m[1]!.replace(/\s+/g, " ").trim().slice(0, 80) : "";
}

/** What was served, for an error message that can be diagnosed later. */
export function describeResponse(status: number, contentType: string | null, body: string): string {
  const title = titleOf(body);
  return `HTTP ${status}, ${contentType ?? "no content type"}, ${body.length} bytes${title ? `, title "${title}"` : ""}`;
}

/**
 * Throw SiteBlockedError when the site answered with its bot protection
 * instead of the page. A refusal is recorded and left alone: no retry in the
 * same run, no workaround — the next scheduled run simply asks again.
 */
export function throwIfRefused(
  what: string,
  status: number,
  contentType: string | null,
  body: string,
): void {
  if (!looksLikeChallenge(body, status)) return;
  throw new SiteBlockedError(
    `the site's bot protection refused ${what} (${describeResponse(status, contentType, body)}) — left alone; the next scheduled run will ask again`,
  );
}

/**
 * A building-wide notice (a special, a disclaimer) at a readable length. A
 * long one — fine print added to an offer — is shortened at a word boundary;
 * it is never dropped: the headline of the offer is what matters.
 */
export function clipNotice(text: string, max = 300): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:—–-]+$/, "")}…`;
}
