// Test-time module alias that mirrors what pi's extension loader does at runtime
// (dist/core/extensions/loader.js): the bare "@earendil-works/pi-ai" specifier
// resolves to the package's /compat entrypoint. Without this, `node --test`
// can't resolve pi-ai (it's nested under pi-coding-agent) and the exports
// (getApiProvider, etc.) wouldn't match what executes inside pi.
import module from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const compat = join(
	here,
	"node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/compat.js",
);
const compatUrl = pathToFileURL(compat).href;
const piTui = join(
	here,
	"node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/index.js",
);
const piTuiUrl = pathToFileURL(piTui).href;

module.registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "@earendil-works/pi-ai" || specifier === "@earendil-works/pi-ai/compat") {
			return { url: compatUrl, shortCircuit: true };
		}
		if (specifier === "@earendil-works/pi-tui") {
			return { url: piTuiUrl, shortCircuit: true };
		}
		return nextResolve(specifier, context);
	},
});
