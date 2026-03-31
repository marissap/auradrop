/* app.js — auradrop frontend logic */

const WORKER_URL = "https://auradrop.marissaphul.workers.dev";
const WS_URL = WORKER_URL.replace(/^https/, "wss").replace(/^http/, "ws");

let myHash;
let myName;
let myStatus;
let myLat;
let myLng;
let currentGeohash;
let contacts = [];
let peers = [];
let agentState = {};
let cellWs;
let agentWs;
let sessionWs;
let peerName;
let peerHash;
let aiEl;
let aiBuffer = "";
let inbound = {};
let pendingHash;
let pendingName;

const el = {
  setup: document.getElementById("setup"),
  inputName: document.getElementById("input-name"),
  inputPhone: document.getElementById("input-phone"),
  inputStatus: document.getElementById("input-status"),
  hashHint: document.getElementById("hash-hint"),
  enterBtn: document.getElementById("enter-btn"),
  userName: document.getElementById("user-name"),
  userStatus: document.getElementById("user-status"),
  connTag: document.getElementById("conn-tag"),
  geohashTag: document.getElementById("geohash-tag"),
  contactCount: document.getElementById("contact-count"),
  contactList: document.getElementById("contact-list"),
  inputContact: document.getElementById("input-contact"),
  addContactBtn: document.getElementById("add-contact-btn"),
  nearbyCount: document.getElementById("nearby-count"),
  nearby: document.getElementById("nearby"),
  idle: document.getElementById("idle"),
  session: document.getElementById("session"),
  sessionName: document.getElementById("session-name"),
  messages: document.getElementById("messages"),
  msgInput: document.getElementById("msg-input"),
  sendBtn: document.getElementById("send-btn"),
  endSessionBtn: document.getElementById("end-session-btn"),
  fileOverlay: document.getElementById("file-overlay"),
  offerFilename: document.getElementById("offer-filename"),
  offerInfo: document.getElementById("offer-info"),
  acceptOfferBtn: document.getElementById("accept-offer-btn"),
  rejectOfferBtn: document.getElementById("reject-offer-btn"),
  inviteOverlay: document.getElementById("invite-overlay"),
  inviteFrom: document.getElementById("invite-from"),
  acceptInviteBtn: document.getElementById("accept-invite-btn"),
  rejectInviteBtn: document.getElementById("reject-invite-btn"),
  nearbyOverlay: document.getElementById("nearby-overlay"),
  nearbyWho: document.getElementById("nearby-who"),
  startWithNearbyBtn: document.getElementById("start-with-nearby-btn"),
  dismissNearbyBtn: document.getElementById("dismiss-nearby-btn"),
  toasts: document.getElementById("toasts"),
};

async function hashPhone(phone) {
  const n = phone.replace(/\D/g, "");
  if (n.length < 7) return null;
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(n));
  return [...new Uint8Array(b)]
    .slice(0, 8)
    .map(x => x.toString(16).padStart(2, "0"))
    .join("");
}

function checkReady() {
  el.enterBtn.disabled = !(
    el.inputName.value.trim() && el.inputPhone.value.replace(/\D/g, "").length >= 7
  );
}

async function doSetup() {
  myName = el.inputName.value.trim();
  myStatus = el.inputStatus.value.trim();
  myHash = await hashPhone(el.inputPhone.value);
  if (!myHash) return;

  el.setup.style.display = "none";
  el.userName.textContent = myName;
  el.userStatus.textContent = myStatus || "";
  if (!myStatus) {
    el.userStatus.classList.add("empty");
  } else {
    el.userStatus.classList.remove("empty");
  }

  el.userStatus.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      el.userStatus.blur();
    }
  });

  el.userStatus.addEventListener("blur", async () => {
    const newStatus = el.userStatus.textContent.trim();
    if (newStatus === myStatus) return;

    myStatus = newStatus;
    el.userStatus.textContent = myStatus || "";
    if (!myStatus) {
      el.userStatus.classList.add("empty");
    } else {
      el.userStatus.classList.remove("empty");
    }

    saveProfile();
    if (cellWs?.readyState === 1) {
      cellWs.send(JSON.stringify({ type: "status_update", status: myStatus }));
    }
  });

  connectAgent();

  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      p => {
        myLat = p.coords.latitude;
        myLng = p.coords.longitude;
        onLocation();
      },
      () => toast("GPS denied", "err"),
      { enableHighAccuracy: true, timeout: 8000 }
    );
  } else {
    toast("GPS not supported", "err");
  }
}

