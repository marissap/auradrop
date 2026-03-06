interface AgentProfile {
    displayName: string;
    hashedPhone: string;
    status: string;
}

interface Contact {
    hashedPhone: string;
    displayName: string;
    addedAt: number;
}
interface AgentState {
    status: "idle" | "offering" | "receiving" | "transferring" | "in_session";
    incomingOffer: TransferOffer | null;
    activeTransfer: TransferProgress | null;
    incomingSession: SessionInvite | null;
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
    r2Key: string;
    fileName: string;
    fileSize: number;
}

interface SessionInvite {
    sessionId: string;
    fromHash: string;
    fromName: string;
    expiresAt: number;
}

export class AuraDropAgent implements DurableObject {
    private state: AgentState = {
        status: "idle",
        incomingOffer: null,
        activeTransfer: null,
        incomingSession: null,
    };
    private connections = new Set<WebSocket>();
    private pendingTransfers = new Map<string, PendingTransfer>();

    constructor(private ctx: DurableObjectState, private env: Env) { }

    async fetch(req: Request): Promise<Response> {
        const url = new URL(req.url);
        const cors = {
            "Access-Control-Allow-Origin": "*",
            "Content-Type": "application/json"
        };

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

        if (url.pathname.endsWith("/profile") && req.method === "GET") {
            const profile = await this.ctx.storage.get<AgentProfile>("profile");
            return Response.json(profile ?? null, { headers: cors });
        }

        if (url.pathname.endsWith("/profile") && req.method === "POST") {
            const profile = await req.json() as AgentProfile;
            await this.ctx.storage.put("profile", profile);
            return Response.json({ ok: true }, { headers: cors });
        }

        if (url.pathname.endsWith("/contacts") && req.method === "GET") {
            const contacts = await this.ctx.storage.get<Contact[]>("contacts") ?? [];
            return Response.json(contacts, { headers: cors });
        }

        if (url.pathname.endsWith("/contacts") && req.method === "POST") {
            const contact = await req.json() as Contact;
            const contacts = await this.ctx.storage.get<Contact[]>("contacts") ?? [];
            if (!contacts.find(c => c.hashedPhone === contact.hashedPhone)) {
                contacts.push({ ...contact, addedAt: Date.now() });
                await this.ctx.storage.put("contacts", contacts);
            }
            return Response.json({ ok: true }, { headers: cors });
        }

        if (url.pathname.endsWith("/rpc/contactNearby") && req.method === "POST") {
            const { hash, name } = await req.json() as { hash: string; name: string };
            this.broadcast({ type: "contact_nearby", hash, name });
            return new Response("ok", { headers: cors });
        }

        const delMatch = url.pathname.match(/\/contacts\/([a-f0-9]+)$/);
        if (delMatch && req.method === "DELETE") {
            let contacts = await this.ctx.storage.get<Contact[]>("contacts") ?? [];
            contacts = contacts.filter(c => c.hashedPhone !== delMatch[1]);
            await this.ctx.storage.put("contacts", contacts);
            return Response.json({ ok: true }, { headers: cors });
        }

        if (url.pathname.endsWith("/upload") && req.method === "POST") {
            const { fileName, fileSize, chunks } = await req.json() as
                { fileName: string; fileSize: number; chunks: string[] };
            const transferId = crypto.randomUUID();
            const r2Key = `transfers/${transferId}`;
            await this.env.FILES.put(r2Key, JSON.stringify({ chunks, fileName, fileSize }));
            this.pendingTransfers.set(transferId, { r2Key, fileName, fileSize });
            return Response.json({ transferId }, { headers: cors });
        }

        const chunksMatch = url.pathname.match(/\/chunks\/(.+)/);
        if (chunksMatch) {
            const meta = this.pendingTransfers.get(chunksMatch[1]);
            if (!meta) return new Response("Not found", { status: 404 });
            const obj = await this.env.FILES.get(meta.r2Key);
            if (!obj) return new Response("Not found", { status: 404 });
            return new Response(obj.body, { headers: cors });
        }

        if (url.pathname.endsWith("/rpc/requestConsent") && req.method === "POST") {
            const offer = await req.json() as Omit<TransferOffer, "expiresAt">;
            this.setState({
                ...this.state, status: "receiving",
                incomingOffer: { ...offer, expiresAt: Date.now() + 60_000 },
            });
            return new Response("ok", { headers: cors });
        }

        if (url.pathname.endsWith("/rpc/sessionInvite") && req.method === "POST") {
            const invite = await req.json() as Omit<SessionInvite, "expiresAt">;
            this.setState({
                ...this.state,
                incomingSession: { ...invite, expiresAt: Date.now() + 120_000 },
            });
            return new Response("ok", { headers: cors });
        }

        if (url.pathname.endsWith("/rpc/offerDeclined") && req.method === "POST") {
            const { transferId } = await req.json() as { transferId: string };
            const meta = this.pendingTransfers.get(transferId);
            if (meta) {
                await this.env.FILES.delete(meta.r2Key);
                this.pendingTransfers.delete(transferId);
            }
            this.setState({ ...this.state, status: "idle" });
            this.broadcast({ type: "offer_declined" });
            return new Response("ok", { headers: cors });
        }

        if (url.pathname.endsWith("/rpc/transferComplete") && req.method === "POST") {
            const { transferId } = await req.json() as { transferId: string };
            const meta = this.pendingTransfers.get(transferId);
            if (meta) {
                await this.env.FILES.delete(meta.r2Key); // clean up R2
                this.pendingTransfers.delete(transferId);
            }
            this.setState({ ...this.state, status: "idle" });
            this.broadcast({ type: "transfer_sent" });
            return new Response("ok", { headers: cors });
        }

        return new Response("AuraDrop Agent", { headers: cors });
    }

