import { useState, useEffect, useRef } from "react";
import { supabase } from "./supabase";

// ─────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────
const ROUNDS = ["Prelims", "Top 32", "Top 16", "Top 8", "Top 4", "Finals"];
const ROUND_LIMIT = { Prelims: 999, "Top 32": 32, "Top 16": 16, "Top 8": 8, "Top 4": 4, Finals: 2 };

// Suggested categories shown as quick-add chips during event creation
const SUGGESTED_CATEGORIES = [
  "HipHop", "Breaking", "Popping", "Locking", "Waacking",
  "House", "All Styles", "Rep Your Style", "Krump",
  "2 vs 2", "Crew vs Crew", "Experimental", "Kids",
];

// Color palette — cycles through for any number of categories
const PALETTE = [
  { primary: "#ffd700", bg: "#2a220066", border: "#ffd70044" },
  { primary: "#ff4d4d", bg: "#2a0a0a66", border: "#ff4d4d44" },
  { primary: "#00e5ff", bg: "#002a2a66", border: "#00e5ff44" },
  { primary: "#7fff00", bg: "#0a2a0066", border: "#7fff0044" },
  { primary: "#ff69b4", bg: "#2a0a1a66", border: "#ff69b444" },
  { primary: "#ff9800", bg: "#2a1a0066", border: "#ff980044" },
  { primary: "#b388ff", bg: "#1a0a2a66", border: "#b388ff44" },
  { primary: "#00e676", bg: "#002a1066", border: "#00e67644" },
  { primary: "#ff6e40", bg: "#2a1a0a66", border: "#ff6e4044" },
  { primary: "#40c4ff", bg: "#002a3066", border: "#40c4ff44" },
];

const getCatColor = (categories, cat) => {
  const idx = categories.indexOf(cat);
  return PALETTE[idx % PALETTE.length];
};

// ─────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────
const rand4     = () => Math.floor(1000 + Math.random() * 9000);
const randAlpha = (n) => Array.from({ length: n }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)]).join("");
const genOrgCode = () => `ORG-${randAlpha(3)}-${rand4()}`;

const genJudgeCodes = (prefix, categories, judgeCounts = {}) => {
  const codes = [];
  categories.forEach((cat) => {
    const slug = cat.replace(/\s+/g, "").slice(0, 3).toUpperCase();
    const count = Math.max(1, Math.min(10, parseInt(judgeCounts[cat]) || 3));
    for (let i = 1; i <= count; i++) {
      codes.push({ code: `${prefix}-${slug}${rand4()}`, category: cat, slot: i });
    }
  });
  return codes;
};

const calcAvgScore = (arr = []) => {
  if (!arr.length) return 0;
  return Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10);
};

const detectBias = (scoreMap = {}) => {
  const entries = Object.entries(scoreMap);
  if (entries.length < 2) return [];
  const avg = entries.reduce((a, [, v]) => a + v, 0) / entries.length;
  return entries.filter(([, v]) => Math.abs(v - avg) > 1.5).map(([j, s]) => ({ judge: j, score: s, avg: avg.toFixed(1) }));
};

