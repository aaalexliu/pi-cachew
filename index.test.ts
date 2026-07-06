import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import cachew, { capOutputTokens, describeThinking, isCacheCold, CachewLogComponent, OPENAI_RESPONSES_MIN_OUTPUT_TOKENS } from "./index.ts";

/**
 * Minimal recorder for the `pi` ExtensionAPI: captures the handlers and command
 * the extension registers so tests can drive them directly. Typed loosely on
 * purpose — only the surface cachew touches is implemented.
 */
function makePi() {
	const handlers = new Map<string, Function>();
	const commands = new Map<string, { handler: Function }>();
	const sent: string[] = [];
	const pi = {
		on: (ev: string, h: Function) => handlers.set(ev, h),
		registerCommand: (name: string, opts: { handler: Function }) => commands.set(name, opts),
		getActiveTools: () => [] as string[],
		getAllTools: () => [] as { name: string; description: string; parameters: unknown }[],
		sendUserMessage: (text: string) => sent.push(text),
	};
	return { pi, handlers, commands, sent };
}

/**
 * Fake ExtensionContext mirroring the REAL pi 0.80.x shape: the current model is
 * the `model` PROPERTY (not a `getModel()` method). A mock that invented
 * getModel() would hide the very regression we care about.
 */
function makeCtx(cacheRead: number) {
	const statuses: Array<string | undefined> = [];
	const notes: string[] = [];
	const customFactories: any[] = [];
	const ctx = {
		ui: {
			setStatus: (_key: string, text: string | undefined) => statuses.push(text),
			notify: (msg: string) => notes.push(msg),
			custom: async (factory: any) => {
				customFactories.push(factory);
				return undefined;
			},
		},
		mode: "tui",
		hasUI: true,
		modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: false }) },
		model: { api: "bedrock-api", id: "us.anthropic.claude-opus-4-8", cost: { cacheRead } },
		getSystemPrompt: () => "system prompt",
	};
	return { ctx, statuses, notes, customFactories };
}

// Minimal theme stub: fg() just returns the text so assertions match plain strings.
const fakeTheme = { fg: (_c: string, t: string) => t } as any;

const lastDefined = (xs: Array<string | undefined>) => [...xs].reverse().find((x) => x != null);
const testConfigPath = () => join(mkdtempSync(join(tmpdir(), "cachew-")), "cachew.json");
const installCachew = (pi: unknown) => cachew(pi as any, { configPath: testConfigPath() });

test("regression: a cache-capable model is read via ctx.model (not getModel())", async () => {
	const { pi, handlers, commands } = makePi();
	installCachew(pi);

	const { ctx, statuses, notes } = makeCtx(0.5); // opus: cacheRead > 0
	handlers.get("session_start")!({}, ctx); // arms + renders the footer
	await commands.get("cachew")!.handler("status", ctx);

	// Footer must NOT be the "no cache" state, and the status text says "cacheable".
	assert.ok(!statuses.some((s) => s?.includes("no cache")), `footer: ${lastDefined(statuses)}`);
	assert.ok(notes.some((n) => n.includes("cacheable")), notes.join("\n"));
	assert.ok(!notes.some((n) => n.includes("no cache on this model")));

	handlers.get("session_shutdown")!({}, ctx); // stop the display interval
});

test("a 0-cacheRead model is correctly treated as non-cacheable", async () => {
	const { pi, handlers, commands } = makePi();
	installCachew(pi);

	const { ctx, statuses, notes } = makeCtx(0); // e.g. kimi
	handlers.get("session_start")!({}, ctx);
	await commands.get("cachew")!.handler("status", ctx);

	assert.ok(statuses.some((s) => s?.includes("idle (no cache)")), `footer: ${lastDefined(statuses)}`);
	assert.ok(notes.some((n) => n.includes("no cache on this model")));

	handlers.get("session_shutdown")!({}, ctx);
});

test("footer shows labelled hit rate and no dollar spend", async () => {
	const { pi, handlers } = makePi();
	installCachew(pi);

	const { ctx, statuses } = makeCtx(0.5);
	handlers.get("session_start")!({}, ctx);

	const footer = lastDefined(statuses);
	assert.ok(footer?.includes("hit rate"), `expected 'hit rate' in: ${footer}`);
	assert.ok(!footer?.includes("$"), `expected no spend in footer: ${footer}`);

	handlers.get("session_shutdown")!({}, ctx);
});

