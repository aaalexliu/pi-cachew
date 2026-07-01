/**
 * 🥜 Cachew — keeps a conversation's prompt cache warm with minimal input, so
 * your next real prompt is a cheap cache *read* instead of an expensive cache
 * *write*. Works for any provider/model pi can stream (built-in or custom
 * gateway providers).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHEN DOES THE CACHE EXPIRE?
 *
 *   - Anthropic prompt cache (direct or via Bedrock), default "short" retention
 *       → **5-minute sliding TTL** (each read resets the 5-min clock).
 *       e.g. Claude Opus  cacheWrite $6.25/Mtok · cacheRead $0.50/Mtok
 *   - Models with no caching → gateway/provider rejects cache points
 *   - OpenAI auto-cache      → ~5-10 min idle, not directly controllable
 *
 * By default Cachew only warms models that actually advertise caching
 * (cost.cacheRead > 0). Set WARM_ANY_MODEL = true to warm everything anyway.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * TWO WAYS TO KEEP WARM  (config: DEFAULT_MODE, toggle: /cachew mode magic|session)
 *
 *  • "magic"  (behind the scenes, default)
 *    ── EXACTLY WHAT IT DOES ───────────────────────────────────────────────
 *    Prompt caches are *prefix-addressed*: a request is a cache hit only if its
 *    leading tokens (tools → system → message history) are byte-identical to a
 *    previous request, up to the provider's cache breakpoint. Reading that
 *    cached prefix resets its TTL; you pay only the cheap cacheRead rate for it.
 *
 *    PREFERRED (replay): Cachew captures the *exact serialized request* pi last
 *    sent to the provider via the `before_provider_request` event. That payload
 *    is the literal wire body (Bedrock ConverseStreamCommandInput, Anthropic
 *    params, …) with system/messages/tools/cache-points already baked in. At
 *    ping time it replays that blob verbatim through the provider's `onPayload`
 *    hook — zero reconstruction, so zero drift. The ONLY field it touches is the
 *    output-token cap (→ 1), whose name is provider-specific (see
 *    `capOutputTokens`). The request already ends in a user/tool turn (pi only
 *    calls the model to generate a reply), so no throwaway turn is needed.
 *
 *    FALLBACK (reconstruct): if no usable payload was captured yet (no real
 *    request since launch, or an unrecognised wire shape), Cachew reconstructs
 *    the *exact* prefix pi would send:
 *      - the message history, run through pi's own `convertToLlm()` (identical
 *        serialization pi uses), so the bytes match;
 *      - the live system prompt (`ctx.getSystemPrompt()`);
 *      - the active tool set (`getActiveTools()` ∩ `getAllTools()`), in order;
 *      and appends ONE throwaway "." user turn (idle conversations end on an
 *      assistant message, which isn't a valid trailing turn).
 *    Then, ~WARM_EVERY_MS after the last activity (only while idle), it:
 *      1. looks up the provider for the model's api via `getApiProvider(model.api)`
 *         — this resolves built-in AND custom providers (e.g. a custom Bedrock
 *         gateway), because pi registers them into the same shared api registry;
 *      2. resolves auth/headers/env for the model via the model registry;
 *      3. calls the provider's `streamSimple()` with maxTokens: 1 and
 *         cacheRetention "short" (matching pi's default) plus an abort signal,
 *         passing `onPayload` to replay the captured request in replay mode.
 *         (We deliberately do NOT pass reasoning:"off" — the Bedrock streamer
 *         rejects it with a SerializationException; omitting it disables
 *         extended thinking anyway.)
 *    The provider re-reads the long cached prefix (cheap) and emits ~1 token.
 *    The TTL is refreshed. **None of this is written to your session history.**
 *    Net cost ≈ cacheRead(prefix) + a couple input tokens + 1 output token.
 *    (Opus, 100k ctx: ~$0.05/ping vs a $0.625 cold cacheWrite.)
 *
 *    SAFETY: if a ping comes back as a cache *write* (read == 0 / write > read),
 *    the prefix drifted and we paid near-full price. After MAX_CONSEC_MISSES
 *    such pings in a row Cachew disables itself and warns you.
 *
 *    SLEEP-AWARENESS: relative timers freeze while the machine sleeps, so a nap
 *    longer than the TTL always expires the cache (the CPU is frozen — nothing
 *    can keep it warm). Cachew won't waste money re-warming for nobody on wake:
 *    it tracks a wall-clock `lastWarmAt` anchor and, before each ping, checks
 *    `isCacheCold()`. If we overslept the TTL it SKIPS the ping (no auto-rewarm)
 *    and waits for real activity to re-warm lazily — a real user turn pays the
 *    unavoidable write once, at the same price. A large clock jump between the
 *    1s display ticks is treated as a wake and cancels any overdue ping.
 *
 *  • "session"  (visible)
 *    Just sends a literal "." as a real user message into the conversation on
 *    the timer. pi builds the request, so it's a guaranteed-faithful cache read,
 *    but it adds a "." user turn + a short assistant reply to your history and
 *    costs that reply's output tokens. Dead simple; no snapshotting.
 *
 * Footer shows mode, seconds-until-next-ping, and hit rate.
 */

