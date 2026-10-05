import { TelemetryObserver } from "./telemetry.ts";
import { createViewerServer } from "./viewer-server.ts";

const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--port")) throw new Error("Usage: npm run web -- [--port 8787]");
const portText = args[1] ?? "8787";
if (!/^[1-9][0-9]*$/.test(portText)) throw new Error("--port must be an integer between 1 and 65535");
const port = Number(portText);
if (!Number.isSafeInteger(port) || port > 65535) throw new Error("--port must be an integer between 1 and 65535");
const observer = new TelemetryObserver();
const server = createViewerServer(observer);
await observer.start();
server.on("error", async (error) => { console.error(error); await observer.stop(); process.exitCode = 1; });
server.listen(port, "0.0.0.0", () => console.log(`P2P viewer listening on 0.0.0.0:${port}; open http://<LAN-IP>:${port}/`));
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await observer.stop();
}
process.on("SIGINT", () => { void stop(); });
process.on("SIGTERM", () => { void stop(); });