test("off/on toggles disable and re-enable the footer", async () => {
	const { pi, handlers, commands } = makePi();
	installCachew(pi);

	const { ctx, statuses } = makeCtx(0.5);
	handlers.get("session_start")!({}, ctx);

	await commands.get("cachew")!.handler("off", ctx);
	assert.ok(lastDefined(statuses)?.includes("off"), `footer after off: ${lastDefined(statuses)}`);

	await commands.get("cachew")!.handler("on", ctx);
	assert.ok(!lastDefined(statuses)?.includes("· off"), `footer after on: ${lastDefined(statuses)}`);

	handlers.get("session_shutdown")!({}, ctx);
});

test("footer off hides the footer without disabling cachew", async () => {
	const { pi, handlers, commands } = makePi();
	installCachew(pi);

	const { ctx, statuses, notes } = makeCtx(0.5);
	handlers.get("session_start")!({}, ctx);
	assert.ok(lastDefined(statuses)?.includes("hit rate"), `footer before off: ${lastDefined(statuses)}`);

	await commands.get("cachew")!.handler("footer off", ctx);
	assert.equal(statuses.at(-1), undefined);

	await commands.get("cachew")!.handler("status", ctx);
	assert.equal(statuses.at(-1), undefined);
	assert.ok(notes.some((n) => n.includes("Cachew on")), notes.join("\n"));

	await commands.get("cachew")!.handler("footer on", ctx);
	assert.ok(lastDefined(statuses)?.includes("hit rate"), `footer after on: ${lastDefined(statuses)}`);

	handlers.get("session_shutdown")!({}, ctx);
});

test("settings are loaded from and saved to config", async () => {
	const configPath = join(mkdtempSync(join(tmpdir(), "cachew-")), "cachew.json");
	writeFileSync(configPath, JSON.stringify({ footer: false, mode: "session", warmEveryMs: 1_000 }));

	const first = makePi();
	cachew(first.pi as any, { configPath });
	const firstRun = makeCtx(0.5);
	first.handlers.get("session_start")!({}, firstRun.ctx);
	assert.equal(firstRun.statuses.at(-1), undefined);

	await first.commands.get("cachew")!.handler("status", firstRun.ctx);
	assert.ok(firstRun.notes.some((n) => n.includes("mode session")), firstRun.notes.join("\n"));
	assert.ok(firstRun.notes.some((n) => n.includes("every 1s")), firstRun.notes.join("\n"));

	await first.commands.get("cachew")!.handler("footer on", firstRun.ctx);
	assert.equal(JSON.parse(readFileSync(configPath, "utf8")).footer, true);
	first.handlers.get("session_shutdown")!({}, firstRun.ctx);

	const second = makePi();
	cachew(second.pi as any, { configPath });
	const secondRun = makeCtx(0.5);
	second.handlers.get("session_start")!({}, secondRun.ctx);
	assert.ok(lastDefined(secondRun.statuses)?.includes("hit rate"), `footer after restart: ${lastDefined(secondRun.statuses)}`);
	second.handlers.get("session_shutdown")!({}, secondRun.ctx);
});

test("magic mode shows 'waiting for 1st turn' until a real call is captured", () => {
	const { pi, handlers } = makePi();
	installCachew(pi);

	const { ctx, statuses } = makeCtx(0.5);
	handlers.get("session_start")!({}, ctx); // armed, but nothing captured yet
	assert.ok(
		lastDefined(statuses)?.includes("waiting for 1st turn"),
		`footer: ${lastDefined(statuses)}`,
	);

	// Once a real provider request is captured, it stops waiting.
	handlers.get("before_provider_request")!({ payload: { inferenceConfig: { maxTokens: 100 } } }, ctx);
	handlers.get("agent_end")!({}, ctx); // re-arm + render
	assert.ok(!lastDefined(statuses)?.includes("waiting"), `footer: ${lastDefined(statuses)}`);

	handlers.get("session_shutdown")!({}, ctx);
});

