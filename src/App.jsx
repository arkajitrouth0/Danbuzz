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

const genJudgeCodes = (prefix, categories) => {
  const codes = [];
  categories.forEach((cat) => {
    const slug = cat.replace(/\s+/g, "").slice(0, 3).toUpperCase();
    for (let i = 1; i <= 3; i++) {
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
function LandingScreen({ onCreateEvent, onOrgLogin, onJudgeReg }) {
  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 32, textAlign: "center", background: "#080808" }}>
      <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 64, letterSpacing: 6, lineHeight: 1 }}>DAN<span style={{ color: "#ff4d4d" }}>BUZZ</span></div>
      <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 11, color: "#444", letterSpacing: 4, marginBottom: 52 }}>BATTLE MANAGEMENT SYSTEM</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 14, width: "100%", maxWidth: 320 }}>
        <button className="btn" style={{ background: "#ff4d4d", color: "#000", fontSize: 14, padding: "15px" }} onClick={onCreateEvent}>+ CREATE NEW EVENT</button>
        <button className="btn" style={{ background: "#111", color: "#fff", border: "1px solid #2a2a2a", fontSize: 14, padding: "15px" }} onClick={onOrgLogin}>🔑 ORGANIZER LOGIN</button>
        <button className="btn" style={{ background: "#111", color: "#aaa", border: "1px solid #222", fontSize: 13, padding: "14px" }} onClick={onJudgeReg}>JUDGE REGISTRATION</button>
      </div>
      <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 10, color: "#1e1e1e", letterSpacing: 2, marginTop: 52 }}>CUSTOM CATEGORIES · REAL-TIME · POWERED BY SUPABASE</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// SCREEN: CREATE EVENT (with custom category builder)