function geohash(lat, lng, p = 5) {
  const B = "0123456789bcdefghjkmnpqrstuvwxyz";
  let i = 0,
    b = 0,
    e = true,
    s = "",
    la = -90,
    lb = 90,
    lo = -180,
    lp = 180;
  while (s.length < p) {
    if (e) {
      const m = (lo + lp) / 2;
      lng >= m ? (i = i * 2 + 1, (lo = m)) : (i *= 2, (lp = m));
    } else {
      const m = (la + lb) / 2;
      lat >= m ? (i = i * 2 + 1, (la = m)) : (i *= 2, (lb = m));
    }
    e = !e;
    if (++b === 5) {
      s += B[i];
      b = 0;
      i = 0;
    }
  }
  return s;
}

function onLocation() {
  const g = geohash(myLat, myLng);
  el.geohashTag.textContent = g;
  if (g !== currentGeohash) {
    currentGeohash = g;
    connectGeohashCell();
  }
}

function connectGeohashCell() {
  cellWs?.close();
  cellWs = new WebSocket(
    `${WS_URL}/cell?lat=${myLat}&lng=${myLng}&id=${myHash}&name=${encodeURIComponent(
      myName
    )}&status=${encodeURIComponent(myStatus)}`
  );

  cellWs.onopen = () => setConnected(1);
  cellWs.onclose = () => {
    setConnected(0);
    peers = [];
    renderNearby();
    setTimeout(connectGeohashCell, 3000);
  };

  cellWs.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.type === "presence") {
      peers = m.peers || [];
      renderNearby();
    }
  };

  setInterval(() => {
    if (cellWs?.readyState === 1) {
      cellWs.send(JSON.stringify({ type: "ping", peerId: myHash }));
    }
  }, 15000);
}

function connectAgent() {
  agentWs = new WebSocket(`${WS_URL}/agent/${myHash}`);
  agentWs.onopen = () => {
    loadContacts();
    saveProfile();
  };
  agentWs.onclose = () => setTimeout(connectAgent, 3000);
  agentWs.onmessage = e => {
    const m = JSON.parse(e.data);
    switch (m.type) {
      case "state":
        onState(m.state);
        break;
      case "chunk":
        onChunk(m);
        break;
      case "transfer_complete":
        onDone(m);
        break;
      case "transfer_sent":
        toast("file sent!", "ok");
        break;
      case "offer_declined":
        toast("declined", "err");
        break;
      case "contact_nearby":
        onNearby(m.hash, m.name);
        break;
      case "session_ready":
        onSessionReady(m.sessionId, m.peerName, m.peerHash);
        break;
    }
  };
}

function connectSession(id) {
  sessionWs?.close();
  sessionWs = new WebSocket(`${WS_URL}/session/${id}?hash=${myHash}&name=${encodeURIComponent(myName)}`);

  sessionWs.onmessage = e => {
    const msg = JSON.parse(e.data);
    switch (msg.type) {
      case "history":
        el.messages.innerHTML = "";
        msg.messages.forEach(addMsg);
        break;
      case "message":
        addMsg(msg.message);
        break;
      case "ai_typing":
        aiBuffer = "";
        aiEl = makeAIBubble();
        break;
      case "ai_token":
        if (aiEl) {
          aiBuffer += msg.token;
          aiEl.textContent = aiBuffer;
          scrollMessages();
        }
        break;
      case "ai_done":
        aiEl = null;
        scrollMessages();
        break;
      case "ai_error":
        toast("AI unavailable", "err");
        aiEl?.closest(".msg")?.remove();
        aiEl = null;
        break;
    }
  };
}

async function loadContacts() {
  try {
    contacts = await (await fetch(`${WORKER_URL}/agent/${myHash}/contacts`)).json();
    renderContacts();
    renderNearby();
  } catch {
    // ignore
  }
}

async function saveProfile() {
  try {
    await fetch(`${WORKER_URL}/agent/${myHash}/profile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: myName, hashedPhone: myHash, status: myStatus }),
    });
  } catch {
    // ignore
  }
}

async function addContact() {
  const phone = el.inputContact.value.trim();
  const hash = await hashPhone(phone);
  if (!hash) return toast("invalid number", "err");
  if (contacts.some(c => c.hashedPhone === hash)) return toast("already added!", "ok");

  const name = prompt("name?");
  if (!name) return;

  try {
    await fetch(`${WORKER_URL}/agent/${myHash}/contacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hashedPhone: hash, displayName: name }),
    });

    contacts.push({ hashedPhone: hash, displayName: name });
    el.inputContact.value = "";
    renderContacts();
    renderNearby();
    toast(`${name} added!`, "ok");
  } catch {
    toast("failed to add contact", "err");
  }
}

async function removeContact(hash) {
  try {
    await fetch(`${WORKER_URL}/agent/${myHash}/contacts/${hash}`, { method: "DELETE" });
    contacts = contacts.filter(c => c.hashedPhone !== hash);
    renderContacts();
    renderNearby();
  } catch {
    toast("failed to remove contact", "err");
  }
}

