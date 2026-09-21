import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import type { SessionInfo } from "../types.ts";
import { renderDashboardHtml } from "./html.ts";

export interface WebServerSessionProvider {
  listSessions(): Promise<SessionInfo[]>;
  send?(to: string, options: { text: string }): Promise<any>;
  on?(event: string, listener: (...args: any[]) => void): void;
  off?(event: string, listener: (...args: any[]) => void): void;
  removeListener?(event: string, listener: (...args: any[]) => void): void;
}

export interface IntercomWebServerOptions {
  port?: number;
  host?: string;
  provider: WebServerSessionProvider;
}

export interface WebServerInfo {
  port: number;
  host: string;
  localUrl: string;
  lanUrls: string[];
}

export class IntercomWebServer {
  private server: Server | null = null;
  private sseClients: Set<ServerResponse> = new Set();
  private provider: WebServerSessionProvider;
  private port: number;
  private host: string;
  private heartbeatTimer?: NodeJS.Timeout;
  private syncTimer?: NodeJS.Timeout;
  private boundSessionListener?: () => void;

  constructor(options: IntercomWebServerOptions) {
    this.provider = options.provider;
    this.port = options.port ?? 4737;
    this.host = options.host ?? "0.0.0.0";
  }

  public isRunning(): boolean {
    return this.server !== null && this.server.listening;
  }

  public getPort(): number {
    return this.port;
  }

  public getLanIps(): string[] {
    const ips: string[] = [];
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name] || []) {
        // Only IPv4 non-internal addresses
        if (iface.family === "IPv4" && !iface.internal) {
          ips.push(iface.address);
        }
      }
    }
    return ips;
  }

  public getServerInfo(): WebServerInfo | null {
    if (!this.server || !this.server.listening) return null;
    const addr = this.server.address();
    const actualPort = typeof addr === "object" && addr ? addr.port : this.port;
    const lanIps = this.getLanIps();
    return {
      port: actualPort,
      host: this.host,
      localUrl: `http://localhost:${actualPort}`,
      lanUrls: lanIps.map((ip) => `http://${ip}:${actualPort}`),
    };
  }

  public async start(): Promise<WebServerInfo> {
    if (this.isRunning()) {
      return this.getServerInfo()!;
    }

    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => this.handleRequest(req, res));

      server.on("error", (err) => {
        reject(err);
      });

      server.listen(this.port, this.host, () => {
        this.server = server;
        this.attachProviderListeners();
        this.startHeartbeat();
        this.startSyncTimer();
        resolve(this.getServerInfo()!);
      });
    });
  }

  public async stop(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = undefined;
    }

    this.detachProviderListeners();

    for (const client of this.sseClients) {
      try {
        client.destroy();
      } catch {
        // Ignore client termination errors
      }
    }
    this.sseClients.clear();

    if (this.server) {
      const s = this.server;
      this.server = null;
      try {
        s.closeAllConnections?.();
        s.closeIdleConnections?.();
      } catch {
        // Ignore fallback
      }
      await new Promise<void>((resolve) => {
        s.close(() => resolve());
      });
    }
  }

  private attachProviderListeners(): void {
    if (!this.provider.on) return;

    this.boundSessionListener = () => {
      this.broadcastSessions().catch(() => {});
    };

    this.provider.on("session_joined", this.boundSessionListener);
    this.provider.on("session_left", this.boundSessionListener);
    this.provider.on("presence_update", this.boundSessionListener);
  }

  private detachProviderListeners(): void {
    if (!this.boundSessionListener) return;
    const off = this.provider.off ?? this.provider.removeListener;
    if (off) {
      off.call(this.provider, "session_joined", this.boundSessionListener);
      off.call(this.provider, "session_left", this.boundSessionListener);
      off.call(this.provider, "presence_update", this.boundSessionListener);
    }
    this.boundSessionListener = undefined;
  }

  private startSyncTimer(): void {
    this.syncTimer = setInterval(() => {
      if (this.sseClients.size > 0) {
        this.broadcastSessions().catch(() => {});
      }
    }, 2000);
    this.syncTimer.unref?.();
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      this.broadcastHeartbeat();
    }, 15000);
    this.heartbeatTimer.unref?.();
  }

  private broadcastHeartbeat(): void {
    for (const client of this.sseClients) {
      try {
        client.write(": ping\n\n");
      } catch {
        this.sseClients.delete(client);
      }
    }
  }

  public async broadcastSessions(): Promise<void> {
    if (this.sseClients.size === 0) return;
    try {
      const sessions = await this.provider.listSessions();
      const payload = `event: sessions\ndata: ${JSON.stringify(sessions)}\n\n`;
      for (const client of this.sseClients) {
        try {
          client.write(payload);
        } catch {
          this.sseClients.delete(client);
        }
      }
    } catch {
      // Ignored
    }
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;

    // CORS headers for local LAN exploration
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (pathname === "/api/send" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", async () => {
        try {
          const payload = JSON.parse(body || "{}");
          const { to, message } = payload;
          if (!to || !message || typeof message !== "string") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Missing 'to' or 'message'" }));
            return;
          }
          if (!this.provider.send) {
            res.writeHead(501, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Send not supported by active transport" }));
            return;
          }
          const sendResult = await this.provider.send(to, { text: message.trim() });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, result: sendResult }));
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message || "Failed to deliver message" }));
        }
      });
      return;
    }

    if (pathname === "/" || pathname === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderDashboardHtml());
      return;
    }

    if (pathname === "/manifest.json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          name: "Pi Intercom Monitor",
          short_name: "Intercom",
          start_url: "/",
          display: "standalone",
          background_color: "#11111b",
          theme_color: "#1e1e2e",
          icons: [
            {
              src: "data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220%200%20100%20100%22><text y=%22.9em%22 font-size=%2290%22>📡</text></svg>",
              sizes: "192x192 512x512",
              type: "image/svg+xml",
            },
          ],
        })
      );
      return;
    }

    if (pathname === "/ping") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, timestamp: Date.now() }));
      return;
    }

    if (pathname === "/api/sessions") {
      try {
        const sessions = await this.provider.listSessions();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(sessions));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message || "Failed to retrieve sessions" }));
      }
      return;
    }

    if (pathname === "/api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });

      this.sseClients.add(res);
      req.on("close", () => {
        this.sseClients.delete(res);
      });

      // Send initial data immediately
      try {
        const sessions = await this.provider.listSessions();
        res.write(`event: sessions\ndata: ${JSON.stringify(sessions)}\n\n`);
      } catch {
        res.write(`event: sessions\ndata: []\n\n`);
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  }
}
