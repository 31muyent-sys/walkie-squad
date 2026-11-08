/* Walkie Squad: push-to-talk between phones, peer to peer (WebRTC via PeerJS's free public server).
   The host owns peer id "walkiesquad-<CODE>" and keeps the roster; audio flows directly between every pair (mesh). */
const $ = (id) => document.getElementById(id);
const PREFIX = "walkiesquad-";
const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I or O, they look like 1 and 0

let peer = null, isHost = false, hostConn = null, stream = null, micOk = false, ac = null, talkingNow = false;
const roster = new Map();   // peer id -> name, everyone including me
const members = new Map();  // host only: peer id -> data connection
const calls = new Map();    // peer id -> media call
const audios = new Map();   // peer id -> <audio>
const talking = new Set();

const say = (where, text) => { $(where).textContent = text || ""; };
const randomCode = () => Array.from({ length: 4 }, () => LETTERS[Math.random() * LETTERS.length | 0]).join("");
const cleanCode = (s) => (s || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
const myName = () => ($("name").value.trim() || "Player").slice(0, 16);

/* ---------- sound: walkie chirps made with Web Audio ---------- */
function audio() {
  ac = ac || new AudioContext();
  if (ac.state === "suspended") ac.resume();
  return ac;
}
function beep(freq, start, len, vol = 0.08, type = "square") {
  const a = audio(), t = a.currentTime + start, o = a.createOscillator(), g = a.createGain();
  o.type = type; o.frequency.value = freq;
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + len);
  o.connect(g).connect(a.destination); o.start(t); o.stop(t + len + 0.02);
}
function squelch(vol = 0.05) {
  const a = audio(), len = 0.12, buf = a.createBuffer(1, a.sampleRate * len, a.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
  const s = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain();
  s.buffer = buf; f.type = "bandpass"; f.frequency.value = 2200; g.gain.value = vol;
  s.connect(f).connect(g).connect(a.destination); s.start();
}
const chirpOn = () => { beep(1500, 0, 0.05); beep(1900, 0.06, 0.06); };
const chirpOff = () => { beep(1200, 0, 0.06); beep(900, 0.07, 0.08); squelch(); };

/* ---------- mic ---------- */
async function getMic() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    micOk = true;
  } catch {
    // no mic (denied, or not https on a phone): join as a listener with a silent stream so calls still connect
    micOk = false;
    stream = audio().createMediaStreamDestination().stream;
  }
  stream.getAudioTracks().forEach((t) => (t.enabled = false));
}

/* ---------- peer setup ---------- */
function makePeer(id) {
  return new Promise((resolve, reject) => {
    const p = id ? new Peer(id) : new Peer();
    p.once("open", () => resolve(p));
    p.once("error", (e) => { p.destroy(); reject(e); });
  });
}
function wirePeer() {
  peer.on("call", (call) => { call.answer(stream); attachCall(call); });
  peer.on("error", (e) => {
    if (e.type === "peer-unavailable") return; // someone left before we called them
    say("room-msg", e.type === "network" || e.type === "server-error" || e.type === "socket-error"
      ? "Lost the connection server. Check your internet." : `Connection problem: ${e.type}`);
  });
}
function attachCall(call) {
  calls.set(call.peer, call);
  call.on("stream", (s) => {
    let el = audios.get(call.peer);
    if (!el) { el = new Audio(); el.autoplay = true; audios.set(call.peer, el); }
    el.srcObject = s;
    el.play().catch(() => say("room-msg", "Tap anywhere to turn on sound."));
  });
  call.on("close", () => dropAudio(call.peer));
}
function dropAudio(id) {
  calls.get(id)?.close(); calls.delete(id);
  const el = audios.get(id); if (el) { el.srcObject = null; audios.delete(id); }
}

/* ---------- host ---------- */
async function createRoom() {
  say("lobby-msg", "Making your room...");
  audio(); await getMic();
  let code;
  for (let tries = 0; tries < 6 && !peer; tries++) {
    code = randomCode();
    try { peer = await makePeer(PREFIX + code); }
    catch (e) { if (e.type !== "unavailable-id") return say("lobby-msg", connectError(e)); }
  }
  if (!peer) return say("lobby-msg", "Couldn't get a free code. Try again.");
  isHost = true;
  roster.set(peer.id, myName());
  wirePeer();
  peer.on("connection", (conn) => {
    conn.on("data", (msg) => hostHandle(conn, msg));
    conn.on("close", () => {
      members.delete(conn.peer); roster.delete(conn.peer); talking.delete(conn.peer); dropAudio(conn.peer);
      broadcast({ type: "roster", roster: [...roster] }); render();
    });
  });
  enterRoom(code);
}
function hostHandle(conn, msg) {
  if (msg.type === "hello") {
    members.set(conn.peer, conn);
    roster.set(conn.peer, String(msg.name || "Player").slice(0, 16));
    broadcast({ type: "roster", roster: [...roster] });
    render(); squelch(0.03);
  } else if (msg.type === "talk") {
    setTalking(conn.peer, !!msg.on);
    broadcast({ type: "talk", id: conn.peer, on: !!msg.on });
  }
}
function broadcast(msg) { members.forEach((c) => c.open && c.send(msg)); }