function renderContacts() {
  const nearbyHashes = new Set(peers.map(p => p.hashedID));
  el.contactCount.textContent = `(${contacts.length})`;

  if (!contacts.length) {
    el.contactList.innerHTML = `<span class="muted">no contacts yet.</span>`;
    return;
  }

  el.contactList.innerHTML = contacts
    .map(c => {
      const isNearby = nearbyHashes.has(c.hashedPhone);
      const sessionBtn = isNearby
        ? `
          <button onclick="startSession('${c.hashedPhone}','${escapeQuotes(c.displayName)}')">session</button>
          <label class="drop-file">
            drop file
            <input type="file" onchange="sendFile('${c.hashedPhone}','${escapeQuotes(
              c.displayName
            )}',this)">
          </label>`
        : `<span class="muted small">not nearby</span>`;

      return `<div class="item">
        <span class="item-name">${c.displayName}</span>
        ${isNearby ? `<span class="tag" data-tag="nearby">nearby</span>` : ""}
        <div class="item-actions">
          ${sessionBtn}
          <button class="button-danger" onclick="removeContact('${c.hashedPhone}')">×</button>
        </div>
      </div>`;
    })
    .join("");
}

function renderNearby() {
  const known = new Set(contacts.map(c => c.hashedPhone));
  const list = peers.filter(p => p.hashedID !== myHash);
  el.nearbyCount.textContent = `(${list.length})`;

  if (!list.length) {
    el.nearby.innerHTML = `<span class="muted full-width">searching…</span>`;
    return;
  }

  el.nearby.innerHTML = list
    .map(p => `
      <div class="card ${known.has(p.hashedID) ? "c" : ""}">
        <div class="card-name">${p.displayName}</div>
        <div class="card-status">${p.status || ""}</div>
        <button onclick="startSession('${p.hashedID}','${escapeQuotes(
          p.displayName
        )}')">session</button>
        <label class="drop-file">
          drop file
          <input type="file" onchange="sendFile('${p.hashedID}','${escapeQuotes(p.displayName)}',this)">
        </label>
      </div>
    `)
    .join("");
}

function startSession(hash, name) {
  peerHash = hash;
  peerName = name;
  agentWs.send(JSON.stringify({ type: "invite_session", targetHash: hash, myHash, myName }));
  toast(`Invite sent to ${name}…`, "ok");
}

function onSessionReady(id, pN, pH) {
  peerName = pN || peerName;
  peerHash = pH || peerHash;
  connectSession(id);
  el.sessionName.textContent = peerName;
  el.messages.innerHTML = "";
  el.idle.style.display = "none";
  el.session.classList.add("on");
}

function endSession() {
  sessionWs?.close();
  sessionWs = null;
  el.session.classList.remove("on");
  el.idle.style.display = "";
  agentWs.send(JSON.stringify({ type: "reject_session" }));
}

function sendMsg() {
  const text = el.msgInput.value.trim();
  if (!text || sessionWs?.readyState !== 1) return;
  sessionWs.send(JSON.stringify({ type: "message", text }));
  el.msgInput.value = "";
  el.msgInput.style.height = "";
}

function addMsg(msg) {
  const isMe = msg.fromHash === myHash;
  const isAI = msg.fromHash === "ai";
  const div = document.createElement("div");
  div.className = "msg";
  div.innerHTML = `
    <div class="msg-meta">${isMe ? "You" : msg.fromName} · ${new Date(
    msg.timestamp
  ).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>
    <div class="bubble ${isMe ? "me" : isAI ? "ai" : ""}">${safeHtml(msg.content)}</div>
  `;
  el.messages.appendChild(div);
  scrollMessages();
}

function makeAIBubble() {
  const div = document.createElement("div");
  div.className = "msg";
  div.innerHTML = `
    <div class="msg-meta">AI · now</div>
    <div class="bubble ai"></div>
  `;
  el.messages.appendChild(div);
  scrollMessages();
  return div.querySelector(".bubble");
}

function onState(state) {
  agentState = state;
  if (state.status === "receiving" && state.incomingOffer) {
    el.offerFilename.textContent = state.incomingOffer.fileName;
    el.offerInfo.textContent = `from ${state.incomingOffer.fromName || state.incomingOffer.fromHash.slice(0, 8)}`;
    overlay("file-overlay", 1);
  }
  if (state.status === "idle") {
    overlay("file-overlay", 0);
  }
  if (state.incomingSession) {
    el.inviteFrom.textContent = state.incomingSession.fromName;
    overlay("invite-overlay", 1);
  }
}