// ─────────────────────────────────────────────────────────────────
function CreateEventScreen({ onBack, onCreate, showToast }) {
  const [form, setForm]         = useState({ name: "", date: "", city: "" });
  const [categories, setCategories] = useState([]);
  const [customInput, setCustomInput] = useState("");
  const [loading, setLoading]   = useState(false);

  const addCategory = (cat) => {
    const trimmed = cat.trim();
    if (!trimmed) return;
    if (categories.map((c) => c.toLowerCase()).includes(trimmed.toLowerCase())) return showToast(`"${trimmed}" already added!`, "error");
    setCategories((prev) => [...prev, trimmed]);
    setCustomInput("");
  };

  const removeCategory = (cat) => setCategories((prev) => prev.filter((c) => c !== cat));

  const toggleSuggested = (cat) => {
    if (categories.map((c) => c.toLowerCase()).includes(cat.toLowerCase())) {
      removeCategory(cat);
    } else {
      addCategory(cat);
    }
  };

  const submit = async () => {
    if (!form.name.trim() || !form.date || !form.city.trim()) return showToast("Fill in event name, date and city!", "error");
    if (categories.length === 0) return showToast("Add at least one category!", "error");
    setLoading(true);

    const orgCode = genOrgCode();
    const prefix  = randAlpha(3);
    const judgeCodes = genJudgeCodes(prefix, categories);

    const { data: eventData, error: eventError } = await supabase
      .from("events")
      .insert({ name: form.name.trim(), city: form.city.trim(), date: form.date, org_code: orgCode, categories })
      .select()
      .single();

    if (eventError) { showToast("Failed to create event: " + eventError.message, "error"); setLoading(false); return; }

    const { error: codesError } = await supabase.from("judge_codes").insert(
      judgeCodes.map((j) => ({ event_id: eventData.id, code: j.code, category: j.category, slot: j.slot }))
    );
    if (codesError) { showToast("Failed to generate judge codes!", "error"); setLoading(false); return; }

    const { data: fullCodes } = await supabase.from("judge_codes").select("*").eq("event_id", eventData.id);
    onCreate({ ...eventData, judgeCodes: fullCodes || [] });
    setLoading(false);
  };

  return (
    <div style={{ minHeight: "100vh", background: "#080808", padding: 32, maxWidth: 600, margin: "0 auto" }}>
      <button className="btn" style={{ background: "transparent", color: "#555", border: "none", padding: 0, marginBottom: 24, fontSize: 12, letterSpacing: 2 }} onClick={onBack}>← BACK</button>
      <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 28, letterSpacing: 3, marginBottom: 6 }}>CREATE NEW EVENT</div>
      <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 12, color: "#555", marginBottom: 28 }}>Set up your event details and build your custom category list.</div>

      {/* Basic info */}
      {[["Event Name", "name", "text", "e.g. Danbuzz Open 2025"], ["City / Venue", "city", "text", "e.g. Imphal, Manipur"], ["Event Date", "date", "date", ""]].map(([label, key, type, ph]) => (
        <div key={key} style={{ marginBottom: 16 }}>
          <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 10, color: "#555", letterSpacing: 2, marginBottom: 6 }}>{label}</div>
          <input className="inp" type={type} placeholder={ph} value={form[key]} onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))} />
        </div>
      ))}

      {/* Category builder */}
      <div style={{ margin: "28px 0 0" }}>
        <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 10, color: "#555", letterSpacing: 2, marginBottom: 6 }}>CATEGORIES <span style={{ color: "#ff4d4d" }}>*</span></div>
        <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 11, color: "#444", marginBottom: 14 }}>
          Click suggestions to add, or type a custom category name and press Enter.
        </div>

        {/* Suggestions */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
          {SUGGESTED_CATEGORIES.map((cat) => {
            const isAdded = categories.map((c) => c.toLowerCase()).includes(cat.toLowerCase());
            return (
              <button key={cat} className={`chip${isAdded ? " active" : ""}`} onClick={() => toggleSuggested(cat)}>
                {isAdded ? "✓ " : "+ "}{cat}
              </button>
            );
          })}
        </div>

        {/* Custom input */}
        <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
          <input
            className="inp"
            placeholder="Type a custom category name..."
            value={customInput}
            onChange={(e) => setCustomInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addCategory(customInput); } }}
          />
          <button className="btn" style={{ background: "#1a1a1a", color: "#fff", border: "1px solid #2a2a2a", whiteSpace: "nowrap" }} onClick={() => addCategory(customInput)}>
            + ADD
          </button>
        </div>

        {/* Selected categories */}
        {categories.length > 0 ? (
          <div style={{ background: "#0f0f0f", border: "1px solid #1e1e1e", borderRadius: 12, padding: 16, marginBottom: 8 }}>
            <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 10, color: "#555", letterSpacing: 2, marginBottom: 12 }}>
              YOUR EVENT CATEGORIES ({categories.length})
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {categories.map((cat, i) => {
                const c = PALETTE[i % PALETTE.length];
                return (
                  <div key={cat} style={{ display: "flex", alignItems: "center", gap: 8, background: c.bg, border: `1px solid ${c.border}`, borderRadius: 8, padding: "6px 12px" }}>
                    <span style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 14, letterSpacing: 1, color: c.primary }}>{cat}</span>
                    <button onClick={() => removeCategory(cat)} style={{ background: "none", border: "none", color: "#555", cursor: "pointer", fontFamily: "Barlow,sans-serif", fontSize: 14, padding: 0, lineHeight: 1 }}>✕</button>
                  </div>
                );
              })}
            </div>
            <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 10, color: "#444", marginTop: 12 }}>
              3 judge slots will be generated per category ({categories.length * 3} total judge codes)
            </div>
          </div>
        ) : (
          <div style={{ background: "#0f0f0f", border: "1px dashed #2a2a2a", borderRadius: 12, padding: "24px", textAlign: "center", marginBottom: 8 }}>
            <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 12, color: "#333" }}>No categories yet — add some above ↑</div>
          </div>
        )}
      </div>

      <button className="btn" style={{ background: "#ff4d4d", color: "#000", width: "100%", marginTop: 24, fontSize: 14, padding: "13px" }} onClick={submit} disabled={loading || categories.length === 0}>
        {loading ? <Spinner /> : `CREATE EVENT WITH ${categories.length} CATEGOR${categories.length === 1 ? "Y" : "IES"} →`}
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// SCREEN: EVENT CREATED
// ─────────────────────────────────────────────────────────────────
function EventCreatedScreen({ event, onEnter }) {
  const [copied, setCopied] = useState(null);
  const copy = (val) => { navigator.clipboard?.writeText(val).catch(() => {}); setCopied(val); setTimeout(() => setCopied(null), 1500); };
  const codes      = event.judgeCodes || [];
  const categories = event.categories || [];

  return (
    <div style={{ minHeight: "100vh", background: "#080808", padding: 32, maxWidth: 720, margin: "0 auto" }}>
      <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 12, color: "#00c853", letterSpacing: 3, marginBottom: 6 }}>✓ EVENT CREATED & SAVED</div>
      <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 30, letterSpacing: 2, marginBottom: 2 }}>{event.name}</div>
      <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 12, color: "#555", marginBottom: 4 }}>{event.city} · {event.date}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 28 }}>
        {categories.map((cat, i) => {
          const c = PALETTE[i % PALETTE.length];
          return <span key={cat} style={{ fontFamily: "Barlow,sans-serif", fontSize: 10, padding: "3px 10px", borderRadius: 20, background: c.bg, border: `1px solid ${c.border}`, color: c.primary }}>{cat}</span>;
        })}
      </div>

      {/* Organizer code */}
      <div style={{ background: "#0f0f0f", border: "1px solid #ff4d4d44", borderRadius: 12, padding: 20, marginBottom: 24 }}>
        <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 10, color: "#ff4d4d", letterSpacing: 3, marginBottom: 10 }}>YOUR ORGANIZER CODE — Save this, it's the only way back in</div>
        <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 34, letterSpacing: 6, color: "#ff4d4d" }}>{event.org_code}</div>
          <button className="btn" style={{ fontSize: 10, padding: "6px 14px", background: "transparent", border: "1px solid #ff4d4d44", color: "#ff4d4d" }} onClick={() => copy(event.org_code)}>
            {copied === event.org_code ? "✓ COPIED" : "COPY"}
          </button>
        </div>
      </div>

      {/* Judge codes per category */}
      <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 10, color: "#555", letterSpacing: 3, marginBottom: 14 }}>
        JUDGE CODES — Share each one individually
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(280px,1fr))", gap: 12, marginBottom: 32 }}>
        {categories.map((cat, catIdx) => {
          const c        = PALETTE[catIdx % PALETTE.length];
          const catCodes = codes.filter((j) => j.category === cat);
          return (
            <div key={cat} style={{ background: "#0f0f0f", border: `1px solid ${c.border}`, borderRadius: 10, padding: 16 }}>
              <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 14, letterSpacing: 2, color: c.primary, marginBottom: 12 }}>{cat}</div>
              {catCodes.map((j) => (
                <div key={j.code} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8, padding: "8px 12px", background: "#151515", borderRadius: 7 }}>
                  <div>
                    <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 14, letterSpacing: 2, color: "#fff" }}>{j.code}</div>
                    <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 10, color: "#555" }}>Judge {j.slot}</div>
                  </div>
                  <button className="btn" style={{ fontSize: 10, padding: "5px 10px", background: "transparent", border: `1px solid ${c.primary}`, color: c.primary }} onClick={() => copy(j.code)}>
                    {copied === j.code ? "✓" : "COPY"}
                  </button>
                </div>
              ))}
            </div>
          );
        })}
      </div>
      <button className="btn" style={{ background: "#ff4d4d", color: "#000", fontSize: 14, padding: "13px 32px" }} onClick={onEnter}>
        ENTER DASHBOARD →
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// SCREEN: ORGANIZER LOGIN
// ─────────────────────────────────────────────────────────────────
function OrgLoginScreen({ onBack, onLogin, showToast }) {
  const [mode, setMode]         = useState("choose");
  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  const [isSignup, setIsSignup] = useState(false);
  const [orgCode, setOrgCode]   = useState("");
  const [loading, setLoading]   = useState(false);

  const handleEmailSubmit = async () => {
    if (!email.trim() || !password.trim()) return showToast("Fill in all fields!", "error");
    setLoading(true);
    if (isSignup) {
      const { error } = await supabase.auth.signUp({ email, password });
      if (error) { showToast(error.message, "error"); setLoading(false); return; }
      showToast("Account created! You can now log in.");
      setIsSignup(false);
    } else {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) { showToast(error.message, "error"); setLoading(false); return; }
      onLogin({ type: "email", user: data.user });
    }
    setLoading(false);
  };

  const handleCodeSubmit = async () => {
    if (!orgCode.trim()) return showToast("Enter your organizer code!", "error");
    setLoading(true);
    const { data, error } = await supabase.from("events").select("*").eq("org_code", orgCode.trim().toUpperCase()).single();
    if (error || !data) { showToast("Invalid organizer code!", "error"); setLoading(false); return; }
    onLogin({ type: "code", event: data });
    setLoading(false);
  };

  if (mode === "choose") return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 32, background: "#080808" }}>
      <div style={{ width: "100%", maxWidth: 360 }}>
        <button className="btn" style={{ background: "transparent", color: "#555", border: "none", padding: 0, marginBottom: 24, fontSize: 12, letterSpacing: 2 }} onClick={onBack}>← BACK</button>
        <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 26, letterSpacing: 3, marginBottom: 24 }}>ORGANIZER LOGIN</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <button className="btn" style={{ background: "#111", color: "#fff", border: "1px solid #2a2a2a", padding: "16px", textAlign: "left" }} onClick={() => setMode("email")}>
            <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 16, letterSpacing: 2, marginBottom: 4 }}>📧 EMAIL & PASSWORD</div>
            <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 11, color: "#555", letterSpacing: 0 }}>Log in with your account to manage your events</div>
          </button>
          <button className="btn" style={{ background: "#111", color: "#fff", border: "1px solid #2a2a2a", padding: "16px", textAlign: "left" }} onClick={() => setMode("code")}>
            <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 16, letterSpacing: 2, marginBottom: 4 }}>🔑 EVENT CODE</div>
            <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 11, color: "#555", letterSpacing: 0 }}>Enter the organizer code from your event creation screen</div>
          </button>
        </div>
      </div>
    </div>
  );

  if (mode === "email") return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 32, background: "#080808" }}>
      <div style={{ width: "100%", maxWidth: 360 }}>
        <button className="btn" style={{ background: "transparent", color: "#555", border: "none", padding: 0, marginBottom: 24, fontSize: 12, letterSpacing: 2 }} onClick={() => setMode("choose")}>← BACK</button>
        <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 26, letterSpacing: 3, marginBottom: 24 }}>{isSignup ? "CREATE ACCOUNT" : "SIGN IN"}</div>
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 10, color: "#555", letterSpacing: 2, marginBottom: 6 }}>EMAIL</div>
          <input className="inp" type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 10, color: "#555", letterSpacing: 2, marginBottom: 6 }}>PASSWORD</div>
          <input className="inp" type="password" placeholder="••••••••" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleEmailSubmit()} />
        </div>
        <button className="btn" style={{ background: "#ff4d4d", color: "#000", width: "100%", fontSize: 14, padding: "13px", marginBottom: 16 }} onClick={handleEmailSubmit} disabled={loading}>
          {loading ? <Spinner /> : isSignup ? "CREATE ACCOUNT →" : "SIGN IN →"}
        </button>
        <div style={{ textAlign: "center", fontFamily: "Barlow,sans-serif", fontSize: 12, color: "#555" }}>
          {isSignup ? "Already have an account? " : "No account? "}
          <button style={{ background: "none", border: "none", color: "#ff4d4d", cursor: "pointer", fontFamily: "Barlow,sans-serif", fontSize: 12, padding: 0 }} onClick={() => setIsSignup(!isSignup)}>
            {isSignup ? "Sign in" : "Create one"}
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 32, background: "#080808" }}>
      <div style={{ width: "100%", maxWidth: 360 }}>
        <button className="btn" style={{ background: "transparent", color: "#555", border: "none", padding: 0, marginBottom: 24, fontSize: 12, letterSpacing: 2 }} onClick={() => setMode("choose")}>← BACK</button>
        <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 26, letterSpacing: 3, marginBottom: 6 }}>ENTER EVENT CODE</div>
        <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 12, color: "#555", marginBottom: 24 }}>The organizer code was shown when your event was created.</div>
        <input className="inp" placeholder="e.g. ORG-XYZ-1234" value={orgCode} onChange={(e) => setOrgCode(e.target.value.toUpperCase())} onKeyDown={(e) => e.key === "Enter" && handleCodeSubmit()} style={{ letterSpacing: 3, fontFamily: "Bebas Neue,sans-serif", fontSize: 20, marginBottom: 14 }} />
        <button className="btn" style={{ background: "#ff4d4d", color: "#000", width: "100%", fontSize: 14, padding: "13px" }} onClick={handleCodeSubmit} disabled={loading}>
          {loading ? <Spinner /> : "ENTER →"}
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// SCREEN: EVENT PICKER (after email login)
// ─────────────────────────────────────────────────────────────────
function EventPickerScreen({ onBack, onSelect, showToast }) {
  const [events, setEvents]       = useState([]);
  const [loading, setLoading]     = useState(true);
  const [orgCode, setOrgCode]     = useState("");
  const [codeLoading, setCodeLoading] = useState(false);

  useEffect(() => {
    supabase.from("events").select("*").order("created_at", { ascending: false }).then(({ data }) => {
      setEvents(data || []);
      setLoading(false);
    });
  }, []);

  const handleCodeJoin = async () => {
    if (!orgCode.trim()) return showToast("Enter an event code!", "error");
    setCodeLoading(true);
    const { data, error } = await supabase.from("events").select("*").eq("org_code", orgCode.trim().toUpperCase()).single();
    if (error || !data) { showToast("Invalid code!", "error"); setCodeLoading(false); return; }
    onSelect(data);
    setCodeLoading(false);
  };

  return (
    <div style={{ minHeight: "100vh", background: "#080808", padding: 32, maxWidth: 600, margin: "0 auto" }}>
      <button className="btn" style={{ background: "transparent", color: "#555", border: "none", padding: 0, marginBottom: 24, fontSize: 12, letterSpacing: 2 }} onClick={onBack}>← BACK</button>
      <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 26, letterSpacing: 3, marginBottom: 24 }}>SELECT EVENT</div>
      {loading ? (
        <div style={{ textAlign: "center", padding: 48 }}><Spinner /></div>
      ) : events.length === 0 ? (
        <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 13, color: "#555", padding: "32px", textAlign: "center", background: "#111", borderRadius: 12, border: "1px solid #1e1e1e", marginBottom: 24 }}>
          No events found. Create one from the home screen.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 28 }}>
          {events.map((ev) => {
            const cats = ev.categories || [];
            return (
              <button key={ev.id} className="btn" style={{ background: "#111", color: "#fff", border: "1px solid #2a2a2a", padding: "14px 18px", textAlign: "left", borderRadius: 10, display: "flex", justifyContent: "space-between", alignItems: "center" }} onClick={() => onSelect(ev)}>
                <div>
                  <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 18, letterSpacing: 2 }}>{ev.name}</div>
                  <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 11, color: "#555", marginTop: 2 }}>{ev.city} · {ev.date}</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 }}>
                    {cats.slice(0, 4).map((cat, i) => {
                      const c = PALETTE[i % PALETTE.length];
                      return <span key={cat} style={{ fontFamily: "Barlow,sans-serif", fontSize: 9, padding: "2px 8px", borderRadius: 10, background: c.bg, border: `1px solid ${c.border}`, color: c.primary }}>{cat}</span>;
                    })}
                    {cats.length > 4 && <span style={{ fontFamily: "Barlow,sans-serif", fontSize: 9, color: "#444" }}>+{cats.length - 4} more</span>}
                  </div>
                </div>
                <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 10, color: "#ff4d4d", letterSpacing: 1 }}>MANAGE →</div>
              </button>
            );
          })}
        </div>
      )}
      <div style={{ borderTop: "1px solid #1a1a1a", paddingTop: 24 }}>
        <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 10, color: "#444", letterSpacing: 2, marginBottom: 10 }}>OR ENTER EVENT CODE DIRECTLY</div>
        <div style={{ display: "flex", gap: 8 }}>
          <input className="inp" placeholder="ORG-XXX-0000" value={orgCode} onChange={(e) => setOrgCode(e.target.value.toUpperCase())} style={{ fontFamily: "Bebas Neue,sans-serif", letterSpacing: 2, fontSize: 16 }} />
          <button className="btn" style={{ background: "#ff4d4d", color: "#000", whiteSpace: "nowrap" }} onClick={handleCodeJoin} disabled={codeLoading}>
            {codeLoading ? <Spinner /> : "GO →"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// SCREEN: JUDGE REGISTRATION
// ─────────────────────────────────────────────────────────────────
function JudgeRegScreen({ onBack, showToast }) {
  const [code, setCode]     = useState("");
  const [name, setName]     = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone]     = useState(null);

  const register = async () => {
    if (!code.trim() || !name.trim()) return showToast("Enter your code and name!", "error");
    setLoading(true);
    const upper = code.trim().toUpperCase();
    const { data: jc, error } = await supabase.from("judge_codes").select("*, events(name, city, categories)").eq("code", upper).single();
    if (error || !jc) { showToast("Invalid code. Ask your organizer.", "error"); setLoading(false); return; }
    if (jc.used) { showToast(`Code already used by ${jc.judge_name}!`, "error"); setLoading(false); return; }
    const { error: updateError } = await supabase.from("judge_codes").update({ used: true, judge_name: name.trim() }).eq("code", upper);
    if (updateError) { showToast("Registration failed. Try again.", "error"); setLoading(false); return; }
    setDone({ category: jc.category, slot: jc.slot, judgeName: name.trim(), eventName: jc.events.name, eventCity: jc.events.city, categories: jc.events.categories || [] });
    setLoading(false);
  };

  if (done) {
    const catIdx = done.categories.indexOf(done.category);
    const c = PALETTE[catIdx >= 0 ? catIdx % PALETTE.length : 0];
    return (
      <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 32, background: "#080808", textAlign: "center" }}>
        <div style={{ fontSize: 52, marginBottom: 12 }}>✓</div>
        <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 28, color: "#00c853", letterSpacing: 2, marginBottom: 4 }}>REGISTERED!</div>
        <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 22, marginBottom: 4 }}>{done.judgeName}</div>
        <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 13, color: "#555", marginBottom: 4 }}>Judge {done.slot} · <span style={{ color: c.primary }}>{done.category}</span></div>
        <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 12, color: "#444", marginBottom: 28 }}>{done.eventName} · {done.eventCity}</div>
        <div style={{ background: c.bg, border: `1px solid ${c.border}`, borderRadius: 12, padding: "16px 28px", marginBottom: 28 }}>
          <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 10, color: c.primary, letterSpacing: 3, marginBottom: 4 }}>YOUR ROLE</div>
          <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 24, letterSpacing: 3, color: c.primary }}>{done.category} · Judge {done.slot}</div>
        </div>
        <button className="btn" style={{ background: "#111", color: "#555", border: "1px solid #222" }} onClick={onBack}>← BACK TO HOME</button>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 32, background: "#080808" }}>
      <div style={{ width: "100%", maxWidth: 380 }}>
        <button className="btn" style={{ background: "transparent", color: "#555", border: "none", padding: 0, marginBottom: 24, fontSize: 12, letterSpacing: 2 }} onClick={onBack}>← BACK</button>
        <div style={{ fontFamily: "Bebas Neue,sans-serif", fontSize: 26, letterSpacing: 3, marginBottom: 4 }}>JUDGE REGISTRATION</div>
        <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 12, color: "#555", marginBottom: 28 }}>Enter the code your organizer gave you. It links you to the correct event and category automatically.</div>
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 10, color: "#555", letterSpacing: 2, marginBottom: 6 }}>JUDGE CODE</div>
          <input className="inp" placeholder="Code from your organizer" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} style={{ letterSpacing: 2, fontFamily: "Bebas Neue,sans-serif", fontSize: 18 }} />
        </div>
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontFamily: "Barlow,sans-serif", fontSize: 10, color: "#555", letterSpacing: 2, marginBottom: 6 }}>YOUR NAME</div>
          <input className="inp" placeholder="Your full name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && register()} />
        </div>
        <button className="btn" style={{ background: "#ff4d4d", color: "#000", width: "100%", fontSize: 14, padding: "13px" }} onClick={register} disabled={loading}>
          {loading ? <Spinner /> : "REGISTER AS JUDGE →"}
        </button>
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
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// ORGANIZER TAB
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
  const [authUser,    setAuthUser]    = useState(null);
  const [activeEvent, setActiveEvent] = useState(null);
  const [toast,       setToast]       = useState(null);

  const showToast = (msg, type = "success") => { setToast({ msg, type }); setTimeout(() => setToast(null), 3000); };

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setAuthUser(session?.user ?? null);
      setScreen("landing");
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, session) => {
      setAuthUser(session?.user ?? null);
    });
    return () => subscription.unsubscribe();
  }, []);

  const handleOrgLogin = (result) => {
    if (result.type === "code") { setActiveEvent(result.event); setScreen("dashboard"); }
    else { setAuthUser(result.user); setScreen("picker"); }
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    setAuthUser(null); setActiveEvent(null); setScreen("landing");
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
      {screen === "landing"   && <LandingScreen onCreateEvent={() => setScreen("create")} onOrgLogin={() => setScreen("orgLogin")} onJudgeReg={() => setScreen("judgeReg")} />}
      {screen === "orgLogin"  && <OrgLoginScreen onBack={() => setScreen("landing")} onLogin={handleOrgLogin} showToast={showToast} />}
      {screen === "picker"    && <EventPickerScreen onBack={() => setScreen("landing")} onSelect={(ev) => { setActiveEvent(ev); setScreen("dashboard"); }} showToast={showToast} />}
      {screen === "create"    && <CreateEventScreen onBack={() => setScreen("landing")} onCreate={(ev) => { setActiveEvent(ev); setScreen("created"); }} showToast={showToast} />}
      {screen === "created"   && activeEvent && <EventCreatedScreen event={activeEvent} onEnter={() => setScreen("dashboard")} />}
      {screen === "judgeReg"  && <JudgeRegScreen onBack={() => setScreen("landing")} showToast={showToast} />}
      {screen === "dashboard" && activeEvent && <Dashboard event={activeEvent} onBack={handleLogout} showToast={showToast} />}
    </div>
  );
}
