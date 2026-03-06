interface Message {
    role: "user" | "bot";
    content: string;
    fromHash: string;
    fromName: string;
    timestamp: number;
}

export class Session implements DurableObject {
    private connections = new Map<string, WebSocket>();
    private history: Message[] = [];
    private sessionId = "";

    constructor(private ctx: DurableObjectState, private env: Env) {
        // restore history if the agent goes into hibernation
        this.ctx.blockConcurrencyWhile(async () => {
            this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          role TEXT, content TEXT,
          from_hash TEXT, from_name TEXT,
          timestamp INTEGER
        )
      `);
            const rows = [...this.ctx.storage.sql.exec("SELECT * FROM messages ORDER BY id")];
            this.history = rows.map(r => ({
                role: r.role as "user" | "bot",
                content: r.content as string,
                fromHash: r.from_hash as string,
                fromName: r.from_name as string,
                timestamp: r.timestamp as number,
            }));
        });
    }

    async fetch(req: Request): Promise<Response> {
        if (req.headers.get("Upgrade") !== "websocket")
      return new Response("Expected WebSocket", { status: 426 });

    const url = new URL(req.url);
    const userHash = url.searchParams.get("hash") ?? "";
    const userName = decodeURIComponent(url.searchParams.get("name") ?? "Unknown");

    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();
    this.connections.set(userHash, server);

    // Send full history on connect so late joiners catch up
    server.send(JSON.stringify({ type: "history", messages: this.history }));

    // Notify everyone that this person joined
    this.broadcast({ type: "joined", hash: userHash, name: userName,
                       participants: this.connections.size }, userHash);

    server.addEventListener("message", evt =>
      this.onMessage(userHash, userName, evt.data as string));

    server.addEventListener("close", () => {
      this.connections.delete(userHash);
      this.broadcast({ type: "left", hash: userHash, name: userName,
                         participants: this.connections.size });
    });
        return new Response(null, { status: 101, webSocket: client })
    }

      private async onMessage(fromHash: string, fromName: string, raw: string): Promise<void> {
    const msg = JSON.parse(raw) as { type: string; text?: string };

    if (msg.type === "message" && msg.text) {
      const userMsg: Message = {
        role: "user", content: msg.text,
        fromHash, fromName, timestamp: Date.now(),
      };

      // save to db and broadcast to all participants
      this.saveMessage(userMsg);
      this.broadcast({ type: "message", message: userMsg });

      // bring ai into convo if message starts w @ai
      if (msg.text.startsWith("@ai")) {
        await this.streamAIResponse(msg.text.slice(3).trim(), fromName);
      }
    }
  }

  // idk if this is the most efficient way to stream a response
    private async streamAIResponse(prompt: string, triggeredBy: string): Promise<void> {
    // indicate that ai is typing
    this.broadcast({ type: "ai_typing" });

    // construct context window from prev messages
    const messages = [
      {
        role: "system",
        content: `you are a collaborative ai in a shared session between two people who are friends and physically nearby each other. you have access to their conversation history. be friendly, encourage teamwork, be collaborative. the person who called you is ${triggeredBy}.` // is this a good prompt? who knows
      },
      ...this.history.slice(-20).map(m => ({  // i am arbitrarily taking the last 20 messages but that lowkey feels like a lot and also, how much data do i want the ai to use if they switch from casual convo to planning?
        role: m.role,
        content: m.role === "user" ? `${m.fromName}: ${m.content}` : m.content,
      })),
      { role: "user", content: prompt },
    ];

    let fullResponse = "";

    try {
      const stream = await this.env.AI.run(
        "@cf/meta/llama-3.1-8b-instruct", // what model should i use?
        { messages, stream: true }
      ) as ReadableStream;

      const reader = stream.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split("\n").filter(l => l.startsWith("data: "));
        for (const line of lines) {
          const data = line.slice(6);
          if (data === "[DONE]") continue;
          try {
            const parsed = JSON.parse(data);
            const token = parsed.response ?? "";
            fullResponse += token;
            this.broadcast({ type: "ai_token", token });
          } catch {}
        }
      }
    } catch (e) {
      this.broadcast({ type: "ai_error", error: "AI unavailable" });
      return;
    }

    const aiMsg: Message = {
      role: "bot", content: fullResponse,
      fromHash: "ai", fromName: "AI", timestamp: Date.now(),
    };
    this.saveMessage(aiMsg);
    this.broadcast({ type: "ai_done", message: aiMsg });
  }

  private saveMessage(msg: Message): void {
    this.history.push(msg);
    this.ctx.storage.sql.exec(
      "INSERT INTO messages (role, content, from_hash, from_name, timestamp) VALUES (?,?,?,?,?)",
      msg.role, msg.content, msg.fromHash, msg.fromName, msg.timestamp
    );
  }

  private broadcast(msg: unknown, excludeHash?: string): void {
    const raw = JSON.stringify(msg);
    for (const [hash, ws] of this.connections) {
      if (hash === excludeHash) continue;
      try { ws.send(raw); } catch { this.connections.delete(hash); }
    }
  }


}