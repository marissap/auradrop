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

  constructor(private ctx: DurableObjectState, private env: Env) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const cors = { "Access-Control-Allow-Origin": "*" };

    if (req.headers.get("Upgrade") === "websocket") {
        const { 0: client, 1: server } = new WebSocketPair();
        server.accept();
        this.connections.add(server);
        server.send(JSON.stringify({ type: "state", state: this.state }));

        server.addEventListener("message", (evt) => {
            this.webSocketMessage(server, evt.data as string);
        });

        server.addEventListener("close", () => {
            this.connections.delete(server);
        });

        return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname.endsWith("/upload") && req.method === "POST") {
      const { fileName, fileSize, chunks } = await req.json() as { fileName: string; fileSize: number; chunks: string[] };
      const transferId = crypto.randomUUID();
      this.pendingChunks.set(transferId, { chunks, fileName, fileSize });
      return Response.json({ transferId }, { headers: cors });
    }

    const chunksMatch = url.pathname.match(/\/chunks\/(.+)/);
    if (chunksMatch) {
      const data = this.pendingChunks.get(chunksMatch[1]);
      if (!data) return new Response("Not found", { status: 404 });
      return Response.json(data, { headers: cors });
    }

    if (url.pathname.endsWith("/rpc/requestConsent") && req.method === "POST") {
      const offer = await req.json() as Omit<TransferOffer, "expiresAt">;
      await this.requestConsent(offer);
      return new Response("ok", { headers: cors });
    }

    if (url.pathname.endsWith("/rpc/transferComplete") && req.method === "POST") {
        const { transferId } = await req.json() as { transferId: string };
        this.pendingChunks.delete(transferId);
        this.setState({ ...this.state, status: "idle" });
        const msg = JSON.stringify({ type: "transfer_sent" });
        for (const ws of this.connections) { try { ws.send(msg); } catch {} }
        return new Response("ok", { headers: cors });
    }

    return new Response("AuraDrop Agent", { headers: cors });
  }

  async webSocketMessage(ws: WebSocket, raw: string): Promise<void> {
    const msg = JSON.parse(raw) as { type: string; [key: string]: unknown };

    switch (msg.type) {
      case "initiate_drop":
        await this.initiateDrop(msg.targetHash as string, msg.transferId as string, msg.fileName as string, msg.fileSize as number,  msg.myHash as string,);
        break;
      case "accept_drop":
        await this.acceptDrop(msg.transferId as string, msg.fromAgentId as string);
        break;
      case "reject_drop":
        // do i want to keep it so there is no feedback to sender if a drop is rejected???
        this.setState({ ...this.state, incomingOffer: null, status: "idle" });
        break;
    }
  }

  private setState(newState: AgentState): void {
    this.state = newState;
    const msg = JSON.stringify({ type: "state", state: this.state });
    for (const ws of this.connections) {
      try { ws.send(msg); } catch { this.connections.delete(ws); }
    }
  }

  private async requestConsent(offer: Omit<TransferOffer, "expiresAt">): Promise<void> {
    console.log("requestConsent called, connections:", this.connections.size)
    this.setState({
      ...this.state,
      status: "receiving",
      incomingOffer: { ...offer, expiresAt: Date.now() + 10 * 60 * 1000 },
    });
    console.log("state after requestConsent:", JSON.stringify(this.state))
  }

  private async initiateDrop(targetHash: string, transferId: string, fileName: string, fileSize: number, fromHash: string,): Promise<void> {
    console.log("initiateDrop called, targeting:", targetHash)
    const targetAgent = this.env.AURA_AGENT.get(this.env.AURA_AGENT.idFromName(targetHash));
    const resp = await targetAgent.fetch(new Request("http://agent/rpc/requestConsent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fromHash, fileName, fileSize, transferId }),
    }));
    console.log("requestConsent RPC response:", resp.status)
    this.setState({ ...this.state, status: "offering" });
  }

  private async acceptDrop(transferId: string, fromAgentId: string): Promise<void> {
    const senderAgent = this.env.AURA_AGENT.get(this.env.AURA_AGENT.idFromName(fromAgentId));
    const resp = await senderAgent.fetch(new Request(`http://agent/chunks/${transferId}`));
    const { chunks, fileName, fileSize } = await resp.json() as PendingTransfer;

    console.log("acceptDrop called, transferId:", transferId, "fromAgentId:", fromAgentId)
    console.log("chunks fetched:", chunks.length)
    console.log("sending done msg, connections:", this.connections.size)

    this.setState({
      ...this.state, status: "transferring", incomingOffer: null,
      activeTransfer: { transferId, fileName, totalBytes: fileSize, bytesReceived: 0, direction: "receiving" },
    });

    for (let i = 0; i < chunks.length; i++) {
      const chunkMsg = JSON.stringify({ type: "chunk", index: i, data: chunks[i], total: chunks.length, fileName, transferId });
      for (const ws of this.connections) { try { ws.send(chunkMsg); } catch {} }
      this.setState({
        ...this.state,
        activeTransfer: { ...this.state.activeTransfer!, bytesReceived: Math.round((i + 1) / chunks.length * fileSize) },
      });
    }

    // notify receiver
    const doneMsg = JSON.stringify({ type: "transfer_complete", transferId, fileName });
    for (const ws of this.connections) { try { ws.send(doneMsg); } catch {} }    

    // notify sender
    await senderAgent.fetch(new Request("http://agent/rpc/transferComplete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transferId }),
    }));

    this.setState({ ...this.state, status: "idle", activeTransfer: null });

  }
}