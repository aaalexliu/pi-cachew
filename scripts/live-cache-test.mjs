#!/usr/bin/env node
/**
 * Live cache warm-ping test for pi-cachew.
 *
 * Drives a REAL pi session over the RPC protocol (`pi --mode rpc`), loads THIS
 * repo's cachew build (not any globally-installed copy), does one real turn to
 * capture a prefix, then fires `/cachew now` and inspects cachew's own per-ping
 * readout to confirm the warm ping was a cache HIT (non-zero cacheRead) rather
 * than the all-zeros MISS that the OpenAI-Responses 16-token bug produced.
 *
 * It is provider-agnostic: pass the model(s) to test with `--model provider/id`
 * and load whatever provider/gateway extension registers them with `--extension`.
 *
 * Why RPC (not a TUI/pty): RPC is a real session (extensions load, lifecycle
 * events fire, `/cachew now` executes immediately) but speaks structured JSONL,
 * so cachew's `ui.notify` HIT/MISS readout comes back as a parseable
 * `extension_ui_request` instead of ANSI screen paint we'd have to scrape.
 *
 * Isolation: by default we point PI_CODING_AGENT_DIR at a throwaway dir with an
 * empty settings.json so a globally-installed cachew package does NOT also load
 * (pi would keep both and disambiguate them as `cachew:1` / `cachew:2`, leaving
 * `/cachew now` ambiguous). This repo's copy is loaded explicitly via `-e`.
 *
 * Usage:
 *   node scripts/live-cache-test.mjs \
 *     --extension /path/to/your/gateway-provider-extension \
 *     --model your-provider/your-model [--model ...]
 *
 * Example (Rippling gateway — the OpenAI-Responses fix this test exists for):
 *   node scripts/live-cache-test.mjs \
 *     --extension ~/.pi/agent/extensions/rippling-gateway \
 *     --model rippling-openai/gpt-5.4 \
 *     --model rippling-bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0
 *
 * Flags:
 *   --model prov/id     Model to warm (repeatable, required). Expected to HIT.
 *   --extension path    Extra extension to load (repeatable) — e.g. the provider.
 *   --warm-text text    User message for the capture turn (default: "Say hi.").
 *   --thinking level    Set thinking level before the capture turn (off|minimal|low|medium|high|xhigh).
 *   --timeout ms        Per-ping wait for the readout (default: 60000).
 *   --no-isolate        Use the real ~/.pi/agent dir (may double-load cachew).
 *   --keep              Keep the temp agent dir (for debugging).
 *
 * Exit code: 0 if every model produced a HIT; non-zero otherwise.
 */

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ── args ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
	const out = { models: [], extensions: [], warmText: "Say hi.", timeout: 60000, isolate: true, keep: false, verbose: false, thinking: undefined };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--model") out.models.push(argv[++i]);
		else if (a === "--extension" || a === "-e") out.extensions.push(expandHome(argv[++i]));
		else if (a === "--warm-text") out.warmText = argv[++i];
		else if (a === "--thinking") out.thinking = argv[++i];
		else if (a === "--timeout") out.timeout = Number(argv[++i]);
		else if (a === "--no-isolate") out.isolate = false;
		else if (a === "--verbose" || a === "-v") out.verbose = true;
		else if (a === "--keep") out.keep = true;
		else if (a === "-h" || a === "--help") {
			console.log(readHelp());
			process.exit(0);
		} else throw new Error(`unknown arg: ${a}`);
	}
	if (out.models.length === 0) throw new Error("at least one --model provider/id is required (see --help)");
	return out;
}
const expandHome = (p) => (p?.startsWith("~") ? join(homedir(), p.slice(1)) : p);
const readHelp = () => "See the header comment in scripts/live-cache-test.mjs for usage and flags.";

