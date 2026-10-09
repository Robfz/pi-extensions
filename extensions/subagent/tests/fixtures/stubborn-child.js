// Fake `pi --mode json` child for runner tests. Uses only globals so it runs as CommonJS or ESM.
// Default: ignores SIGTERM, prints one assistant message_end line, then idles 30 s (only SIGKILL stops it).
// With --quick: prints the line and exits 0.
const message = {
	role: "assistant",
	content: [{ type: "text", text: "stubborn hello" }],
	api: "fake",
	provider: "fake",
	model: "fake-model",
	usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { total: 0.0125 } },
	stopReason: "stop",
	timestamp: Date.now(),
};
const quick = process.argv.includes("--quick");
if (!quick) process.on("SIGTERM", () => {});
process.stdout.write(`${JSON.stringify({ type: "message_end", message })}\n`, () => {
	if (quick) process.exit(0);
});
if (!quick) setTimeout(() => {}, 30_000);