// ─────────────────────────────────────────────────────────────────
// CSS
// ─────────────────────────────────────────────────────────────────
const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Barlow:wght@300;400;600;700&display=swap');
  * { box-sizing: border-box; } body { margin: 0; background: #080808; }
  ::-webkit-scrollbar { width: 4px; } ::-webkit-scrollbar-track { background: #111; } ::-webkit-scrollbar-thumb { background: #333; }
  .tbtn { font-family: 'Bebas Neue', sans-serif; font-size: 12px; letter-spacing: 2px; padding: 9px 14px; border: none; cursor: pointer; transition: all .2s; border-bottom: 3px solid transparent; background: transparent; color: #555; white-space: nowrap; }
  .tbtn:hover { color: #fff; }
  .card { background: #111; border: 1px solid #1e1e1e; border-radius: 12px; padding: 18px; margin-bottom: 12px; }
  .inp { background: #151515; border: 1px solid #2a2a2a; color: #fff; padding: 9px 13px; border-radius: 8px; font-family: 'Barlow', sans-serif; font-size: 13px; width: 100%; outline: none; transition: border-color .2s; }
  .inp:focus { border-color: #888; }
  .btn { font-family: 'Bebas Neue', sans-serif; letter-spacing: 2px; padding: 9px 18px; border: none; border-radius: 8px; cursor: pointer; font-size: 13px; transition: all .2s; }
  .btn:hover { opacity: .85; transform: translateY(-1px); }
  .btn:disabled { opacity: .35; cursor: not-allowed; transform: none; }
  .badge { display: inline-block; padding: 3px 10px; border-radius: 20px; font-family: 'Barlow', sans-serif; font-size: 10px; font-weight: 700; letter-spacing: 1px; }
  .pulse { animation: pulse 1.5s infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .4; } }
  .slide { animation: slideIn .2s ease; }
  @keyframes slideIn { from { transform: translateY(-6px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
  .lrow { display: flex; align-items: center; gap: 13px; padding: 11px 16px; border-bottom: 1px solid #0f0f0f; transition: background .15s; }
  .lrow:hover { background: #111; }
  .mcard { background: #111; border: 1px solid #1e1e1e; border-radius: 10px; overflow: hidden; min-width: 170px; }
  .mfighter { padding: 9px 12px; display: flex; justify-content: space-between; align-items: center; font-family: 'Barlow', sans-serif; font-size: 12px; border-bottom: 1px solid #1a1a1a; }
  .mfighter:last-child { border-bottom: none; }
  .chip { font-family: 'Barlow', sans-serif; font-size: 11px; padding: 5px 12px; border-radius: 20px; border: 1px solid #2a2a2a; background: #111; color: #777; cursor: pointer; transition: all .15s; white-space: nowrap; }
  .chip:hover { border-color: #555; color: #fff; }
  .chip.active { background: #ff4d4d22; border-color: #ff4d4d; color: #ff4d4d; }
  select { appearance: none; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='7' fill='%23888'%3E%3Cpath d='M0 0l5 7 5-7z'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 11px center; }
  .spin { display: inline-block; width: 16px; height: 16px; border: 2px solid #ffffff44; border-top-color: #fff; border-radius: 50%; animation: spinner .6s linear infinite; vertical-align: middle; }
  @keyframes spinner { to { transform: rotate(360deg); } }
`;

// ─────────────────────────────────────────────────────────────────
// MICRO COMPONENTS
// ─────────────────────────────────────────────────────────────────
function Spinner() { return <span className="spin" />; }

function Toast({ toast }) {
  if (!toast) return null;
  return (
    <div className="slide" style={{ position: "fixed", top: 16, right: 16, zIndex: 9999, background: toast.type === "error" ? "#200a0a" : "#0a200a", border: `1px solid ${toast.type === "error" ? "#ff4d4d" : "#00c853"}`, borderRadius: 10, padding: "10px 18px", fontFamily: "Barlow,sans-serif", fontSize: 13, color: toast.type === "error" ? "#ff4d4d" : "#00c853", maxWidth: 300 }}>
      {toast.msg}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// SCREEN: LANDING
// ─────────────────────────────────────────────────────────────────
// SCREEN: LANDING
// ─────────────────────────────────────────────────────────────────
function LandingScreen({ onAdminLogin, onOrgLogin, onJudgeLogin }) {
  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 32, textAlign: "center", background: "#080808" }}>
      <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 64, letterSpacing: 6, lineHeight: 1 }}>DAN<span style={{ color: "#ff4d4d" }}>BUZZ</span></div>
      <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 11, color: "#444", letterSpacing: 4, marginBottom: 52 }}>BATTLE MANAGEMENT SYSTEM</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 14, width: "100%", maxWidth: 320 }}>
        <button className="btn" style={{ background: "#ff4d4d", color: "#000", fontSize: 14, padding: "15px" }} onClick={onOrgLogin}>🔑 ORGANIZER LOGIN</button>
        <button className="btn" style={{ background: "#111", color: "#aaa", border: "1px solid #222", fontSize: 13, padding: "14px" }} onClick={onJudgeLogin}>⚖️ JUDGE LOGIN</button>
        <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 10, color: "#333", marginTop: 4 }}>First time as a judge? Use Judge Login — it handles registration too.</div>
      </div>
      <div style={{ marginTop: 52, borderTop: "1px solid #111", paddingTop: 20 }}>
        <button style={{ background: "none", border: "none", color: "#1e1e1e", cursor: "pointer", fontFamily: "Barlow,sans-serif", fontSize: 9, letterSpacing: 3 }} onClick={onAdminLogin}>ADMIN</button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// SCREEN: ADMIN LOGIN (DanBuzz only — email + password via Supabase Auth)
// ─────────────────────────────────────────────────────────────────
function AdminLoginScreen({ onBack, onLogin, showToast }) {
  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading]   = useState(false);

  const handleLogin = async () => {
    if (!email.trim() || !password.trim()) return showToast("Fill in all fields!", "error");
    setLoading(true);
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) { showToast(error.message, "error"); setLoading(false); return; }
    onLogin(data.user);
    setLoading(false);
  };

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 32, background: "#080808" }}>
      <div style={{ width: "100%", maxWidth: 360 }}>
        <button className="btn" style={{ background: "transparent", color: "#333", border: "none", padding: 0, marginBottom: 24, fontSize: 12, letterSpacing: 2 }} onClick={onBack}>← BACK</button>
        <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 12, color: "#ff4d4d", letterSpacing: 4, marginBottom: 4 }}>DANBUZZ</div>
        <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 26, letterSpacing: 3, marginBottom: 4 }}>ADMIN LOGIN</div>
        <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 12, color: "#555", marginBottom: 28 }}>Restricted to DanBuzz administrators only.</div>
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 10, color: "#555", letterSpacing: 2, marginBottom: 6 }}>EMAIL</div>
          <input className="inp" type="email" placeholder="admin@danbuzz.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 10, color: "#555", letterSpacing: 2, marginBottom: 6 }}>PASSWORD</div>
          <input className="inp" type="password" placeholder="••••••••" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleLogin()} />
        </div>
        <button className="btn" style={{ background: "#ff4d4d", color: "#000", width: "100%", fontSize: 14, padding: "13px" }} onClick={handleLogin} disabled={loading}>
          {loading ? <Spinner /> : "LOGIN →"}
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// SCREEN: ADMIN DASHBOARD — create & manage all events
// ─────────────────────────────────────────────────────────────────
function AdminDashboard({ onBack, showToast }) {
  const [tab, setTab]         = useState("events");
  const [events, setEvents]   = useState([]);
  const [loading, setLoading] = useState(true);

  const loadEvents = async () => {
    setLoading(true);
    const { data } = await supabase.from("events").select("*").order("created_at", { ascending: false });
    setEvents(data || []);
    setLoading(false);
  };

  useEffect(() => { loadEvents(); }, []);

  const deleteEvent = async (id, name) => {
    if (!window.confirm(`Delete "${name}"? This cannot be undone.`)) return;
    const { error } = await supabase.from("events").delete().eq("id", id);
    if (error) return showToast("Delete failed: " + error.message, "error");
    showToast("Event deleted ✓");
    loadEvents();
  };

  return (
    <div style={{ fontFamily: "'Bebas Neue',Impact,sans-serif", background: "#080808", minHeight: "100vh", color: "#fff" }}>
      {/* Header */}
      <div style={{ padding: "22px 22px 0", maxWidth: 1100, margin: "0 auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>
          <div>
            <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 36, letterSpacing: 4, lineHeight: 1 }}>DAN<span style={{ color: "#ff4d4d" }}>BUZZ</span> <span style={{ fontSize: 14, color: "#ff4d4d", letterSpacing: 3 }}>ADMIN</span></div>
            <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 11, color: "#555", marginTop: 4 }}>{events.length} events total</div>
          </div>
          <button className="btn" style={{ background: "transparent", color: "#555", border: "1px solid #222", fontSize: 11 }} onClick={onBack}>← LOGOUT</button>
        </div>
        {/* Tabs */}
        <div style={{ display: "flex", borderBottom: "1px solid #1a1a1a" }}>
          {[{ key: "events", label: "ALL EVENTS" }, { key: "create", label: "+ CREATE EVENT" }].map((t) => (
            <button key={t.key} className="tbtn" style={{ color: tab === t.key ? "#ff4d4d" : "#555", borderBottom: tab === t.key ? "3px solid #ff4d4d" : "3px solid transparent" }} onClick={() => setTab(t.key)}>{t.label}</button>
          ))}
        </div>
      </div>

      <div style={{ padding: "20px 22px 40px", maxWidth: 1100, margin: "0 auto" }}>
        {/* ALL EVENTS */}
        {tab === "events" && (
          <div className="slide">
            {loading ? <div style={{ textAlign: "center", padding: 48 }}><Spinner /></div> : events.length === 0 ? (
              <div style={{ textAlign: "center", padding: "48px", fontFamily: "Barlow,sans-serif", color: "#333" }}>No events yet — create one using the tab above.</div>
            ) : events.map((ev) => {
              const cats       = ev.categories || [];
              const jCounts    = ev.judge_counts || {};
              const totalJudges = cats.reduce((sum, cat) => sum + (parseInt(jCounts[cat]) || 3), 0);
              return (
                <div key={ev.id} style={{ background: "#111", border: "1px solid #1e1e1e", borderRadius: 12, padding: "16px 20px", marginBottom: 12, display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
                  <div>
                    <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 18, letterSpacing: 2 }}>{ev.name}</div>
                    <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 11, color: "#555", marginTop: 2 }}>
                      {ev.city} · {ev.date}{ev.organizer_name ? ` · ${ev.organizer_name}` : ""}
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 }}>
                      {cats.slice(0, 5).map((cat, i) => {
                        const c     = PALETTE[i % PALETTE.length];
                        const count = parseInt(jCounts[cat]) || 3;
                        return (
                          <span key={cat} style={{ fontFamily: "Barlow,sans-serif", fontSize: 9, padding: "2px 8px", borderRadius: 10, background: c.bg, border: `1px solid ${c.border}`, color: c.primary }}>
                            {cat} · {count}J
                          </span>
                        );
                      })}
                      {cats.length > 5 && <span style={{ fontFamily: "Barlow,sans-serif", fontSize: 9, color: "#444" }}>+{cats.length - 5} more</span>}
                    </div>
                    <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 9, color: "#444", marginTop: 5, letterSpacing: 1 }}>
                      {cats.length} CATEGORIES · {totalJudges} JUDGE SLOTS TOTAL
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <div style={{ background: "#0f0f0f", border: "1px solid #ff4d4d22", borderRadius: 7, padding: "6px 12px" }}>
                      <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 8, color: "#555", letterSpacing: 2 }}>ORG CODE</div>
                      <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 14, color: "#ff4d4d", letterSpacing: 2 }}>{ev.org_code}</div>
                    </div>
                    <button className="btn" style={{ fontSize: 10, background: "#1a0a0a", color: "#ff4d4d", border: "1px solid #ff4d4d33" }} onClick={() => deleteEvent(ev.id, ev.name)}>DELETE</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* CREATE EVENT */}
        {tab === "create" && (
          <AdminCreateEvent showToast={showToast} onCreated={() => { setTab("events"); loadEvents(); }} />
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// ADMIN: CREATE EVENT sub-component
// ─────────────────────────────────────────────────────────────────
function AdminCreateEvent({ showToast, onCreated }) {
  const [form, setForm]               = useState({ name: "", date: "", city: "", organizer: "" });
  const [categories, setCategories]   = useState([]);
  const [customInput, setCustomInput] = useState("");
  const [judgeCounts, setJudgeCounts] = useState({});
  const [loading, setLoading]         = useState(false);
  const [createdEvent, setCreatedEvent] = useState(null);
  const [copied, setCopied]           = useState(null);

  const copy = (val) => { navigator.clipboard?.writeText(val).catch(() => {}); setCopied(val); setTimeout(() => setCopied(null), 1500); };

  const addCategory = (cat) => {
    const trimmed = cat.trim();
    if (!trimmed) return;
    if (categories.map((c) => c.toLowerCase()).includes(trimmed.toLowerCase())) return showToast(`"${trimmed}" already added!`, "error");
    setCategories((prev) => [...prev, trimmed]);
    setCustomInput("");
  };
  const removeCategory = (cat) => {
    setCategories((prev) => prev.filter((c) => c !== cat));
    setJudgeCounts((prev) => { const n = { ...prev }; delete n[cat]; return n; });
  };
  const toggleSuggested = (cat) => {
    if (categories.map((c) => c.toLowerCase()).includes(cat.toLowerCase())) removeCategory(cat);
    else addCategory(cat);
  };

  const submit = async () => {
    if (!form.name.trim() || !form.date || !form.city.trim()) return showToast("Fill in event name, date and city!", "error");
    if (categories.length === 0) return showToast("Add at least one category!", "error");
    setLoading(true);
    const orgCode    = genOrgCode();
    const prefix     = randAlpha(3);
    const judgeCodes = genJudgeCodes(prefix, categories, judgeCounts);

    const { data: eventData, error: eventError } = await supabase
      .from("events")
      .insert({ name: form.name.trim(), city: form.city.trim(), date: form.date, org_code: orgCode, categories, organizer_name: form.organizer.trim() || null, judge_counts: judgeCounts })
      .select().single();
    if (eventError) { showToast("Failed to create event: " + eventError.message, "error"); setLoading(false); return; }

    const { error: codesError } = await supabase.from("judge_codes").insert(
      judgeCodes.map((j) => ({ event_id: eventData.id, code: j.code, category: j.category, slot: j.slot }))
    );
    if (codesError) { showToast("Failed to generate judge codes!", "error"); setLoading(false); return; }

    const { data: fullCodes } = await supabase.from("judge_codes").select("*").eq("event_id", eventData.id);
    setCreatedEvent({ ...eventData, judgeCodes: fullCodes || [] });
    showToast(`Event "${eventData.name}" created ✓`);
    setLoading(false);
  };

  if (createdEvent) {
    const codes = createdEvent.judgeCodes || [];
    return (
      <div className="slide">
        <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 12, color: "#00c853", letterSpacing: 3, marginBottom: 6 }}>✓ EVENT CREATED</div>
        <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 26, letterSpacing: 2, marginBottom: 2 }}>{createdEvent.name}</div>
        <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 12, color: "#555", marginBottom: 20 }}>{createdEvent.city} · {createdEvent.date}{createdEvent.organizer_name ? ` · Organizer: ${createdEvent.organizer_name}` : ""}</div>

        {/* Org code */}
        <div style={{ background: "#0f0f0f", border: "1px solid #ff4d4d44", borderRadius: 12, padding: 20, marginBottom: 20 }}>
          <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 10, color: "#ff4d4d", letterSpacing: 3, marginBottom: 8 }}>ORGANIZER CODE — Share this with the event organizer</div>
          <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
            <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 34, letterSpacing: 6, color: "#ff4d4d" }}>{createdEvent.org_code}</div>
            <button className="btn" style={{ fontSize: 10, padding: "6px 14px", background: "transparent", border: "1px solid #ff4d4d44", color: "#ff4d4d" }} onClick={() => copy(createdEvent.org_code)}>
              {copied === createdEvent.org_code ? "✓ COPIED" : "COPY"}
            </button>
          </div>
        </div>

        {/* Judge codes per category */}
        <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 10, color: "#555", letterSpacing: 3, marginBottom: 14 }}>JUDGE CODES — Share each one with the respective judge</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(260px,1fr))", gap: 12, marginBottom: 24 }}>
          {(createdEvent.categories || []).map((cat, catIdx) => {
            const c        = PALETTE[catIdx % PALETTE.length];
            const catCodes = codes.filter((j) => j.category === cat);
            return (
              <div key={cat} style={{ background: "#0f0f0f", border: `1px solid ${c.border}`, borderRadius: 10, padding: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                  <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 14, letterSpacing: 2, color: c.primary }}>{cat}</div>
                  <span style={{ fontFamily: "Barlow,sans-serif", fontSize: 9, color: c.primary, background: c.bg, border: `1px solid ${c.border}`, borderRadius: 20, padding: "2px 8px" }}>{catCodes.length} JUDGES</span>
                </div>
                {catCodes.map((j) => (
                  <div key={j.code} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 7, padding: "7px 10px", background: "#151515", borderRadius: 7 }}>
                    <div>
                      <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 13, letterSpacing: 2 }}>{j.code}</div>
                      <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 9, color: "#555" }}>Judge {j.slot}</div>
                    </div>
                    <button className="btn" style={{ fontSize: 9, padding: "4px 9px", background: "transparent", border: `1px solid ${c.primary}`, color: c.primary }} onClick={() => copy(j.code)}>
                      {copied === j.code ? "✓" : "COPY"}
                    </button>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
        <button className="btn" style={{ background: "#111", color: "#fff", border: "1px solid #2a2a2a", fontSize: 12 }} onClick={() => { setCreatedEvent(null); setForm({ name: "", date: "", city: "", organizer: "" }); setCategories([]); setJudgeCounts({}); onCreated(); }}>
          ← BACK TO ALL EVENTS
        </button>
      </div>
    );
  }

  return (
    <div className="slide" style={{ maxWidth: 640 }}>
      <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 22, letterSpacing: 3, marginBottom: 20 }}>CREATE NEW EVENT</div>

      {/* Organizer name */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 10, color: "#555", letterSpacing: 2, marginBottom: 6 }}>ORGANIZER NAME <span style={{ color: "#333" }}>(optional)</span></div>
        <input className="inp" placeholder="e.g. Rhythmix Crew, Battle Zone NE" value={form.organizer} onChange={(e) => setForm((f) => ({ ...f, organizer: e.target.value }))} />
      </div>

      {[["Event Name", "name", "text", "e.g. Danbuzz Open 2025"], ["City / Venue", "city", "text", "e.g. Imphal, Manipur"], ["Event Date", "date", "date", ""]].map(([label, key, type, ph]) => (
        <div key={key} style={{ marginBottom: 14 }}>
          <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 10, color: "#555", letterSpacing: 2, marginBottom: 6 }}>{label}</div>
          <input className="inp" type={type} placeholder={ph} value={form[key]} onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))} />
        </div>
      ))}

      {/* Categories */}
      <div style={{ margin: "20px 0 0" }}>
        <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 10, color: "#555", letterSpacing: 2, marginBottom: 10 }}>CATEGORIES <span style={{ color: "#ff4d4d" }}>*</span></div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
          {SUGGESTED_CATEGORIES.map((cat) => {
            const isAdded = categories.map((c) => c.toLowerCase()).includes(cat.toLowerCase());
            return <button key={cat} className={`chip${isAdded ? " active" : ""}`} onClick={() => toggleSuggested(cat)}>{isAdded ? "✓ " : "+ "}{cat}</button>;
          })}
        </div>
        <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
          <input className="inp" placeholder="Custom category..." value={customInput} onChange={(e) => setCustomInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addCategory(customInput); } }} />
          <button className="btn" style={{ background: "#1a1a1a", color: "#fff", border: "1px solid #2a2a2a", whiteSpace: "nowrap" }} onClick={() => addCategory(customInput)}>+ ADD</button>
        </div>
        {categories.length > 0 && (
          <div style={{ background: "#0f0f0f", border: "1px solid #1e1e1e", borderRadius: 12, padding: 14, marginBottom: 8 }}>
            <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 10, color: "#555", letterSpacing: 2, marginBottom: 10 }}>CATEGORIES ({categories.length}) — Judges per category</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {categories.map((cat, i) => {
                const c = PALETTE[i % PALETTE.length];
                const count = judgeCounts[cat] || 3;
                return (
                  <div key={cat} style={{ display: "flex", alignItems: "center", gap: 10, background: c.bg, border: `1px solid ${c.border}`, borderRadius: 8, padding: "8px 12px" }}>
                    <span style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 13, color: c.primary, flex: 1 }}>{cat}</span>
                    <span style={{ fontFamily: "Barlow,sans-serif", fontSize: 10, color: "#555" }}>Judges:</span>
                    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      <button onClick={() => setJudgeCounts((p) => ({ ...p, [cat]: Math.max(1, (parseInt(p[cat]) || 3) - 1) }))} style={{ background: "#1a1a1a", border: "1px solid #333", color: "#aaa", borderRadius: 4, width: 24, height: 24, cursor: "pointer", fontFamily: "Bebas Neue,sans-serif", fontSize: 14 }}>−</button>
                      <span style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 16, color: c.primary, minWidth: 18, textAlign: "center" }}>{count}</span>
                      <button onClick={() => setJudgeCounts((p) => ({ ...p, [cat]: Math.min(10, (parseInt(p[cat]) || 3) + 1) }))} style={{ background: "#1a1a1a", border: "1px solid #333", color: "#aaa", borderRadius: 4, width: 24, height: 24, cursor: "pointer", fontFamily: "Bebas Neue,sans-serif", fontSize: 14 }}>+</button>
                    </div>
                    <button onClick={() => removeCategory(cat)} style={{ background: "none", border: "none", color: "#555", cursor: "pointer", fontSize: 14, padding: 0 }}>✕</button>
                  </div>
                );
              })}
            </div>
            <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 10, color: "#444", marginTop: 10 }}>
              Total judge codes: {categories.reduce((sum, cat) => sum + (parseInt(judgeCounts[cat]) || 3), 0)}
            </div>
          </div>
        )}
      </div>

      <button className="btn" style={{ background: "#ff4d4d", color: "#000", width: "100%", marginTop: 20, fontSize: 14, padding: "13px" }} onClick={submit} disabled={loading || categories.length === 0}>
        {loading ? <Spinner /> : `CREATE EVENT WITH ${categories.length} CATEGOR${categories.length === 1 ? "Y" : "IES"} →`}
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// SCREEN: ORGANIZER LOGIN (code only — org codes issued by DanBuzz admin)
// ─────────────────────────────────────────────────────────────────
function OrgLoginScreen({ onBack, onLogin, showToast }) {
  const [orgCode, setOrgCode] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    if (!orgCode.trim()) return showToast("Enter your organizer code!", "error");
    setLoading(true);
    const { data, error } = await supabase.from("events").select("*").eq("org_code", orgCode.trim().toUpperCase()).single();
    if (error || !data) { showToast("Invalid organizer code! Contact DanBuzz admin.", "error"); setLoading(false); return; }
    onLogin(data);
    setLoading(false);
  };

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 32, background: "#080808" }}>
      <div style={{ width: "100%", maxWidth: 360 }}>
        <button className="btn" style={{ background: "transparent", color: "#555", border: "none", padding: 0, marginBottom: 24, fontSize: 12, letterSpacing: 2 }} onClick={onBack}>← BACK</button>
        <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 26, letterSpacing: 3, marginBottom: 4 }}>ORGANIZER LOGIN</div>
        <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 12, color: "#555", marginBottom: 28 }}>Enter the organizer code provided by DanBuzz admin to access your event dashboard.</div>
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 10, color: "#555", letterSpacing: 2, marginBottom: 6 }}>ORGANIZER CODE</div>
          <input className="inp" placeholder="e.g. ORG-XYZ-1234" value={orgCode} onChange={(e) => setOrgCode(e.target.value.toUpperCase())} onKeyDown={(e) => e.key === "Enter" && handleSubmit()} style={{ letterSpacing: 3, fontFamily: "Bebas Neue,sans-serif", fontSize: 20 }} />
        </div>
        <button className="btn" style={{ background: "#ff4d4d", color: "#000", width: "100%", fontSize: 14, padding: "13px" }} onClick={handleSubmit} disabled={loading}>
          {loading ? <Spinner /> : "ENTER DASHBOARD →"}
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// SCREEN: JUDGE LOGIN
// ─────────────────────────────────────────────────────────────────
function JudgeLoginScreen({ onBack, onLogin, showToast }) {
  const [code, setCode]       = useState("");
  const [name, setName]       = useState("");
  const [loading, setLoading] = useState(false);
  // "peek" holds the judge_codes row after code is validated, before name confirmed
  const [peek, setPeek]       = useState(null);

  // Step 1 — validate code, show what we know
  const checkCode = async () => {
    if (!code.trim()) return showToast("Enter your judge code!", "error");
    setLoading(true);
    const upper = code.trim().toUpperCase();
    const { data: jc, error } = await supabase
      .from("judge_codes")
      .select("*, events(*)")
      .eq("code", upper)
      .single();
    if (error || !jc) { showToast("Invalid code. Contact DanBuzz admin.", "error"); setLoading(false); return; }
    setPeek(jc);
    setLoading(false);
  };

  // Step 2 — confirm name, register if first time or verify if returning
  const confirmName = async () => {
    if (!name.trim()) return showToast("Enter your name!", "error");
    setLoading(true);
    if (!peek.used) {
      // First time — register name against this code
      const { error } = await supabase
        .from("judge_codes")
        .update({ used: true, judge_name: name.trim() })
        .eq("code", peek.code);
      if (error) { showToast("Registration failed. Try again.", "error"); setLoading(false); return; }
      const updated = { ...peek, used: true, judge_name: name.trim() };
      showToast(`Welcome, ${name.trim()}! You're now registered ✓`);
      onLogin({ judgeCode: updated, event: peek.events });
    } else {
      // Returning — verify name matches (case-insensitive)
      if (peek.judge_name.trim().toLowerCase() !== name.trim().toLowerCase()) {
        showToast("Name doesn't match. Enter the name you registered with.", "error");
        setLoading(false);
        return;
      }
      onLogin({ judgeCode: peek, event: peek.events });
    }
    setLoading(false);
  };

  const categories  = peek?.events?.categories || [];
  const catIdx      = categories.indexOf(peek?.category);
  const c           = PALETTE[catIdx >= 0 ? catIdx % PALETTE.length : 0];

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 32, background: "#080808" }}>
      <div style={{ width: "100%", maxWidth: 400 }}>
        <button className="btn" style={{ background: "transparent", color: "#555", border: "none", padding: 0, marginBottom: 24, fontSize: 12, letterSpacing: 2 }} onClick={() => { if (peek) { setPeek(null); setName(""); } else onBack(); }}>← BACK</button>
        <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 26, letterSpacing: 3, marginBottom: 4 }}>JUDGE LOGIN</div>
        <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 12, color: "#555", marginBottom: 28 }}>
          {!peek ? "Enter your judge code and name to access your scoring panel." : peek.used ? "Welcome back! Confirm your name to continue." : "First time? Your name will be registered to this code."}
        </div>

        {/* Step 1 — Code input */}
        {!peek ? (
          <>
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 10, color: "#555", letterSpacing: 2, marginBottom: 6 }}>JUDGE CODE</div>
              <input className="inp" placeholder="Code from DanBuzz admin" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} onKeyDown={(e) => e.key === "Enter" && checkCode()} style={{ letterSpacing: 2, fontFamily: "Bebas Neue,sans-serif", fontSize: 18 }} />
            </div>
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 10, color: "#555", letterSpacing: 2, marginBottom: 6 }}>YOUR NAME</div>
              <input className="inp" placeholder="Your full name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && checkCode()} />
            </div>
            <button className="btn" style={{ background: "#ff4d4d", color: "#000", width: "100%", fontSize: 14, padding: "13px" }} onClick={async () => {
              if (!code.trim()) return showToast("Enter your judge code!", "error");
              if (!name.trim()) return showToast("Enter your name!", "error");
              setLoading(true);
              const upper = code.trim().toUpperCase();
              const { data: jc, error } = await supabase.from("judge_codes").select("*, events(*)").eq("code", upper).single();
              if (error || !jc) { showToast("Invalid code. Contact DanBuzz admin.", "error"); setLoading(false); return; }
              // Register or verify inline
              if (!jc.used) {
                const { error: ue } = await supabase.from("judge_codes").update({ used: true, judge_name: name.trim() }).eq("code", upper);
                if (ue) { showToast("Registration failed. Try again.", "error"); setLoading(false); return; }
                showToast(`Welcome, ${name.trim()}! Registered ✓`);
                onLogin({ judgeCode: { ...jc, used: true, judge_name: name.trim() }, event: jc.events });
              } else {
                if (jc.judge_name.trim().toLowerCase() !== name.trim().toLowerCase()) {
                  showToast("Name doesn't match. Enter the name you registered with.", "error");
                  setLoading(false); return;
                }
                onLogin({ judgeCode: jc, event: jc.events });
              }
              setLoading(false);
            }} disabled={loading}>
              {loading ? <Spinner /> : "LOGIN →"}
            </button>
          </>
        ) : (
          /* Step 2 — Confirm with event/category preview */
          <>
            <div style={{ background: c.bg, border: `1px solid ${c.border}`, borderRadius: 12, padding: "16px 20px", marginBottom: 20 }}>
              <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 9, color: c.primary, letterSpacing: 3, marginBottom: 6 }}>CODE VERIFIED</div>
              <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 20, letterSpacing: 2, color: c.primary }}>{peek.category} · Judge {peek.slot}</div>
              <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 11, color: "#555", marginTop: 2 }}>{peek.events?.name} · {peek.events?.city}</div>
              {peek.used && <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 10, color: "#00c853", marginTop: 6 }}>Registered as: <strong>{peek.judge_name}</strong></div>}
            </div>
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 10, color: "#555", letterSpacing: 2, marginBottom: 6 }}>{peek.used ? "CONFIRM YOUR NAME" : "ENTER YOUR NAME"}</div>
              <input className="inp" placeholder={peek.used ? `Enter "${peek.judge_name}"` : "Your full name"} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && confirmName()} autoFocus />
            </div>
            <button className="btn" style={{ background: c.primary, color: "#000", width: "100%", fontSize: 14, padding: "13px" }} onClick={confirmName} disabled={loading}>
              {loading ? <Spinner /> : peek.used ? "CONFIRM & LOGIN →" : "REGISTER & LOGIN →"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// SCREEN: JUDGE DASHBOARD
// ─────────────────────────────────────────────────────────────────
function JudgeDashboard({ judgeCode, event, onBack, showToast }) {
  const categories  = event.categories || [];
  const myCategory  = judgeCode.category;
  const myKey       = `${myCategory}-J${judgeCode.slot}`;
  const col         = getCatColor(categories, myCategory);

  const [tab, setTab]             = useState("scoring");
  const [scoreInputs, setScoreInputs] = useState({});
  const [participants, setParticipants] = useState([]);
  const [scores, setScores]             = useState([]);
  const [judgeCodes, setJudgeCodes]     = useState([]);
  const [loading, setLoading]           = useState(true);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      const [pRes, sRes, jcRes] = await Promise.all([
        supabase.from("participants").select("*").eq("event_id", event.id).eq("category", myCategory),
        supabase.from("scores").select("*").eq("event_id", event.id),
        supabase.from("judge_codes").select("*").eq("event_id", event.id).eq("category", myCategory),
      ]);
      if (pRes.data)  setParticipants(pRes.data);
      if (sRes.data)  setScores(sRes.data);
      if (jcRes.data) setJudgeCodes(jcRes.data);
      setLoading(false);
    };
    load();
  }, [event.id, myCategory]);

  useEffect(() => {
    const pCh = supabase.channel(`jp-${event.id}-${myCategory}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "participants", filter: `event_id=eq.${event.id}` },
        (p) => { if (p.new.category === myCategory) setParticipants((prev) => [...prev, p.new]); })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "participants", filter: `event_id=eq.${event.id}` },
        (p) => setParticipants((prev) => prev.map((x) => x.id === p.new.id ? p.new : x)))
      .subscribe();
    const sCh = supabase.channel(`js-${event.id}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "scores", filter: `event_id=eq.${event.id}` },
        (p) => setScores((prev) => [...prev, p.new]))
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "scores", filter: `event_id=eq.${event.id}` },
        (p) => setScores((prev) => prev.map((s) => s.id === p.new.id ? p.new : s)))
      .subscribe();
    return () => { supabase.removeChannel(pCh); supabase.removeChannel(sCh); };
  }, [event.id, myCategory]);

  const scoreMap = {};
  scores.forEach((s) => {
    if (!scoreMap[s.participant_id]) scoreMap[s.participant_id] = {};
    scoreMap[s.participant_id][s.judge_key] = s.score;
  });
  const getScore    = (pid) => calcAvgScore(Object.values(scoreMap[pid] || {}));
  const getMyScore  = (pid) => scoreMap[pid]?.[myKey];
  const catParts    = participants.filter((p) => p.checked_in);
  const catSorted   = [...catParts].sort((a, b) => getScore(b.id) - getScore(a.id));
  const catJudges   = judgeCodes.filter((j) => j.used);

  const submitScore = async (pid) => {
    const val = parseFloat(scoreInputs[pid]);
    if (isNaN(val) || val < 1 || val > 10) return showToast("Score must be 1–10", "error");
    const { error } = await supabase.from("scores").upsert(
      { participant_id: pid, event_id: event.id, judge_key: myKey, score: val },
      { onConflict: "participant_id,judge_key" }
    );
    if (error) return showToast("Score failed: " + error.message, "error");
    setScoreInputs((prev) => ({ ...prev, [pid]: "" }));
    showToast("Score submitted ✓");
  };

  if (loading) return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#080808" }}><Spinner /></div>
  );

  return (
    <div style={{ fontFamily: "'Bebas Neue',Impact,sans-serif", background: "#080808", minHeight: "100vh", color: "#fff" }}>
      {/* Header */}
      <div style={{ padding: "22px 22px 0", maxWidth: 900, margin: "0 auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>
          <div>
            <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 36, letterSpacing: 4, lineHeight: 1 }}>DAN<span style={{ color: col.primary }}>BUZZ</span></div>
            <div style={{ background: col.bg, border: `1px solid ${col.border}`, borderRadius: 8, padding: "8px 14px", marginTop: 8, display: "inline-flex", alignItems: "center", gap: 10 }}>
              <div className="pulse" style={{ width: 7, height: 7, borderRadius: "50%", background: "#00c853" }} />
              <div>
                <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 15, color: col.primary }}>{judgeCode.judge_name}</div>
                <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 10, color: "#555" }}>Judge {judgeCode.slot} · {myCategory} · {event.name}</div>
              </div>
            </div>
          </div>
          <button className="btn" style={{ background: "transparent", color: "#555", border: "1px solid #222", fontSize: 11 }} onClick={onBack}>← LOGOUT</button>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", borderBottom: "1px solid #1a1a1a", overflowX: "auto" }}>
          {[
            { key: "scoring",     label: "MY SCORING" },
            { key: "allscores",   label: "ALL SCORES" },
            { key: "leaderboard", label: "LEADERBOARD" },
          ].map((t) => (
            <button key={t.key} className="tbtn" style={{ color: tab === t.key ? col.primary : "#555", borderBottom: tab === t.key ? `3px solid ${col.primary}` : "3px solid transparent" }} onClick={() => setTab(t.key)}>{t.label}</button>
          ))}
        </div>
      </div>

      <div style={{ padding: "20px 22px 40px", maxWidth: 900, margin: "0 auto" }}>
        {/* MY SCORING */}
        {tab === "scoring" && (
          <div className="slide">
            <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 18, letterSpacing: 3, color: col.primary, marginBottom: 4 }}>MY SCORES · {myCategory}</div>
            <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 12, color: "#555", marginBottom: 18 }}>Scoring as <span style={{ color: col.primary }}>{judgeCode.judge_name}</span>. Enter a score 1–10 and submit for each dancer.</div>
            {catParts.length === 0 && <div style={{ textAlign: "center", padding: "48px", fontFamily: "Barlow,sans-serif", color: "#333" }}>No checked-in participants yet</div>}
            {catParts.map((p) => {
              const myScore = getMyScore(p.id);
              return (
                <div key={p.id} className="card" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", border: myScore !== undefined ? `1px solid ${col.border}` : "1px solid #1e1e1e" }}>
                  <div style={{ flex: 1, minWidth: 110 }}>
                    <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 16 }}>{p.name}</div>
                    <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 10, color: "#555" }}>{p.city}</div>
                  </div>
                  {myScore !== undefined && (
                    <span className="badge" style={{ background: col.bg, color: col.primary, border: `1px solid ${col.border}` }}>MY SCORE: {myScore}</span>
                  )}
                  <div style={{ display: "flex", gap: 7, alignItems: "center" }}>
                    <input className="inp" type="number" min="1" max="10" step="0.5" placeholder="1–10" value={scoreInputs[p.id] || ""} onChange={(e) => setScoreInputs((prev) => ({ ...prev, [p.id]: e.target.value }))} style={{ width: 72 }} />
                    <button className="btn" style={{ background: col.primary, color: "#000", fontSize: 11 }} onClick={() => submitScore(p.id)}>{myScore !== undefined ? "UPDATE" : "SUBMIT"}</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* ALL SCORES */}
        {tab === "allscores" && (
          <div className="slide">
            <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 18, letterSpacing: 3, color: col.primary, marginBottom: 4 }}>ALL SCORES · {myCategory}</div>
            <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 12, color: "#555", marginBottom: 18 }}>Scores from all judges in your category. Updates in real-time.</div>
            {catParts.length === 0 && <div style={{ textAlign: "center", padding: "48px", fontFamily: "Barlow,sans-serif", color: "#333" }}>No checked-in participants yet</div>}
            {catParts.map((p) => {
              const sm = scoreMap[p.id] || {};
              return (
                <div key={p.id} className="card" style={{ marginBottom: 10 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 6 }}>
                    <div>
                      <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 16 }}>{p.name}</div>
                      <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 10, color: "#555" }}>{p.city}</div>
                    </div>
                    <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 28, color: col.primary }}>{getScore(p.id) || "—"}</div>
                  </div>
                  <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
                    {catJudges.map((j) => {
                      const key   = `${j.category}-J${j.slot}`;
                      const isMe  = key === myKey;
                      return (
                        <div key={key} style={{ background: isMe ? col.bg : "#1a1a1a", border: `1px solid ${isMe ? col.border : "#2a2a2a"}`, borderRadius: 6, padding: "5px 9px", textAlign: "center", minWidth: 64 }}>
                          <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 8, color: isMe ? col.primary : "#555", marginBottom: 1 }}>{j.judge_name}{isMe ? " (YOU)" : ""}</div>
                          <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 20, color: isMe ? col.primary : "#fff" }}>{sm[key] ?? "—"}</div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* LEADERBOARD */}
        {tab === "leaderboard" && (
          <div className="slide">
            <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 18, letterSpacing: 3, color: col.primary, marginBottom: 4 }}>LEADERBOARD · {myCategory}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 16 }}>
              <div className="pulse" style={{ width: 7, height: 7, borderRadius: "50%", background: col.primary }} />
              <span style={{ fontFamily: "Barlow,sans-serif", fontSize: 9, color: "#555", letterSpacing: 2 }}>REAL-TIME · {catParts.length} DANCERS</span>
            </div>
            {catSorted.length >= 2 && (
              <div style={{ display: "flex", gap: 10, marginBottom: 22, flexWrap: "wrap" }}>
                {[{ p: catSorted[1], rank: 2, pt: 55 }, { p: catSorted[0], rank: 1, pt: 85 }, { p: catSorted[2], rank: 3, pt: 38 }].map(({ p, rank, pt }) => p && (
                  <div key={p.id} style={{ flex: 1, minWidth: 120, background: rank === 1 ? col.bg : "#0d0d0d", border: `1px solid ${rank === 1 ? col.border : "#1a1a1a"}`, borderRadius: 12, padding: "14px", paddingTop: pt + "px", textAlign: "center" }}>
                    <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 38, color: rank === 1 ? col.primary : rank === 2 ? "#aaa" : "#cd7f32", lineHeight: 1 }}>#{rank}</div>
                    <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 17, marginBottom: 2 }}>{p.name}</div>
                    <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 10, color: "#555", marginBottom: 6 }}>{p.city}</div>
                    <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 36, color: rank === 1 ? col.primary : "#fff" }}>{getScore(p.id)}</div>
                  </div>
                ))}
              </div>
            )}
            <div style={{ background: "#0c0c0c", border: "1px solid #161616", borderRadius: 12, overflow: "hidden" }}>
              {catSorted.map((p, i) => (
                <div key={p.id} className="lrow">
                  <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 20, color: i < 3 ? col.primary : "#222", minWidth: 36 }}>#{i + 1}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 15 }}>{p.name}</div>
                    <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 10, color: "#555" }}>{p.city}</div>
                  </div>
                  <div style={{ display: "flex", gap: 7, alignItems: "center", minWidth: 120 }}>
                    <div style={{ background: "#1a1a1a", borderRadius: 3, height: 4, flex: 1, overflow: "hidden" }}>
                      <div style={{ height: "100%", borderRadius: 3, background: col.primary, width: `${getScore(p.id)}%`, transition: "width .6s" }} />
                    </div>
                    <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 18, color: i < 3 ? col.primary : "#fff", minWidth: 32, textAlign: "right" }}>{getScore(p.id) || "—"}</div>
                  </div>
                  {scoreMap[p.id]?.[myKey] !== undefined && (
                    <span className="badge" style={{ background: col.bg, color: col.primary, border: `1px solid ${col.border}`, fontSize: 9 }}>MY: {scoreMap[p.id][myKey]}</span>
                  )}
                </div>
              ))}
              {catSorted.length === 0 && <div style={{ padding: "40px", textAlign: "center", fontFamily: "Barlow,sans-serif", color: "#333" }}>No scores yet</div>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// SCREEN: DASHBOARD
// ─────────────────────────────────────────────────────────────────
function Dashboard({ event, onBack, showToast }) {
  const categories = event.categories || [];
  const [tab, setTab]             = useState("organizer");
  const [activeCat, setActiveCat] = useState(categories[0] || "");
  const [scoreInputs, setScoreInputs] = useState({});
  const [activeJudge, setActiveJudge] = useState(null);
  const [currentRound, setCurrentRound] = useState("Prelims");
  const [searchQr, setSearchQr]   = useState("");
  const [showQrFor, setShowQrFor] = useState(null);
  const [overlayActive, setOverlayActive] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  const [judgeCodes, setJudgeCodes]     = useState([]);
  const [participants, setParticipants] = useState([]);
  const [scores, setScores]             = useState([]);
  const [loading, setLoading]           = useState(true);

  // Load data
  useEffect(() => {
    const load = async () => {
      setLoading(true);
      const [jcRes, pRes, sRes] = await Promise.all([
        supabase.from("judge_codes").select("*").eq("event_id", event.id),
        supabase.from("participants").select("*").eq("event_id", event.id),
        supabase.from("scores").select("*").eq("event_id", event.id),
      ]);
      if (jcRes.data) setJudgeCodes(jcRes.data);
      if (pRes.data)  setParticipants(pRes.data);
      if (sRes.data)  setScores(sRes.data);
      setLoading(false);
    };
    load();
  }, [event.id]);

  // Real-time
  useEffect(() => {
    const jcCh = supabase.channel(`jc-${event.id}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "judge_codes", filter: `event_id=eq.${event.id}` },
        (p) => setJudgeCodes((prev) => prev.map((j) => j.id === p.new.id ? p.new : j)))
      .subscribe();

    const pCh = supabase.channel(`p-${event.id}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "participants", filter: `event_id=eq.${event.id}` },
        (p) => setParticipants((prev) => [...prev, p.new]))
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "participants", filter: `event_id=eq.${event.id}` },
        (p) => setParticipants((prev) => prev.map((x) => x.id === p.new.id ? p.new : x)))
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "participants", filter: `event_id=eq.${event.id}` },
        (p) => setParticipants((prev) => prev.filter((x) => x.id !== p.old.id)))
      .subscribe();

    const sCh = supabase.channel(`s-${event.id}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "scores", filter: `event_id=eq.${event.id}` },
        (p) => setScores((prev) => [...prev, p.new]))
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "scores", filter: `event_id=eq.${event.id}` },
        (p) => setScores((prev) => prev.map((s) => s.id === p.new.id ? p.new : s)))
      .subscribe();

    return () => { supabase.removeChannel(jcCh); supabase.removeChannel(pCh); supabase.removeChannel(sCh); };
  }, [event.id]);

  // Derived
  const col       = getCatColor(categories, activeCat);
  const catJudges = judgeCodes.filter((j) => j.category === activeCat && j.used);
  const catParts  = participants.filter((p) => p.category === activeCat);

  const scoreMap = {};
  scores.forEach((s) => {
    if (!scoreMap[s.participant_id]) scoreMap[s.participant_id] = {};
    scoreMap[s.participant_id][s.judge_key] = s.score;
  });

  const getScore   = (pid) => calcAvgScore(Object.values(scoreMap[pid] || {}));
  const catSorted  = [...catParts].sort((a, b) => getScore(b.id) - getScore(a.id));
  const regJudges  = judgeCodes.filter((j) => j.used);
  const biasAlerts = catParts.flatMap((p) => detectBias(scoreMap[p.id] || {}).map((f) => ({ ...f, participant: p.name })));
  const totalBias  = participants.flatMap((p) => detectBias(scoreMap[p.id] || {})).length;

  const switchCat = (cat) => { setActiveCat(cat); setActiveJudge(null); setScoreInputs({}); };

  // DB actions
  const addParticipant = async (form) => {
    if (!form.name.trim() || !form.city.trim()) return showToast("Fill in name and city!", "error");
    const { error } = await supabase.from("participants").insert({ event_id: event.id, name: form.name.trim(), city: form.city.trim(), category: activeCat });
    if (error) return showToast("Failed to add: " + error.message, "error");
    showToast(`${form.name} added to ${activeCat}!`);
  };

  const checkIn = async (id) => {
    const { error } = await supabase.from("participants").update({ checked_in: true }).eq("id", id);
    if (error) return showToast("Check-in failed!", "error");
    showToast("Dancer checked in ✓");
  };

  const submitScore = async (pid) => {
    if (!activeJudge) return showToast("Select a judge first!", "error");
    const val = parseFloat(scoreInputs[pid]);
    if (isNaN(val) || val < 1 || val > 10) return showToast("Score must be 1–10", "error");
    const { error } = await supabase.from("scores").upsert(
      { participant_id: pid, event_id: event.id, judge_key: activeJudge, score: val },
      { onConflict: "participant_id,judge_key" }
    );
    if (error) return showToast("Score failed: " + error.message, "error");
    setScoreInputs((prev) => ({ ...prev, [pid]: "" }));
    showToast("Score submitted ✓");
  };

  const endEvent = async () => {
    const { error } = await supabase.from("events").delete().eq("id", event.id);
    if (error) return showToast("Failed to end event!", "error");
    onBack();
  };

  // Export CSV
  const exportCSV = () => {
    const rows = [];
    rows.push(["Category","Participant","City","Checked In","Round",...judgeCodes.filter((j) => j.used).map((j) => `${j.category}-J${j.slot} (${j.judge_name})`), "Avg Score"]);
    participants.forEach((p) => {
      const catJudgesForP = judgeCodes.filter((j) => j.used && j.category === p.category);
      const sm = scoreMap[p.id] || {};
      const judgeScores = catJudgesForP.map((j) => {
        const key = `${j.category}-J${j.slot}`;
        return sm[key] !== undefined ? sm[key] : "";
      });
      // Pad for judges not in this category
      const allUsed = judgeCodes.filter((j) => j.used);
      const allScores = allUsed.map((j) => {
        const key = `${j.category}-J${j.slot}`;
        return j.category === p.category ? (sm[key] !== undefined ? sm[key] : "") : "";
      });
      rows.push([p.category, p.name, p.city, p.checked_in ? "Yes" : "No", currentRound, ...allScores, getScore(p.id) || ""]);
    });
    const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url; a.download = `${event.name.replace(/\s+/g,"-")}-export.csv`; a.click();
    URL.revokeObjectURL(url);
    showToast("CSV exported ✓");
  };

  const top8 = catSorted.slice(0, 8);
  const bracketRounds = [
    { name: "Top 8",  matches: [[top8[0], top8[7]], [top8[1], top8[6]], [top8[2], top8[5]], [top8[3], top8[4]]] },
    { name: "Top 4",  matches: [[top8[0], top8[3]], [top8[1], top8[2]]] },
    { name: "Finals", matches: [[top8[0], top8[1]]] },
  ];

  if (loading) return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#080808" }}>
      <Spinner />
    </div>
  );

  if (categories.length === 0) return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#080808", flexDirection: "column", gap: 16 }}>
      <div style={{ fontFamily: "Barlow,sans-serif", color: "#555" }}>This event has no categories configured.</div>
      <button className="btn" style={{ background: "#111", color: "#777", border: "1px solid #222" }} onClick={onBack}>← BACK</button>
    </div>
  );

  return (
    <div style={{ fontFamily: "'Bebas Neue',Impact,sans-serif", background: "#080808", minHeight: "100vh", color: "#fff" }}>

      {/* Stream overlay */}
      {overlayActive && (() => {
        const limit = ROUND_LIMIT[currentRound] ?? 999;
        const list  = catSorted.slice(0, limit);
        return (
          <div style={{ position: "fixed", inset: 0, background: "#000000f5", zIndex: 200, display: "flex", flexDirection: "column", padding: 36, overflowY: "auto" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
              <div className="pulse" style={{ width: 10, height: 10, borderRadius: "50%", background: "#ff4d4d" }} />
              <span style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 12, letterSpacing: 4, color: "#ff4d4d" }}>LIVE · {event.name.toUpperCase()}</span>
            </div>
            <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 36, letterSpacing: 3, lineHeight: 1, marginBottom: 4 }}>
              {currentRound} <span style={{ color: col.primary }}>· {activeCat}</span>
            </div>
            <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 11, color: "#555", letterSpacing: 2, marginBottom: 24 }}>{list.length} QUALIFIERS · {event.city}</div>
            {list.length <= 8 ? (
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", flex: 1 }}>
                {list.map((p, i) => (
                  <div key={p.id} style={{ background: i === 0 ? col.bg : "#0f0f0f", border: `1px solid ${i === 0 ? col.border : "#1e1e1e"}`, borderRadius: 12, padding: "16px 20px", minWidth: 145, flex: "1 1 145px" }}>
                    <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 13, color: col.primary, letterSpacing: 2, marginBottom: 4 }}>#{i + 1}</div>
                    <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 20, lineHeight: 1.1, marginBottom: 2 }}>{p.name}</div>
                    <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 10, color: "#555", marginBottom: 8 }}>{p.city}</div>
                    <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 40, color: i === 0 ? col.primary : "#fff", lineHeight: 1 }}>{getScore(p.id)}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(280px,1fr))", gap: 6, alignContent: "start", flex: 1 }}>
                {list.map((p, i) => (
                  <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 12, background: i < 3 ? col.bg : "#0d0d0d", border: `1px solid ${i < 3 ? col.border : "#161616"}`, borderRadius: 8, padding: "9px 13px" }}>
                    <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 20, color: i < 3 ? col.primary : "#333", minWidth: 34 }}>#{i + 1}</div>
                    <div style={{ flex: 1 }}><div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 15 }}>{p.name}</div><div style={{ fontFamily: "Barlow,sans-serif", fontSize: 10, color: "#555" }}>{p.city}</div></div>
                    <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 16, color: i < 3 ? col.primary : "#fff", minWidth: 28, textAlign: "right" }}>{getScore(p.id) || "—"}</div>
                  </div>
                ))}
              </div>
            )}
            <button className="btn" style={{ marginTop: 22, alignSelf: "flex-start", background: "#1a1a1a", color: "#777", border: "1px solid #333", fontSize: 11 }} onClick={() => setOverlayActive(false)}>✕ CLOSE OVERLAY</button>
          </div>
        );
      })()}

      {/* End event confirm */}
      {showConfirm && (
        <div style={{ position: "fixed", inset: 0, background: "#000000cc", zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
          <div style={{ background: "#111", border: "1px solid #ff4d4d44", borderRadius: 14, padding: 28, maxWidth: 380, width: "100%", textAlign: "center" }}>
            <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 22, color: "#ff4d4d", marginBottom: 8 }}>END EVENT?</div>
            <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 13, color: "#666", marginBottom: 24 }}>
              "<strong style={{ color: "#fff" }}>{event.name}</strong>" and all its data will be permanently deleted.
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button className="btn" style={{ flex: 1, background: "#1a1a1a", color: "#777", border: "1px solid #333" }} onClick={() => setShowConfirm(false)}>CANCEL</button>
              <button className="btn" style={{ flex: 1, background: "#ff4d4d", color: "#000" }} onClick={endEvent}>YES, DELETE</button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div style={{ padding: "22px 22px 0", maxWidth: 1100, margin: "0 auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
          <div>
            <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 36, letterSpacing: 4, lineHeight: 1 }}>DAN<span style={{ color: col.primary }}>BUZZ</span></div>
            <div style={{ background: "#0f0f0f", border: `1px solid ${col.border}`, borderRadius: 8, padding: "8px 14px", marginTop: 8, display: "inline-flex", alignItems: "center", gap: 10 }}>
              <div className="pulse" style={{ width: 7, height: 7, borderRadius: "50%", background: "#00c853" }} />
              <div>
                <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 15, color: "#fff" }}>{event.name}</div>
                <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 10, color: "#555" }}>{event.city} · {event.date} · {categories.length} categories · {regJudges.length} judges</div>
              </div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <select className="inp" style={{ width: "auto", padding: "7px 32px 7px 11px", fontSize: 12 }} value={currentRound} onChange={(e) => setCurrentRound(e.target.value)}>
              {ROUNDS.map((r) => <option key={r}>{r}</option>)}
            </select>
            <button className="btn" style={{ background: "#111", color: "#777", border: "1px solid #2a2a2a", fontSize: 11 }} onClick={() => setOverlayActive(true)}>⬛ STREAM</button>
            <button className="btn" style={{ background: "transparent", color: "#555", border: "1px solid #222", fontSize: 11 }} onClick={onBack}>← LOGOUT</button>
            <button className="btn" style={{ background: "#1a0a0a", color: "#ff4d4d", border: "1px solid #ff4d4d33", fontSize: 11 }} onClick={() => setShowConfirm(true)}>END EVENT</button>
          </div>
        </div>

        {/* Stats */}
        <div style={{ display: "flex", gap: 10, marginTop: 16, flexWrap: "wrap" }}>
          {[
            { label: "PARTICIPANTS", val: participants.length, color: "#fff" },
            { label: "CHECKED IN",  val: participants.filter((p) => p.checked_in).length, color: "#00c853" },
            { label: "CATEGORIES",  val: categories.length, color: col.primary },
            { label: "JUDGES REG",  val: regJudges.length, color: "#ffd700" },
            { label: "SCORES CAST", val: scores.length, color: "#00e5ff" },
            { label: "BIAS FLAGS",  val: totalBias, color: totalBias > 0 ? "#ff4d4d" : "#333" },
          ].map((s) => (
            <div key={s.label} style={{ background: "#0f0f0f", border: "1px solid #181818", borderRadius: 8, padding: "8px 14px", textAlign: "center" }}>
              <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 24, color: s.color, lineHeight: 1 }}>{s.val}</div>
              <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 8, color: "#444", letterSpacing: 2, marginTop: 2 }}>{s.label}</div>
            </div>
          ))}
        </div>

        {/* Category pills — scrollable */}
        <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
          {categories.map((cat) => {
            const c        = getCatColor(categories, cat);
            const count    = participants.filter((p) => p.category === cat).length;
            const judgesIn = judgeCodes.filter((j) => j.category === cat && j.used).length;
            const active   = activeCat === cat;
            return (
              <button key={cat} className="btn" style={{ fontSize: 11, padding: "7px 14px", background: active ? c.primary : "#111", color: active ? "#000" : "#555", border: `1px solid ${active ? c.primary : "#222"}`, letterSpacing: 1 }} onClick={() => switchCat(cat)}>
                {cat} <span style={{ opacity: 0.7 }}>({count}p · {judgesIn}j)</span>
              </button>
            );
          })}
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", borderBottom: "1px solid #1a1a1a", marginTop: 12, overflowX: "auto" }}>
          {[
            { key: "organizer",   label: "ORGANIZER" },
            { key: "judges",      label: `JUDGES (${regJudges.length})` },
            { key: "checkin",     label: "CHECK-IN" },
            { key: "scoring",     label: "SCORING" },
            { key: "bracket",     label: "BRACKET" },
            { key: "leaderboard", label: "LEADERBOARD" },
            { key: "bias",        label: `BIAS${biasAlerts.length > 0 ? ` (${biasAlerts.length})` : ""}` },
            { key: "export",      label: "EXPORT" },
          ].map((t) => (
            <button key={t.key} className="tbtn" style={{ color: tab === t.key ? col.primary : "#555", borderBottom: tab === t.key ? `3px solid ${col.primary}` : "3px solid transparent" }} onClick={() => setTab(t.key)}>{t.label}</button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <div style={{ padding: "20px 22px 40px", maxWidth: 1100, margin: "0 auto" }}>
        {/* Category banner */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, padding: "9px 14px", background: col.bg, border: `1px solid ${col.border}`, borderRadius: 9 }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: col.primary }} />
          <span style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 13, letterSpacing: 3, color: col.primary }}>{activeCat}</span>
          <span style={{ fontFamily: "Barlow,sans-serif", fontSize: 11, color: "#555", marginLeft: 4 }}>
            {catParts.length} participants · {catJudges.length > 0 ? catJudges.map((j) => j.judge_name).join(" · ") : "No judges registered yet"}
          </span>
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
            <div className="pulse" style={{ width: 5, height: 5, borderRadius: "50%", background: "#00c853" }} />
            <span style={{ fontFamily: "Barlow,sans-serif", fontSize: 9, color: "#444", letterSpacing: 2 }}>LIVE</span>
          </div>
        </div>

        {/* ORGANIZER */}
        {tab === "organizer" && <OrganizerTab activeCat={activeCat} catSorted={catSorted} col={col} onAdd={addParticipant} getScore={getScore} />}

        {/* JUDGES */}
        {tab === "judges" && (
          <div className="slide">
            <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 18, letterSpacing: 3, color: col.primary, marginBottom: 6 }}>JUDGES · {activeCat}</div>
            <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 12, color: "#555", marginBottom: 20 }}>Judges register on the home screen using their code. Updates here in real-time.</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(240px,1fr))", gap: 12, marginBottom: 32 }}>
              {judgeCodes.filter((j) => j.category === activeCat).map((j) => (
                <div key={j.code} className="card" style={{ border: `1px solid ${j.used ? col.border : "#1e1e1e"}` }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
                    <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 15, color: j.used ? col.primary : "#333", letterSpacing: 2 }}>{activeCat} · Judge {j.slot}</div>
                    <span className="badge" style={{ background: j.used ? "#00c85322" : "#1a1a1a", color: j.used ? "#00c853" : "#333", border: `1px solid ${j.used ? "#00c85344" : "#2a2a2a"}` }}>{j.used ? "REGISTERED" : "WAITING"}</span>
                  </div>
                  {j.used ? <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 20 }}>{j.judge_name}</div> : <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 12, color: "#555" }}>Waiting for judge</div>}
                  <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 12, letterSpacing: 2, color: "#333", marginTop: 10, padding: "6px 10px", background: "#151515", borderRadius: 6 }}>{j.code}</div>
                </div>
              ))}
            </div>

            {/* All categories status */}
            <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 13, letterSpacing: 3, color: "#444", marginBottom: 12 }}>ALL CATEGORIES STATUS</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(160px,1fr))", gap: 10 }}>
              {categories.map((cat) => {
                const c     = getCatColor(categories, cat);
                const total = judgeCodes.filter((j) => j.category === cat);
                const reg   = total.filter((j) => j.used).length;
                return (
                  <div key={cat} style={{ background: "#0f0f0f", border: `1px solid ${reg > 0 ? c.border : "#1a1a1a"}`, borderRadius: 9, padding: "12px 16px", cursor: "pointer" }} onClick={() => switchCat(cat)}>
                    <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 12, color: c.primary, letterSpacing: 1, marginBottom: 6 }}>{cat}</div>
                    <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 28, color: reg > 0 ? "#fff" : "#333" }}>{reg}<span style={{ fontSize: 16, color: "#444" }}>/{total.length}</span></div>
                    <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 10, color: "#555", marginTop: 2 }}>judges registered</div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* CHECK-IN */}
        {tab === "checkin" && (
          <div className="slide">
            <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 18, letterSpacing: 3, color: col.primary, marginBottom: 6 }}>CHECK-IN · {activeCat}</div>
            <input className="inp" placeholder="Search dancer..." value={searchQr} onChange={(e) => setSearchQr(e.target.value)} style={{ maxWidth: 300, marginBottom: 16 }} />
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(185px,1fr))", gap: 12 }}>
              {catParts.filter((p) => p.name.toLowerCase().includes(searchQr.toLowerCase())).map((p) => (
                <div key={p.id} className="card" style={{ textAlign: "center", border: `1px solid ${p.checked_in ? col.border : "#1e1e1e"}` }}>
                  <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 15, marginBottom: 2 }}>{p.name}</div>
                  <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 10, color: "#555", marginBottom: 10 }}>{p.city}</div>
                  {showQrFor === p.id ? (
                    <div style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}>
                      <div style={{ background: "#fff", borderRadius: 8, padding: 10, display: "inline-flex", flexDirection: "column", alignItems: "center", gap: 5 }}>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(9,10px)", gap: 1 }}>
                          {Array.from({ length: 81 }, (_, idx) => {
                            const r = Math.floor(idx / 9), c2 = idx % 9;
                            const corner = (r < 3 && c2 < 3) || (r < 3 && c2 > 5) || (r > 5 && c2 < 3);
                            return <div key={idx} style={{ width: 10, height: 10, borderRadius: 1, background: (corner || ((p.name.length * 7 + idx * 3) % 2 === 0)) ? "#111" : "#fff" }} />;
                          })}
                        </div>
                        <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 8, color: "#333", letterSpacing: 1 }}>DBZ-{p.id.slice(-6).toUpperCase()}</div>
                      </div>
                    </div>
                  ) : (
                    <button className="btn" style={{ fontSize: 10, marginBottom: 10, background: "transparent", border: `1px solid ${col.primary}`, color: col.primary }} onClick={() => setShowQrFor(showQrFor === p.id ? null : p.id)}>SHOW QR</button>
                  )}
                  {p.checked_in
                    ? <span className="badge" style={{ background: "#00c85322", color: "#00c853", border: "1px solid #00c85344" }}>✓ CHECKED IN</span>
                    : <button className="btn" style={{ background: "#00c853", color: "#000", fontSize: 11, width: "100%" }} onClick={() => checkIn(p.id)}>CHECK IN</button>}
                </div>
              ))}
              {catParts.length === 0 && <div style={{ fontFamily: "Barlow,sans-serif", color: "#333", fontSize: 13, padding: "40px 0" }}>No {activeCat} participants yet</div>}
            </div>
          </div>
        )}

        {/* SCORING */}
        {tab === "scoring" && (
          <div className="slide">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10, marginBottom: 14 }}>
              <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 18, letterSpacing: 3, color: col.primary }}>SCORING · {activeCat} · {currentRound}</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {catJudges.map((j) => {
                  const key = `${j.category}-J${j.slot}`;
                  return <button key={key} className="btn" style={{ fontSize: 10, padding: "7px 13px", background: activeJudge === key ? col.primary : "#111", color: activeJudge === key ? "#000" : "#555", border: `1px solid ${activeJudge === key ? col.primary : "#222"}` }} onClick={() => setActiveJudge(key)}>{j.judge_name}</button>;
                })}
                {catJudges.length === 0 && <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 12, color: "#555" }}>No judges registered for {activeCat} yet</div>}
              </div>
            </div>
            {activeJudge && <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 11, color: "#444", marginBottom: 14 }}>Scoring as <span style={{ color: col.primary }}>{catJudges.find((j) => `${j.category}-J${j.slot}` === activeJudge)?.judge_name}</span></div>}
            {catParts.filter((p) => p.checked_in).map((p) => {
              const sm = scoreMap[p.id] || {};
              return (
                <div key={p.id} className="card" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                  <div style={{ flex: 1, minWidth: 110 }}><div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 16 }}>{p.name}</div><div style={{ fontFamily: "Barlow,sans-serif", fontSize: 10, color: "#555" }}>{p.city}</div></div>
                  <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
                    {catJudges.map((j) => { const key = `${j.category}-J${j.slot}`; return <div key={key} style={{ background: key === activeJudge ? col.bg : "#1a1a1a", border: `1px solid ${key === activeJudge ? col.border : "#2a2a2a"}`, borderRadius: 6, padding: "5px 9px", textAlign: "center", minWidth: 58 }}><div style={{ fontFamily: "Barlow,sans-serif", fontSize: 8, color: "#555", marginBottom: 1 }}>{j.judge_name}</div><div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 18, color: key === activeJudge ? col.primary : "#fff" }}>{sm[key] ?? "—"}</div></div>; })}
                  </div>
                  <div style={{ display: "flex", gap: 7, alignItems: "center" }}>
                    <input className="inp" type="number" min="1" max="10" step="0.5" placeholder="1–10" value={scoreInputs[p.id] || ""} onChange={(e) => setScoreInputs((prev) => ({ ...prev, [p.id]: e.target.value }))} style={{ width: 68 }} />
                    <button className="btn" style={{ background: col.primary, color: "#000", fontSize: 11 }} onClick={() => submitScore(p.id)}>SUBMIT</button>
                  </div>
                  <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 24, color: col.primary, minWidth: 44, textAlign: "right" }}>{getScore(p.id) || "—"}</div>
                </div>
              );
            })}
            {catParts.filter((p) => !p.checked_in).length > 0 && <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 11, color: "#333", marginTop: 8 }}>{catParts.filter((p) => !p.checked_in).length} dancers not checked in yet</div>}
            {catParts.length === 0 && <div style={{ textAlign: "center", padding: "48px", fontFamily: "Barlow,sans-serif", color: "#333" }}>No {activeCat} participants yet</div>}
          </div>
        )}

        {/* BRACKET */}
        {tab === "bracket" && (
          <div className="slide">
            <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 18, letterSpacing: 3, color: col.primary, marginBottom: 4 }}>BRACKET · {activeCat}</div>
            <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 11, color: "#444", marginBottom: 20 }}>Seeded by score. Updates live.</div>
            <div style={{ display: "flex", gap: 24, overflowX: "auto", paddingBottom: 20 }}>
              {bracketRounds.map((round, ri) => (
                <div key={round.name} style={{ display: "flex", flexDirection: "column", gap: ri === 0 ? 14 : ri === 1 ? 62 : 152, minWidth: 175 }}>
                  <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 12, letterSpacing: 3, color: col.primary, marginBottom: 6, textAlign: "center" }}>{round.name}</div>
                  {round.matches.map((match, mi) => (
                    <div key={mi} style={{ display: "flex", alignItems: "center" }}>
                      <div className="mcard" style={{ borderColor: col.border + "33" }}>
                        {match.map((f, fi) => f ? (
                          <div key={fi} className="mfighter" style={{ background: fi === 0 ? "#141414" : "#0f0f0f" }}>
                            <div><div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 13 }}>{f.name}</div><div style={{ fontFamily: "Barlow,sans-serif", fontSize: 9, color: "#555" }}>{f.city}</div></div>
                            <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 15, color: col.primary }}>{getScore(f.id)}</div>
                          </div>
                        ) : <div key={fi} className="mfighter"><span style={{ fontFamily: "Barlow,sans-serif", fontSize: 10, color: "#333" }}>TBD</span></div>)}
                      </div>
                      {ri < bracketRounds.length - 1 && <div style={{ width: 22, height: 2, background: col.primary + "33" }} />}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* LEADERBOARD */}
        {tab === "leaderboard" && (
          <div className="slide">
            <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 18, letterSpacing: 3, color: col.primary, marginBottom: 4 }}>LIVE LEADERBOARD · {activeCat}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 16 }}>
              <div className="pulse" style={{ width: 7, height: 7, borderRadius: "50%", background: col.primary }} />
              <span style={{ fontFamily: "Barlow,sans-serif", fontSize: 9, color: "#555", letterSpacing: 2 }}>REAL-TIME · {currentRound}</span>
            </div>
            {catSorted.length >= 2 && (
              <div style={{ display: "flex", gap: 10, marginBottom: 22, flexWrap: "wrap" }}>
                {[{ p: catSorted[1], rank: 2, pt: 55 }, { p: catSorted[0], rank: 1, pt: 85 }, { p: catSorted[2], rank: 3, pt: 38 }].map(({ p, rank, pt }) => p && (
                  <div key={p.id} style={{ flex: 1, minWidth: 120, background: rank === 1 ? col.bg : "#0d0d0d", border: `1px solid ${rank === 1 ? col.border : "#1a1a1a"}`, borderRadius: 12, padding: "14px", paddingTop: pt + "px", textAlign: "center" }}>
                    <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 38, color: rank === 1 ? col.primary : rank === 2 ? "#aaa" : "#cd7f32", lineHeight: 1 }}>#{rank}</div>
                    <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 17, marginBottom: 2 }}>{p.name}</div>
                    <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 10, color: "#555", marginBottom: 6 }}>{p.city}</div>
                    <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 36, color: rank === 1 ? col.primary : "#fff" }}>{getScore(p.id)}</div>
                  </div>
                ))}
              </div>
            )}
            <div style={{ background: "#0c0c0c", border: "1px solid #161616", borderRadius: 12, overflow: "hidden" }}>
              {catSorted.map((p, i) => (
                <div key={p.id} className="lrow">
                  <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 20, color: i < 3 ? col.primary : "#222", minWidth: 36 }}>#{i + 1}</div>
                  <div style={{ flex: 1 }}><div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 15 }}>{p.name}</div><div style={{ fontFamily: "Barlow,sans-serif", fontSize: 10, color: "#555" }}>{p.city}</div></div>
                  <div style={{ display: "flex", gap: 7, alignItems: "center", minWidth: 120 }}>
                    <div style={{ background: "#1a1a1a", borderRadius: 3, height: 4, flex: 1, overflow: "hidden" }}><div style={{ height: "100%", borderRadius: 3, background: col.primary, width: `${getScore(p.id)}%`, transition: "width .6s" }} /></div>
                    <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 18, color: i < 3 ? col.primary : "#fff", minWidth: 32, textAlign: "right" }}>{getScore(p.id) || "—"}</div>
                  </div>
                  <span className="badge" style={{ background: p.checked_in ? "#00c85322" : "#ff4d4d22", color: p.checked_in ? "#00c853" : "#ff4d4d" }}>{p.checked_in ? "✓" : "⌛"}</span>
                </div>
              ))}
              {catParts.length === 0 && <div style={{ padding: "40px", textAlign: "center", fontFamily: "Barlow,sans-serif", color: "#333" }}>No {activeCat} participants yet</div>}
            </div>
          </div>
        )}

        {/* BIAS */}
        {tab === "bias" && (
          <div className="slide">
            <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 18, letterSpacing: 3, color: col.primary, marginBottom: 4 }}>BIAS DETECTION · {activeCat}</div>
            <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 12, color: "#555", marginBottom: 18 }}>Flags when a judge scores 1.5+ points away from the other judges' average for the same participant.</div>
            {biasAlerts.length === 0 ? (
              <div style={{ textAlign: "center", padding: "56px 20px" }}>
                <div style={{ fontSize: 42, marginBottom: 10 }}>✓</div>
                <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 20, color: "#00c853", letterSpacing: 2 }}>NO BIAS DETECTED</div>
              </div>
            ) : biasAlerts.map((a, i) => (
              <div key={i} style={{ background: "#1a0a0a", border: "1px solid #ff4d4d33", borderRadius: 8, padding: "11px 15px", marginBottom: 9 }}>
                <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                  <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 13 }}><span style={{ color: "#ff4d4d", fontFamily: "Bebas Neue,sans-serif", fontSize: 14 }}>{a.judge}</span>{" "}scored{" "}<span style={{ color: "#fff", fontFamily: "Bebas Neue,sans-serif", fontSize: 14 }}>{a.score}</span>{" "}for {a.participant}{" "}<span style={{ color: "#555" }}>(avg: {a.avg})</span></div>
                  <span className="badge" style={{ background: "#ff4d4d22", color: "#ff4d4d", border: "1px solid #ff4d4d44" }}>⚠ OUTLIER</span>
                </div>
                <div style={{ marginTop: 8, height: 4, background: "#1a1a1a", borderRadius: 4, overflow: "hidden" }}><div style={{ height: "100%", width: `${a.score * 10}%`, background: Math.abs(a.score - parseFloat(a.avg)) > 2 ? "#ff4d4d" : "#ff9800", borderRadius: 4 }} /></div>
              </div>
            ))}
          </div>
        )}

        {/* EXPORT */}
        {tab === "export" && (
          <div className="slide">
            <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 18, letterSpacing: 3, color: col.primary, marginBottom: 4 }}>EXPORT EVENT DATA</div>
            <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 12, color: "#555", marginBottom: 24 }}>Download all event data as a CSV — includes all participants, check-in status, individual judge scores, and averages across all categories.</div>

            {/* Summary stats */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(160px,1fr))", gap: 10, marginBottom: 24 }}>
              {[
                { label: "TOTAL PARTICIPANTS", val: participants.length, color: "#fff" },
                { label: "CHECKED IN",         val: participants.filter((p) => p.checked_in).length, color: "#00c853" },
                { label: "CATEGORIES",         val: categories.length, color: col.primary },
                { label: "JUDGES",             val: regJudges.length, color: "#ffd700" },
                { label: "SCORES RECORDED",    val: scores.length, color: "#00e5ff" },
              ].map((s) => (
                <div key={s.label} style={{ background: "#0f0f0f", border: "1px solid #181818", borderRadius: 10, padding: "14px 16px", textAlign: "center" }}>
                  <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 32, color: s.color, lineHeight: 1 }}>{s.val}</div>
                  <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 8, color: "#444", letterSpacing: 2, marginTop: 4 }}>{s.label}</div>
                </div>
              ))}
            </div>

            {/* Per-category breakdown */}
            <div style={{ marginBottom: 24 }}>
              <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 13, letterSpacing: 3, color: "#444", marginBottom: 12 }}>PER CATEGORY BREAKDOWN</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {categories.map((cat) => {
                  const c         = getCatColor(categories, cat);
                  const catP      = participants.filter((p) => p.category === cat);
                  const checkedIn = catP.filter((p) => p.checked_in).length;
                  const catJ      = judgeCodes.filter((j) => j.category === cat && j.used);
                  const catScores = scores.filter((s) => catP.some((p) => p.id === s.participant_id));
                  return (
                    <div key={cat} style={{ display: "flex", alignItems: "center", gap: 14, background: "#0d0d0d", border: `1px solid ${c.border}`, borderRadius: 9, padding: "12px 16px", flexWrap: "wrap" }}>
                      <span style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 14, color: c.primary, letterSpacing: 1, minWidth: 120 }}>{cat}</span>
                      <span style={{ fontFamily: "Barlow,sans-serif", fontSize: 11, color: "#555" }}>{catP.length} participants</span>
                      <span style={{ fontFamily: "Barlow,sans-serif", fontSize: 11, color: "#00c853" }}>{checkedIn} checked in</span>
                      <span style={{ fontFamily: "Barlow,sans-serif", fontSize: 11, color: "#ffd700" }}>{catJ.length} judges</span>
                      <span style={{ fontFamily: "Barlow,sans-serif", fontSize: 11, color: "#00e5ff" }}>{catScores.length} scores</span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Export buttons */}
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <button className="btn" style={{ background: "#00c853", color: "#000", fontSize: 13, padding: "13px 28px" }} onClick={exportCSV}>
                ⬇ EXPORT ALL DATA (CSV)
              </button>
              <button className="btn" style={{ background: "#111", color: "#555", border: "1px solid #2a2a2a", fontSize: 11 }} onClick={() => {
                const checkins = participants.filter((p) => p.checked_in);
                const rows = [["Category","Name","City","Checked In"],...checkins.map((p) => [p.category, p.name, p.city, "Yes"])];
                const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g,'""')}"`).join(",")).join("\n");
                const blob = new Blob([csv], { type: "text/csv" });
                const url = URL.createObjectURL(blob); const a = document.createElement("a");
                a.href = url; a.download = `${event.name.replace(/\s+/g,"-")}-checkins.csv`; a.click();
                URL.revokeObjectURL(url); showToast("Check-in list exported ✓");
              }}>⬇ CHECK-INS ONLY</button>
              <button className="btn" style={{ background: "#111", color: "#555", border: "1px solid #2a2a2a", fontSize: 11 }} onClick={() => {
                const rows = [["Category","Judge","Slot","Code","Registered"],...judgeCodes.map((j) => [j.category, j.judge_name || "", j.slot, j.code, j.used ? "Yes" : "No"])];
                const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g,'""')}"`).join(",")).join("\n");
                const blob = new Blob([csv], { type: "text/csv" });
                const url = URL.createObjectURL(blob); const a = document.createElement("a");
                a.href = url; a.download = `${event.name.replace(/\s+/g,"-")}-judges.csv`; a.click();
                URL.revokeObjectURL(url); showToast("Judge list exported ✓");
              }}>⬇ JUDGES LIST</button>
            </div>
            <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 10, color: "#333", marginTop: 14 }}>CSV opens in Excel, Google Sheets, or any spreadsheet app.</div>
          </div>
        )}
      </div>
    </div>
  );
}
// ─────────────────────────────────────────────────────────────────
function OrganizerTab({ activeCat, catSorted, col, onAdd, getScore }) {
  const [form, setForm]       = useState({ name: "", city: "" });
  const [loading, setLoading] = useState(false);
  const submit = async () => { setLoading(true); await onAdd(form); setForm({ name: "", city: "" }); setLoading(false); };
  return (
    <div className="slide">
      <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 18, letterSpacing: 3, color: col.primary, marginBottom: 12 }}>ADD PARTICIPANT · {activeCat}</div>
      <div className="card" style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 10, alignItems: "end" }}>
        {[["Dancer Name", "name"], ["City / Country", "city"]].map(([label, key]) => (
          <div key={key}>
            <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 9, color: "#555", letterSpacing: 2, marginBottom: 5 }}>{label}</div>
            <input className="inp" placeholder={label} value={form[key]} onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))} onKeyDown={(e) => e.key === "Enter" && submit()} />
          </div>
        ))}
        <button className="btn" style={{ background: col.primary, color: "#000" }} onClick={submit} disabled={loading}>{loading ? <Spinner /> : "+ ADD"}</button>
      </div>
      <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 10, color: "#444", letterSpacing: 2, marginBottom: 10 }}>{catSorted.length} PARTICIPANTS</div>
      {catSorted.map((p, i) => (
        <div key={p.id} className="lrow" style={{ borderRadius: 10, marginBottom: 5, background: "#0c0c0c", border: "1px solid #161616" }}>
          <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 20, color: i < 3 ? col.primary : "#222", minWidth: 36 }}>#{i + 1}</div>
          <div style={{ flex: 1 }}><div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 15 }}>{p.name}</div><div style={{ fontFamily: "Barlow,sans-serif", fontSize: 10, color: "#555" }}>{p.city}</div></div>
          <span className="badge" style={{ background: p.checked_in ? "#00c85322" : "#ff4d4d22", color: p.checked_in ? "#00c853" : "#ff4d4d" }}>{p.checked_in ? "✓ IN" : "PENDING"}</span>
          <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 20, color: col.primary, minWidth: 40, textAlign: "right" }}>{getScore(p.id) || "—"}</div>
        </div>
      ))}
      {catSorted.length === 0 && <div style={{ textAlign: "center", padding: "48px", fontFamily: "Barlow,sans-serif", color: "#333", fontSize: 13 }}>No {activeCat} participants yet — add one above ↑</div>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// ROOT
// ─────────────────────────────────────────────────────────────────
export default function App() {
  const [screen,      setScreen]      = useState("loading");
  const [activeEvent, setActiveEvent] = useState(null);
  const [judgeData,   setJudgeData]   = useState(null);
  const [toast,       setToast]       = useState(null);

  const showToast = (msg, type = "success") => { setToast({ msg, type }); setTimeout(() => setToast(null), 3000); };

  useEffect(() => {
    // Just check session to decide if admin is already logged in
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) setScreen("adminDashboard");
      else setScreen("landing");
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, session) => {
      if (!session?.user && screen === "adminDashboard") setScreen("landing");
    });
    return () => subscription.unsubscribe();
  }, []);

  const handleAdminLogout = async () => {
    await supabase.auth.signOut();
    setScreen("landing");
  };

  if (screen === "loading") return (
    <div style={{ fontFamily: "'Bebas Neue',sans-serif", background: "#080808", minHeight: "100vh", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 24 }}>
      <style>{CSS}</style>
      <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 48, letterSpacing: 5 }}>DAN<span style={{ color: "#ff4d4d" }}>BUZZ</span></div>
      <Spinner />
    </div>
  );

  return (
    <div style={{ fontFamily: "'Bebas Neue',sans-serif", background: "#080808", minHeight: "100vh", color: "#fff" }}>
      <style>{CSS}</style>
      <Toast toast={toast} />
      {screen === "landing"        && <LandingScreen onAdminLogin={() => setScreen("adminLogin")} onOrgLogin={() => setScreen("orgLogin")} onJudgeLogin={() => setScreen("judgeLogin")} />}
      {screen === "adminLogin"     && <AdminLoginScreen onBack={() => setScreen("landing")} onLogin={() => setScreen("adminDashboard")} showToast={showToast} />}
      {screen === "adminDashboard" && <AdminDashboard onBack={handleAdminLogout} showToast={showToast} />}
      {screen === "orgLogin"       && <OrgLoginScreen onBack={() => setScreen("landing")} onLogin={(ev) => { setActiveEvent(ev); setScreen("dashboard"); }} showToast={showToast} />}
      {screen === "judgeLogin"     && <JudgeLoginScreen onBack={() => setScreen("landing")} onLogin={({ judgeCode, event }) => { setJudgeData(judgeCode); setActiveEvent(event); setScreen("judgeDashboard"); }} showToast={showToast} />}
      {screen === "judgeDashboard" && judgeData && activeEvent && <JudgeDashboard judgeCode={judgeData} event={activeEvent} onBack={() => { setJudgeData(null); setActiveEvent(null); setScreen("landing"); }} showToast={showToast} />}
      {screen === "dashboard"      && activeEvent && <Dashboard event={activeEvent} onBack={() => { setActiveEvent(null); setScreen("landing"); }} showToast={showToast} />}
    </div>
  );
}