// ── minimal RPC client (JSONL, LF-only framing per docs/rpc.md) ────────────────
class Rpc {
	constructor(child, verbose = false) {
		this.child = child;
		this.verbose = verbose;
		this.nextId = 1;
		this.pending = new Map(); // id -> {resolve}
		this.eventWaiters = []; // {type, resolve}
		this.notifies = []; // collected notify messages (strings)
		const dec = new StringDecoder("utf8");
		let buf = "";
		child.stdout.on("data", (chunk) => {
			buf += dec.write(chunk);
			let nl;
			// Split on LF only (never a generic line reader — see docs/rpc.md framing).
			while ((nl = buf.indexOf("\n")) >= 0) {
				let line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				if (line.endsWith("\r")) line = line.slice(0, -1);
				if (line.trim()) this._onLine(line);
			}
		});
		this.stderr = "";
		child.stderr.on("data", (c) => (this.stderr += c.toString()));
	}
	_onLine(line) {
		let msg;
		try {
			msg = JSON.parse(line);
		} catch {
			return;
		}
		if (msg.type === "response" && msg.id != null && this.pending.has(msg.id)) {
			this.pending.get(msg.id).resolve(msg);
			this.pending.delete(msg.id);
			return;
		}
		if (msg.type === "extension_ui_request" && msg.method === "notify") {
			const text = String(msg.message ?? "");
			this.notifies.push(text);
			if (this.verbose) console.log(`     · notify: ${text.replace(/^🥜\s*/, "")}`);
			return;
		}
		if (msg.type === "extension_error") {
			console.error(`  ⚠️  extension_error: ${(msg.extensionPath || "").split("/").slice(-2).join("/")}: ${msg.error}`);
			return;
		}
		if (msg.type) {
			// Resolve the first matching event waiter.
			const idx = this.eventWaiters.findIndex((w) => w.type === msg.type);
			if (idx >= 0) {
				const [w] = this.eventWaiters.splice(idx, 1);
				w.resolve(msg);
			}
		}
	}
	send(obj) {
		this.child.stdin.write(JSON.stringify(obj) + "\n");
	}
	request(cmd, timeoutMs = 60000) {
		const id = `req-${this.nextId++}`;
		return new Promise((resolvePromise, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`RPC ${cmd.type} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (m) => {
					clearTimeout(timer);
					resolvePromise(m);
				},
			});
			this.send({ ...cmd, id });
		});
	}
	waitEvent(type, timeoutMs = 120000) {
		return new Promise((resolvePromise, reject) => {
			const timer = setTimeout(() => {
				const i = this.eventWaiters.findIndex((w) => w.timer === timer);
				if (i >= 0) this.eventWaiters.splice(i, 1);
				reject(new Error(`event ${type} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			this.eventWaiters.push({ type, timer, resolve: (m) => (clearTimeout(timer), resolvePromise(m)) });
		});
	}
	clearNotifies() {
		this.notifies = [];
	}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// cachew's per-ping readouts arrive as `notify` messages. Two formats:
//  debug ON:  "🥜 [debug] ping #1 HIT ✅ (replay) on gpt-5.4: cacheRead 12.3k · ..."
//  debug OFF: "🥜 Cachew cache-miss ping 1/2 (replay) on gpt-5.4: cacheRead 0 · ..." (misses only; hits are silent)
const DEBUG_RE = /ping #\d+\s+(HIT ✅|MISS ⚠️).*?(cacheRead .*)$/u;
const MISS_RE = /cache-miss ping \d+\/\d+.*?(cacheRead .*)$/u;
function classify(notifies) {
	for (const n of notifies) {
		let m = n.match(DEBUG_RE);
		if (m) return { outcome: m[1].startsWith("HIT") ? "HIT" : "MISS", detail: n.replace(/^🥜\s*/, "").trim() };
		m = n.match(MISS_RE);
		if (m) return { outcome: "MISS", detail: n.replace(/^🥜\s*/, "").trim() };
	}
	return null;
}

async function testModel(rpc, spec, warmText, thinking, timeout) {
	const [provider, ...rest] = spec.split("/");
	const modelId = rest.join("/");
	console.log(`\n▶ ${spec}`);

	const setRes = await rpc.request({ type: "set_model", provider, modelId });
	if (!setRes.success) return { spec, outcome: "ERROR", detail: `set_model failed: ${setRes.error}` };
	if (thinking) await rpc.request({ type: "set_thinking_level", level: thinking });

	// Re-arm cachew for this model (model_select reset its miss counter). Debug is
	// enabled ONCE in main() — it's a toggle, so we must not flip it per model.
	await rpc.request({ type: "prompt", message: "/cachew on" });

	// One real turn so magic mode captures a prefix to replay.
	rpc.clearNotifies();
	await rpc.request({ type: "prompt", message: warmText });
	await rpc.waitEvent("agent_end", timeout).catch(() => {});

	// Fire the warm ping. The command handler awaits warmPing(), so by the time
	// this response returns, cachew has already emitted its readout notify.
	rpc.clearNotifies();
	await rpc.request({ type: "prompt", message: "/cachew now" }, timeout);
	// Grace window in case the notify lands just after the command response.
	for (let i = 0; i < 20 && !classify(rpc.notifies); i++) await sleep(250);

	const res = classify(rpc.notifies);
	if (res) return { spec, ...res };
	const note = rpc.notifies.find((n) => /nothing to warm|no cache|is off|busy|error|timed out/i.test(n));
	return { spec, outcome: "NO-PING", detail: (note ?? "(no readout emitted — model not cacheable, or timed out)").replace(/^🥜\s*/, "") };
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));

	let agentDir;
	if (opts.isolate) {
		agentDir = mkdtempSync(join(tmpdir(), "pi-cachew-livetest-"));
		writeFileSync(join(agentDir, "settings.json"), "{}\n");
	}

	// Load THIS repo's cachew, plus any provider/gateway extensions.
	const piArgs = ["--mode", "rpc", "--no-session", "-e", REPO_ROOT];
	for (const ext of opts.extensions) piArgs.push("-e", ext);

	const env = { ...process.env };
	if (agentDir) env.PI_CODING_AGENT_DIR = agentDir;

	console.log(`pi ${piArgs.join(" ")}`);
	console.log(`  cachew under test: ${REPO_ROOT}`);
	if (agentDir) console.log(`  isolated agent dir: ${agentDir}`);

	const child = spawn("pi", piArgs, { env, stdio: ["pipe", "pipe", "pipe"] });
	const rpc = new Rpc(child, opts.verbose);
	const cleanup = () => {
		try {
			child.kill();
		} catch {}
		if (agentDir && !opts.keep) rmSync(agentDir, { recursive: true, force: true });
	};

	const results = [];
	try {
		// Preflight: confirm the local cachew is the one (and only) loaded.
		const cmds = await rpc.request({ type: "get_commands" }, 30000);
		const cachewCmds = (cmds.data?.commands ?? []).map((c) => c.name).filter((n) => /^cachew(:\d+)?$/.test(n));
		if (cachewCmds.length === 0) throw new Error("cachew did not load — is this repo's index.ts valid?");
		if (cachewCmds.length > 1 || cachewCmds[0] !== "cachew")
			throw new Error(`ambiguous cachew (${cachewCmds.join(", ")}) — a global copy also loaded; run with isolation (default).`);

		const models = await rpc.request({ type: "get_available_models" }, 30000);
		const avail = new Set((models.data?.models ?? []).map((m) => `${m.provider}/${m.id}`));

		// Enable cachew's per-ping readout ONCE (it's a toggle) so HITs are visible
		// too (a non-debug hit is silent). Verify it actually turned on.
		rpc.clearNotifies();
		await rpc.request({ type: "prompt", message: "/cachew debug" });
		await sleep(200);
		if (!rpc.notifies.some((n) => /debug ON/i.test(n))) {
			await rpc.request({ type: "prompt", message: "/cachew debug" }); // was already on; toggle back on
		}

		for (const spec of opts.models) {
			if (!avail.has(spec)) {
				results.push({ spec, outcome: "MISSING", detail: "not in get_available_models — check --extension / --model" });
				continue;
			}
			results.push(await testModel(rpc, spec, opts.warmText, opts.thinking, opts.timeout));
		}
	} catch (err) {
		console.error(`\n✖ ${err.message}`);
		if (rpc.stderr.trim()) console.error(rpc.stderr.split("\n").slice(0, 10).join("\n"));
		cleanup();
		process.exit(2);
	}

	cleanup();

	// ── report ───────────────────────────────────────────────────────────────
	console.log("\n── results ─────────────────────────────────────────────────");
	const icon = { HIT: "✅", MISS: "❌", "NO-PING": "⚠️ ", MISSING: "⚠️ ", ERROR: "✖ " };
	for (const r of results) {
		console.log(`${icon[r.outcome] ?? "? "} ${r.outcome.padEnd(8)} ${r.spec}`);
		console.log(`     ${r.detail}`);
	}
	const failed = results.filter((r) => r.outcome !== "HIT");
	console.log("────────────────────────────────────────────────────────────");
	console.log(`${results.length - failed.length}/${results.length} HIT`);
	process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
	console.error(e);
	process.exit(2);
});