test("`every <seconds>` reconfigures the interval and re-arms", async () => {
	const { pi, handlers, commands } = makePi();
	installCachew(pi);

	const { ctx, statuses, notes } = makeCtx(0.5);
	handlers.get("session_start")!({}, ctx);
	// Capture a request so the footer leaves the 'waiting' state and shows the countdown.
	handlers.get("before_provider_request")!({ payload: { inferenceConfig: { maxTokens: 100 } } }, ctx);

	await commands.get("cachew")!.handler("every 1", ctx);
	assert.ok(notes.some((n) => n.includes("every 1s")), notes.join("\n"));
	// Footer countdown should reflect the new ~1s interval, not the 270s default.
	const footer = lastDefined(statuses);
	assert.match(footer ?? "", /next [01]s/, `footer: ${footer}`);

	// Invalid values are rejected without changing the interval.
	await commands.get("cachew")!.handler("every nope", ctx);
	assert.ok(notes.some((n) => n.includes("interval is 1s")), notes.join("\n"));

	handlers.get("session_shutdown")!({}, ctx);
});

test("capOutputTokens caps output verbatim per wire shape and leaves the prefix untouched", () => {
	// Bedrock Converse: nested inferenceConfig.maxTokens.
	const bedrock = {
		modelId: "x",
		system: [{ text: "sys" }],
		messages: [{ role: "user", content: [{ text: "hi" }] }],
		inferenceConfig: { maxTokens: 64000, temperature: 0.7 },
	};
	const cappedBedrock = capOutputTokens(bedrock) as any;
	assert.equal(cappedBedrock.inferenceConfig.maxTokens, 1);
	assert.equal(cappedBedrock.inferenceConfig.temperature, 0.7); // untouched
	assert.deepEqual(cappedBedrock.messages, bedrock.messages); // prefix opaque/untouched
	assert.equal(bedrock.inferenceConfig.maxTokens, 64000); // original not mutated

	// Anthropic Messages: top-level max_tokens.
	assert.equal((capOutputTokens({ max_tokens: 8000, messages: [] }) as any).max_tokens, 1);
	// OpenAI Responses: floored at the API minimum (16), NOT 1 — sub-16 is a 400.
	assert.equal(
		(capOutputTokens({ max_output_tokens: 9000 }) as any).max_output_tokens,
		OPENAI_RESPONSES_MIN_OUTPUT_TOKENS,
	);
	// ...and a below-minimum request is floored UP to 16, not passed through.
	assert.equal(
		(capOutputTokens({ max_output_tokens: 9 }) as any).max_output_tokens,
		OPENAI_RESPONSES_MIN_OUTPUT_TOKENS,
	);
	// OpenAI Chat Completions: capped to 1 (no sub-16 floor there).
	assert.equal((capOutputTokens({ max_completion_tokens: 9 }) as any).max_completion_tokens, 1);
	// Google (pi wire shape: { model, contents, config } — cap lives at config.maxOutputTokens).
	const cappedGoogle = capOutputTokens({
		model: "gemini",
		contents: [],
		config: { maxOutputTokens: 9, temperature: 0.5 },
	}) as any;
	assert.equal(cappedGoogle.config.maxOutputTokens, 1);
	assert.equal(cappedGoogle.config.temperature, 0.5); // other config untouched
	// A top-level generationConfig is NOT pi's shape → unrecognised → reconstruct.
	assert.equal(capOutputTokens({ generationConfig: { maxOutputTokens: 9 } }), undefined);

	// Unrecognised shape → undefined → caller falls back to reconstruction.
	assert.equal(capOutputTokens({ something: "else" }), undefined);
	assert.equal(capOutputTokens(undefined), undefined);
	assert.equal(capOutputTokens("nope"), undefined);
});

test("describeThinking detects extended thinking per wire shape (for cache-miss diagnostics)", () => {
	// Bedrock Converse / custom Bedrock gateways: additionalModelRequestFields.reasoning_config.
	assert.equal(
		describeThinking({ additionalModelRequestFields: { reasoning_config: { budget_tokens: 32000 } } }),
		"thinking ON (budget 32000)",
	);
	// Anthropic Messages.
	assert.equal(describeThinking({ thinking: { type: "enabled", budget_tokens: 16000 } }), "thinking ON (budget 16000)");
	assert.equal(describeThinking({ thinking: { type: "disabled" } }), "thinking OFF");
	// OpenAI Responses.
	assert.equal(describeThinking({ reasoning: { effort: "high" } }), "reasoning ON (effort high)");
	// Google (config.thinkingConfig).
	assert.equal(
		describeThinking({ config: { thinkingConfig: { thinkingBudget: 2048 } } }),
		"thinking ON (budget 2048)",
	);
	// No thinking config present on a recognised-ish object → OFF.
	assert.equal(describeThinking({ inferenceConfig: { maxTokens: 1 } }), "thinking OFF");
	// Non-object payloads → n/a.
	assert.equal(describeThinking(undefined), "thinking n/a");
	assert.equal(describeThinking("nope"), "thinking n/a");
});