import {
	convertToLlm,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionUIContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";

// The current model as pi types it on the extension context (Model<any> | undefined).
type CurrentModel = ExtensionContext["model"];
// Inside extensions, "@earendil-works/pi-ai" is aliased to the compat entry,
// which is the same api-provider registry pi registers custom providers into.
import { getApiProvider } from "@earendil-works/pi-ai";
// matchesKey normalizes both legacy escape sequences AND the Kitty keyboard
// protocol, so arrow/PgUp/PgDn/Esc work regardless of terminal mode. (Hardcoded
// byte sequences miss Kitty-encoded keys — that was the scroll/close bug.)
import { matchesKey } from "@earendil-works/pi-tui";

// ── config ──────────────────────────────────────────────────────────────────
const DEFAULT_MODE: "magic" | "session" = "magic";
const TTL_MS = 5 * 60_000; // provider "short" sliding cache TTL (Anthropic 5 min)
const WARM_EVERY_MS = 4 * 60_000; // fire at 240s — a full 60s under the 5-min TTL
const PING_TIMEOUT_MS = 30_000; // give up on a magic ping after 30s
const MAX_CONSEC_MISSES = 2; // disable magic after this many cache-miss pings
const SESSION_PING_TEXT = "."; // what "session" mode sends into history
// SLEEP-AWARENESS: setTimeout freezes while the machine is asleep, so a laptop
// nap longer than the TTL always expires the cache (unavoidable — the CPU is
// frozen). What we CAN avoid is the wasteful auto-rewarm on wake: if more than
// (TTL − COLD_SKIP_MARGIN_MS) has elapsed since we last warmed, the prefix is
// already cold, so firing a keep-alive would pay a full cacheWrite for nobody
// (a real user turn re-warms at the same price anyway). We skip it and let the
// next real turn re-warm lazily. WAKE_DRIFT_MS: a jump this large between the
// 1s display ticks means we just resumed from sleep — cancel any overdue ping.
const COLD_SKIP_MARGIN_MS = 20_000; // treat cache as cold this long before the TTL
const WAKE_DRIFT_MS = 5_000; // clock jump between display ticks ⇒ resumed from sleep

/**
 * Pure predicate (exported for testing): has the cached prefix almost certainly
 * expired? Anchored to wall-clock time so it stays correct across system sleep,
 * where relative timers freeze. `lastWarmAtMs` is when we last wrote/read the
 * cache (a real turn or a successful ping).
 */
export function isCacheCold(lastWarmAtMs: number, nowMs: number, ttlMs: number, marginMs: number): boolean {
	return nowMs - lastWarmAtMs >= ttlMs - marginMs;
}
const WARM_ANY_MODEL = false; // false → only warm models with cost.cacheRead > 0

function cacheCapable(model: CurrentModel): model is NonNullable<CurrentModel> {
	if (!model) return false;
	if (WARM_ANY_MODEL) return true;
	return (model.cost?.cacheRead ?? 0) > 0;
}

/**
 * The captured payload is replayed as an OPAQUE BLOB — we never inspect the
 * prefix (system / messages / tools / cache breakpoints). The single exception:
 * cap the output to 1 token so the warm ping is cheap. That cap field is the
 * only thing whose name/location is provider-specific, so we recognise known
 * wire shapes and clone-with-override. Returns `undefined` for an unrecognised
 * shape, which signals the caller to fall back to generic reconstruction.
 */
export function capOutputTokens(payload: unknown): unknown | undefined {
	if (!payload || typeof payload !== "object") return undefined;
	const p = payload as Record<string, any>;
	// Bedrock Converse (ConverseStreamCommandInput) — also custom Bedrock gateways.
	if (p.inferenceConfig && typeof p.inferenceConfig === "object") {
		return { ...p, inferenceConfig: { ...p.inferenceConfig, maxTokens: 1 } };
	}
	// Anthropic Messages.
	if ("max_tokens" in p) return { ...p, max_tokens: 1 };
	// OpenAI Responses.
	if ("max_output_tokens" in p) return { ...p, max_output_tokens: 1 };
	// OpenAI Chat Completions.
	if ("max_completion_tokens" in p) return { ...p, max_completion_tokens: 1 };
	// Google Generative AI / Vertex: pi's wire payload is { model, contents, config }
	// with the generation params spread into `config` (so the output cap lives at
	// `config.maxOutputTokens`), NOT a top-level `generationConfig`. Match that shape.
	if (p.config && typeof p.config === "object" && Array.isArray(p.contents)) {
		return { ...p, config: { ...p.config, maxOutputTokens: 1 } };
	}
	return undefined;
}

/**
 * Inspect a captured wire payload and report whether extended thinking /
 * reasoning was enabled (and its token budget). Used purely for cache-miss
 * diagnostics: it lets a single warning say whether the replayed request was a
 * thinking-enabled one capped to 1 output token — the exact condition behind the
 * "thinking drift" hypothesis — so we can confirm or kill that theory from data
 * instead of guessing. Recognises the same wire shapes as `capOutputTokens`.
 */
export function describeThinking(payload: unknown): string {
	if (!payload || typeof payload !== "object") return "thinking n/a";
	const p = payload as Record<string, any>;
	// Bedrock Converse (also custom Bedrock gateways): additionalModelRequestFields.
	const amrf = p.additionalModelRequestFields;
	if (amrf && typeof amrf === "object") {
		const rc = amrf.reasoning_config ?? amrf.reasoningConfig ?? amrf.thinking;
		if (rc && typeof rc === "object") {
			const b = rc.budget_tokens ?? rc.budgetTokens ?? rc.max_tokens;
			return `thinking ON (budget ${b ?? "?"})`;
		}
		if ("reasoning_config" in amrf || "thinking" in amrf) return "thinking ON";
	}
	// Anthropic Messages: thinking: { type: "enabled", budget_tokens }.
	if (p.thinking && typeof p.thinking === "object") {
		if (p.thinking.type === "enabled" || p.thinking.budget_tokens)
			return `thinking ON (budget ${p.thinking.budget_tokens ?? "?"})`;
		return "thinking OFF";
	}
	// OpenAI Responses: reasoning: { effort }.
	if (p.reasoning && typeof p.reasoning === "object") return `reasoning ON (effort ${p.reasoning.effort ?? "?"})`;
	// Google Generative AI / Vertex: config.thinkingConfig (thinkingBudget or thinkingLevel).
	if (p.config?.thinkingConfig) {
		const tc = p.config.thinkingConfig;
		return `thinking ON (budget ${tc.thinkingBudget ?? tc.thinkingLevel ?? "?"})`;
	}
	return "thinking OFF";
}

// ── ping log + overlay ───────────────────────────────────────────────────────
// One row per warm attempt, kept in a small ring buffer so `/cachew log` can show
// an accumulating, scrollable history (#62, #63, …) instead of a single toast.
export type PingRecord = {
	n?: number; // ping # (the `pings` counter); undefined for a skip
	ts: number;
	outcome: "hit" | "miss" | "skip";
	via: string; // replay | reconstruct | session | magic (skip)
	read: number; // cache-read tokens
	write: number; // cache-write tokens
	inTok: number;
	outTok: number;
	cost: number; // total $ for this ping
	costs?: { read: number; write: number; input: number; output: number }; // $ breakdown
	think?: string;
	text?: string; // response text for pings, or the reason note for skips
};
export const PING_LOG_MAX = 500;

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const vwidth = (s: string) => [...stripAnsi(s)].length;
const fmtTokM = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

// Interactive overlay listing recent pings, modelled on the token-graph overlay:
// a duck-typed component with `render(width)` + `handleInput(data)` that `ui.custom`
// drives. Tails the newest ping by default; arrow/PgUp/PgDn/g/G scroll; q/Esc close.
export class CachewLogComponent {
	focused = false;
	private windowStart = 0;
	private follow = true;
	private readonly rows = 18;
	private theme: Theme;
	private getLog: () => PingRecord[];
	private done: (r: undefined) => void;

	constructor(theme: Theme, getLog: () => PingRecord[], done: (r: undefined) => void) {
		this.theme = theme;
		this.getLog = getLog;
		this.done = done;
	}

	invalidate(): void {}

	handleInput(data: string): void {
		const n = this.getLog().length;
		const maxStart = Math.max(0, n - this.rows);
		if (matchesKey(data, "escape") || matchesKey(data, "esc") || data === "q" || data === "\x03") {
			return this.done(undefined);
		}
		const up = (d: number) => {
			this.follow = false;
			this.windowStart = Math.max(0, Math.min(this.windowStart, maxStart) - d);
		};
		const down = (d: number) => {
			this.windowStart = Math.min(maxStart, Math.min(this.windowStart, maxStart) + d);
			if (this.windowStart >= maxStart) this.follow = true;
		};
		if (matchesKey(data, "up") || data === "k") up(1);
		else if (matchesKey(data, "down") || data === "j") down(1);
		else if (matchesKey(data, "pageUp")) up(this.rows);
		else if (matchesKey(data, "pageDown")) down(this.rows);
		else if (matchesKey(data, "home") || data === "g") {
			this.follow = false;
			this.windowStart = 0;
		} else if (matchesKey(data, "end") || data === "G") {
			this.follow = true;
			this.windowStart = maxStart;
		}
	}

	private line(r: PingRecord, innerW: number): string {
		const th = this.theme;
		const num = r.n != null ? `#${r.n}`.padStart(5) : "  ·  ";
		const tag =
			r.outcome === "hit"
				? th.fg("success", "HIT ✅")
				: r.outcome === "miss"
					? th.fg("error", "MISS ⚠️")
					: th.fg("warning", "SKIP ⏭️");
		const via = th.fg("dim", `(${r.via})`);
		let body: string;
		if (r.outcome === "skip") {
			body = th.fg("dim", r.text ?? "cache cold");
		} else {
			const c = r.costs;
			// token counts, then the TOTAL (kept adjacent so it's never truncated),
			// then the per-category $ breakdown (may clip on very narrow terminals).
			const toks =
				`${th.fg("dim", "read")} ${fmtTokM(r.read)} ${th.fg("dim", "write")} ${fmtTokM(r.write)} ` +
				`${th.fg("dim", "in")} ${r.inTok} ${th.fg("dim", "out")} ${r.outTok}`;
			const total = ` ${th.fg("text", `$${r.cost.toFixed(4)}`)}`;
			const breakdown = c
				? th.fg(
						"muted",
						` (read $${c.read.toFixed(4)} · write $${c.write.toFixed(4)} · in $${c.input.toFixed(4)} · out $${c.output.toFixed(4)})`,
					)
				: "";
			const resp = r.text ? th.fg("dim", `  ${JSON.stringify(r.text.slice(0, 20))}`) : "";
			body = toks + total + breakdown + resp;
		}
		const s = ` ${th.fg("dim", num)} ${tag} ${via} ${body}`;
		// hard-truncate to the inner width (ANSI-aware) so the box never wraps
		if (vwidth(s) <= innerW) return s;
		let out = "";
		let w = 0;
		for (const ch of s) {
			if (ch === "\x1b") {
				// copy the whole escape sequence without counting width
				out += ch;
				continue;
			}
			if (w >= innerW - 1) break;
			out += ch;
			if (!/[\d;[m]/.test(ch) || out.slice(-2, -1) !== "\x1b") w += stripAnsi(ch).length;
		}
		return out;
	}

	render(width: number): string[] {
		const th = this.theme;
		const w = Math.min(width, 110);
		const innerW = w - 2;
		const pad = (s: string) => s + " ".repeat(Math.max(0, innerW - vwidth(s)));
		const row = (c: string) => th.fg("border", "│") + pad(c) + th.fg("border", "│");
		const lines: string[] = [];

		const log = this.getLog();
		const n = log.length;
		const hits = log.filter((r) => r.outcome === "hit").length;
		const misses = log.filter((r) => r.outcome === "miss").length;
		const skips = log.filter((r) => r.outcome === "skip").length;

		lines.push(th.fg("border", `╭${"─".repeat(innerW)}╮`));
		lines.push(
			row(
				` ${th.fg("accent", "🥜 Cachew ping log")}  ${th.fg("dim", "hits")} ${hits} · ` +
					`${th.fg("dim", "miss")} ${misses} · ${th.fg("dim", "skip")} ${skips} · ${th.fg("dim", `${n} total`)}`,
			),
		);
		lines.push(
			row(
				` ${th.fg("dim", "read = cacheRead tokens · write = cacheWrite tokens · $ shown per category, = total")}`,
			),
		);
		lines.push(th.fg("border", `├${"─".repeat(innerW)}┤`));

		if (n === 0) {
			lines.push(row(""));
			lines.push(row(` ${th.fg("dim", "No pings yet — warm one with /cachew now.")}`));
			lines.push(row(""));
		} else {
			const maxStart = Math.max(0, n - this.rows);
			if (this.follow) this.windowStart = maxStart;
			const start = Math.max(0, Math.min(this.windowStart, maxStart));
			const slice = log.slice(start, start + this.rows);
			for (const r of slice) lines.push(row(this.line(r, innerW)));
			for (let i = slice.length; i < this.rows; i++) lines.push(row(""));
		}

		lines.push(th.fg("border", `├${"─".repeat(innerW)}┤`));
		const pos = n ? `${Math.min(this.windowStart + this.rows, n)}/${n}` : "0/0";
		lines.push(
			row(
				` ${th.fg("dim", "↑/↓ scroll · PgUp/PgDn · g/G top/bottom · q close")}   ${th.fg("dim", pos)}` +
					(this.follow ? `  ${th.fg("success", "● live")}` : ""),
			),
		);
		lines.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));
		return lines;
	}
}

