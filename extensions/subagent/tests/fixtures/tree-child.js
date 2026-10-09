// Fake `pi --mode json` child that starts a long-lived grandchild (like a bash tool call), reports the
// grandchild's pid as its assistant text ("grandchild <pid>"), then idles 30 s. Default SIGTERM handling.
const { spawn } = process.getBuiltinModule("node:child_process");
const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
const message = {
	role: "assistant",
	content: [{ type: "text", text: `grandchild ${grandchild.pid}` }],
	api: "fake",
	provider: "fake",
	model: "fake-model",
	usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
	stopReason: "stop",
	timestamp: Date.now(),
};
process.stdout.write(`${JSON.stringify({ type: "message_end", message })}\n`);
setTimeout(() => {}, 30_000);