/* ---------- joiner ---------- */
async function joinRoom() {
  const code = cleanCode($("code").value);
  if (code.length !== 4) return say("lobby-msg", "Room codes are 4 letters.");
  say("lobby-msg", "Joining...");
  audio(); await getMic();
  try { peer = await makePeer(); } catch (e) { return say("lobby-msg", connectError(e)); }
  wirePeer();
  peer.on("error", (e) => { if (e.type === "peer-unavailable" && !roster.size) { say("lobby-msg", `No room called ${code}. Check the code.`); reset(); } });
  hostConn = peer.connect(PREFIX + code, { reliable: true });
  const timer = setTimeout(() => { if (!roster.size) { say("lobby-msg", `No room called ${code}. Check the code.`); reset(); } }, 9000);
  let first = true;
  hostConn.on("open", () => hostConn.send({ type: "hello", name: myName() }));
  hostConn.on("data", (msg) => {
    if (msg.type === "roster") {
      clearTimeout(timer);
      roster.clear(); msg.roster.forEach(([id, name]) => roster.set(id, name));
      if (first) { // newcomer calls everyone already in the room; they answer, so every pair gets one call
        first = false; enterRoom(code);
        roster.forEach((_, id) => { if (id !== peer.id && !calls.has(id)) attachCall(peer.call(id, stream)); });
      }
      [...calls.keys()].forEach((id) => { if (!roster.has(id)) dropAudio(id); });
      render();
    } else if (msg.type === "talk") setTalking(msg.id, msg.on);
  });
  // shortcut: the room lives on the host's phone, so it ends when the host leaves; hand off to the next member if squads complain
  hostConn.on("close", () => { if (peer) { reset(); say("lobby-msg", "The host left, so the room closed."); } });
}

/* ---------- talking ---------- */
function setTalking(id, on) {
  const was = talking.has(id);
  on ? talking.add(id) : talking.delete(id);
  if (id !== peer?.id && was && !on) squelch(0.035); // the classic hiss when someone lets go
  render();
}
function press() {
  if (talkingNow || !peer) return;
  if (!micOk) return say("room-msg", "Your mic is blocked, so you can listen but not talk. Allow the mic and rejoin.");
  talkingNow = true;
  audio(); chirpOn();
  stream.getAudioTracks().forEach((t) => (t.enabled = true));
  $("ptt").classList.add("down"); $("led").className = "led tx"; say("ptt-label", "Talking");
  sendTalk(true);
}
function release() {
  if (!talkingNow) return;
  talkingNow = false;
  stream.getAudioTracks().forEach((t) => (t.enabled = false));
  chirpOff();
  $("ptt").classList.remove("down"); $("led").className = "led live"; say("ptt-label", "Hold to talk");
  sendTalk(false);
}
function sendTalk(on) {
  if (isHost) { setTalking(peer.id, on); broadcast({ type: "talk", id: peer.id, on }); }
  else { hostConn?.open && hostConn.send({ type: "talk", on }); setTalking(peer.id, on); }
}

/* ---------- screens ---------- */
function enterRoom(code) {
  $("lobby").hidden = true; $("room").hidden = false;
  $("channel").textContent = code; $("led").className = "led live";
  say("lobby-msg"); say("room-msg", micOk ? "" : "Mic blocked: you're in listen-only mode.");
  history.replaceState(null, "", `?room=${code}`);
  render();
}
function render() {
  $("squad").replaceChildren(...[...roster].map(([id, name]) => {
    const li = document.createElement("li");
    li.textContent = id === peer?.id ? `${name} (you)` : name;
    li.classList.toggle("talking", talking.has(id));
    return li;
  }));
}
function reset() {
  release();
  [...calls.keys()].forEach(dropAudio);
  members.clear(); roster.clear(); talking.clear();
  hostConn = null; isHost = false;
  stream?.getTracks().forEach((t) => t.stop()); stream = null;
  const p = peer; peer = null; p?.destroy();
  $("room").hidden = true; $("lobby").hidden = false;
  history.replaceState(null, "", location.pathname);
}
function connectError(e) {
  return e.type === "browser-incompatible" ? "This browser can't do walkie-talkie calls. Try Chrome or Safari."
    : "Couldn't reach the connection server. Check your internet and try again.";
}

/* ---------- controls ---------- */
$("create").onclick = createRoom;
$("join").onclick = joinRoom;
$("code").addEventListener("input", (e) => { e.target.value = cleanCode(e.target.value); });
$("code").addEventListener("keydown", (e) => { if (e.key === "Enter") joinRoom(); });
$("leave").onclick = () => { reset(); say("lobby-msg", "You left the room."); };
$("share").onclick = async () => {
  const link = `${location.origin}${location.pathname}?room=${$("channel").textContent}`;
  try { await navigator.clipboard.writeText(link); $("share").textContent = "Copied"; }
  catch { prompt("Copy this invite link:", link); }
  setTimeout(() => ($("share").textContent = "Copy invite link"), 1500);
};
const ptt = $("ptt");
ptt.addEventListener("pointerdown", (e) => { ptt.setPointerCapture(e.pointerId); press(); });
["pointerup", "pointercancel", "lostpointercapture"].forEach((ev) => ptt.addEventListener(ev, release));
ptt.addEventListener("contextmenu", (e) => e.preventDefault()); // long-press on phones shouldn't open a menu
document.addEventListener("keydown", (e) => {
  if (e.code !== "Space" || e.repeat || $("room").hidden || e.target.closest("input")) return;
  e.preventDefault(); press();
});
document.addEventListener("keyup", (e) => { if (e.code === "Space" && !$("room").hidden) { e.preventDefault(); release(); } });
document.addEventListener("pointerdown", () => audios.forEach((el) => el.paused && el.play().catch(() => {})));
addEventListener("pagehide", () => peer?.destroy());

// invite links: ?room=CODE fills the code so a friend only types their name
const invited = cleanCode(new URLSearchParams(location.search).get("room"));
if (invited.length === 4) { $("code").value = invited; say("lobby-msg", `Invited to room ${invited}. Add your name and tap Join.`); }