export default function (pi: ExtensionAPI) {
	type Snapshot = {
		model: NonNullable<CurrentModel>;
		systemPrompt: string;
		messages: ReturnType<typeof convertToLlm>;
		tools: { name: string; description: string; parameters: unknown }[];
	};

	// Captured into closure scope so the bare timer callback (no event `ctx`)
	// can still reach the UI, model registry and current model.
	let ui: ExtensionUIContext | undefined;
	let modelRegistry: ExtensionContext["modelRegistry"] | undefined;
	let currentModel: CurrentModel;
	let snapshot: Snapshot | undefined;
	// The exact serialized request pi last sent to the provider (captured via
	// `before_provider_request`). Opaque/provider-specific; replayed verbatim.
	let capturedPayload: unknown;

	let mode: "magic" | "session" = DEFAULT_MODE;
	let enabled = true;
	let debug = false; // /cachew debug — print full cache metrics + response for EVERY ping
	let warmEveryMs = WARM_EVERY_MS; // mutable at runtime via `/cachew every <seconds>`
	let agentBusy = false;
	let inFlight = false;
	let sessionPingPending = false;

	let warmTimer: ReturnType<typeof setTimeout> | undefined;
	let displayTimer: ReturnType<typeof setInterval> | undefined;
	let nextPingAt = 0;
	// Wall-clock anchor for the sleep-aware skip: the last time we KNOW the cache
	// prefix was written/read (any real provider request or a successful ping).
	let lastWarmAt = Date.now();
	// Wall-clock of the previous 1s display tick; a big jump ⇒ we resumed from sleep.
	let lastTick = Date.now();

	let consecMisses = 0;
	let pings = 0;
	let hits = 0;
	let coldSkips = 0; // pings deliberately skipped because the cache was already cold
	let spentUsd = 0;
	const pingLog: PingRecord[] = []; // ring buffer of recent pings for the /cachew log overlay

	const clearWarm = () => {
		if (warmTimer) clearTimeout(warmTimer);
		warmTimer = undefined;
		nextPingAt = 0;
	};

	const arm = () => {
		clearWarm();
		if (!enabled || agentBusy) return;
		nextPingAt = Date.now() + warmEveryMs;
		warmTimer = setTimeout(() => void warmPing(), warmEveryMs);
	};

	// Sleep-aware guard: have we been idle longer than the cache can survive?
	const cacheLikelyCold = () => isCacheCold(lastWarmAt, Date.now(), TTL_MS, COLD_SKIP_MARGIN_MS);

	const rate = () => (pings ? Math.round((hits / pings) * 100) : 100);
	// Human-readable token counts for the cache-miss diagnostics.
	const fmtTok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
	// Detailed cache-miss warning. Shows exactly what the ping paid for so you
	// can distinguish a TTL lapse (cacheRead 0 → whole prefix re-written) from
	// partial prefix drift (cacheWrite > cacheRead), and whether the ping replayed
	// the captured wire payload or reconstructed the prefix.
	const warnMiss = (via: string, u: any, label: string, extra?: string) => {
		const read = u?.cacheRead ?? 0;
		const write = u?.cacheWrite ?? 0;
		const inTok = u?.input ?? u?.inputTokens ?? 0;
		const outTok = u?.output ?? u?.outputTokens ?? 0;
		const cost = u?.cost?.total ?? 0;
		const why =
			read === 0
				? "cacheRead 0 → whole prefix re-written (TTL lapse / cold cache)"
				: "cacheWrite > cacheRead → prefix drifted mid-request";
		ui?.notify(
			`🥜 Cachew ${label} (${via}) on ${currentModel?.id ?? "model"}: ` +
				`cacheRead ${fmtTok(read)} · cacheWrite ${fmtTok(write)} · ` +
				`input ${fmtTok(inTok)} · out ${outTok} · $${cost.toFixed(4)}` +
				(extra ? ` · ${extra}` : "") +
				`. ${why}.`,
			"warning",
		);
	};
	// Magic mode can only warm something it has captured from a real LLM call.
	const hasWarmTarget = () => capturedPayload !== undefined || snapshot !== undefined;

	// Extract the (usually tiny, maxTokens:1) response text from a ping reply, for
	// the debug readout. Handles string content and content-part arrays.
	const msgText = (m: any): string => {
		const c = m?.content;
		if (typeof c === "string") return c.trim();
		if (Array.isArray(c)) return c.map((p: any) => (typeof p === "string" ? p : (p?.text ?? ""))).join("").trim();
		return "";
	};
	// Per-ping debug readout (only when `debug` is on): full cache metrics + the
	// response text for EVERY ping, hit or miss — most useful in magic mode, where
	// the ping is otherwise completely invisible.
	const reportPing = (via: string, u: any, outcome: "hit" | "miss", responseText?: string, extra?: string) => {
		if (!debug) return;
		const read = u?.cacheRead ?? 0;
		const write = u?.cacheWrite ?? 0;
		const inTok = u?.input ?? u?.inputTokens ?? 0;
		const outTok = u?.output ?? u?.outputTokens ?? 0;
		const cost = u?.cost?.total ?? 0;
		const resp = responseText ? ` · resp ${JSON.stringify(responseText.slice(0, 48))}` : "";
		ui?.notify(
			`🥜 [debug] ping #${pings} ${outcome === "hit" ? "HIT ✅" : "MISS ⚠️"} (${via}) on ${currentModel?.id ?? "model"}: ` +
				`cacheRead ${fmtTok(read)} · cacheWrite ${fmtTok(write)} · input ${fmtTok(inTok)} · out ${outTok} · $${cost.toFixed(4)}` +
				(extra ? ` · ${extra}` : "") +
				resp,
			outcome === "hit" ? "info" : "warning",
		);
	};

	// Always-on recorder (independent of the `debug` toast flag) so `/cachew log`
	// has an accumulating history to show. Cheap: one small object per ping.
	const logPing = (rec: Omit<PingRecord, "ts">) => {
		pingLog.push({ ...rec, ts: Date.now() });
		if (pingLog.length > PING_LOG_MAX) pingLog.shift();
	};

	const render = (note?: string) => {
		if (!ui) return;
		const tag = `🥜 ${mode}${debug ? " 🐛" : ""}`;
		if (!enabled) return ui.setStatus("cachew", `${tag} · off`);
		if (!cacheCapable(currentModel)) return ui.setStatus("cachew", `${tag} · idle (no cache)`);
		let mid: string;
		if (note) mid = note;
		else if (agentBusy) mid = "active";
		else if (mode === "magic" && !hasWarmTarget()) mid = "waiting for 1st turn";
		else if (inFlight) mid = "pinging…";
		else if (nextPingAt) mid = `next ${Math.max(0, Math.ceil((nextPingAt - Date.now()) / 1000))}s`;
		else mid = "ready";
		ui.setStatus("cachew", `${tag} · ${mid} · hit rate ${rate()}% (${hits}/${pings})`);
	};

	const startDisplay = () => {
		if (displayTimer) return;
		lastTick = Date.now();
		displayTimer = setInterval(() => {
			const now = Date.now();
			// A large jump between 1s ticks means the process was suspended (system
			// sleep). If the cache went cold while we slept, cancel the now-overdue
			// ping so it can't fire a doomed full-rewrite; real activity will re-arm.
			if (now - lastTick > WAKE_DRIFT_MS && warmTimer && cacheLikelyCold()) {
				coldSkips++;
				clearWarm();
				logPing({
					outcome: "skip",
					via: mode,
					read: 0,
					write: 0,
					inTok: 0,
					outTok: 0,
					cost: 0,
					text: `woke from sleep — idle ${Math.round((now - lastWarmAt) / 1000)}s ≥ TTL`,
				});
				lastTick = now;
				return render("cold — waiting for activity");
			}
			lastTick = now;
			render();
		}, 1000);
		if (typeof displayTimer === "object" && (displayTimer as any).unref) (displayTimer as any).unref();
	};
	const stopDisplay = () => {
		if (displayTimer) clearInterval(displayTimer);
		displayTimer = undefined;
	};

	const captureRefs = (ctx: ExtensionContext) => {
		ui = ctx.ui;
		modelRegistry = ctx.modelRegistry;
		// pi exposes the current model as the `ctx.model` property (0.80.x).
		// Older pi used a `getModel()` method; keep it as a fallback.
		currentModel = ctx.model ?? (ctx as any).getModel?.();
	};

	// Capture the EXACT serialized request pi sent to the provider — the most
	// faithful thing to replay (no reconstruction drift). Opaque blob; we only
	// ever cap its output tokens at ping time.
	pi.on("before_provider_request", (event, ctx) => {
		captureRefs(ctx);
		// Every real provider request (re)writes the cache prefix, regardless of
		// mode — refresh the wall-clock anchor so the sleep-aware skip is accurate.
		lastWarmAt = Date.now();
		if (mode !== "magic") return;
		capturedPayload = event.payload;
	});

	// Snapshot pi's exact request prefix on every real LLM call (reconstruction
	// fallback for when no captured payload is usable yet).
	pi.on("context", (event, ctx) => {
		captureRefs(ctx);
		if (mode !== "magic" || !cacheCapable(currentModel)) return;
		const active = new Set(pi.getActiveTools?.() ?? []);
		const tools = (pi.getAllTools?.() ?? [])
			.filter((t) => active.has(t.name))
			.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
		snapshot = {
			model: currentModel,
			systemPrompt: ctx.getSystemPrompt(),
			messages: convertToLlm(event.messages),
			tools,
		};
	});

	// Capture usage of the assistant reply to a "session"-mode ping.
	pi.on("message_end", (event) => {
		if (!sessionPingPending || event.message.role !== "assistant") return;
		sessionPingPending = false;
		pings++;
		const u: any = event.message.usage;
		spentUsd += u?.cost?.total ?? 0;
		const hit = (u?.cacheRead ?? 0) > 0 && (u?.cacheRead ?? 0) >= (u?.cacheWrite ?? 0);
		if (hit) {
			hits++;
			lastWarmAt = Date.now();
		}
		if (debug) reportPing("session", u, hit ? "hit" : "miss", msgText(event.message));
		else if (!hit) warnMiss("session", u, "cache-miss ping");
		logPing({
			n: pings,
			outcome: hit ? "hit" : "miss",
			via: "session",
			read: u?.cacheRead ?? 0,
			write: u?.cacheWrite ?? 0,
			inTok: u?.input ?? u?.inputTokens ?? 0,
			outTok: u?.output ?? u?.outputTokens ?? 0,
			cost: u?.cost?.total ?? 0,
			costs: {
				read: u?.cost?.cacheRead ?? 0,
				write: u?.cost?.cacheWrite ?? 0,
				input: u?.cost?.input ?? 0,
				output: u?.cost?.output ?? 0,
			},
			text: msgText(event.message),
		});
	});

	pi.on("agent_start", () => {
		agentBusy = true;
		clearWarm();
		render();
	});
	pi.on("agent_end", () => {
		agentBusy = false;
		arm();
		render();
	});
	pi.on("turn_end", () => {
		if (!agentBusy) arm();
	});
	pi.on("model_select", (event, ctx) => {
		captureRefs(ctx);
		currentModel = event.model;
		// Both the captured payload and the reconstruct snapshot were built for the
		// previous model; drop them so we never replay/reconstruct another model's
		// request (a guaranteed miss). They're re-captured on the next real turn.
		capturedPayload = undefined;
		snapshot = undefined;
		consecMisses = 0;
		arm();
		render();
	});
	pi.on("session_start", (_event, ctx) => {
		captureRefs(ctx);
		lastWarmAt = lastTick = Date.now();
		startDisplay();
		arm();
		render();
	});
	pi.on("session_shutdown", () => {
		clearWarm();
		stopDisplay();
	});

	async function warmPing() {
		clearWarm();
		if (!enabled || agentBusy || inFlight) return;
		if (!cacheCapable(currentModel)) return arm();

		// Sleep-aware skip: if we've been idle longer than the cache TTL (e.g. the
		// laptop slept and froze this timer, so it fired late), the prefix is already
		// cold. Firing now would pay a full cacheWrite to re-warm for nobody — and the
		// next REAL user turn would re-warm at the same price anyway. Skip the
		// auto-rewarm and DON'T re-arm; real activity (agent_end/turn_end) re-arms
		// after the unavoidable lazy re-warm. This is what turns a sleep from
		// "guaranteed miss + wasted ~$0.20 rewrite" into "guaranteed miss, $0 wasted".
		if (cacheLikelyCold()) {
			coldSkips++;
			clearWarm();
			const idle = Math.round((Date.now() - lastWarmAt) / 1000);
			logPing({ outcome: "skip", via: mode, read: 0, write: 0, inTok: 0, outTok: 0, cost: 0, text: `cache cold — idle ${idle}s ≥ TTL` });
			if (debug)
				ui?.notify(
					`🥜 [debug] SKIP (${mode}) on ${currentModel?.id ?? "model"}: cache cold — idle ` +
						`${idle}s ≥ TTL. Not re-warming for nobody; ` +
						`next real turn re-warms lazily.`,
					"info",
				);
			return render("cold — waiting for activity");
		}

		if (mode === "session") {
			// Just send a "." into history; the agent lifecycle re-arms the timer.
			sessionPingPending = true;
			render("warming…");
			pi.sendUserMessage(SESSION_PING_TEXT);
			return;
		}

		// magic mode
		const provider = getApiProvider(currentModel.api);
		if (!provider) return arm();

		// PREFERRED: replay the exact serialized request pi last sent (captured
		// verbatim), with output capped to 1 token. No reconstruction, so no drift.
		// FALLBACK: if we have no usable captured payload (none captured yet, or an
		// unrecognised wire shape), reconstruct the prefix from the snapshot and
		// append a throwaway "." user turn so it's a valid request.
		const replayPayload = capOutputTokens(capturedPayload);

		let context: any;
		if (replayPayload) {
			// Dummy context only needs to survive the pre-onPayload build; it is
			// discarded because onPayload replaces the serialized request entirely.
			context = snapshot
				? { systemPrompt: snapshot.systemPrompt, tools: snapshot.tools, messages: snapshot.messages }
				: {
						systemPrompt: "",
						tools: [],
						messages: [{ role: "user", content: [{ type: "text", text: "." }], timestamp: Date.now() }],
					};
		} else {
			const snap = snapshot;
			if (!snap) return arm();
			const last = snap.messages[snap.messages.length - 1];
			// A valid trailing turn needs a user message; idle conversations end on an
			// assistant message, so append one throwaway "." user turn.
			if (!last || last.role !== "assistant") return arm();
			context = {
				systemPrompt: snap.systemPrompt,
				tools: snap.tools,
				messages: [
					...snap.messages,
					{ role: "user" as const, content: [{ type: "text" as const, text: "." }], timestamp: Date.now() },
				],
			};
		}

		inFlight = true;
		render(replayPayload ? "replaying…" : "pinging…");
		const ac = new AbortController();
		const killer = setTimeout(() => ac.abort(), PING_TIMEOUT_MS);
		try {
			// Resolve auth the same way pi does, and set any env the provider needs.
			let apiKey: string | undefined;
			let headers: Record<string, string> | undefined;
			try {
				const auth = await modelRegistry?.getApiKeyAndHeaders(currentModel);
				if (auth?.ok) {
					apiKey = auth.apiKey;
					headers = auth.headers;
					if (auth.env) for (const [k, v] of Object.entries(auth.env)) process.env[k] = v as string;
				}
			} catch {
				// Custom providers (e.g. a custom Bedrock gateway) resolve their own auth.
			}

			// NOTE: do NOT pass `reasoning: "off"`. The Bedrock streamer rejects it
			// with a SerializationException; omitting it means no extended thinking
			// anyway, and maxTokens:1 keeps the ping minimal (verified live).
			//
			// In replay mode, `onPayload` returns the captured request, which the
			// provider sends verbatim instead of the one built from `context`.
			const stream = provider.streamSimple(currentModel, context as any, {
				apiKey,
				headers,
				maxTokens: 1,
				cacheRetention: "short", // match pi's default window
				signal: ac.signal,
				...(replayPayload ? { onPayload: () => replayPayload } : {}),
			} as any);
			const msg = await stream.result();

			pings++;
			const u: any = msg.usage;
			const read = u?.cacheRead ?? 0;
			const write = u?.cacheWrite ?? 0;
			spentUsd += u?.cost?.total ?? 0;
			const via = replayPayload ? "replay" : "reconstruct";
			const think = replayPayload ? describeThinking(capturedPayload) : "reconstructed prefix (no thinking)";
			const hit = read > 0 && read >= write;
			if (hit) {
				hits++;
				consecMisses = 0;
				lastWarmAt = Date.now();
			} else {
				consecMisses++;
			}
			// Debug: show EVERY ping (hit or miss) with full metrics + response.
			// Otherwise keep the old behaviour: silent hits, warn only on a miss.
			if (debug) reportPing(via, u, hit ? "hit" : "miss", msgText(msg), think);
			else if (!hit) warnMiss(via, u, `cache-miss ping ${consecMisses}/${MAX_CONSEC_MISSES}`, think);
			logPing({
				n: pings,
				outcome: hit ? "hit" : "miss",
				via,
				read,
				write,
				inTok: u?.input ?? u?.inputTokens ?? 0,
				outTok: u?.output ?? u?.outputTokens ?? 0,
				cost: u?.cost?.total ?? 0,
				costs: {
					read: u?.cost?.cacheRead ?? 0,
					write: u?.cost?.cacheWrite ?? 0,
					input: u?.cost?.input ?? 0,
					output: u?.cost?.output ?? 0,
				},
				think,
				text: msgText(msg),
			});

			if (consecMisses >= MAX_CONSEC_MISSES) {
				enabled = false;
				clearWarm();
				ui?.notify(
					`🥜 Cachew paused: ${consecMisses} cache-miss pings in a row (prefix drift). Re-enable with /cachew on.`,
					"warning",
				);
				return render();
			}
			render();
		} catch (err) {
			pings++;
			consecMisses++;
			// A timeout (our own PING_TIMEOUT_MS abort) is a different failure from a
			// provider/serialization error, so say so explicitly instead of surfacing
			// the opaque "The operation was aborted" AbortError message. It still
			// counts toward the auto-pause — repeated timeouts mean the gateway is
			// slow/unreachable and there's no point hammering it.
			const timedOut = ac.signal.aborted;
			const secs = Math.round(PING_TIMEOUT_MS / 1000);
			const reason = timedOut ? `ping timed out after ${secs}s` : (err as Error).message;
			ui?.notify(
				`🥜 Cachew ping error ${consecMisses}/${MAX_CONSEC_MISSES} ` +
					`(${replayPayload ? "replay" : "reconstruct"}) on ${currentModel?.id ?? "model"}: ` +
					`${reason}` +
					(replayPayload ? ` · ${describeThinking(capturedPayload)}` : ""),
				"warning",
			);
			if (consecMisses >= MAX_CONSEC_MISSES) {
				enabled = false;
				clearWarm();
				ui?.notify(
					timedOut
						? `🥜 Cachew paused: ${consecMisses} pings in a row timed out (>${secs}s). ` +
							`The gateway is slow or unreachable — not going to keep hammering it. Re-enable with /cachew on.`
						: `🥜 Cachew paused after repeated ping errors: ${(err as Error).message}. Re-enable with /cachew on.`,
					"warning",
				);
				return render();
			}
			render(timedOut ? "ping timed out" : "ping failed");
		} finally {
			clearTimeout(killer);
			inFlight = false;
			arm();
		}
	}

	// /cachew  — status | on | off | now | reset | debug | log | mode magic|session | every <seconds>
	pi.registerCommand("cachew", {
		description:
			"🥜 keep the prompt cache warm (status|on|off|now|reset|debug [on|off]|log|mode magic|session|every <seconds>)",
		handler: async (args, ctx) => {
			captureRefs(ctx);
			startDisplay();
			const [verb, arg] = (args || "status").trim().toLowerCase().split(/\s+/);
			switch (verb) {
				case "on":
					enabled = true;
					consecMisses = 0;
					arm();
					ctx.ui.notify("🥜 Cachew enabled", "info");
					break;
				case "off":
					enabled = false;
					clearWarm();
					ctx.ui.notify("🥜 Cachew disabled", "info");
					break;
				case "now":
					if (mode === "magic" && !hasWarmTarget()) {
						ctx.ui.notify(
							"🥜 nothing to warm yet — magic mode needs one real turn first (send a prompt).",
							"warning",
						);
						break;
					}
					ctx.ui.notify(`🥜 warming now (${mode})…`, "info");
					await warmPing();
					break;
				case "reset":
					pings = hits = consecMisses = coldSkips = 0;
					spentUsd = 0;
					pingLog.length = 0;
					ctx.ui.notify("🥜 stats reset", "info");
					break;
				case "log":
					if (ctx.mode !== "tui" || !ctx.hasUI) {
						ctx.ui.notify(`🥜 ${pingLog.length} pings logged — open /cachew log in the TUI to view`, "info");
						break;
					}
					await ctx.ui.custom<undefined>(
						(_tui, theme, _kb, done) => new CachewLogComponent(theme, () => pingLog, done),
						{ overlay: true, overlayOptions: { anchor: "center", width: "90%" } },
					);
					break;
				case "debug":
					debug = arg === "on" ? true : arg === "off" ? false : !debug;
					ctx.ui.notify(
						`🥜 debug ${debug ? "ON — per-ping cache metrics + response will print" : "off"}`,
						"info",
					);
					break;
				case "mode":
					if (arg === "magic" || arg === "session") {
						mode = arg;
						ctx.ui.notify(`🥜 mode → ${mode}`, "info");
					} else {
						ctx.ui.notify(`🥜 mode is "${mode}" (use: /cachew mode magic|session)`, "info");
					}
					break;
				case "every": {
					const secs = Number(arg);
					if (!Number.isFinite(secs) || secs <= 0) {
						ctx.ui.notify(
							`🥜 interval is ${Math.round(warmEveryMs / 1000)}s (use: /cachew every <seconds>)`,
							"info",
						);
						break;
					}
					warmEveryMs = secs * 1000;
					arm(); // re-arm with the new interval
					ctx.ui.notify(`🥜 warming every ${secs}s`, "info");
					break;
				}
				default:
					ctx.ui.notify(
						`🥜 Cachew ${enabled ? "on" : "off"} · mode ${mode} · ` +
							`${cacheCapable(currentModel) ? "cacheable" : "no cache on this model"} · ` +
							`${hits}/${pings} hits (${rate()}%) · ${coldSkips} cold-skips · every ${Math.round(warmEveryMs / 1000)}s` +
							`${debug ? " · debug ON" : ""}`,
						"info",
					);
			}
			render();
		},
	});
}