test("isCacheCold: sleep-aware skip predicate (wall-clock anchored)", () => {
	const TTL = 5 * 60_000; // 300s
	const MARGIN = 20_000; // skip if within 20s of the TTL → threshold 280s
	const now = 1_000_000;

	// Fresh warm / steady-state 240s heartbeat → still warm, DO ping.
	assert.equal(isCacheCold(now - 0, now, TTL, MARGIN), false);
	assert.equal(isCacheCold(now - 240_000, now, TTL, MARGIN), false);
	// Just under the 280s threshold → still warm.
	assert.equal(isCacheCold(now - 279_000, now, TTL, MARGIN), false);
	// At/over the threshold (overslept) → cold, SKIP the auto-rewarm.
	assert.equal(isCacheCold(now - 280_000, now, TTL, MARGIN), true);
	assert.equal(isCacheCold(now - 300_000, now, TTL, MARGIN), true);
	// Long laptop sleep → definitely cold.
	assert.equal(isCacheCold(now - 32 * 60_000, now, TTL, MARGIN), true);
});

test("cachew skips the ping after a long idle gap (session mode, sleep sim)", async () => {
	const { pi, handlers, commands, sent } = makePi();
	installCachew(pi);

	const { ctx } = makeCtx(0.5);
	handlers.get("session_start")!({}, ctx);
	// Switch to session mode: a real ping would call pi.sendUserMessage(".").
	await commands.get("cachew")!.handler("mode session", ctx);

	// Simulate a long sleep: lastWarmAt was set at session_start; jump time past
	// the TTL so the cache is cold, then force a ping attempt.
	const realNow = Date.now;
	try {
		Date.now = () => realNow() + 6 * 60_000; // +6 min → cache cold
		await commands.get("cachew")!.handler("now", ctx);
	} finally {
		Date.now = realNow;
	}

	// The whole point: it must NOT have sent a "." ping (that would pay a full
	// cacheWrite for nobody). The skip fires instead.
	assert.deepEqual(sent, [], `should skip the ping when cold, but sent: ${JSON.stringify(sent)}`);

	handlers.get("session_shutdown")!({}, ctx);
});

test("cachew DOES ping in session mode when the cache is still warm", async () => {
	const { pi, handlers, commands, sent } = makePi();
	installCachew(pi);

	const { ctx } = makeCtx(0.5);
	handlers.get("session_start")!({}, ctx); // lastWarmAt = now (warm)
	await commands.get("cachew")!.handler("mode session", ctx);
	await commands.get("cachew")!.handler("now", ctx); // warm → should send "."

	assert.deepEqual(sent, ["."], `expected one warm ping, got: ${JSON.stringify(sent)}`);

	handlers.get("session_shutdown")!({}, ctx);
});

test("debug mode prints a per-ping HIT readout with cache metrics + response (session)", async () => {
	const { pi, handlers, commands, sent } = makePi();
	installCachew(pi);

	const { ctx, notes } = makeCtx(0.5);
	handlers.get("session_start")!({}, ctx);
	await commands.get("cachew")!.handler("mode session", ctx);
	await commands.get("cachew")!.handler("debug on", ctx);
	assert.ok(notes.some((n) => n.includes("debug ON")), notes.join("\n"));

	// Warm ping (cache warm) → sends "." and marks a session ping pending.
	await commands.get("cachew")!.handler("now", ctx);
	assert.deepEqual(sent, ["."]);

	// Simulate the assistant reply pi produces for that "." ping — a cache HIT.
	handlers.get("message_end")!({
		message: {
			role: "assistant",
			content: [{ type: "text", text: "." }],
			usage: { cacheRead: 26163, cacheWrite: 8, input: 2, output: 1, cost: { total: 0.0131 } },
		},
	});

	const dbg = notes.find((n) => n.includes("[debug]"));
	assert.ok(dbg, `expected a [debug] readout, notes:\n${notes.join("\n")}`);
	assert.ok(dbg!.includes("HIT"), `expected HIT: ${dbg}`);
	assert.ok(dbg!.includes("cacheRead 26.2k"), `expected cache metrics: ${dbg}`);
	assert.ok(dbg!.includes("resp"), `expected response text: ${dbg}`);

	handlers.get("session_shutdown")!({}, ctx);
});