    async webSocketMessage(ws: WebSocket, raw: string): Promise<void> {
        const msg = JSON.parse(raw) as { type: string;[key: string]: unknown };

        switch (msg.type) {
            case "initiate_drop":
                await this.initiateDrop(msg.targetHash as string, msg.transferId as string, msg.fileName as string, msg.fileSize as number, msg.myHash as string, msg.myName as string);
                break;
            case "accept_drop":
                await this.acceptDrop(msg.transferId as string, msg.fromAgentId as string);
                break;
            case "reject_drop":
                if (this.state.incomingOffer) {
                    const sender = this.env.AURA_AGENT.get(
                        this.env.AURA_AGENT.idFromName(this.state.incomingOffer.fromHash));
                    await sender.fetch(new Request("http://agent/rpc/offerDeclined", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ transferId: this.state.incomingOffer.transferId }),
                    }));
                }
                this.setState({ ...this.state, incomingOffer: null, status: "idle" });
                break;
            case "invite_session":
                await this.inviteSession(msg.targetHash as string, msg.myHash as string, msg.myName as string);
                break;
            case "accept_session":
                this.setState({ ...this.state, status: "in_session", incomingSession: null });
                this.broadcast({ type: "session_ready", sessionId: msg.sessionId });
                break;
            case "reject_session":
                this.setState({ ...this.state, incomingSession: null, status: "idle" });
                break;
        }
    }

    private setState(newState: AgentState): void {
        this.state = newState;
        this.broadcast({ type: "state", state: this.state });
    }

    private broadcast(msg: unknown): void {
        const raw = JSON.stringify(msg);
        for (const ws of this.connections) {
            try { ws.send(raw); } catch { this.connections.delete(ws); }
        }
    }


    // private async requestConsent(offer: Omit<TransferOffer, "expiresAt">): Promise<void> {
    //     console.log("requestConsent called, connections:", this.connections.size)
    //     this.setState({
    //         ...this.state,
    //         status: "receiving",
    //         incomingOffer: { ...offer, expiresAt: Date.now() + 10 * 60 * 1000 },
    //     });
    //     console.log("state after requestConsent:", JSON.stringify(this.state))
    // }

    private async initiateDrop(targetHash: string, transferId: string,
        fileName: string, fileSize: number, fromHash: string, fromName: string): Promise<void> {
        const target = this.env.AURA_AGENT.get(this.env.AURA_AGENT.idFromName(targetHash));
        await target.fetch(new Request("http://agent/rpc/requestConsent", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ fromHash, fromName, fileName, fileSize, transferId }),
        }));
        this.setState({ ...this.state, status: "offering" });
    }

    private async acceptDrop(transferId: string, fromAgentId: string): Promise<void> {
        const senderAgent = this.env.AURA_AGENT.get(this.env.AURA_AGENT.idFromName(fromAgentId));
        const resp = await senderAgent.fetch(new Request(`http://agent/chunks/${transferId}`));
        const { chunks, fileName, fileSize } = await resp.json() as
            { chunks: string[]; fileName: string; fileSize: number };

        this.setState({
            ...this.state, status: "transferring", incomingOffer: null,
            activeTransfer: { transferId, fileName, totalBytes: fileSize, bytesReceived: 0, direction: "receiving" },
        });

        for (let i = 0; i < chunks.length; i++) {
            this.broadcast({ type: "chunk", index: i, data: chunks[i], total: chunks.length, fileName, transferId });
            this.setState({
                ...this.state,
                activeTransfer: { ...this.state.activeTransfer!, bytesReceived: Math.round((i + 1) / chunks.length * fileSize) },
            });
        }

        await senderAgent.fetch(new Request("http://agent/rpc/transferComplete", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ transferId }),
        }));

        this.broadcast({ type: "transfer_complete", transferId, fileName });
        this.setState({ ...this.state, status: "idle", activeTransfer: null });
    }

    private async inviteSession(targetHash: string, myHash: string, myName: string): Promise<void> {
        const sessionId = crypto.randomUUID();
        const target = this.env.AURA_AGENT.get(this.env.AURA_AGENT.idFromName(targetHash));
        await target.fetch(new Request("http://agent/rpc/sessionInvite", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId, fromHash: myHash, fromName: myName }),
        }));

        this.broadcast({ type: "session_ready", sessionId });
        this.setState({ ...this.state, status: "in_session" });
    }
}