interface Peer {
    ws: WebSocket;
    hashedID: string;
    displayName: string;
    status: string;
    lastSeen: number;
}

export class GeoTarget implements DurableObject {
    private peers = new Map<string, Peer>();

    constructor(private ctx: DurableObjectState, private env: Env) { }

    async fetch(req: Request): Promise<Response> {
        if (req.headers.get("Upgrade") !== "websocket")
            return new Response("Expected WebSocket", { status: 426 });

        const url = new URL(req.url);
        const hashedID = url.searchParams.get("id") ?? "";
        const displayName = decodeURIComponent(url.searchParams.get("name") ?? "Unknown");
        const status = decodeURIComponent(url.searchParams.get("status") ?? "");

        const { 0: client, 1: server } = new WebSocketPair();
        server.accept();

        this.peers.set(hashedID, { ws: server, hashedID, displayName, status, lastSeen: Date.now() });

        // what happens if someone is a contact of one person and not another in the convo? can they still be added? i think yes bc thats how video calls work rn
        // so yeah, i think it doesn't have to be mutual trust
        // or does it bc location is more sensitive info
        await this.confirmTrust(hashedID, displayName);

        this.broadcastPresence();

        server.addEventListener("message", () => {
            const peer = this.peers.get(hashedID);
            if (peer) peer.lastSeen = Date.now();
        });

        server.addEventListener("close", () => {
            this.peers.delete(hashedID);
            this.broadcastPresence();
        });

        return new Response(null, { status: 101, webSocket: client })
    }

    private async confirmTrust(newHash: string, newName: string): Promise<void> {
        const newAgent = this.env.AURA_AGENT.get(this.env.AURA_AGENT.idFromName(newHash));
        const contactsResp = await newAgent.fetch(new Request(`http://agent/contacts`));
        const contacts = await contactsResp.json() as { hashedPhone: string; displayName: string }[];
        const contactHashes = new Set(contacts.map(c => c.hashedPhone));

        // this is the code for mutual trust which i am still undecided on
        for (const [existingHash, existingPeer] of this.peers) {
            if (existingHash === newHash) continue;
            if (!contactHashes.has(existingHash)) continue;

            const existingAgent = this.env.AURA_AGENT.get(this.env.AURA_AGENT.idFromName(existingHash));
            const existingContactsResp = await existingAgent.fetch(new Request(`http://agent/contacts`));
            const existingContacts = await existingContactsResp.json() as { hashedPhone: string }[];

            if (!existingContacts.find(c => c.hashedPhone === newHash)) continue;

            await newAgent.fetch(new Request("http://agent/rpc/contactNearby", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ hash: existingHash, name: existingPeer.displayName }),
            }));

            await existingAgent.fetch(new Request("http://agent/rpc/contactNearby", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ hash: newHash, name: newName }),
            }));
        }
    }

    private broadcastPresence(): void {
        const now = Date.now();
        for (const [id, p] of this.peers)
            if (now - p.lastSeen > 30_000) this.peers.delete(id);

        const peerList = [...this.peers.values()].map(p => ({
            hashedID: p.hashedID, displayName: p.displayName, status: p.status,
        }));

        for (const peer of this.peers.values()) {
            try {
                peer.ws.send(JSON.stringify({ type: "presence", peers: peerList }));
            } catch { }
        }
    }
}