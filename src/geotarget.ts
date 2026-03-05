interface Peer {
  ws: WebSocket;
  hashedID: string;
  displayName: string;
  lastSeen: number;
}

export class GeoTarget implements DurableObject {
  private peers = new Map<string, Peer>();

  constructor(private ctx: DurableObjectState, private env: Env) {}

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 })
    }

    const { 0: client, 1: server } = new WebSocketPair()
    server.accept()

    server.addEventListener("message", (evt) => {
        this.webSocketMessage(server, evt.data as string)
    })

    server.addEventListener("close", () => {
        this.webSocketClose(server)
    })

    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws: WebSocket, raw: string): Promise<void> {
    const msg = JSON.parse(raw);

    if (msg.type === "join") {
      const peer: Peer = {
        ws,
        hashedID: msg.hashedID,
        displayName: msg.displayName ?? "?",
        lastSeen: Date.now(),
      };
      
      this.peers.set(msg.hashedID, peer);
      this.broadcastPresence();
    }

    if (msg.type === "ping") {
      const peer = this.peers.get(msg.hashedID);
      if (peer) peer.lastSeen = Date.now();
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    for (const [id, p] of this.peers) {
      if (p.ws === ws) { this.peers.delete(id); break; }
    }
    this.broadcastPresence();
  }

  private broadcastPresence(): void {
    console.log("broadcastPresence called, peers:", this.peers.size)
    const now = Date.now();
    for (const [id, p] of this.peers)
      if (now - p.lastSeen > 300_000) this.peers.delete(id);

    for (const viewer of this.peers.values()) {
        const visible = [...this.peers.values()]
        .filter(o => o.hashedID !== viewer.hashedID)
        .map(p => ({ hashedID: p.hashedID, displayName: p.displayName }))

        console.log("sending to", viewer.displayName, "visible peers:", visible.length)

        try { viewer.ws.send(JSON.stringify({ type: "presence", peers: visible, cellCount: this.peers.size })) } catch {}
    }
  }
}