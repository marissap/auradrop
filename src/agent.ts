interface AgentState {
  status: "idle" | "offering" | "receiving" | "transferring";
  incomingOffer: TransferOffer | null;
  activeTransfer: TransferProgress | null;
}

interface TransferOffer {
  fromHash: string;
  fileName: string;
  fileSize: number;
  transferId: string;
  expiresAt: number;
}

interface TransferProgress {
  transferId: string;
  fileName: string;
  totalBytes: number;
  bytesReceived: number;
  direction: "sending" | "receiving";
}

interface PendingTransfer {
  chunks: string[];
  fileName: string;
  fileSize: number;
}

export class AuraDropAgent implements DurableObject {
  private state: AgentState = {
    status: "idle",
    incomingOffer: null,
    activeTransfer: null,
  };
  private connections = new Set<WebSocket>();
  private pendingChunks = new Map<string, PendingTransfer>();

  constructor(private ctx: DurableObjectState, private env: Env) {
    // Create transfer history table on first run
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS transfers (
        id TEXT PRIMARY KEY,
        direction TEXT,
        peer_hash TEXT,
        file_name TEXT,
        file_size INTEGER,
        completed_at INTEGER,
        status TEXT
      )
    `);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const cors = { "Access-Control-Allow-Origin": "*" };

    // WebSocket upgrade — browser connecting to its own agent
    if (req.headers.get("Upgrade") === "websocket") {
      const { 0: client, 1: server } = new WebSocketPair();
      this.ctx.acceptWebSocket(server);
      this.connections.add(server);
      server.send(JSON.stringify({ type: "state", state: this.state }));
      return new Response(null, { status: 101, webSocket: client });
    }

    // POST /upload — sender uploads file chunks to their own agent
    if (url.pathname.endsWith("/upload") && req.method === "POST") {
      const { fileName, fileSize, chunks } = await req.json() as { fileName: string; fileSize: number; chunks: string[] };
      const transferId = crypto.randomUUID();
      this.pendingChunks.set(transferId, { chunks, fileName, fileSize });
      return Response.json({ transferId }, { headers: cors });
    }

    // GET /chunks/:transferId — receiver's agent fetches chunks from sender's agent
    const chunksMatch = url.pathname.match(/\/chunks\/(.+)/);
    if (chunksMatch) {
      const data = this.pendingChunks.get(chunksMatch[1]);
      if (!data) return new Response("Not found", { status: 404 });
      return Response.json(data, { headers: cors });
    }

    // POST /rpc/requestConsent — called by the sender's agent (Agent-to-Agent RPC)
    if (url.pathname.endsWith("/rpc/requestConsent") && req.method === "POST") {
      const offer = await req.json() as Omit<TransferOffer, "expiresAt">;
      await this.requestConsent(offer);
      return new Response("ok", { headers: cors });
    }

    // GET /history
    if (url.pathname.endsWith("/history")) {
      const rows = [...this.ctx.storage.sql.exec(
        "SELECT * FROM transfers ORDER BY completed_at DESC LIMIT 50"
      )];
      return Response.json(rows, { headers: cors });
    }

    return new Response("AuraDrop Agent", { headers: cors });
  }

  async webSocketMessage(ws: WebSocket, raw: string): Promise<void> {
    const msg = JSON.parse(raw) as { type: string; [key: string]: unknown };

    switch (msg.type) {
      case "initiate_drop":
        await this.initiateDrop(msg.targetHash as string, msg.transferId as string, msg.fileName as string, msg.fileSize as number);
        break;
      case "accept_drop":
        await this.acceptDrop(msg.transferId as string, msg.fromAgentId as string);
        break;
      case "reject_drop":
        this.setState({ ...this.state, incomingOffer: null, status: "idle" });
        break;
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.connections.delete(ws);
  }

  // ── setState: update state and push to all browser clients ────────
  private setState(newState: AgentState): void {
    this.state = newState;
    const msg = JSON.stringify({ type: "state", state: this.state });
    for (const ws of this.connections) {
      try { ws.send(msg); } catch { this.connections.delete(ws); }
    }
  }

  // ── requestConsent: called by sender's agent via HTTP RPC ─────────
  private async requestConsent(offer: Omit<TransferOffer, "expiresAt">): Promise<void> {
    this.setState({
      ...this.state,
      status: "receiving",
      incomingOffer: { ...offer, expiresAt: Date.now() + 10 * 60 * 1000 },
    });
    // Schedule auto-expiry via Durable Object alarm
    await this.ctx.storage.setAlarm(Date.now() + 10 * 60 * 1000);
    await this.ctx.storage.put("pendingExpiry", offer.transferId);
  }

  // ── alarm: fires when offer TTL expires ───────────────────────────
  async alarm(): Promise<void> {
    const transferId = await this.ctx.storage.get<string>("pendingExpiry");
    if (this.state.incomingOffer?.transferId === transferId) {
      this.setState({ ...this.state, incomingOffer: null, status: "idle" });
    }
  }

  private async initiateDrop(targetHash: string, transferId: string, fileName: string, fileSize: number): Promise<void> {
    // Look up receiver's agent by their hashed phone — Agent-to-Agent RPC
    const targetAgent = this.env.AURA_AGENT.get(this.env.AURA_AGENT.idFromName(targetHash));
    await targetAgent.fetch(new Request("http://agent/rpc/requestConsent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fromHash: this.ctx.id.toString(), fileName, fileSize, transferId }),
    }));
    this.setState({ ...this.state, status: "offering" });
  }

  private async acceptDrop(transferId: string, fromAgentId: string): Promise<void> {
    // Fetch chunks from sender's agent
    const senderAgent = this.env.AURA_AGENT.get(this.env.AURA_AGENT.idFromName(fromAgentId));
    const resp = await senderAgent.fetch(new Request(`http://agent/chunks/${transferId}`));
    const { chunks, fileName, fileSize } = await resp.json() as PendingTransfer;

    this.setState({
      ...this.state, status: "transferring", incomingOffer: null,
      activeTransfer: { transferId, fileName, totalBytes: fileSize, bytesReceived: 0, direction: "receiving" },
    });

    // Stream each chunk to connected browser clients
    for (let i = 0; i < chunks.length; i++) {
      const chunkMsg = JSON.stringify({ type: "chunk", index: i, data: chunks[i], total: chunks.length, fileName });
      for (const ws of this.connections) { try { ws.send(chunkMsg); } catch {} }
      this.setState({
        ...this.state,
        activeTransfer: { ...this.state.activeTransfer!, bytesReceived: Math.round((i + 1) / chunks.length * fileSize) },
      });
    }

    // Log to SQL history
    this.ctx.storage.sql.exec(
      "INSERT INTO transfers VALUES (?, 'received', ?, ?, ?, ?, 'completed')",
      transferId, fromAgentId, fileName, fileSize, Date.now()
    );

    const doneMsg = JSON.stringify({ type: "transfer_complete", transferId, fileName });
    for (const ws of this.connections) { try { ws.send(doneMsg); } catch {} }
    this.setState({ ...this.state, status: "idle", activeTransfer: null });
  }
}