test("debug off suppresses HIT readouts but misses still warn", async () => {
	const { pi, handlers, commands } = makePi();
	installCachew(pi);

	const { ctx, notes } = makeCtx(0.5);
	handlers.get("session_start")!({}, ctx);
	await commands.get("cachew")!.handler("mode session", ctx);
	await commands.get("cachew")!.handler("now", ctx);

	// A cache MISS reply → should still warn even with debug off.
	handlers.get("message_end")!({
		message: {
			role: "assistant",
			content: [{ type: "text", text: "." }],
			usage: { cacheRead: 0, cacheWrite: 33000, input: 2, output: 1, cost: { total: 0.2 } },
		},
	});

	assert.ok(!notes.some((n) => n.includes("[debug]")), "no debug readout when debug is off");
	assert.ok(notes.some((n) => n.includes("cache-miss ping")), "miss should still warn");

	handlers.get("session_shutdown")!({}, ctx);
});

test("CachewLogComponent renders hits/misses/skips with ping numbers and counts", () => {
	const log = [
		{ n: 65, ts: 0, outcome: "hit" as const, via: "replay", read: 19100, write: 0, inTok: 3, outTok: 1, cost: 0.0057, costs: { read: 0.0096, write: 0, input: 0, output: 0.0001 }, think: "thinking OFF", text: "Hi" },
		{ n: 66, ts: 0, outcome: "miss" as const, via: "reconstruct", read: 0, write: 33100, inTok: 2, outTok: 1, cost: 0.2074, costs: { read: 0, write: 0.2069, input: 0, output: 0.0005 } },
		{ ts: 0, outcome: "skip" as const, via: "magic", read: 0, write: 0, inTok: 0, outTok: 0, cost: 0, text: "cache cold — idle 372s ≥ TTL" },
	];
	let closed = false;
	const comp = new CachewLogComponent(fakeTheme, () => log, () => { closed = true; });
	const out = comp.render(120).join("\n");

	assert.ok(out.includes("Cachew ping log"), out);
	assert.ok(out.includes("hits 1") && out.includes("miss 1") && out.includes("skip 1"), out);
	assert.ok(out.includes("#65") && out.includes("HIT"), out);
	assert.ok(out.includes("#66") && out.includes("MISS"), out);
	assert.ok(out.includes("SKIP") && out.includes("idle 372s"), out);
	// Clear labels: read = cacheRead, write = cacheWrite (with a legend line).
	assert.ok(out.includes("read = cacheRead tokens"), `expected legend: ${out}`);
	assert.ok(out.includes("read 19.1k") && out.includes("write 33.1k"), `expected token labels: ${out}`);
	// Cost breakdown after the token counts, plus the total.
	assert.ok(out.includes("read $0.0096") && out.includes("write $0.2069"), `expected cost breakdown: ${out}`);
	assert.ok(out.includes("$0.0057"), `expected total cost: ${out}`);

	// q closes the overlay.
	comp.handleInput("q");
	assert.equal(closed, true);
});

test("CachewLogComponent: narrow width still shows core metrics (no clip at 'read')", () => {
	// Regression: the old ANSI-aware truncator miscounted color-code chars as
	// visible width and clipped rows right after the first "read" label, hiding all
	// token/cost metrics on a sub-full-width overlay (e.g. the 90%-width default).
	const log = [
		{ n: 65, ts: 0, outcome: "hit" as const, via: "replay", read: 19100, write: 0, inTok: 3, outTok: 1, cost: 0.0057, costs: { read: 0.0096, write: 0, input: 0, output: 0.0001 }, think: "thinking OFF", text: "Hi" },
	];
	const comp = new CachewLogComponent(fakeTheme, () => log, () => {});
	// 80 cols → innerW 78 → the full row (~95 visible) MUST truncate, but the
	// leading token counts + total must survive (they come before the breakdown).
	const out = comp.render(80).join("\n");
	assert.ok(out.includes("read 19.1k"), `cacheRead metric clipped: ${out}`);
	assert.ok(out.includes("write 0"), `cacheWrite metric clipped: ${out}`);
	assert.ok(out.includes("$0.0057"), `total cost clipped: ${out}`);
});