function acceptOffer() {
  const o = agentState.incomingOffer;
  if (!o) return;
  overlay("file-overlay", 0);
  agentWs.send(
    JSON.stringify({ type: "accept_drop", transferId: o.transferId, fromAgentId: o.fromHash })
  );
}

function rejectOffer() {
  overlay("file-overlay", 0);
  agentWs.send(JSON.stringify({ type: "reject_drop" }));
}

function onChunk({ index, data, fileName, transferId }) {
  if (!inbound[transferId]) inbound[transferId] = { chunks: [], fileName };
  inbound[transferId].chunks[index] = Uint8Array.from(atob(data), c => c.charCodeAt(0));
}

function onDone({ transferId, fileName }) {
  const transfer = inbound[transferId];
  if (!transfer) return;

  const blob = new Blob(transfer.chunks);
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(blob),
    download: transfer.fileName || fileName,
  });

  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);

  delete inbound[transferId];
  toast(`${transfer.fileName || fileName} saved`, "ok");
}

async function sendFile(targetHash, targetName, input) {
  const file = input.files[0];
  if (!file) return;
  input.value = "";

  const CHUNK_SIZE = 64 * 1024;
  const chunks = [];

  for (let i = 0; i < Math.ceil(file.size / CHUNK_SIZE); i++) {
    const buffer = await file.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE).arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let j = 0; j < bytes.length; j++) binary += String.fromCharCode(bytes[j]);
    chunks.push(btoa(binary));
  }

  const res = await fetch(`${WORKER_URL}/agent/${myHash}/upload`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileName: file.name, fileSize: file.size, chunks }),
  });
  const { transferId } = await res.json();

  agentWs.send(
    JSON.stringify({
      type: "initiate_drop",
      targetHash,
      transferId,
      fileName: file.name,
      fileSize: file.size,
      myHash,
      myName,
    })
  );

  toast(`offer sent to ${targetName}`, "ok");
}

function acceptInvite() {
  overlay("invite-overlay", 0);
  agentWs.send(
    JSON.stringify({
      type: "accept_session",
      sessionId: agentState.incomingSession?.sessionId,
      myName,
    })
  );
}

function rejectInvite() {
  overlay("invite-overlay", 0);
  agentWs.send(JSON.stringify({ type: "reject_session" }));
}

function onNearby(hash, name) {
  pendingHash = hash;
  pendingName = name;
  el.nearbyWho.textContent = name;
  overlay("nearby-overlay", 1);
}

function startWithNearby() {
  overlay("nearby-overlay", 0);
  pendingHash && startSession(pendingHash, pendingName);
}

function setConnected(on) {
  el.connTag.textContent = on ? "live" : "offline";
  el.connTag.className = "tag" + (on ? " live" : "");
}

function overlay(id, on) {
  document.getElementById(id).classList[on ? "add" : "remove"]("on");
}

function scrollMessages() {
  el.messages.scrollTop = el.messages.scrollHeight;
}

function toast(msg, type) {
  const elToast = Object.assign(document.createElement("div"), {
    className: `toast ${type}`,
    textContent: msg,
  });
  el.toasts.appendChild(elToast);
  setTimeout(() => elToast.remove(), 4000);
}

const escapeQuotes = s => s.replace(/'/g, "\\'");

function safeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");
}

function init() {
  el.inputName.addEventListener("input", checkReady);
  el.inputPhone.addEventListener("input", async e => {
    const h = await hashPhone(e.target.value);
    el.hashHint.textContent = h ? `→ ${h}` : "";
    checkReady();
  });

  el.enterBtn.addEventListener("click", doSetup);

  el.inputContact.addEventListener("keydown", e => {
    if (e.key === "Enter") {
      addContact();
      e.preventDefault();
    }
  });

  el.inputContact.addEventListener("keydown", e => {
    if (e.key === "Enter") {
      addContact();
      e.preventDefault();
    }
  });

  el.addContactBtn?.addEventListener("click", addContact);

  el.msgInput.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMsg();
    }
  });

  el.msgInput.addEventListener("input", () => {
    el.msgInput.style.height = "";
    el.msgInput.style.height = `${Math.min(el.msgInput.scrollHeight, 100)}px`;
  });

  el.sendBtn?.addEventListener("click", sendMsg);
  el.endSessionBtn?.addEventListener("click", endSession);
  el.acceptOfferBtn?.addEventListener("click", acceptOffer);
  el.rejectOfferBtn?.addEventListener("click", rejectOffer);
  el.acceptInviteBtn?.addEventListener("click", acceptInvite);
  el.rejectInviteBtn?.addEventListener("click", rejectInvite);
  el.startWithNearbyBtn?.addEventListener("click", startWithNearby);
  el.dismissNearbyBtn?.addEventListener("click", () => overlay("nearby-overlay", 0));
}


init();