test("CachewLogComponent: arrow keys scroll and Esc closes (matchesKey)", () => {
	const log = Array.from({ length: 30 }, (_, i) => ({
		n: i + 1,
		ts: 0,
		outcome: "hit" as const,
		via: "replay",
		read: 1000,
		write: 0,
		inTok: 2,
		outTok: 1,
		cost: 0.001,
		costs: { read: 0.001, write: 0, input: 0, output: 0 },
	}));
	let closed = false;
	const comp = new CachewLogComponent(fakeTheme, () => log, () => { closed = true; });

	const nums = (s: string) => s.replace(/\d+\.\d+/g, ""); // drop costs so #NN matching is clean

	// 30 entries, 18 rows → follows the tail: window shows #13..#30.
	let out = comp.render(120).join("\n");
	assert.ok(/#30\b/.test(nums(out)) && /#13\b/.test(nums(out)), `tail window: ${out}`);
	assert.ok(!/#12\b/.test(nums(out)), `should not show #12 yet: ${out}`);
	assert.ok(out.includes("● live"), `should be live-tailing: ${out}`);

	// Up arrow (legacy sequence) scrolls up by one → window #12..#29, tail paused.
	comp.handleInput("\x1b[A");
	out = comp.render(120).join("\n");
	assert.ok(/#12\b/.test(nums(out)), `up-arrow should reveal #12: ${out}`);
	assert.ok(!/#30\b/.test(nums(out)), `#30 should scroll out of view: ${out}`);
	assert.ok(!out.includes("● live"), `tail should be paused after scrolling up: ${out}`);

	// Down arrow returns to the bottom and resumes live tail.
	comp.handleInput("\x1b[B");
	out = comp.render(120).join("\n");
	assert.ok(/#30\b/.test(nums(out)) && out.includes("● live"), `down-arrow back to live: ${out}`);

	// PgUp jumps a page and pauses the tail.
	comp.handleInput("\x1b[5~");
	assert.ok(!comp.render(120).join("\n").includes("● live"), "PgUp pauses tail");

	// Esc closes (bare escape handled by matchesKey).
	assert.equal(closed, false);
	comp.handleInput("\x1b");
	assert.equal(closed, true);
});

test("CachewLogComponent: Kitty-encoded Esc also closes", () => {
	let closed = false;
	const comp = new CachewLogComponent(fakeTheme, () => [], () => { closed = true; });
	comp.handleInput("\x1b[27u"); // Kitty protocol escape
	assert.equal(closed, true);
});

test("session pings are recorded and surface in the /cachew log overlay", async () => {
	const { pi, handlers, commands } = makePi();
	installCachew(pi);

	const { ctx, customFactories } = makeCtx(0.5);
	handlers.get("session_start")!({}, ctx);
	await commands.get("cachew")!.handler("mode session", ctx);
	await commands.get("cachew")!.handler("now", ctx); // sends "."

	// Simulate the assistant reply (a cache HIT) → recorded into the log.
	handlers.get("message_end")!({
		message: {
			role: "assistant",
			content: [{ type: "text", text: "yo" }],
			usage: { cacheRead: 20000, cacheWrite: 5, input: 2, output: 1, cost: { total: 0.01 } },
		},
	});

	// Open the overlay; grab the component the extension handed to ui.custom.
	await commands.get("cachew")!.handler("log", ctx);
	assert.equal(customFactories.length, 1, "expected /cachew log to open a custom overlay");
	const comp = customFactories[0](null, fakeTheme, null, () => {});
	const out = comp.render(120).join("\n");

	assert.ok(out.includes("hits 1"), `expected the recorded hit: ${out}`);
	assert.ok(out.includes("HIT") && out.includes("(session)"), out);
	assert.ok(out.includes("read 20.0k") && out.includes("$0.0100"), `expected recorded metrics/cost: ${out}`);

	handlers.get("session_shutdown")!({}, ctx);
});
