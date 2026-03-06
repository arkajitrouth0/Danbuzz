import { useState, useEffect, useMemo, useCallback } from "react";
import { supabase } from "./supabase";

// ─────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────
const ALL_POST_PRELIM_ROUNDS = ["Top 32", "Top 16", "Top 8", "Top 4", "Finals"];
const ROUND_LIMIT = { Prelims: 999, "Top 32": 32, "Top 16": 16, "Top 8": 8, "Top 4": 4, Finals: 2 };

const SUGGESTED_CATEGORIES = [
  "HipHop","Breaking","Popping","Locking","Waacking",
  "House","All Styles","Rep Your Style","Krump",
  "2 vs 2","Crew vs Crew","Experimental","Kids",
];

const PALETTE = [
  { primary:"#ffd700", bg:"#2a220066", border:"#ffd70044" },
  { primary:"#ff4d4d", bg:"#2a0a0a66", border:"#ff4d4d44" },
  { primary:"#00e5ff", bg:"#002a2a66", border:"#00e5ff44" },
  { primary:"#7fff00", bg:"#0a2a0066", border:"#7fff0044" },
  { primary:"#ff69b4", bg:"#2a0a1a66", border:"#ff69b444" },
  { primary:"#ff9800", bg:"#2a1a0066", border:"#ff980044" },
  { primary:"#b388ff", bg:"#1a0a2a66", border:"#b388ff44" },
  { primary:"#00e676", bg:"#002a1066", border:"#00e67644" },
  { primary:"#ff6e40", bg:"#2a1a0a66", border:"#ff6e4044" },
  { primary:"#40c4ff", bg:"#002a3066", border:"#40c4ff44" },
];

const getCatColor = (categories, cat) => PALETTE[categories.indexOf(cat) % PALETTE.length] || PALETTE[0];

// ─────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────
const rand4     = () => Math.floor(1000 + Math.random() * 9000);
const randAlpha = (n) => Array.from({length:n}, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random()*32)]).join("");
const genOrgCode    = () => `ORG-${randAlpha(3)}-${rand4()}`;
const genViewerCode = () => `VIEW-${randAlpha(4)}-${rand4()}`;

const genJudgeCodes = (prefix, categories, judgeCounts={}) => {
  const codes = [];
  categories.forEach(cat => {
    const slug  = cat.replace(/\s+/g,"").slice(0,3).toUpperCase();
    const count = Math.max(1, Math.min(10, parseInt(judgeCounts[cat])||3));
    for (let i=1; i<=count; i++) codes.push({ code:`${prefix}-${slug}${rand4()}`, category:cat, slot:i });
  });
  return codes;
};

const calcAvgScore = (arr=[]) => {
  if (!arr.length) return 0;
  return Math.round((arr.reduce((a,b)=>a+b,0)/arr.length)*10);
};

const detectBias = (scoreMap={}) => {
  const entries = Object.entries(scoreMap);
  if (entries.length < 2) return [];
  const avg = entries.reduce((a,[,v])=>a+v,0)/entries.length;
  return entries.filter(([,v])=>Math.abs(v-avg)>1.5).map(([j,s])=>({judge:j,score:s,avg:avg.toFixed(1)}));
};

// ─── ELIMINATION ENGINE ──────────────────────────────────────────
//
// COMPETITION FLOW:
//   1. PRELIMS  — Score-based. Every checked-in participant performs solo.
//                 Judges give 1-10 scores. Average score = prelim rank.
//                 Prelim scores are ONLY used to create the seeding list.
//                 They do NOT carry into knockout rounds.
//
//   2. KNOCKOUT — 1v1 elimination battles. Top vs Bottom seeding from prelims.
//                 Seed 1 vs Seed N, Seed 2 vs Seed N-1, etc.
//                 Each round is judged INDEPENDENTLY — no previous round's
//                 result or score influences the current round's judging.
//                 Judges choose a winner per battle. Majority of judges wins.
//
//   3. TIE RULE — If judges are split evenly, a TIE is declared.
//                 The same two fighters must battle again (tie_round increments).
//                 Judges MUST pick a winner in a tie-breaker (no new ties).
//                 Multiple tie-breaker rounds are allowed until resolved.
//
// ─────────────────────────────────────────────────────────────────

// Build the first-round bracket from prelim-ranked list (Top vs Bottom pairing).
// match_index 0 = Seed1 vs SeedN, index 1 = Seed2 vs Seed(N-1), …
const buildFirstRoundBattles = (rankedList, roundName) => {
  const limit = ROUND_LIMIT[roundName] ?? 2;
  const pool  = rankedList.slice(0, limit);
  const half  = Math.floor(pool.length / 2);
  const battles = [];
  for (let i = 0; i < half; i++) {
    battles.push({
      match_index: i,
      round: roundName,
      p1: pool[i],                    // top seed
      p2: pool[pool.length - 1 - i],  // bottom seed
    });
  }
  return battles;
};

// For a single battle (identified by round+match_index), get the highest tie_round
// submitted so far and determine the current status.
//
// Returns:
//   { status: "pending" | "decided" | "tied", winner_id, winner_name, tie_round, judgeVotes }
//   - "pending"  : judges haven't all voted on the current tie_round yet
//   - "tied"     : majority declared tie — need another tie_round
//   - "decided"  : majority picked a winner — battle is over
//
const resolveBattle = (decisions = []) => {
  if (!decisions.length) return { status: "pending", tie_round: 0 };

  // Find the highest tie_round being played
  const maxTieRound = Math.max(...decisions.map(d => d.tie_round ?? 0));

  // Only look at votes for the current tie_round
  const current = decisions.filter(d => (d.tie_round ?? 0) === maxTieRound);
  if (!current.length) return { status: "pending", tie_round: maxTieRound };

  const p1Id = current[0].p1_id;
  const p2Id = current[0].p2_id;
  const p1Wins = current.filter(d => !d.is_tie && d.winner_id === p1Id).length;
  const p2Wins = current.filter(d => !d.is_tie && d.winner_id === p2Id).length;
  const tieVotes = current.filter(d => d.is_tie).length;
  const totalVotes = current.length;

  // Majority wins
  if (p1Wins > p2Wins && p1Wins > tieVotes) {
    return { status: "decided", winner_id: p1Id, winner_name: current[0].p1_name, tie_round: maxTieRound };
  }
  if (p2Wins > p1Wins && p2Wins > tieVotes) {
    return { status: "decided", winner_id: p2Id, winner_name: current[0].p2_name, tie_round: maxTieRound };
  }
  // Tie majority or split — treat as tied, needs extra round
  return { status: "tied", winner_id: null, winner_name: null, tie_round: maxTieRound };
};

// ─────────────────────────────────────────────────────────────────
// CSS
// ─────────────────────────────────────────────────────────────────
const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Barlow:wght@300;400;600;700&display=swap');
  *{box-sizing:border-box;} body{margin:0;background:#080808;}
  ::-webkit-scrollbar{width:4px;} ::-webkit-scrollbar-track{background:#111;} ::-webkit-scrollbar-thumb{background:#333;}
  .tbtn{font-family:'Bebas Neue',sans-serif;font-size:12px;letter-spacing:2px;padding:9px 14px;border:none;cursor:pointer;transition:all .2s;border-bottom:3px solid transparent;background:transparent;color:#555;white-space:nowrap;}
  .tbtn:hover{color:#fff;}
  .card{background:#111;border:1px solid #1e1e1e;border-radius:12px;padding:18px;margin-bottom:12px;}
  .inp{background:#151515;border:1px solid #2a2a2a;color:#fff;padding:9px 13px;border-radius:8px;font-family:'Barlow',sans-serif;font-size:13px;width:100%;outline:none;transition:border-color .2s;}
  .inp:focus{border-color:#888;}
  .btn{font-family:'Bebas Neue',sans-serif;letter-spacing:2px;padding:9px 18px;border:none;border-radius:8px;cursor:pointer;font-size:13px;transition:all .2s;}
  .btn:hover{opacity:.85;transform:translateY(-1px);}
  .btn:disabled{opacity:.35;cursor:not-allowed;transform:none;}
  .badge{display:inline-block;padding:3px 10px;border-radius:20px;font-family:'Barlow',sans-serif;font-size:10px;font-weight:700;letter-spacing:1px;}
  .pulse{animation:pulse 1.5s infinite;}
  @keyframes pulse{0%,100%{opacity:1;}50%{opacity:.4;}}
  .slide{animation:slideIn .2s ease;}
  @keyframes slideIn{from{transform:translateY(-6px);opacity:0;}to{transform:translateY(0);opacity:1;}}
  .lrow{display:flex;align-items:center;gap:13px;padding:11px 16px;border-bottom:1px solid #0f0f0f;transition:background .15s;}
  .lrow:hover{background:#111;}
  .chip{font-family:'Barlow',sans-serif;font-size:11px;padding:5px 12px;border-radius:20px;border:1px solid #2a2a2a;background:#111;color:#777;cursor:pointer;transition:all .15s;white-space:nowrap;}
  .chip:hover{border-color:#555;color:#fff;}
  .chip.active{background:#ff4d4d22;border-color:#ff4d4d;color:#ff4d4d;}
  select{appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='7' fill='%23888'%3E%3Cpath d='M0 0l5 7 5-7z'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 11px center;}
  .spin{display:inline-block;width:16px;height:16px;border:2px solid #ffffff44;border-top-color:#fff;border-radius:50%;animation:spinner .6s linear infinite;vertical-align:middle;}
  @keyframes spinner{to{transform:rotate(360deg);}}
  .rchip{font-family:'Barlow',sans-serif;font-size:10px;padding:4px 10px;border-radius:20px;border:1px solid #2a2a2a;background:#111;color:#555;cursor:pointer;transition:all .15s;}
  .rchip.on{background:#ffd70022;border-color:#ffd700;color:#ffd700;}
  .battle-card{background:#111;border:1px solid #1e1e1e;border-radius:14px;padding:0;overflow:hidden;margin-bottom:14px;}
  .fighter{display:flex;align-items:center;gap:12px;padding:14px 18px;cursor:pointer;transition:background .15s;}
  .fighter:hover{background:#181818;}
  .fighter.selected{background:#1a2a1a;}
  .fighter.winner{background:#0a1e0a;}
  .fighter.loser{opacity:0.4;}
  .vs-bar{display:flex;align-items:center;justify-content:center;padding:6px;background:#0a0a0a;font-family:'Bebas Neue',sans-serif;font-size:11px;letter-spacing:3px;color:#333;}
`;

function Spinner() { return <span className="spin"/>; }
function Toast({toast}) {
  if (!toast) return null;
  return <div className="slide" style={{position:"fixed",top:16,right:16,zIndex:9999,background:toast.type==="error"?"#200a0a":"#0a200a",border:`1px solid ${toast.type==="error"?"#ff4d4d":"#00c853"}`,borderRadius:10,padding:"10px 18px",fontFamily:"Barlow,sans-serif",fontSize:13,color:toast.type==="error"?"#ff4d4d":"#00c853",maxWidth:300}}>{toast.msg}</div>;
}

// ─────────────────────────────────────────────────────────────────
// LANDING
// ─────────────────────────────────────────────────────────────────
function LandingScreen({ onAdminLogin, onOrgLogin, onJudgeLogin, onViewerLogin }) {
  return (
    <div style={{minHeight:"100vh",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:32,textAlign:"center",background:"#080808"}}>
      <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:64,letterSpacing:6,lineHeight:1}}>DAN<span style={{color:"#ff4d4d"}}>BUZZ</span></div>
      <div style={{fontFamily:"Barlow,sans-serif",fontSize:11,color:"#444",letterSpacing:4,marginBottom:52}}>BATTLE MANAGEMENT SYSTEM</div>
      <div style={{display:"flex",flexDirection:"column",gap:14,width:"100%",maxWidth:320}}>
        <button className="btn" style={{background:"#ff4d4d",color:"#000",fontSize:14,padding:"15px"}} onClick={onOrgLogin}>🔑 ORGANIZER LOGIN</button>
        <button className="btn" style={{background:"#111",color:"#aaa",border:"1px solid #222",fontSize:13,padding:"14px"}} onClick={onJudgeLogin}>⚖️ JUDGE LOGIN</button>
        <button className="btn" style={{background:"#111",color:"#00e5ff",border:"1px solid #00e5ff33",fontSize:13,padding:"14px"}} onClick={onViewerLogin}>👁 LIVE VIEW (VIEWER / PARTICIPANT)</button>
        <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#333",marginTop:4}}>First time as a judge? Judge Login handles registration too.</div>
      </div>
      <div style={{marginTop:52,borderTop:"1px solid #111",paddingTop:20}}>
        <button style={{background:"none",border:"none",color:"#1e1e1e",cursor:"pointer",fontFamily:"Barlow,sans-serif",fontSize:9,letterSpacing:3}} onClick={onAdminLogin}>ADMIN</button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// ADMIN LOGIN
// ─────────────────────────────────────────────────────────────────
function AdminLoginScreen({ onBack, onLogin, showToast }) {
  const [email,setEmail]=useState(""); const [password,setPassword]=useState(""); const [loading,setLoading]=useState(false);
  const handleLogin = async () => {
    if (!email.trim()||!password.trim()) return showToast("Fill in all fields!","error");
    setLoading(true);
    const {data,error}=await supabase.auth.signInWithPassword({email,password});
    if (error){showToast(error.message,"error");setLoading(false);return;}
    onLogin(data.user); setLoading(false);
  };
  return (
    <div style={{minHeight:"100vh",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:32,background:"#080808"}}>
      <div style={{width:"100%",maxWidth:360}}>
        <button className="btn" style={{background:"transparent",color:"#333",border:"none",padding:0,marginBottom:24,fontSize:12,letterSpacing:2}} onClick={onBack}>← BACK</button>
        <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:12,color:"#ff4d4d",letterSpacing:4,marginBottom:4}}>DANBUZZ</div>
        <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:26,letterSpacing:3,marginBottom:4}}>ADMIN LOGIN</div>
        <div style={{fontFamily:"Barlow,sans-serif",fontSize:12,color:"#555",marginBottom:28}}>Restricted to DanBuzz administrators only.</div>
        <div style={{marginBottom:14}}>
          <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#555",letterSpacing:2,marginBottom:6}}>EMAIL</div>
          <input className="inp" type="email" placeholder="admin@danbuzz.com" value={email} onChange={e=>setEmail(e.target.value)}/>
        </div>
        <div style={{marginBottom:20}}>
          <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#555",letterSpacing:2,marginBottom:6}}>PASSWORD</div>
          <input className="inp" type="password" placeholder="••••••••" value={password} onChange={e=>setPassword(e.target.value)} onKeyDown={e=>e.key==="Enter"&&handleLogin()}/>
        </div>
        <button className="btn" style={{background:"#ff4d4d",color:"#000",width:"100%",fontSize:14,padding:"13px"}} onClick={handleLogin} disabled={loading}>{loading?<Spinner/>:"LOGIN →"}</button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// ADMIN DASHBOARD
// ─────────────────────────────────────────────────────────────────
function AdminDashboard({ onBack, showToast }) {
  const [tab,setTab]=useState("events"); const [events,setEvents]=useState([]); const [loading,setLoading]=useState(true);
  const loadEvents=async()=>{setLoading(true);const{data}=await supabase.from("events").select("*").order("created_at",{ascending:false});setEvents(data||[]);setLoading(false);};
  useEffect(()=>{loadEvents();},[]);
  const deleteEvent=async(id,name)=>{if(!window.confirm(`Delete "${name}"?`))return;const{error}=await supabase.from("events").delete().eq("id",id);if(error)return showToast("Delete failed","error");showToast("Event deleted ✓");loadEvents();};
  return (
    <div style={{fontFamily:"'Bebas Neue',Impact,sans-serif",background:"#080808",minHeight:"100vh",color:"#fff"}}>
      <div style={{padding:"22px 22px 0",maxWidth:1100,margin:"0 auto"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:12,marginBottom:16}}>
          <div>
            <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:36,letterSpacing:4}}>DAN<span style={{color:"#ff4d4d"}}>BUZZ</span> <span style={{fontSize:14,color:"#ff4d4d",letterSpacing:3}}>ADMIN</span></div>
            <div style={{fontFamily:"Barlow,sans-serif",fontSize:11,color:"#555",marginTop:4}}>{events.length} events total</div>
          </div>
          <button className="btn" style={{background:"transparent",color:"#555",border:"1px solid #222",fontSize:11}} onClick={onBack}>← LOGOUT</button>
        </div>
        <div style={{display:"flex",borderBottom:"1px solid #1a1a1a"}}>
          {[{key:"events",label:"ALL EVENTS"},{key:"create",label:"+ CREATE EVENT"}].map(t=>(
            <button key={t.key} className="tbtn" style={{color:tab===t.key?"#ff4d4d":"#555",borderBottom:tab===t.key?"3px solid #ff4d4d":"3px solid transparent"}} onClick={()=>setTab(t.key)}>{t.label}</button>
          ))}
        </div>
      </div>
      <div style={{padding:"20px 22px 40px",maxWidth:1100,margin:"0 auto"}}>
        {tab==="events"&&(
          <div className="slide">
            {loading?<div style={{textAlign:"center",padding:48}}><Spinner/></div>:events.length===0?(
              <div style={{textAlign:"center",padding:"48px",fontFamily:"Barlow,sans-serif",color:"#333"}}>No events yet.</div>
            ):events.map(ev=>{
              const cats=ev.categories||[];
              return (
                <div key={ev.id} style={{background:"#111",border:"1px solid #1e1e1e",borderRadius:12,padding:"16px 20px",marginBottom:12,display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:12}}>
                  <div>
                    <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:18,letterSpacing:2}}>{ev.name}</div>
                    <div style={{fontFamily:"Barlow,sans-serif",fontSize:11,color:"#555",marginTop:2}}>{ev.city} · {ev.date}</div>
                    <div style={{display:"flex",flexWrap:"wrap",gap:4,marginTop:6}}>
                      {cats.slice(0,5).map((cat,i)=>{const c=PALETTE[i%PALETTE.length];return <span key={cat} style={{fontFamily:"Barlow,sans-serif",fontSize:9,padding:"2px 8px",borderRadius:10,background:c.bg,border:`1px solid ${c.border}`,color:c.primary}}>{cat}</span>;})}
                      {cats.length>5&&<span style={{fontFamily:"Barlow,sans-serif",fontSize:9,color:"#444"}}>+{cats.length-5} more</span>}
                    </div>
                  </div>
                  <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                    <div style={{background:"#0f0f0f",border:"1px solid #ff4d4d22",borderRadius:7,padding:"6px 12px"}}>
                      <div style={{fontFamily:"Barlow,sans-serif",fontSize:8,color:"#555",letterSpacing:2}}>ORG CODE</div>
                      <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:14,color:"#ff4d4d",letterSpacing:2}}>{ev.org_code}</div>
                    </div>
                    {ev.viewer_code&&<div style={{background:"#0f0f0f",border:"1px solid #00e5ff22",borderRadius:7,padding:"6px 12px"}}>
                      <div style={{fontFamily:"Barlow,sans-serif",fontSize:8,color:"#555",letterSpacing:2}}>VIEWER CODE</div>
                      <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:14,color:"#00e5ff",letterSpacing:2}}>{ev.viewer_code}</div>
                    </div>}
                    <button className="btn" style={{fontSize:10,background:"#1a0a0a",color:"#ff4d4d",border:"1px solid #ff4d4d33"}} onClick={()=>deleteEvent(ev.id,ev.name)}>DELETE</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {tab==="create"&&<AdminCreateEvent showToast={showToast} onCreated={()=>{setTab("events");loadEvents();}}/>}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// ADMIN: CREATE EVENT
// ─────────────────────────────────────────────────────────────────
function AdminCreateEvent({ showToast, onCreated }) {
  const [form,setForm]=useState({name:"",date:"",city:"",organizer:""});
  const [categories,setCategories]=useState([]);
  const [customInput,setCustomInput]=useState("");
  const [judgeCounts,setJudgeCounts]=useState({});
  const [selectedRounds,setSelectedRounds]=useState(["Top 16","Top 8","Top 4","Finals"]);
  const [loading,setLoading]=useState(false);
  const [createdEvent,setCreatedEvent]=useState(null);
  const [copied,setCopied]=useState(null);

  const copy=(val)=>{navigator.clipboard?.writeText(val).catch(()=>{});setCopied(val);setTimeout(()=>setCopied(null),1500);};
  const addCategory=(cat)=>{const t=cat.trim();if(!t)return;if(categories.map(c=>c.toLowerCase()).includes(t.toLowerCase()))return showToast(`"${t}" already added!`,"error");setCategories(p=>[...p,t]);setCustomInput("");};
  const removeCategory=(cat)=>{setCategories(p=>p.filter(c=>c!==cat));setJudgeCounts(p=>{const n={...p};delete n[cat];return n;});setJudgeTypes(p=>{const n={...p};delete n[cat];return n;});};
  const toggleSuggested=(cat)=>categories.map(c=>c.toLowerCase()).includes(cat.toLowerCase())?removeCategory(cat):addCategory(cat);
  const toggleRound=(r)=>setSelectedRounds(p=>p.includes(r)?p.filter(x=>x!==r):[...p,r]);
  const orderedRounds=["Prelims",...ALL_POST_PRELIM_ROUNDS.filter(r=>selectedRounds.includes(r))];

  const submit=async()=>{
    if(!form.name.trim()||!form.date||!form.city.trim())return showToast("Fill event name, date and city!","error");
    if(categories.length===0)return showToast("Add at least one category!","error");
    if(selectedRounds.length===0)return showToast("Select at least one round after Prelims!","error");
    setLoading(true);
    const orgCode=genOrgCode(); const viewerCode=genViewerCode(); const prefix=randAlpha(3);
    const jCodes=genJudgeCodes(prefix,categories,judgeCounts);
    const{data:ev,error:evErr}=await supabase.from("events").insert({
      name:form.name.trim(),city:form.city.trim(),date:form.date,
      org_code:orgCode,viewer_code:viewerCode,categories,
      organizer_name:form.organizer.trim()||null,
      judge_counts:judgeCounts,rounds:orderedRounds
    }).select().single();
    if(evErr){showToast("Failed: "+evErr.message,"error");setLoading(false);return;}
    await supabase.from("judge_codes").insert(jCodes.map(j=>({event_id:ev.id,code:j.code,category:j.category,slot:j.slot})));
    const{data:fullCodes}=await supabase.from("judge_codes").select("*").eq("event_id",ev.id);
    setCreatedEvent({...ev,judgeCodes:fullCodes||[]});
    showToast(`Event "${ev.name}" created ✓`);setLoading(false);
  };

  if (createdEvent) {
    const codes=createdEvent.judgeCodes||[];
    return (
      <div className="slide">
        <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:12,color:"#00c853",letterSpacing:3,marginBottom:6}}>✓ EVENT CREATED</div>
        <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:26,letterSpacing:2,marginBottom:2}}>{createdEvent.name}</div>
        <div style={{fontFamily:"Barlow,sans-serif",fontSize:12,color:"#555",marginBottom:20}}>{createdEvent.city} · {createdEvent.date}</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:20}}>
          <div style={{background:"#0f0f0f",border:"1px solid #ff4d4d44",borderRadius:12,padding:20}}>
            <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#ff4d4d",letterSpacing:3,marginBottom:8}}>ORGANIZER CODE</div>
            <div style={{display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
              <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:28,letterSpacing:5,color:"#ff4d4d"}}>{createdEvent.org_code}</div>
              <button className="btn" style={{fontSize:10,padding:"6px 14px",background:"transparent",border:"1px solid #ff4d4d44",color:"#ff4d4d"}} onClick={()=>copy(createdEvent.org_code)}>{copied===createdEvent.org_code?"✓ COPIED":"COPY"}</button>
            </div>
          </div>
          <div style={{background:"#0f0f0f",border:"1px solid #00e5ff44",borderRadius:12,padding:20}}>
            <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#00e5ff",letterSpacing:3,marginBottom:8}}>VIEWER / PARTICIPANT CODE</div>
            <div style={{display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
              <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:22,letterSpacing:3,color:"#00e5ff"}}>{createdEvent.viewer_code}</div>
              <button className="btn" style={{fontSize:10,padding:"6px 14px",background:"transparent",border:"1px solid #00e5ff44",color:"#00e5ff"}} onClick={()=>copy(createdEvent.viewer_code)}>{copied===createdEvent.viewer_code?"✓ COPIED":"COPY"}</button>
            </div>
            <div style={{fontFamily:"Barlow,sans-serif",fontSize:9,color:"#444",marginTop:4}}>Share with participants & attendees for live view</div>
          </div>
        </div>
        <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#555",letterSpacing:3,marginBottom:14}}>JUDGE CODES</div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(260px,1fr))",gap:12,marginBottom:24}}>
          {(createdEvent.categories||[]).map((cat,ci)=>{
            const c=PALETTE[ci%PALETTE.length];
            const catCodes=codes.filter(j=>j.category===cat);
            return (
              <div key={cat} style={{background:"#0f0f0f",border:`1px solid ${c.border}`,borderRadius:10,padding:16}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                  <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:14,color:c.primary}}>{cat}</div>
                  <span style={{fontFamily:"Barlow,sans-serif",fontSize:9,padding:"2px 8px",borderRadius:20,background:"#ffd70011",border:"1px solid #ffd70044",color:"#ffd700"}}>PRELIMS: SCORE · KNOCKOUT: CHOICE</span>
                </div>
                {catCodes.map(j=>(
                  <div key={j.code} style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:7,padding:"7px 10px",background:"#151515",borderRadius:7}}>
                    <div><div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:13,letterSpacing:2}}>{j.code}</div><div style={{fontFamily:"Barlow,sans-serif",fontSize:9,color:"#555"}}>Judge {j.slot}</div></div>
                    <button className="btn" style={{fontSize:9,padding:"4px 9px",background:"transparent",border:`1px solid ${c.primary}`,color:c.primary}} onClick={()=>copy(j.code)}>{copied===j.code?"✓":"COPY"}</button>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
        <button className="btn" style={{background:"#111",color:"#fff",border:"1px solid #2a2a2a",fontSize:12}} onClick={()=>{setCreatedEvent(null);setForm({name:"",date:"",city:"",organizer:""});setCategories([]);setJudgeCounts({});setSelectedRounds(["Top 16","Top 8","Top 4","Finals"]);onCreated();}}>← BACK TO ALL EVENTS</button>
      </div>
    );
  }

  return (
    <div className="slide" style={{maxWidth:640}}>
      <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:22,letterSpacing:3,marginBottom:20}}>CREATE NEW EVENT</div>
      <div style={{marginBottom:14}}>
        <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#555",letterSpacing:2,marginBottom:6}}>ORGANIZER NAME <span style={{color:"#333"}}>(optional)</span></div>
        <input className="inp" placeholder="e.g. Rhythmix Crew" value={form.organizer} onChange={e=>setForm(f=>({...f,organizer:e.target.value}))}/>
      </div>
      {[["Event Name","name","text","e.g. Danbuzz Open 2025"],["City / Venue","city","text","e.g. Imphal, Manipur"],["Event Date","date","date",""]].map(([label,key,type,ph])=>(
        <div key={key} style={{marginBottom:14}}>
          <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#555",letterSpacing:2,marginBottom:6}}>{label}</div>
          <input className="inp" type={type} placeholder={ph} value={form[key]} onChange={e=>setForm(f=>({...f,[key]:e.target.value}))}/>
        </div>
      ))}

      {/* Rounds */}
      <div style={{margin:"20px 0 0"}}>
        <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#555",letterSpacing:2,marginBottom:6}}>KNOCKOUT ROUNDS AFTER PRELIMS <span style={{color:"#ff4d4d"}}>*</span></div>
        <div style={{fontFamily:"Barlow,sans-serif",fontSize:11,color:"#333",marginBottom:8}}>Prelims rank all dancers by score → top qualifiers enter knockout (1v1) battles:</div>
        <div style={{display:"flex",flexWrap:"wrap",gap:8,marginBottom:8}}>
          {ALL_POST_PRELIM_ROUNDS.map(r=>(
            <button key={r} className={`rchip${selectedRounds.includes(r)?" on":""}`} onClick={()=>toggleRound(r)}>{selectedRounds.includes(r)?"✓ ":"+ "}{r}</button>
          ))}
        </div>
        <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#444",marginBottom:14}}>
          Flow: <span style={{color:"#ffd700"}}>Prelims (scores) → {ALL_POST_PRELIM_ROUNDS.filter(r=>selectedRounds.includes(r)).join(" → ")||"—"} (1v1 battles)</span>
        </div>
      </div>

      {/* Categories */}
      <div>
        <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#555",letterSpacing:2,marginBottom:10}}>CATEGORIES <span style={{color:"#ff4d4d"}}>*</span></div>
        <div style={{display:"flex",flexWrap:"wrap",gap:8,marginBottom:12}}>
          {SUGGESTED_CATEGORIES.map(cat=>{const isAdded=categories.map(c=>c.toLowerCase()).includes(cat.toLowerCase());return <button key={cat} className={`chip${isAdded?" active":""}`} onClick={()=>toggleSuggested(cat)}>{isAdded?"✓ ":"+ "}{cat}</button>;})}
        </div>
        <div style={{display:"flex",gap:8,marginBottom:16}}>
          <input className="inp" placeholder="Custom category..." value={customInput} onChange={e=>setCustomInput(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"){e.preventDefault();addCategory(customInput);}}}/>
          <button className="btn" style={{background:"#1a1a1a",color:"#fff",border:"1px solid #2a2a2a",whiteSpace:"nowrap"}} onClick={()=>addCategory(customInput)}>+ ADD</button>
        </div>
        {categories.length>0&&(
          <div style={{background:"#0f0f0f",border:"1px solid #1e1e1e",borderRadius:12,padding:14,marginBottom:8}}>
            <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#555",letterSpacing:2,marginBottom:10}}>CATEGORIES — Judges per category & Prelim scoring type</div>
            <div style={{display:"flex",flexDirection:"column",gap:7}}>
              {categories.map((cat,i)=>{
                const c=PALETTE[i%PALETTE.length]; const count=judgeCounts[cat]||3;
                return (
                  <div key={cat} style={{background:c.bg,border:`1px solid ${c.border}`,borderRadius:8,padding:"10px 12px"}}>
                    <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
                      <span style={{fontFamily:"Bebas Neue,sans-serif",fontSize:13,color:c.primary,flex:1}}>{cat}</span>
                      <span style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#555"}}>Judges:</span>
                      <div style={{display:"flex",alignItems:"center",gap:4}}>
                        <button onClick={()=>setJudgeCounts(p=>({...p,[cat]:Math.max(1,(parseInt(p[cat])||3)-1)}))} style={{background:"#1a1a1a",border:"1px solid #333",color:"#aaa",borderRadius:4,width:24,height:24,cursor:"pointer",fontFamily:"Bebas Neue,sans-serif",fontSize:14}}>−</button>
                        <span style={{fontFamily:"Bebas Neue,sans-serif",fontSize:16,color:c.primary,minWidth:18,textAlign:"center"}}>{count}</span>
                        <button onClick={()=>setJudgeCounts(p=>({...p,[cat]:Math.min(10,(parseInt(p[cat])||3)+1)}))} style={{background:"#1a1a1a",border:"1px solid #333",color:"#aaa",borderRadius:4,width:24,height:24,cursor:"pointer",fontFamily:"Bebas Neue,sans-serif",fontSize:14}}>+</button>
                      </div>
                      <button onClick={()=>removeCategory(cat)} style={{background:"none",border:"none",color:"#555",cursor:"pointer",fontSize:14,padding:0}}>✕</button>
                    </div>
                    <div style={{fontFamily:"Barlow,sans-serif",fontSize:9,color:"#444",marginTop:6}}>Prelims: score-based ranking → Knockout: 1v1 judge choice</div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
      <button className="btn" style={{background:"#ff4d4d",color:"#000",width:"100%",marginTop:20,fontSize:14,padding:"13px"}} onClick={submit} disabled={loading||categories.length===0}>
        {loading?<Spinner/>:`CREATE EVENT WITH ${categories.length} CATEGOR${categories.length===1?"Y":"IES"} →`}
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// ORG LOGIN
// ─────────────────────────────────────────────────────────────────
function OrgLoginScreen({ onBack, onLogin, showToast }) {
  const [orgCode,setOrgCode]=useState(""); const [loading,setLoading]=useState(false);
  const handleSubmit=async()=>{
    if(!orgCode.trim())return showToast("Enter your organizer code!","error");
    setLoading(true);
    const{data,error}=await supabase.from("events").select("*").eq("org_code",orgCode.trim().toUpperCase()).single();
    if(error||!data){showToast("Invalid organizer code!","error");setLoading(false);return;}
    onLogin(data);setLoading(false);
  };
  return (
    <div style={{minHeight:"100vh",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:32,background:"#080808"}}>
      <div style={{width:"100%",maxWidth:360}}>
        <button className="btn" style={{background:"transparent",color:"#555",border:"none",padding:0,marginBottom:24,fontSize:12,letterSpacing:2}} onClick={onBack}>← BACK</button>
        <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:26,letterSpacing:3,marginBottom:4}}>ORGANIZER LOGIN</div>
        <div style={{fontFamily:"Barlow,sans-serif",fontSize:12,color:"#555",marginBottom:28}}>Enter the organizer code provided by DanBuzz admin.</div>
        <div style={{marginBottom:14}}>
          <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#555",letterSpacing:2,marginBottom:6}}>ORGANIZER CODE</div>
          <input className="inp" placeholder="e.g. ORG-XYZ-1234" value={orgCode} onChange={e=>setOrgCode(e.target.value.toUpperCase())} onKeyDown={e=>e.key==="Enter"&&handleSubmit()} style={{letterSpacing:3,fontFamily:"Bebas Neue,sans-serif",fontSize:20}}/>
        </div>
        <button className="btn" style={{background:"#ff4d4d",color:"#000",width:"100%",fontSize:14,padding:"13px"}} onClick={handleSubmit} disabled={loading}>{loading?<Spinner/>:"ENTER DASHBOARD →"}</button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// VIEWER LOGIN
// ─────────────────────────────────────────────────────────────────
function ViewerLoginScreen({ onBack, onLogin, showToast }) {
  const [viewerCode,setViewerCode]=useState(""); const [name,setName]=useState(""); const [city,setCity]=useState("");
  const [phone,setPhone]=useState(""); const [role,setRole]=useState("attendee"); const [category,setCategory]=useState("");
  const [loading,setLoading]=useState(false); const [event,setEvent]=useState(null);

  const lookupEvent=async()=>{
    if(!viewerCode.trim())return showToast("Enter event code!","error");
    setLoading(true);
    const{data,error}=await supabase.from("events").select("*").eq("viewer_code",viewerCode.trim().toUpperCase()).single();
    if(error||!data){showToast("Invalid event code!","error");setLoading(false);return;}
    setEvent(data);setLoading(false);
  };

  const handleRegister=async()=>{
    if(!name.trim()||!city.trim()||!phone.trim())return showToast("Fill in name, city and phone!","error");
    if(role==="participant"&&!category)return showToast("Select your category!","error");
    setLoading(true);
    const{error}=await supabase.from("attendees").insert({event_id:event.id,name:name.trim(),city:city.trim(),phone:phone.trim(),role,category:role==="participant"?category:null});
    if(error){showToast("Registration failed: "+error.message,"error");setLoading(false);return;}
    showToast("Registered! Loading live view...");
    onLogin({event,name:name.trim(),role});setLoading(false);
  };

  return (
    <div style={{minHeight:"100vh",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:32,background:"#080808"}}>
      <div style={{width:"100%",maxWidth:400}}>
        <button className="btn" style={{background:"transparent",color:"#555",border:"none",padding:0,marginBottom:24,fontSize:12,letterSpacing:2}} onClick={()=>{if(event)setEvent(null);else onBack();}}>← BACK</button>
        <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:26,letterSpacing:3,marginBottom:4}}>LIVE EVENT VIEW</div>
        <div style={{fontFamily:"Barlow,sans-serif",fontSize:12,color:"#555",marginBottom:28}}>{!event?"Enter your event code to see live updates.":"Register to track this event in real-time."}</div>
        {!event?(
          <>
            <div style={{marginBottom:14}}>
              <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#555",letterSpacing:2,marginBottom:6}}>EVENT CODE</div>
              <input className="inp" placeholder="e.g. VIEW-ABCD-1234" value={viewerCode} onChange={e=>setViewerCode(e.target.value.toUpperCase())} onKeyDown={e=>e.key==="Enter"&&lookupEvent()} style={{letterSpacing:2,fontFamily:"Bebas Neue,sans-serif",fontSize:18}}/>
            </div>
            <button className="btn" style={{background:"#00e5ff",color:"#000",width:"100%",fontSize:14,padding:"13px"}} onClick={lookupEvent} disabled={loading}>{loading?<Spinner/>:"FIND EVENT →"}</button>
          </>
        ):(
          <>
            <div style={{background:"#0d2222",border:"1px solid #00e5ff33",borderRadius:12,padding:"14px 18px",marginBottom:20}}>
              <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:20,letterSpacing:2,color:"#00e5ff"}}>{event.name}</div>
              <div style={{fontFamily:"Barlow,sans-serif",fontSize:11,color:"#555"}}>{event.city} · {event.date}</div>
            </div>
            <div style={{display:"flex",gap:8,marginBottom:16}}>
              {["participant","attendee"].map(r=>(
                <button key={r} onClick={()=>setRole(r)} style={{flex:1,fontFamily:"Barlow,sans-serif",fontSize:12,padding:"10px",borderRadius:8,border:`1px solid ${role===r?"#00e5ff":"#2a2a2a"}`,background:role===r?"#00e5ff22":"#151515",color:role===r?"#00e5ff":"#555",cursor:"pointer"}}>
                  {r==="participant"?"🏆 Participant":"👥 Attendee"}
                </button>
              ))}
            </div>
            {[["Name",name,setName,"text"],["City",city,setCity,"text"],["Phone",phone,setPhone,"tel"]].map(([label,val,setter,type])=>(
              <div key={label} style={{marginBottom:12}}>
                <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#555",letterSpacing:2,marginBottom:5}}>{label.toUpperCase()}</div>
                <input className="inp" type={type} placeholder={label} value={val} onChange={e=>setter(e.target.value)}/>
              </div>
            ))}
            {role==="participant"&&(
              <div style={{marginBottom:12}}>
                <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#555",letterSpacing:2,marginBottom:5}}>CATEGORY</div>
                <select className="inp" value={category} onChange={e=>setCategory(e.target.value)}>
                  <option value="">Select your category...</option>
                  {(event.categories||[]).map(cat=><option key={cat} value={cat}>{cat}</option>)}
                </select>
              </div>
            )}
            <button className="btn" style={{background:"#00e5ff",color:"#000",width:"100%",fontSize:14,padding:"13px",marginTop:8}} onClick={handleRegister} disabled={loading}>{loading?<Spinner/>:"REGISTER & VIEW LIVE →"}</button>
          </>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// JUDGE LOGIN
// ─────────────────────────────────────────────────────────────────
function JudgeLoginScreen({ onBack, onLogin, showToast }) {
  const [code,setCode]=useState(""); const [name,setName]=useState(""); const [loading,setLoading]=useState(false); const [peek,setPeek]=useState(null);
  const categories=peek?.events?.categories||[];
  const c=PALETTE[Math.max(0,categories.indexOf(peek?.category))%PALETTE.length];

  const doLogin=async()=>{
    if(!code.trim())return showToast("Enter your judge code!","error");
    if(!name.trim())return showToast("Enter your name!","error");
    setLoading(true);
    const upper=code.trim().toUpperCase();
    const{data:jc,error}=await supabase.from("judge_codes").select("*, events(*)").eq("code",upper).single();
    if(error||!jc){showToast("Invalid code.","error");setLoading(false);return;}
    if(!jc.used){
      const{error:ue}=await supabase.from("judge_codes").update({used:true,judge_name:name.trim()}).eq("code",upper);
      if(ue){showToast("Registration failed.","error");setLoading(false);return;}
      showToast(`Welcome, ${name.trim()}! Registered ✓`);
      onLogin({judgeCode:{...jc,used:true,judge_name:name.trim()},event:jc.events});
    } else {
      if(jc.judge_name.trim().toLowerCase()!==name.trim().toLowerCase()){showToast("Name doesn't match.","error");setLoading(false);return;}
      onLogin({judgeCode:jc,event:jc.events});
    }
    setLoading(false);
  };

  return (
    <div style={{minHeight:"100vh",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:32,background:"#080808"}}>
      <div style={{width:"100%",maxWidth:400}}>
        <button className="btn" style={{background:"transparent",color:"#555",border:"none",padding:0,marginBottom:24,fontSize:12,letterSpacing:2}} onClick={onBack}>← BACK</button>
        <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:26,letterSpacing:3,marginBottom:4}}>JUDGE LOGIN</div>
        <div style={{fontFamily:"Barlow,sans-serif",fontSize:12,color:"#555",marginBottom:28}}>Enter your judge code and name. First time? You'll be registered automatically.</div>
        <div style={{marginBottom:16}}>
          <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#555",letterSpacing:2,marginBottom:6}}>JUDGE CODE</div>
          <input className="inp" placeholder="Code from DanBuzz admin" value={code} onChange={e=>setCode(e.target.value.toUpperCase())} style={{letterSpacing:2,fontFamily:"Bebas Neue,sans-serif",fontSize:18}}/>
        </div>
        <div style={{marginBottom:20}}>
          <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#555",letterSpacing:2,marginBottom:6}}>YOUR NAME</div>
          <input className="inp" placeholder="Your full name" value={name} onChange={e=>setName(e.target.value)} onKeyDown={e=>e.key==="Enter"&&doLogin()}/>
        </div>
        <button className="btn" style={{background:"#ff4d4d",color:"#000",width:"100%",fontSize:14,padding:"13px"}} onClick={doLogin} disabled={loading}>{loading?<Spinner/>:"LOGIN →"}</button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// JUDGE DASHBOARD — spec-compliant elimination engine
// ─────────────────────────────────────────────────────────────────
function JudgeDashboard({ judgeCode, event, onBack, showToast }) {
  const categories = event.categories||[];
  const rounds     = event.rounds||["Prelims","Finals"];
  const myCategory = judgeCode.category;
  const myKey      = `${myCategory}-J${judgeCode.slot}`;
  const col        = getCatColor(categories, myCategory);

  const [tab,setTab]               = useState("scoring");
  const [currentRound,setCurrentRound] = useState(rounds[0]||"Prelims");
  const [scoreInputs,setScoreInputs]   = useState({});
  const [participants,setParticipants] = useState([]);
  const [scores,setScores]             = useState([]);
  const [battles,setBattles]           = useState([]);
  const [judgeCodes,setJudgeCodes]     = useState([]);
  const [loading,setLoading]           = useState(true);
  // UI state: per match_index, what the judge has selected but not yet submitted
  const [battleChoices,setBattleChoices] = useState({});

  const isPrelim = currentRound === "Prelims";

  const loadAll = async () => {
    setLoading(true);
    const [pRes,sRes,jcRes,bRes] = await Promise.all([
      supabase.from("participants").select("*").eq("event_id",event.id).eq("category",myCategory),
      supabase.from("scores").select("*").eq("event_id",event.id).eq("category",myCategory),
      supabase.from("judge_codes").select("*").eq("event_id",event.id).eq("category",myCategory),
      supabase.from("battle_decisions").select("*").eq("event_id",event.id).eq("category",myCategory),
    ]);
    if(pRes.data) setParticipants(pRes.data);
    if(sRes.data) setScores(sRes.data);
    if(jcRes.data) setJudgeCodes(jcRes.data);
    if(bRes.data) setBattles(bRes.data);
    setLoading(false);
  };

  useEffect(()=>{ loadAll(); },[event.id,myCategory]);

  useEffect(()=>{
    const pCh=supabase.channel(`jp-${event.id}-${myCategory}`)
      .on("postgres_changes",{event:"INSERT",schema:"public",table:"participants",filter:`event_id=eq.${event.id}`},(p)=>{if(p.new.category===myCategory)setParticipants(prev=>[...prev,p.new]);})
      .on("postgres_changes",{event:"UPDATE",schema:"public",table:"participants",filter:`event_id=eq.${event.id}`},(p)=>setParticipants(prev=>prev.map(x=>x.id===p.new.id?p.new:x)))
      .subscribe();
    const sCh=supabase.channel(`js-${event.id}-${myCategory}`)
      .on("postgres_changes",{event:"INSERT",schema:"public",table:"scores",filter:`event_id=eq.${event.id}`},(p)=>{if(p.new.category===myCategory)setScores(prev=>[...prev,p.new]);})
      .on("postgres_changes",{event:"UPDATE",schema:"public",table:"scores",filter:`event_id=eq.${event.id}`},(p)=>setScores(prev=>prev.map(s=>s.id===p.new.id?p.new:s)))
      .subscribe();
    const bCh=supabase.channel(`jb-${event.id}-${myCategory}`)
      .on("postgres_changes",{event:"INSERT",schema:"public",table:"battle_decisions",filter:`event_id=eq.${event.id}`},(p)=>{if(p.new.category===myCategory)setBattles(prev=>[...prev,p.new]);})
      .on("postgres_changes",{event:"UPDATE",schema:"public",table:"battle_decisions",filter:`event_id=eq.${event.id}`},(p)=>setBattles(prev=>prev.map(b=>b.id===p.new.id?p.new:b)))
      .subscribe();
    return ()=>{supabase.removeChannel(pCh);supabase.removeChannel(sCh);supabase.removeChannel(bCh);};
  },[event.id,myCategory]);

  // Derived
  const scoreMap = useMemo(()=>{
    const m = {};
    scores.forEach(s=>{ if(!m[s.participant_id])m[s.participant_id]={};m[s.participant_id][s.judge_key]=s.score; });
    return m;
  },[scores]);
  const getScore   = useCallback((pid)=>calcAvgScore(Object.values(scoreMap[pid]||{})),[scoreMap]);
  const getMyScore = useCallback((pid)=>scoreMap[pid]?.[myKey],[scoreMap,myKey]);
  const checkedIn  = useMemo(()=>participants.filter(p=>p.checked_in),[participants]);
  const prelimRanked = useMemo(()=>[...checkedIn].sort((a,b)=>getScore(b.id)-getScore(a.id)),[checkedIn,getScore]);

  // Build current round's battles from prelim ranking (Top vs Bottom seeding)
  const currentBattles = isPrelim ? [] : buildFirstRoundBattles(prelimRanked, currentRound);

  // Get my existing decision for a battle at the current active tie_round
  const getBattleDecisions = (mi) => battles.filter(b=>b.round===currentRound&&b.match_index===mi);
  const getMyDecision = (mi, tieRound) => battles.find(b=>b.round===currentRound&&b.match_index===mi&&b.judge_key===myKey&&(b.tie_round??0)===tieRound);

  const submitPrelimScore=async(pid)=>{
    const val=parseFloat(scoreInputs[pid]);
    if(isNaN(val)||val<1||val>10)return showToast("Score must be 1–10","error");
    // Try upsert first; if the unique constraint doesn't include category, fall back to update/insert
    const existing=scores.find(s=>s.participant_id===pid&&s.judge_key===myKey&&s.event_id===event.id);
    let error;
    if(existing){
      ({error}=await supabase.from("scores").update({score:val}).eq("id",existing.id));
    } else {
      ({error}=await supabase.from("scores").insert({participant_id:pid,event_id:event.id,category:myCategory,judge_key:myKey,score:val}));
    }
    if(error)return showToast("Score failed: "+error.message,"error");
    setScoreInputs(prev=>({...prev,[pid]:""}));
    showToast("Score submitted ✓");
  };

  const submitBattleDecision=async(battle, winnerId, isTie, tieRound)=>{
    // isTie can only be true in the FIRST battle of a matchup (tie_round 0)
    // After a tie, judges MUST pick a winner — no more ties allowed
    const winnerP = isTie ? null : [battle.p1,battle.p2].find(p=>p.id===winnerId);
    const{error}=await supabase.from("battle_decisions").upsert({
      event_id:event.id, category:myCategory, round:currentRound,
      match_index:battle.match_index,
      p1_id:battle.p1.id, p1_name:battle.p1.name,
      p2_id:battle.p2.id, p2_name:battle.p2.name,
      winner_id:isTie?null:winnerId,
      winner_name:isTie?null:winnerP?.name,
      is_tie:isTie,
      tie_round: tieRound,
      judge_key:myKey,
    },{onConflict:"event_id,category,round,match_index,tie_round,judge_key"});
    if(error)return showToast("Failed to submit: "+error.message,"error");
    showToast(isTie?"🤝 Tie declared — extra battle required":"🏆 Winner submitted ✓");
    setBattleChoices(prev=>({...prev,[`${battle.match_index}-${tieRound}`]:null}));
  };

  if(loading)return <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:"#080808"}}><Spinner/></div>;

  return (
    <div style={{fontFamily:"'Bebas Neue',Impact,sans-serif",background:"#080808",minHeight:"100vh",color:"#fff"}}>
      <div style={{padding:"22px 22px 0",maxWidth:900,margin:"0 auto"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:12,marginBottom:16}}>
          <div>
            <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:42,letterSpacing:5,lineHeight:1}}>{event.name}</div>
            <div style={{background:col.bg,border:`1px solid ${col.border}`,borderRadius:8,padding:"8px 14px",marginTop:8,display:"inline-flex",alignItems:"center",gap:10}}>
              <div className="pulse" style={{width:7,height:7,borderRadius:"50%",background:"#00c853"}}/>
              <div>
                <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:15,color:col.primary}}>{judgeCode.judge_name}</div>
                <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#555"}}>Judge {judgeCode.slot} · {myCategory} · {isPrelim?"Prelims (score each dancer)":"Knockout (choose winner per battle)"}</div>
              </div>
            </div>
          </div>
          <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
            <select className="inp" style={{width:"auto",padding:"7px 32px 7px 11px",fontSize:12}} value={currentRound} onChange={e=>setCurrentRound(e.target.value)}>
              {rounds.map(r=><option key={r}>{r}</option>)}
            </select>
            <button className="btn" style={{background:"transparent",color:"#555",border:"1px solid #222",fontSize:11}} onClick={onBack}>← LOGOUT</button>
          </div>
        </div>
        <div style={{display:"flex",borderBottom:"1px solid #1a1a1a",overflowX:"auto"}}>
          {[{key:"scoring",label:isPrelim?"PRELIM SCORING":"BATTLE JUDGING"},{key:"leaderboard",label:"LEADERBOARD"}].map(t=>(
            <button key={t.key} className="tbtn" style={{color:tab===t.key?col.primary:"#555",borderBottom:tab===t.key?`3px solid ${col.primary}`:"3px solid transparent"}} onClick={()=>setTab(t.key)}>{t.label}</button>
          ))}
        </div>
      </div>

      <div style={{padding:"20px 22px 40px",maxWidth:900,margin:"0 auto"}}>

        {/* ── PRELIM SCORING ── */}
        {tab==="scoring"&&isPrelim&&(
          <div className="slide">
            <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:18,letterSpacing:3,color:col.primary,marginBottom:4}}>PRELIMS · {myCategory} · SCORE EACH DANCER</div>
            <div style={{fontFamily:"Barlow,sans-serif",fontSize:12,color:"#555",marginBottom:6}}>
              Scoring as <span style={{color:col.primary}}>{judgeCode.judge_name}</span>. Give each dancer a score from 1–10 based on their solo performance.
            </div>
            <div style={{background:"#1a1a0a",border:"1px solid #ffd70033",borderRadius:8,padding:"8px 14px",marginBottom:18,fontFamily:"Barlow,sans-serif",fontSize:11,color:"#ffd700"}}>
              ⚡ Prelim scores are used only to create the seeding list. They do NOT carry into knockout rounds.
            </div>
            {checkedIn.length===0&&<div style={{textAlign:"center",padding:"48px",fontFamily:"Barlow,sans-serif",color:"#333"}}>No checked-in participants yet</div>}
            {checkedIn.map(p=>{
              const myScore=getMyScore(p.id);
              return (
                <div key={p.id} className="card" style={{display:"flex",alignItems:"center",gap:12,flexWrap:"wrap",border:myScore!==undefined?`1px solid ${col.border}`:"1px solid #1e1e1e"}}>
                  <div style={{flex:1,minWidth:110}}>
                    <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:16}}>{p.name}</div>
                    <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#555"}}>{p.city}</div>
                  </div>
                  {myScore!==undefined&&<span className="badge" style={{background:col.bg,color:col.primary,border:`1px solid ${col.border}`}}>MY SCORE: {myScore}</span>}
                  <div style={{display:"flex",gap:7,alignItems:"center"}}>
                    <input className="inp" type="number" min="1" max="10" step="0.5" placeholder="1–10" value={scoreInputs[p.id]||""} onChange={e=>setScoreInputs(prev=>({...prev,[p.id]:e.target.value}))} style={{width:72}}/>
                    <button className="btn" style={{background:col.primary,color:"#000",fontSize:11}} onClick={()=>submitPrelimScore(p.id)}>{myScore!==undefined?"UPDATE":"SUBMIT"}</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* ── KNOCKOUT BATTLE JUDGING ── */}
        {tab==="scoring"&&!isPrelim&&(
          <div className="slide">
            <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:18,letterSpacing:3,color:col.primary,marginBottom:4}}>{currentRound} BATTLES · {myCategory}</div>
            <div style={{fontFamily:"Barlow,sans-serif",fontSize:12,color:"#555",marginBottom:4}}>
              Each battle is 1v1. Choose the winner. If you cannot decide, declare a tie — the same two dancers battle again and you must pick a winner then.
            </div>
            <div style={{background:"#1a1a0a",border:"1px solid #ffd70033",borderRadius:8,padding:"8px 14px",marginBottom:20,fontFamily:"Barlow,sans-serif",fontSize:11,color:"#ffd700"}}>
              ⚡ Each battle is judged independently. Prelim scores have no influence here.
            </div>
            {currentBattles.length===0&&<div style={{textAlign:"center",padding:"48px",fontFamily:"Barlow,sans-serif",color:"#333"}}>No battles yet — prelim scores needed to seed matchups.</div>}
            {currentBattles.map(battle=>{
              const allDecs      = getBattleDecisions(battle.match_index);
              const resolved     = resolveBattle(allDecs);
              const activeTieRound = resolved.tie_round ?? 0;
              // If the battle is tied, next tie_round is activeTieRound + 1
              const currentTieRound = resolved.status === "tied" ? activeTieRound + 1 : activeTieRound;
              const myDec        = getMyDecision(battle.match_index, currentTieRound);
              const uiKey        = `${battle.match_index}-${currentTieRound}`;
              const uiChoice     = battleChoices[uiKey];
              const p1=battle.p1; const p2=battle.p2;
              const chosen    = uiChoice?.winner_id ?? myDec?.winner_id;
              const tieChosen = uiChoice?.is_tie ?? (!!myDec && myDec.is_tie);
              const isTieBreaker = currentTieRound > 0;
              const isDecided    = resolved.status === "decided";

              return (
                <div key={battle.match_index} className="battle-card" style={{opacity:isDecided?0.75:1}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 18px",background:"#0d0d0d",borderBottom:"1px solid #1a1a1a"}}>
                    <div>
                      <span style={{fontFamily:"Bebas Neue,sans-serif",fontSize:11,color:col.primary,letterSpacing:3}}>
                        BATTLE {battle.match_index+1} · SEED #{battle.match_index+1} vs #{ROUND_LIMIT[currentRound]-battle.match_index}
                      </span>
                      {isTieBreaker&&<span style={{fontFamily:"Barlow,sans-serif",fontSize:9,color:"#ffd700",marginLeft:10,letterSpacing:2}}>🔄 TIE-BREAKER ROUND {currentTieRound}</span>}
                    </div>
                    {isDecided&&<span className="badge" style={{background:"#00c85322",color:"#00c853",border:"1px solid #00c85344"}}>✓ DECIDED</span>}
                    {resolved.status==="tied"&&<span className="badge" style={{background:"#ffd70022",color:"#ffd700",border:"1px solid #ffd70044"}}>🤝 TIE — EXTRA BATTLE</span>}
                    {myDec&&!isDecided&&resolved.status!=="tied"&&<span className="badge" style={{background:"#00c85322",color:"#00c853",border:"1px solid #00c85344"}}>✓ VOTED</span>}
                  </div>

                  {isDecided?(
                    // Show winner/loser clearly
                    <div>
                      {[p1,p2].map(p=>{
                        const isW=resolved.winner_id===p.id;
                        return (
                          <div key={p.id} style={{display:"flex",alignItems:"center",gap:12,padding:"14px 18px",background:isW?"#0a1e0a":"#1a0a0a",borderBottom:"1px solid #1a1a1a",opacity:isW?1:0.4}}>
                            <div style={{flex:1}}><div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:20,color:isW?col.primary:"#fff"}}>{p.name}</div><div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#555"}}>{p.city}</div></div>
                            {isW&&<span style={{fontFamily:"Bebas Neue,sans-serif",fontSize:14,color:col.primary}}>🏆 WINNER</span>}
                          </div>
                        );
                      })}
                    </div>
                  ):(
                    // Active judging
                    <div>
                      {/* Fighter 1 */}
                      <div className={`fighter${chosen===p1.id&&!tieChosen?" selected":""}`} onClick={()=>setBattleChoices(prev=>({...prev,[uiKey]:{winner_id:p1.id,is_tie:false}}))}>
                        <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:10,color:"#444",minWidth:24}}>#{battle.match_index+1}</div>
                        <div style={{flex:1}}>
                          <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:20,color:chosen===p1.id&&!tieChosen?col.primary:"#fff"}}>{p1.name}</div>
                          <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#555"}}>{p1.city}</div>
                        </div>
                        {chosen===p1.id&&!tieChosen&&<span style={{fontFamily:"Bebas Neue,sans-serif",fontSize:12,color:col.primary,letterSpacing:2}}>✓ SELECTED</span>}
                      </div>
                      <div className="vs-bar">VS</div>
                      {/* Fighter 2 */}
                      <div className={`fighter${chosen===p2.id&&!tieChosen?" selected":""}`} onClick={()=>setBattleChoices(prev=>({...prev,[uiKey]:{winner_id:p2.id,is_tie:false}}))}>
                        <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:10,color:"#444",minWidth:24}}>#{ROUND_LIMIT[currentRound]-battle.match_index}</div>
                        <div style={{flex:1}}>
                          <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:20,color:chosen===p2.id&&!tieChosen?col.primary:"#fff"}}>{p2.name}</div>
                          <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#555"}}>{p2.city}</div>
                        </div>
                        {chosen===p2.id&&!tieChosen&&<span style={{fontFamily:"Bebas Neue,sans-serif",fontSize:12,color:col.primary,letterSpacing:2}}>✓ SELECTED</span>}
                      </div>

                      {/* Actions */}
                      <div style={{padding:"12px 18px",background:"#0a0a0a",display:"flex",gap:10,flexWrap:"wrap",alignItems:"center"}}>
                        {/* Tie only allowed in round 0, not in tie-breakers */}
                        {!isTieBreaker&&(
                          <button className="btn" style={{fontSize:11,background:tieChosen?"#ffd70022":"#1a1a1a",color:tieChosen?"#ffd700":"#555",border:`1px solid ${tieChosen?"#ffd700":"#333"}`}}
                            onClick={()=>setBattleChoices(prev=>({...prev,[uiKey]:{winner_id:null,is_tie:true}}))}>
                            🤝 {tieChosen?"✓ TIE SELECTED":"DECLARE TIE"}
                          </button>
                        )}
                        {isTieBreaker&&(
                          <span style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#ff9800"}}>⚠ Tie-breaker: you MUST pick a winner — no ties allowed</span>
                        )}
                        <button className="btn" style={{background:col.primary,color:"#000",fontSize:11}}
                          disabled={!uiChoice&&!myDec}
                          onClick={()=>{
                            const ch=uiChoice||{winner_id:chosen,is_tie:tieChosen};
                            if(!ch.is_tie&&!ch.winner_id)return showToast("Select a winner first!","error");
                            submitBattleDecision(battle,ch.winner_id,ch.is_tie,currentTieRound);
                          }}>
                          {myDec?"UPDATE →":"SUBMIT →"}
                        </button>
                        {tieChosen&&!isTieBreaker&&<span style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#888"}}>Both dancers battle again · you must pick a winner next round</span>}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* ── LEADERBOARD ── */}
        {tab==="leaderboard"&&(
          <div className="slide">
            <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:18,letterSpacing:3,color:col.primary,marginBottom:4}}>
              {isPrelim?"PRELIM RANKINGS · LIVE":"PRELIM SEEDS (for bracket seeding)"} · {myCategory}
            </div>
            <div style={{fontFamily:"Barlow,sans-serif",fontSize:11,color:"#555",marginBottom:4}}>
              {isPrelim?"Ranked by score. Top qualifiers advance to knockout battles.":"Seeding from prelims only. Knockout battles judged independently."}
            </div>
            <div style={{background:"#1a1a0a",border:"1px solid #ffd70022",borderRadius:8,padding:"8px 14px",marginBottom:16,fontFamily:"Barlow,sans-serif",fontSize:10,color:"#888"}}>
              Prelim scores are used only for seeding. They have no effect on knockout battle judging.
            </div>
            <div style={{background:"#0c0c0c",border:"1px solid #161616",borderRadius:12,overflow:"hidden"}}>
              {prelimRanked.map((p,i)=>(
                <div key={p.id} className="lrow">
                  <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:20,color:i<3?col.primary:"#222",minWidth:36}}>#{i+1}</div>
                  <div style={{flex:1}}>
                    <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:15}}>{p.name}</div>
                    <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#555"}}>{p.city}</div>
                  </div>
                  <div style={{background:"#1a1a1a",borderRadius:3,height:4,width:80,overflow:"hidden"}}>
                    <div style={{height:"100%",borderRadius:3,background:col.primary,width:`${getScore(p.id)}%`,transition:"width .6s"}}/>
                  </div>
                  <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:22,color:i<3?col.primary:"#fff",minWidth:40,textAlign:"right"}}>{getScore(p.id)||"—"}</div>
                </div>
              ))}
              {prelimRanked.length===0&&<div style={{padding:"40px",textAlign:"center",fontFamily:"Barlow,sans-serif",color:"#333"}}>No scored participants yet</div>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// ORGANIZER: Add Participant tab
// ─────────────────────────────────────────────────────────────────
function OrganizerTab({ activeCat, catSorted, col, onAdd, getScore }) {
  const [form,setForm]=useState({name:"",city:"",phone:""});
  const [loading,setLoading]=useState(false);
  const submit=async()=>{setLoading(true);await onAdd({...form,category:activeCat});setForm({name:"",city:"",phone:""});setLoading(false);};
  return (
    <div className="slide">
      <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:18,letterSpacing:3,color:col.primary,marginBottom:12}}>ADD PARTICIPANT · {activeCat}</div>
      <div className="card" style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr auto",gap:10,alignItems:"end"}}>
        {[["Dancer Name","name"],["City","city"],["Phone","phone"]].map(([label,key])=>(
          <div key={key}>
            <div style={{fontFamily:"Barlow,sans-serif",fontSize:9,color:"#555",letterSpacing:2,marginBottom:5}}>{label.toUpperCase()}</div>
            <input className="inp" placeholder={label} value={form[key]} onChange={e=>setForm(f=>({...f,[key]:e.target.value}))} onKeyDown={e=>e.key==="Enter"&&submit()}/>
          </div>
        ))}
        <button className="btn" style={{background:col.primary,color:"#000"}} onClick={submit} disabled={loading}>{loading?<Spinner/>:"+ ADD"}</button>
      </div>
      <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#444",letterSpacing:2,marginBottom:10}}>{catSorted.length} PARTICIPANTS</div>
      {catSorted.map((p,i)=>(
        <div key={p.id} className="lrow" style={{borderRadius:10,marginBottom:5,background:"#0c0c0c",border:"1px solid #161616"}}>
          <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:20,color:i<3?col.primary:"#222",minWidth:36}}>#{i+1}</div>
          <div style={{flex:1}}>
            <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:15}}>{p.name}</div>
            <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#555"}}>{p.city}{p.phone?` · ${p.phone}`:""}</div>
          </div>
          <span className="badge" style={{background:p.checked_in?"#00c85322":"#ff4d4d22",color:p.checked_in?"#00c853":"#ff4d4d"}}>{p.checked_in?"✓ IN":"PENDING"}</span>
          <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:20,color:col.primary,minWidth:40,textAlign:"right"}}>{getScore(p.id)||"—"}</div>
        </div>
      ))}
      {catSorted.length===0&&<div style={{textAlign:"center",padding:"48px",fontFamily:"Barlow,sans-serif",color:"#333",fontSize:13}}>No {activeCat} participants yet — add one above ↑</div>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// ORGANIZER: Attendee tab
// ─────────────────────────────────────────────────────────────────
function AttendeeTab({ event, col, showToast }) {
  const [form,setForm]=useState({name:"",city:"",phone:"",role:"attendee",category:""});
  const [attendees,setAttendees]=useState([]);
  const [loading,setLoading]=useState(false); const [listLoading,setListLoading]=useState(true);
  const load=async()=>{setListLoading(true);const{data}=await supabase.from("attendees").select("*").eq("event_id",event.id);setAttendees(data||[]);setListLoading(false);};
  useEffect(()=>{load();},[event.id]);
  const submit=async()=>{
    if(!form.name.trim()||!form.city.trim()||!form.phone.trim())return showToast("Fill name, city and phone!","error");
    if(form.role==="participant"&&!form.category)return showToast("Select a category!","error");
    setLoading(true);
    const{error}=await supabase.from("attendees").insert({event_id:event.id,name:form.name.trim(),city:form.city.trim(),phone:form.phone.trim(),role:form.role,category:form.role==="participant"?form.category:null});
    if(error){showToast("Failed: "+error.message,"error");setLoading(false);return;}
    showToast(`${form.name} registered as ${form.role} ✓`);
    setForm({name:"",city:"",phone:"",role:"attendee",category:""});setLoading(false);load();
  };
  const parts=attendees.filter(a=>a.role==="participant"); const viewers=attendees.filter(a=>a.role==="attendee");
  return (
    <div className="slide">
      <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:18,letterSpacing:3,color:col.primary,marginBottom:12}}>REGISTER ATTENDEE / PARTICIPANT</div>
      <div className="card">
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10}}>
          {[["Name","name"],["City","city"],["Phone","phone"]].map(([label,key])=>(
            <div key={key}>
              <div style={{fontFamily:"Barlow,sans-serif",fontSize:9,color:"#555",letterSpacing:2,marginBottom:5}}>{label.toUpperCase()}</div>
              <input className="inp" placeholder={label} value={form[key]} onChange={e=>setForm(f=>({...f,[key]:e.target.value}))}/>
            </div>
          ))}
          <div>
            <div style={{fontFamily:"Barlow,sans-serif",fontSize:9,color:"#555",letterSpacing:2,marginBottom:5}}>TYPE</div>
            <select className="inp" value={form.role} onChange={e=>setForm(f=>({...f,role:e.target.value,category:""}))}>
              <option value="attendee">Attendee (Viewer)</option>
              <option value="participant">Participant</option>
            </select>
          </div>
          {form.role==="participant"&&(
            <div>
              <div style={{fontFamily:"Barlow,sans-serif",fontSize:9,color:"#555",letterSpacing:2,marginBottom:5}}>CATEGORY</div>
              <select className="inp" value={form.category} onChange={e=>setForm(f=>({...f,category:e.target.value}))}>
                <option value="">Select category...</option>
                {(event.categories||[]).map(cat=><option key={cat} value={cat}>{cat}</option>)}
              </select>
            </div>
          )}
        </div>
        <button className="btn" style={{background:col.primary,color:"#000",width:"100%",marginTop:4}} onClick={submit} disabled={loading}>{loading?<Spinner/>:`+ REGISTER ${form.role.toUpperCase()}`}</button>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,marginTop:8}}>
        <div>
          <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:14,letterSpacing:3,color:col.primary,marginBottom:8}}>PARTICIPANTS ({parts.length})</div>
          {listLoading?<Spinner/>:parts.map(a=>(
            <div key={a.id} className="lrow" style={{borderRadius:8,background:"#0c0c0c",border:"1px solid #161616",marginBottom:5}}>
              <div style={{flex:1}}>
                <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:14}}>{a.name}</div>
                <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#555"}}>{a.city} · {a.category}</div>
              </div>
              <span className="badge" style={{background:"#00c85322",color:"#00c853",border:"1px solid #00c85344",fontSize:9}}>PARTICIPANT</span>
            </div>
          ))}
          {parts.length===0&&!listLoading&&<div style={{fontFamily:"Barlow,sans-serif",color:"#333",fontSize:12,padding:"20px 0"}}>None yet</div>}
        </div>
        <div>
          <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:14,letterSpacing:3,color:"#00e5ff",marginBottom:8}}>ATTENDEES ({viewers.length})</div>
          {listLoading?<Spinner/>:viewers.map(a=>(
            <div key={a.id} className="lrow" style={{borderRadius:8,background:"#0c0c0c",border:"1px solid #161616",marginBottom:5}}>
              <div style={{flex:1}}>
                <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:14}}>{a.name}</div>
                <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#555"}}>{a.city}</div>
              </div>
              <span className="badge" style={{background:"#00e5ff22",color:"#00e5ff",border:"1px solid #00e5ff44",fontSize:9}}>ATTENDEE</span>
            </div>
          ))}
          {viewers.length===0&&!listLoading&&<div style={{fontFamily:"Barlow,sans-serif",color:"#333",fontSize:12,padding:"20px 0"}}>None yet</div>}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// ORGANIZER: Bracket view — reads battle_decisions, shows majority winner
// ─────────────────────────────────────────────────────────────────
function BracketTab({ event, activeCat, col, prelimRanked, showToast }) {
  const rounds = (event.rounds||[]).filter(r=>r!=="Prelims");

  const [battles,setBattles] = useState([]);
  const [loading,setLoading] = useState(true);

  useEffect(()=>{
    const load=async()=>{
      setLoading(true);
      const{data}=await supabase.from("battle_decisions").select("*").eq("event_id",event.id).eq("category",activeCat);
      setBattles(data||[]);setLoading(false);
    };
    load();
    const ch=supabase.channel(`brk-${event.id}-${activeCat}`)
      .on("postgres_changes",{event:"INSERT",schema:"public",table:"battle_decisions",filter:`event_id=eq.${event.id}`},(p)=>{if(p.new.category===activeCat)setBattles(prev=>[...prev,p.new]);})
      .on("postgres_changes",{event:"UPDATE",schema:"public",table:"battle_decisions",filter:`event_id=eq.${event.id}`},(p)=>setBattles(prev=>prev.map(b=>b.id===p.new.id?p.new:b)))
      .subscribe();
    return ()=>supabase.removeChannel(ch);
  },[event.id,activeCat]);

  return (
    <div className="slide">
      <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:18,letterSpacing:3,color:col.primary,marginBottom:4}}>BRACKET · {activeCat}</div>
      <div style={{fontFamily:"Barlow,sans-serif",fontSize:11,color:"#444",marginBottom:4}}>Top vs Bottom seeding from prelims. Each round judged independently.</div>
      <div style={{background:"#1a1a0a",border:"1px solid #ffd70022",borderRadius:8,padding:"8px 14px",marginBottom:20,fontFamily:"Barlow,sans-serif",fontSize:10,color:"#888"}}>
        Prelim scores only determine seeding. They have no effect on knockout battle outcomes.
      </div>
      {loading?<Spinner/>:(
        <div style={{display:"flex",gap:24,overflowX:"auto",paddingBottom:20}}>
          {rounds.map(roundName=>{
            const roundBattles = buildFirstRoundBattles(prelimRanked, roundName);
            return (
              <div key={roundName} style={{display:"flex",flexDirection:"column",gap:14,minWidth:220}}>
                <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:13,letterSpacing:3,color:col.primary,textAlign:"center",marginBottom:4}}>{roundName}</div>
                {roundBattles.map(battle=>{
                  const decs   = battles.filter(b=>b.round===roundName&&b.match_index===battle.match_index);
                  const result = resolveBattle(decs);
                  const judgeCount = [...new Set(decs.filter(d=>(d.tie_round??0)===result.tie_round).map(d=>d.judge_key))].length;
                  const isTied = result.status === "tied";
                  const isDecided = result.status === "decided";
                  return (
                    <div key={battle.match_index} style={{background:"#111",border:`1px solid ${isDecided?col.border:isTied?"#ffd70044":"#1e1e1e"}`,borderRadius:10,overflow:"hidden"}}>
                      {[battle.p1,battle.p2].map((p,fi)=>{
                        const isWinner = isDecided && result.winner_id===p.id;
                        const isLoser  = isDecided && result.winner_id!==p.id;
                        return (
                          <div key={p.id} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 14px",background:isWinner?"#0a1e0a":isLoser?"#1a0a0a":"#0f0f0f",borderBottom:fi===0?"1px solid #1a1a1a":"none",opacity:isLoser?0.45:1}}>
                            <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:10,color:"#444",minWidth:20}}>#{fi===0?battle.match_index+1:ROUND_LIMIT[roundName]-battle.match_index}</div>
                            <div style={{flex:1}}>
                              <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:14,color:isWinner?col.primary:"#fff"}}>{p.name}</div>
                              <div style={{fontFamily:"Barlow,sans-serif",fontSize:9,color:"#555"}}>{p.city}</div>
                            </div>
                            {isWinner&&<span style={{fontFamily:"Bebas Neue,sans-serif",fontSize:10,color:col.primary,letterSpacing:1}}>🏆 WIN</span>}
                          </div>
                        );
                      })}
                      <div style={{padding:"5px 14px",background:"#0a0a0a",fontFamily:"Barlow,sans-serif",fontSize:9,color: isTied?"#ffd700":isDecided?"#00c853":"#444"}}>
                        {isTied?`🤝 TIE × ${result.tie_round+1} — extra battle needed`:isDecided?`🏆 ${result.winner_name} advances`:`${judgeCount} judge${judgeCount!==1?"s":""} voted`}
                      </div>
                    </div>
                  );
                })}
                {roundBattles.length===0&&<div style={{fontFamily:"Barlow,sans-serif",color:"#333",fontSize:11,textAlign:"center",padding:"20px 0"}}>Need prelim scores to seed</div>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// VIEWER DASHBOARD
// ─────────────────────────────────────────────────────────────────
function ViewerDashboard({ event, viewerName, onBack }) {
  const categories = event.categories||[];
  const rounds     = event.rounds||["Prelims","Finals"];
  const [activeCat,setActiveCat]=useState(categories[0]||"");
  const [currentRound,setCurrentRound]=useState(rounds[0]||"Prelims");
  const col=getCatColor(categories,activeCat);
  const isPrelim=currentRound==="Prelims";

  const [participants,setParticipants]=useState([]);
  const [scores,setScores]=useState([]);
  const [battles,setBattles]=useState([]);
  const [loading,setLoading]=useState(true);

  useEffect(()=>{
    const load=async()=>{
      setLoading(true);
      const[pRes,sRes,bRes]=await Promise.all([
        supabase.from("participants").select("*").eq("event_id",event.id),
        supabase.from("scores").select("*").eq("event_id",event.id),
        supabase.from("battle_decisions").select("*").eq("event_id",event.id),
      ]);
      if(pRes.data)setParticipants(pRes.data);
      if(sRes.data)setScores(sRes.data);
      if(bRes.data)setBattles(bRes.data);
      setLoading(false);
    };
    load();
    const pCh=supabase.channel(`vp-${event.id}`).on("postgres_changes",{event:"INSERT",schema:"public",table:"participants",filter:`event_id=eq.${event.id}`},(p)=>setParticipants(prev=>[...prev,p.new])).on("postgres_changes",{event:"UPDATE",schema:"public",table:"participants",filter:`event_id=eq.${event.id}`},(p)=>setParticipants(prev=>prev.map(x=>x.id===p.new.id?p.new:x))).subscribe();
    const sCh=supabase.channel(`vs-${event.id}`).on("postgres_changes",{event:"INSERT",schema:"public",table:"scores",filter:`event_id=eq.${event.id}`},(p)=>setScores(prev=>[...prev,p.new])).on("postgres_changes",{event:"UPDATE",schema:"public",table:"scores",filter:`event_id=eq.${event.id}`},(p)=>setScores(prev=>prev.map(s=>s.id===p.new.id?p.new:s))).subscribe();
    const bCh=supabase.channel(`vb-${event.id}`).on("postgres_changes",{event:"INSERT",schema:"public",table:"battle_decisions",filter:`event_id=eq.${event.id}`},(p)=>setBattles(prev=>[...prev,p.new])).on("postgres_changes",{event:"UPDATE",schema:"public",table:"battle_decisions",filter:`event_id=eq.${event.id}`},(p)=>setBattles(prev=>prev.map(b=>b.id===p.new.id?p.new:b))).subscribe();
    return ()=>{supabase.removeChannel(pCh);supabase.removeChannel(sCh);supabase.removeChannel(bCh);};
  },[event.id]);

  const scoreMap={};
  scores.forEach(s=>{if(!scoreMap[s.participant_id])scoreMap[s.participant_id]={};scoreMap[s.participant_id][s.judge_key]=s.score;});
  const getScore=(pid)=>calcAvgScore(Object.values(scoreMap[pid]||{}));
  const checkedIn=participants.filter(p=>p.category===activeCat&&p.checked_in);
  const prelimRanked=[...checkedIn].sort((a,b)=>getScore(b.id)-getScore(a.id));
  const currentBattles=isPrelim?[]:buildFirstRoundBattles(prelimRanked,currentRound);

  if(loading)return <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:"#080808"}}><Spinner/></div>;

  return (
    <div style={{fontFamily:"'Bebas Neue',Impact,sans-serif",background:"#080808",minHeight:"100vh",color:"#fff"}}>
      <div style={{padding:"22px 22px 0",maxWidth:900,margin:"0 auto"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:12,marginBottom:16}}>
          <div>
            <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:48,letterSpacing:5,lineHeight:1}}>{event.name}</div>
            <div style={{fontFamily:"Barlow,sans-serif",fontSize:11,color:col.primary,letterSpacing:4,marginTop:2}}>{event.city} · {event.date}</div>
            <div style={{display:"flex",alignItems:"center",gap:6,marginTop:6}}>
              <div className="pulse" style={{width:7,height:7,borderRadius:"50%",background:"#00c853"}}/>
              <span style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#444",letterSpacing:2}}>LIVE · Viewing as {viewerName}</span>
            </div>
          </div>
          <div style={{display:"flex",gap:8,alignItems:"center"}}>
            <select className="inp" style={{width:"auto",padding:"7px 32px 7px 11px",fontSize:12}} value={currentRound} onChange={e=>setCurrentRound(e.target.value)}>
              {rounds.map(r=><option key={r}>{r}</option>)}
            </select>
            <button className="btn" style={{background:"transparent",color:"#555",border:"1px solid #222",fontSize:11}} onClick={onBack}>← EXIT</button>
          </div>
        </div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:0}}>
          {categories.map(cat=>{const c=getCatColor(categories,cat);const cnt=participants.filter(p=>p.category===cat&&p.checked_in).length;const active=activeCat===cat;return <button key={cat} className="btn" style={{fontSize:11,padding:"7px 14px",background:active?c.primary:"#111",color:active?"#000":"#555",border:`1px solid ${active?c.primary:"#222"}`}} onClick={()=>setActiveCat(cat)}>{cat} <span style={{opacity:.7}}>({cnt})</span></button>;})}
        </div>
      </div>

      <div style={{padding:"20px 22px 40px",maxWidth:900,margin:"0 auto"}}>
        <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:18,letterSpacing:3,color:col.primary,marginBottom:16}}>{currentRound} · {activeCat}</div>

        {isPrelim?(
          // Prelim: ranked leaderboard
          <div style={{background:"#0c0c0c",border:"1px solid #161616",borderRadius:12,overflow:"hidden"}}>
            {prelimRanked.map((p,i)=>(
              <div key={p.id} className="lrow">
                <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:20,color:i<3?col.primary:"#222",minWidth:36}}>#{i+1}</div>
                <div style={{flex:1}}><div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:15}}>{p.name}</div><div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#555"}}>{p.city}</div></div>
                <div style={{background:"#1a1a1a",borderRadius:3,height:4,width:80,overflow:"hidden"}}><div style={{height:"100%",borderRadius:3,background:col.primary,width:`${getScore(p.id)}%`,transition:"width .6s"}}/></div>
                <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:22,color:i<3?col.primary:"#fff",minWidth:40,textAlign:"right"}}>{getScore(p.id)||"—"}</div>
              </div>
            ))}
            {prelimRanked.length===0&&<div style={{padding:"40px",textAlign:"center",fontFamily:"Barlow,sans-serif",color:"#333"}}>Prelims in progress…</div>}
          </div>
        ):(
          // Knockout: show battles with results
          <div style={{display:"flex",flexDirection:"column",gap:14}}>
            {currentBattles.map(battle=>{
              const decs=battles.filter(b=>b.round===currentRound&&b.match_index===battle.match_index&&b.category===activeCat);
              const result=resolveBattle(decs);
              const p1=battle.p1; const p2=battle.p2;
              const isDecided=result.status==="decided";
              const isTied=result.status==="tied";
              return (
                <div key={battle.match_index} className="battle-card">
                  <div style={{padding:"8px 18px",background:"#0a0a0a",fontFamily:"Bebas Neue,sans-serif",fontSize:11,color:col.primary,letterSpacing:3,borderBottom:"1px solid #1a1a1a"}}>
                    BATTLE {battle.match_index+1} · SEED #{battle.match_index+1} vs #{ROUND_LIMIT[currentRound]-battle.match_index}
                    {isDecided&&<span style={{color:"#00c853",marginLeft:12}}>✓ DECIDED</span>}
                    {isTied&&<span style={{color:"#ffd700",marginLeft:12}}>🤝 TIE — EXTRA BATTLE × {result.tie_round+1}</span>}
                  </div>
                  {[p1,p2].map((p,fi)=>{
                    const isWinner=isDecided&&result.winner_id===p.id;
                    const isLoser=isDecided&&result.winner_id!==p.id;
                    return (
                      <div key={p.id} style={{display:"flex",alignItems:"center",gap:12,padding:"14px 18px",background:isWinner?"#0a1e0a":isLoser?"#1a0a0a":"#0f0f0f",borderBottom:fi===0?"1px solid #1a1a1a":"none",opacity:isLoser?0.45:1}}>
                        <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:10,color:"#444",minWidth:24}}>#{fi===0?battle.match_index+1:ROUND_LIMIT[currentRound]-battle.match_index}</div>
                        <div style={{flex:1}}><div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:20,color:isWinner?col.primary:"#fff"}}>{p.name}</div><div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#555"}}>{p.city}</div></div>
                        {isWinner&&<span style={{fontFamily:"Bebas Neue,sans-serif",fontSize:14,color:col.primary,letterSpacing:2}}>🏆 WINNER → ADVANCES</span>}
                      </div>
                    );
                  })}
                  {result.status==="pending"&&<div style={{padding:"8px 18px",background:"#080808",fontFamily:"Barlow,sans-serif",fontSize:10,color:"#444"}}>Judges deciding…</div>}
                  {isTied&&<div style={{padding:"8px 18px",background:"#1a1500",fontFamily:"Barlow,sans-serif",fontSize:10,color:"#ffd700"}}>🔄 Same two dancers battle again — judges must pick a winner</div>}
                </div>
              );
            })}
            {currentBattles.length===0&&<div style={{textAlign:"center",padding:"48px",fontFamily:"Barlow,sans-serif",color:"#333"}}>Waiting for prelim scores to set battle seeding…</div>}
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// ORGANIZER DASHBOARD
// ─────────────────────────────────────────────────────────────────
function Dashboard({ event, onBack, showToast }) {
  const categories = event.categories||[];
  const rounds     = event.rounds||["Prelims","Top 8","Top 4","Finals"];
  const [tab,setTab]=useState("organizer");
  const [activeCat,setActiveCat]=useState(categories[0]||"");
  const [currentRound,setCurrentRound]=useState(rounds[0]||"Prelims");
  const [searchQr,setSearchQr]=useState(""); const [showQrFor,setShowQrFor]=useState(null);
  const [overlayActive,setOverlayActive]=useState(false); const [showConfirm,setShowConfirm]=useState(false);

  const [judgeCodes,setJudgeCodes]=useState([]);
  const [participants,setParticipants]=useState([]);
  const [scores,setScores]=useState([]);
  const [battles,setBattles]=useState([]);
  const [attendees,setAttendees]=useState([]);
  const [loading,setLoading]=useState(true);

  useEffect(()=>{
    const load=async()=>{
      setLoading(true);
      const[jcRes,pRes,sRes,bRes,aRes]=await Promise.all([
        supabase.from("judge_codes").select("*").eq("event_id",event.id),
        supabase.from("participants").select("*").eq("event_id",event.id),
        supabase.from("scores").select("*").eq("event_id",event.id),
        supabase.from("battle_decisions").select("*").eq("event_id",event.id),
        supabase.from("attendees").select("*").eq("event_id",event.id),
      ]);
      if(jcRes.data)setJudgeCodes(jcRes.data);
      if(pRes.data)setParticipants(pRes.data);
      if(sRes.data)setScores(sRes.data);
      if(bRes.data)setBattles(bRes.data);
      if(aRes.data)setAttendees(aRes.data);
      setLoading(false);
    };
    load();
  },[event.id]);

  useEffect(()=>{
    const jcCh=supabase.channel(`jc-${event.id}`).on("postgres_changes",{event:"UPDATE",schema:"public",table:"judge_codes",filter:`event_id=eq.${event.id}`},(p)=>setJudgeCodes(prev=>prev.map(j=>j.id===p.new.id?p.new:j))).subscribe();
    const pCh=supabase.channel(`p-${event.id}`).on("postgres_changes",{event:"INSERT",schema:"public",table:"participants",filter:`event_id=eq.${event.id}`},(p)=>setParticipants(prev=>[...prev,p.new])).on("postgres_changes",{event:"UPDATE",schema:"public",table:"participants",filter:`event_id=eq.${event.id}`},(p)=>setParticipants(prev=>prev.map(x=>x.id===p.new.id?p.new:x))).on("postgres_changes",{event:"DELETE",schema:"public",table:"participants",filter:`event_id=eq.${event.id}`},(p)=>setParticipants(prev=>prev.filter(x=>x.id!==p.old.id))).subscribe();
    const sCh=supabase.channel(`s-${event.id}`).on("postgres_changes",{event:"INSERT",schema:"public",table:"scores",filter:`event_id=eq.${event.id}`},(p)=>setScores(prev=>[...prev,p.new])).on("postgres_changes",{event:"UPDATE",schema:"public",table:"scores",filter:`event_id=eq.${event.id}`},(p)=>setScores(prev=>prev.map(s=>s.id===p.new.id?p.new:s))).subscribe();
    const bCh=supabase.channel(`b-${event.id}`).on("postgres_changes",{event:"INSERT",schema:"public",table:"battle_decisions",filter:`event_id=eq.${event.id}`},(p)=>setBattles(prev=>[...prev,p.new])).on("postgres_changes",{event:"UPDATE",schema:"public",table:"battle_decisions",filter:`event_id=eq.${event.id}`},(p)=>setBattles(prev=>prev.map(b=>b.id===p.new.id?p.new:b))).subscribe();
    return()=>{supabase.removeChannel(jcCh);supabase.removeChannel(pCh);supabase.removeChannel(sCh);supabase.removeChannel(bCh);};
  },[event.id]);

  const col=getCatColor(categories,activeCat);
  const catJudges=useMemo(()=>judgeCodes.filter(j=>j.category===activeCat&&j.used),[judgeCodes,activeCat]);
  const catParts=useMemo(()=>participants.filter(p=>p.category===activeCat),[participants,activeCat]);
  const scoreMap=useMemo(()=>{
    const m={};
    scores.forEach(s=>{if(!m[s.participant_id])m[s.participant_id]={};m[s.participant_id][s.judge_key]=s.score;});
    return m;
  },[scores]);
  const getScore=useCallback((pid)=>calcAvgScore(Object.values(scoreMap[pid]||{})),[scoreMap]);
  const catSorted=useMemo(()=>[...catParts].sort((a,b)=>getScore(b.id)-getScore(a.id)),[catParts,getScore]);
  const regJudges=useMemo(()=>judgeCodes.filter(j=>j.used),[judgeCodes]);
  const biasAlerts=useMemo(()=>catParts.flatMap(p=>detectBias(scoreMap[p.id]||{}).map(f=>({...f,participant:p.name}))),[catParts,scoreMap]);
  const totalBias=useMemo(()=>participants.flatMap(p=>detectBias(scoreMap[p.id]||{})).length,[participants,scoreMap]);
  const checkedIn=useMemo(()=>catParts.filter(p=>p.checked_in),[catParts]);
  const prelimRanked=useMemo(()=>[...checkedIn].sort((a,b)=>getScore(b.id)-getScore(a.id)),[checkedIn,getScore]);

  const addParticipant=useCallback(async(form)=>{
    if(!form.name.trim()||!form.city.trim())return showToast("Fill name and city!","error");
    const{error}=await supabase.from("participants").insert({event_id:event.id,name:form.name.trim(),city:form.city.trim(),phone:form.phone?.trim()||null,category:activeCat});
    if(error)return showToast("Failed: "+error.message,"error");
    showToast(`${form.name} added to ${activeCat}!`);
  },[activeCat,event.id,showToast]);
  const checkIn=useCallback(async(id)=>{const{error}=await supabase.from("participants").update({checked_in:true}).eq("id",id);if(error)return showToast("Check-in failed!","error");showToast("Dancer checked in ✓");},[showToast]);
  const endEvent=async()=>{const{error}=await supabase.from("events").delete().eq("id",event.id);if(error)return showToast("Failed!","error");onBack();};

  const exportCSV=()=>{
    // Section 1: Competition Participants with scores
    const rows=[["=== COMPETITION PARTICIPANTS ==="],
      ["Category","Name","City","Phone","Checked In","Prelim Score",...rounds.filter(r=>r!=="Prelims").map(r=>`${r} Result`)]];
    participants.forEach(p=>{
      const prelimScore=getScore(p.id)||"";
      const roundResults=rounds.filter(r=>r!=="Prelims").map(r=>{
        const bds=battles.filter(b=>b.category===p.category&&b.round===r&&(b.p1_id===p.id||b.p2_id===p.id));
        if(!bds.length)return "";
        const mi=bds[0].match_index;
        const allDecs=battles.filter(b=>b.category===p.category&&b.round===r&&b.match_index===mi);
        const result=resolveBattle(allDecs);
        if(!result)return "pending";
        if(result.is_tie)return "tie";
        return result.winner_id===p.id?"WIN":"LOSS";
      });
      rows.push([p.category,p.name,p.city,p.phone||"",p.checked_in?"Yes":"No",prelimScore,...roundResults]);
    });

    // Section 2: Attendees / Viewers
    rows.push([],["=== ATTENDEES & VIEWERS ==="],["Type","Name","City","Phone","Category"]);
    attendees.forEach(a=>{
      rows.push([a.role==="participant"?"Registered Participant":"Viewer/Attendee",a.name,a.city||"",a.phone||"",a.category||""]);
    });
    if(attendees.length===0) rows.push(["(none registered)"]);

    const csv=rows.map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(",")).join("\n");
    const blob=new Blob([csv],{type:"text/csv"});const url=URL.createObjectURL(blob);const a=document.createElement("a");
    a.href=url;a.download=`${event.name.replace(/\s+/g,"-")}-export.csv`;a.click();URL.revokeObjectURL(url);
    showToast("CSV exported ✓");
  };

  if(loading)return <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:"#080808"}}><Spinner/></div>;
  if(categories.length===0)return <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:"#080808",flexDirection:"column",gap:16}}><div style={{fontFamily:"Barlow,sans-serif",color:"#555"}}>No categories configured.</div><button className="btn" style={{background:"#111",color:"#777",border:"1px solid #222"}} onClick={onBack}>← BACK</button></div>;

  return (
    <div style={{fontFamily:"'Bebas Neue',Impact,sans-serif",background:"#080808",minHeight:"100vh",color:"#fff"}}>

      {/* Stream overlay */}
      {overlayActive&&(()=>{
        const isPrelimOv=currentRound==="Prelims";
        const limit=ROUND_LIMIT[currentRound]??999;
        const list=catSorted.slice(0,limit);
        return (
          <div style={{position:"fixed",inset:0,background:"#000000f5",zIndex:200,display:"flex",flexDirection:"column",padding:36,overflowY:"auto"}}>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:4}}>
              <div className="pulse" style={{width:10,height:10,borderRadius:"50%",background:"#ff4d4d"}}/>
              <span style={{fontFamily:"Bebas Neue,sans-serif",fontSize:12,letterSpacing:4,color:"#ff4d4d"}}>LIVE · {event.name.toUpperCase()}</span>
            </div>
            <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:36,letterSpacing:3,lineHeight:1,marginBottom:4}}>{currentRound} <span style={{color:col.primary}}>· {activeCat}</span></div>
            <div style={{fontFamily:"Barlow,sans-serif",fontSize:11,color:"#555",letterSpacing:2,marginBottom:24}}>{event.city}</div>
            {list.map((p,i)=>(
              <div key={p.id} style={{display:"flex",alignItems:"center",gap:12,background:i<3?col.bg:"#0d0d0d",border:`1px solid ${i<3?col.border:"#161616"}`,borderRadius:8,padding:"9px 13px",marginBottom:6}}>
                <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:20,color:i<3?col.primary:"#333",minWidth:34}}>#{i+1}</div>
                <div style={{flex:1}}><div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:15}}>{p.name}</div><div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#555"}}>{p.city}</div></div>
                {isPrelimOv&&<div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:16,color:i<3?col.primary:"#fff",minWidth:28,textAlign:"right"}}>{getScore(p.id)||"—"}</div>}
              </div>
            ))}
            <button className="btn" style={{marginTop:22,alignSelf:"flex-start",background:"#1a1a1a",color:"#777",border:"1px solid #333",fontSize:11}} onClick={()=>setOverlayActive(false)}>✕ CLOSE</button>
          </div>
        );
      })()}

      {/* End event confirm */}
      {showConfirm&&(
        <div style={{position:"fixed",inset:0,background:"#000000cc",zIndex:300,display:"flex",alignItems:"center",justifyContent:"center",padding:24}}>
          <div style={{background:"#111",border:"1px solid #ff4d4d44",borderRadius:14,padding:28,maxWidth:380,width:"100%",textAlign:"center"}}>
            <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:22,color:"#ff4d4d",marginBottom:8}}>END EVENT?</div>
            <div style={{fontFamily:"Barlow,sans-serif",fontSize:13,color:"#666",marginBottom:24}}>All data for "<strong style={{color:"#fff"}}>{event.name}</strong>" will be permanently deleted.</div>
            <div style={{display:"flex",gap:10}}>
              <button className="btn" style={{flex:1,background:"#1a1a1a",color:"#777",border:"1px solid #333"}} onClick={()=>setShowConfirm(false)}>CANCEL</button>
              <button className="btn" style={{flex:1,background:"#ff4d4d",color:"#000"}} onClick={endEvent}>YES, DELETE</button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div style={{padding:"22px 22px 0",maxWidth:1100,margin:"0 auto"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:12}}>
          <div>
            <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:52,letterSpacing:5,lineHeight:1,color:"#fff"}}>{event.name}</div>
            <div style={{fontFamily:"Barlow,sans-serif",fontSize:11,color:col.primary,letterSpacing:3,marginTop:2}}>DanBuzz · {event.city} · {event.date}</div>
          </div>
          <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
            <select className="inp" style={{width:"auto",padding:"7px 32px 7px 11px",fontSize:12}} value={currentRound} onChange={e=>setCurrentRound(e.target.value)}>
              {rounds.map(r=><option key={r}>{r}</option>)}
            </select>
            <button className="btn" style={{background:"#111",color:"#777",border:"1px solid #2a2a2a",fontSize:11}} onClick={()=>setOverlayActive(true)}>⬛ STREAM</button>
            <button className="btn" style={{background:"transparent",color:"#555",border:"1px solid #222",fontSize:11}} onClick={onBack}>← LOGOUT</button>
            <button className="btn" style={{background:"#1a0a0a",color:"#ff4d4d",border:"1px solid #ff4d4d33",fontSize:11}} onClick={()=>setShowConfirm(true)}>END EVENT</button>
          </div>
        </div>

        <div style={{display:"flex",gap:10,marginTop:16,flexWrap:"wrap"}}>
          {[{label:"PARTICIPANTS",val:participants.length,color:"#fff"},{label:"CHECKED IN",val:participants.filter(p=>p.checked_in).length,color:"#00c853"},{label:"CATEGORIES",val:categories.length,color:col.primary},{label:"JUDGES",val:regJudges.length,color:"#ffd700"},{label:"SCORES",val:scores.length,color:"#00e5ff"},{label:"BATTLES",val:battles.length,color:"#ff9800"},{label:"BIAS FLAGS",val:totalBias,color:totalBias>0?"#ff4d4d":"#333"}].map(s=>(
            <div key={s.label} style={{background:"#0f0f0f",border:"1px solid #181818",borderRadius:8,padding:"8px 14px",textAlign:"center"}}>
              <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:24,color:s.color,lineHeight:1}}>{s.val}</div>
              <div style={{fontFamily:"Barlow,sans-serif",fontSize:8,color:"#444",letterSpacing:2,marginTop:2}}>{s.label}</div>
            </div>
          ))}
        </div>

        <div style={{display:"flex",gap:8,marginTop:16,flexWrap:"wrap"}}>
          {categories.map(cat=>{const c=getCatColor(categories,cat);const count=participants.filter(p=>p.category===cat).length;const judgesIn=judgeCodes.filter(j=>j.category===cat&&j.used).length;const active=activeCat===cat;return <button key={cat} className="btn" style={{fontSize:11,padding:"7px 14px",background:active?c.primary:"#111",color:active?"#000":"#555",border:`1px solid ${active?c.primary:"#222"}`}} onClick={()=>setActiveCat(cat)}>{cat} <span style={{opacity:.7}}>({count}p · {judgesIn}j)</span></button>;})}
        </div>

        <div style={{display:"flex",borderBottom:"1px solid #1a1a1a",marginTop:12,overflowX:"auto"}}>
          {[
            {key:"organizer",label:"PARTICIPANTS"},
            {key:"attendees",label:"ATTENDEES"},
            {key:"judges",label:`JUDGES (${regJudges.length})`},
            {key:"checkin",label:"CHECK-IN"},
            {key:"scores",label:"SCORES (VIEW)"},
            {key:"bracket",label:"BRACKET"},
            {key:"leaderboard",label:"LEADERBOARD"},
            {key:"bias",label:`BIAS${biasAlerts.length>0?` (${biasAlerts.length})`:""}`},
            {key:"export",label:"EXPORT"},
          ].map(t=><button key={t.key} className="tbtn" style={{color:tab===t.key?col.primary:"#555",borderBottom:tab===t.key?`3px solid ${col.primary}`:"3px solid transparent"}} onClick={()=>setTab(t.key)}>{t.label}</button>)}
        </div>
      </div>

      <div style={{padding:"20px 22px 40px",maxWidth:1100,margin:"0 auto"}}>
        {/* Category banner */}
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16,padding:"9px 14px",background:col.bg,border:`1px solid ${col.border}`,borderRadius:9}}>
          <div style={{width:8,height:8,borderRadius:"50%",background:col.primary}}/>
          <span style={{fontFamily:"Bebas Neue,sans-serif",fontSize:13,letterSpacing:3,color:col.primary}}>{activeCat}</span>
          <span style={{fontFamily:"Barlow,sans-serif",fontSize:11,color:"#555",marginLeft:4}}>{catParts.length} participants · {catJudges.length>0?catJudges.map(j=>j.judge_name).join(" · "):"No judges yet"}</span>
          <span style={{fontFamily:"Barlow,sans-serif",fontSize:9,color:currentRound==="Prelims"?"#ffd700":"#00e5ff",marginLeft:8}}>
            {currentRound==="Prelims"?"PRELIMS (SCORE-BASED)":"KNOCKOUT (1V1)"}
          </span>
          <div style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:6}}>
            <div className="pulse" style={{width:5,height:5,borderRadius:"50%",background:"#00c853"}}/>
            <span style={{fontFamily:"Barlow,sans-serif",fontSize:9,color:"#444",letterSpacing:2}}>LIVE</span>
          </div>
        </div>

        {tab==="organizer"&&<OrganizerTab activeCat={activeCat} catSorted={catSorted} col={col} onAdd={addParticipant} getScore={getScore}/>}
        {tab==="attendees"&&<AttendeeTab event={event} col={col} showToast={showToast}/>}

        {tab==="judges"&&(
          <div className="slide">
            <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:18,letterSpacing:3,color:col.primary,marginBottom:6}}>JUDGES · {activeCat}</div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(240px,1fr))",gap:12,marginBottom:32}}>
              {judgeCodes.filter(j=>j.category===activeCat).map(j=>(
                <div key={j.code} className="card" style={{border:`1px solid ${j.used?col.border:"#1e1e1e"}`}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}>
                    <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:15,color:j.used?col.primary:"#333",letterSpacing:2}}>{activeCat} · Judge {j.slot}</div>
                    <span className="badge" style={{background:j.used?"#00c85322":"#1a1a1a",color:j.used?"#00c853":"#333",border:`1px solid ${j.used?"#00c85344":"#2a2a2a"}`}}>{j.used?"REGISTERED":"WAITING"}</span>
                  </div>
                  {j.used?<div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:20}}>{j.judge_name}</div>:<div style={{fontFamily:"Barlow,sans-serif",fontSize:12,color:"#555"}}>Waiting for judge</div>}
                  <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:12,letterSpacing:2,color:"#333",marginTop:10,padding:"6px 10px",background:"#151515",borderRadius:6}}>{j.code}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab==="checkin"&&(
          <div className="slide">
            <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:18,letterSpacing:3,color:col.primary,marginBottom:6}}>CHECK-IN · {activeCat}</div>
            <input className="inp" placeholder="Search dancer..." value={searchQr} onChange={e=>setSearchQr(e.target.value)} style={{maxWidth:300,marginBottom:16}}/>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(185px,1fr))",gap:12}}>
              {catParts.filter(p=>p.name.toLowerCase().includes(searchQr.toLowerCase())).map(p=>(
                <div key={p.id} className="card" style={{textAlign:"center",border:`1px solid ${p.checked_in?col.border:"#1e1e1e"}`}}>
                  <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:15,marginBottom:2}}>{p.name}</div>
                  <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#555",marginBottom:10}}>{p.city}</div>
                  {p.checked_in?<span className="badge" style={{background:"#00c85322",color:"#00c853",border:"1px solid #00c85344"}}>✓ CHECKED IN</span>:<button className="btn" style={{background:"#00c853",color:"#000",fontSize:11,width:"100%"}} onClick={()=>checkIn(p.id)}>CHECK IN</button>}
                </div>
              ))}
            </div>
          </div>
        )}

        {tab==="scores"&&(
          <div className="slide">
            <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:18,letterSpacing:3,color:col.primary,marginBottom:4}}>SCORES (VIEW ONLY) · {activeCat}</div>
            <div style={{fontFamily:"Barlow,sans-serif",fontSize:12,color:"#555",marginBottom:8}}>Prelim scores only — entered by judges. Read-only for organizers.</div>
            <div style={{background:"#1a1a0a",border:"1px solid #ffd70022",borderRadius:8,padding:"8px 14px",marginBottom:18,fontFamily:"Barlow,sans-serif",fontSize:11,color:"#888"}}>
              ⚡ These scores are used only for seeding. They do not carry into knockout rounds.
            </div>
            {checkedIn.map(p=>{
              const sm=scoreMap[p.id]||{};
              return (
                <div key={p.id} className="card" style={{marginBottom:10}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10,flexWrap:"wrap",gap:6}}>
                    <div><div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:16}}>{p.name}</div><div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#555"}}>{p.city}</div></div>
                    <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:28,color:col.primary}}>{getScore(p.id)||"—"}</div>
                  </div>
                  <div style={{display:"flex",gap:7,flexWrap:"wrap"}}>
                    {catJudges.map(j=>{const key=`${j.category}-J${j.slot}`;return <div key={key} style={{background:"#1a1a1a",border:"1px solid #2a2a2a",borderRadius:6,padding:"5px 9px",textAlign:"center",minWidth:64}}><div style={{fontFamily:"Barlow,sans-serif",fontSize:8,color:"#555",marginBottom:1}}>{j.judge_name}</div><div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:20,color:"#fff"}}>{sm[key]??"—"}</div></div>;})}
                  </div>
                </div>
              );
            })}
            {checkedIn.length===0&&<div style={{textAlign:"center",padding:"48px",fontFamily:"Barlow,sans-serif",color:"#333"}}>No checked-in participants yet</div>}
          </div>
        )}

        {tab==="bracket"&&<BracketTab event={event} activeCat={activeCat} col={col} prelimRanked={prelimRanked} showToast={showToast}/>}

        {tab==="leaderboard"&&(
          <div className="slide">
            <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:18,letterSpacing:3,color:col.primary,marginBottom:4}}>PRELIM RANKING · {activeCat}</div>
            <div style={{fontFamily:"Barlow,sans-serif",fontSize:11,color:"#555",marginBottom:4}}>Ranked by judge scores. Sets seeds for knockout brackets.</div>
            <div style={{background:"#1a1a0a",border:"1px solid #ffd70022",borderRadius:8,padding:"8px 14px",marginBottom:16,fontFamily:"Barlow,sans-serif",fontSize:11,color:"#888"}}>
              These scores only determine seeding. Knockout battles are judged fresh.
            </div>
            {catSorted.length>=2&&(
              <div style={{display:"flex",gap:10,marginBottom:22,flexWrap:"wrap"}}>
                {[{p:catSorted[1],rank:2,pt:55},{p:catSorted[0],rank:1,pt:85},{p:catSorted[2],rank:3,pt:38}].map(({p,rank,pt})=>p&&(
                  <div key={p.id} style={{flex:1,minWidth:120,background:rank===1?col.bg:"#0d0d0d",border:`1px solid ${rank===1?col.border:"#1a1a1a"}`,borderRadius:12,padding:"14px",paddingTop:pt+"px",textAlign:"center"}}>
                    <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:38,color:rank===1?col.primary:rank===2?"#aaa":"#cd7f32",lineHeight:1}}>#{rank}</div>
                    <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:17,marginBottom:2}}>{p.name}</div>
                    <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#555",marginBottom:6}}>{p.city}</div>
                    <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:36,color:rank===1?col.primary:"#fff"}}>{getScore(p.id)}</div>
                  </div>
                ))}
              </div>
            )}
            <div style={{background:"#0c0c0c",border:"1px solid #161616",borderRadius:12,overflow:"hidden"}}>
              {catSorted.map((p,i)=>(
                <div key={p.id} className="lrow">
                  <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:20,color:i<3?col.primary:"#222",minWidth:36}}>#{i+1}</div>
                  <div style={{flex:1}}><div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:15}}>{p.name}</div><div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#555"}}>{p.city}</div></div>
                  <div style={{background:"#1a1a1a",borderRadius:3,height:4,flex:1,maxWidth:100,overflow:"hidden"}}><div style={{height:"100%",borderRadius:3,background:col.primary,width:`${getScore(p.id)}%`,transition:"width .6s"}}/></div>
                  <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:18,color:i<3?col.primary:"#fff",minWidth:32,textAlign:"right"}}>{getScore(p.id)||"—"}</div>
                  <span className="badge" style={{background:p.checked_in?"#00c85322":"#ff4d4d22",color:p.checked_in?"#00c853":"#ff4d4d"}}>{p.checked_in?"✓":"⌛"}</span>
                </div>
              ))}
              {catParts.length===0&&<div style={{padding:"40px",textAlign:"center",fontFamily:"Barlow,sans-serif",color:"#333"}}>No participants yet</div>}
            </div>
          </div>
        )}

        {tab==="bias"&&(
          <div className="slide">
            <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:18,letterSpacing:3,color:col.primary,marginBottom:4}}>BIAS DETECTION · {activeCat}</div>
            <div style={{fontFamily:"Barlow,sans-serif",fontSize:12,color:"#555",marginBottom:18}}>Flags when a judge scores 1.5+ points from the average for the same participant.</div>
            {biasAlerts.length===0?(
              <div style={{textAlign:"center",padding:"56px 20px"}}>
                <div style={{fontSize:42,marginBottom:10}}>✓</div>
                <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:20,color:"#00c853",letterSpacing:2}}>NO BIAS DETECTED</div>
              </div>
            ):biasAlerts.map((a,i)=>(
              <div key={i} style={{background:"#1a0a0a",border:"1px solid #ff4d4d33",borderRadius:8,padding:"11px 15px",marginBottom:9}}>
                <div style={{display:"flex",justifyContent:"space-between",flexWrap:"wrap",gap:8,alignItems:"center"}}>
                  <div style={{fontFamily:"Barlow,sans-serif",fontSize:13}}><span style={{color:"#ff4d4d",fontFamily:"Bebas Neue,sans-serif",fontSize:14}}>{a.judge}</span>{" "}scored{" "}<span style={{color:"#fff",fontFamily:"Bebas Neue,sans-serif",fontSize:14}}>{a.score}</span>{" "}for {a.participant}{" "}<span style={{color:"#555"}}>(avg: {a.avg})</span></div>
                  <span className="badge" style={{background:"#ff4d4d22",color:"#ff4d4d",border:"1px solid #ff4d4d44"}}>⚠ OUTLIER</span>
                </div>
                <div style={{marginTop:8,height:4,background:"#1a1a1a",borderRadius:4,overflow:"hidden"}}><div style={{height:"100%",width:`${a.score*10}%`,background:Math.abs(a.score-parseFloat(a.avg))>2?"#ff4d4d":"#ff9800",borderRadius:4}}/></div>
              </div>
            ))}
          </div>
        )}

        {tab==="export"&&(
          <div className="slide">
            <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:18,letterSpacing:3,color:col.primary,marginBottom:4}}>EXPORT EVENT DATA</div>
            <div style={{fontFamily:"Barlow,sans-serif",fontSize:12,color:"#555",marginBottom:16}}>CSV includes: competition participants with prelim scores and knockout results, plus all registered attendees and viewers.</div>
            <div style={{display:"flex",gap:10,marginBottom:16,flexWrap:"wrap"}}>
              <div style={{background:"#0f0f0f",border:"1px solid #181818",borderRadius:8,padding:"8px 14px",fontFamily:"Barlow,sans-serif",fontSize:11,color:"#888"}}>
                📋 <strong style={{color:"#fff"}}>{participants.length}</strong> participants · <strong style={{color:"#00e5ff"}}>{attendees.filter(a=>a.role==="attendee").length}</strong> viewers · <strong style={{color:"#ffd700"}}>{attendees.filter(a=>a.role==="participant").length}</strong> registered participants
              </div>
            </div>
            <div style={{display:"flex",gap:12,flexWrap:"wrap"}}>
              <button className="btn" style={{background:"#00c853",color:"#000",fontSize:13,padding:"13px 28px"}} onClick={exportCSV}>⬇ EXPORT ALL DATA (CSV)</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// ROOT
// ─────────────────────────────────────────────────────────────────
export default function App() {
  const [screen,setScreen]=useState("loading");
  const [activeEvent,setActiveEvent]=useState(null);
  const [judgeData,setJudgeData]=useState(null);
  const [viewerData,setViewerData]=useState(null);
  const [toast,setToast]=useState(null);
  const showToast=(msg,type="success")=>{setToast({msg,type});setTimeout(()=>setToast(null),3000);};

  useEffect(()=>{
    supabase.auth.getSession().then(({data:{session}})=>{if(session?.user)setScreen("adminDashboard");else setScreen("landing");});
    const{data:{subscription}}=supabase.auth.onAuthStateChange((_e,session)=>{if(!session?.user&&screen==="adminDashboard")setScreen("landing");});
    return()=>subscription.unsubscribe();
  },[]);

  const handleAdminLogout=async()=>{await supabase.auth.signOut();setScreen("landing");};

  if(screen==="loading")return <div style={{fontFamily:"'Bebas Neue',sans-serif",background:"#080808",minHeight:"100vh",color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:24}}><style>{CSS}</style><div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:48,letterSpacing:5}}>DAN<span style={{color:"#ff4d4d"}}>BUZZ</span></div><Spinner/></div>;

  return (
    <div style={{fontFamily:"'Bebas Neue',sans-serif",background:"#080808",minHeight:"100vh",color:"#fff"}}>
      <style>{CSS}</style>
      <Toast toast={toast}/>
      {screen==="landing"         &&<LandingScreen onAdminLogin={()=>setScreen("adminLogin")} onOrgLogin={()=>setScreen("orgLogin")} onJudgeLogin={()=>setScreen("judgeLogin")} onViewerLogin={()=>setScreen("viewerLogin")}/>}
      {screen==="adminLogin"      &&<AdminLoginScreen onBack={()=>setScreen("landing")} onLogin={()=>setScreen("adminDashboard")} showToast={showToast}/>}
      {screen==="adminDashboard"  &&<AdminDashboard onBack={handleAdminLogout} showToast={showToast}/>}
      {screen==="orgLogin"        &&<OrgLoginScreen onBack={()=>setScreen("landing")} onLogin={(ev)=>{setActiveEvent(ev);setScreen("dashboard");}} showToast={showToast}/>}
      {screen==="judgeLogin"      &&<JudgeLoginScreen onBack={()=>setScreen("landing")} onLogin={({judgeCode,event})=>{setJudgeData(judgeCode);setActiveEvent(event);setScreen("judgeDashboard");}} showToast={showToast}/>}
      {screen==="viewerLogin"     &&<ViewerLoginScreen onBack={()=>setScreen("landing")} onLogin={({event,name,role})=>{setActiveEvent(event);setViewerData({name,role});setScreen("viewerDashboard");}} showToast={showToast}/>}
      {screen==="judgeDashboard"  &&judgeData&&activeEvent&&<JudgeDashboard judgeCode={judgeData} event={activeEvent} onBack={()=>{setJudgeData(null);setActiveEvent(null);setScreen("landing");}} showToast={showToast}/>}
      {screen==="viewerDashboard" &&viewerData&&activeEvent&&<ViewerDashboard event={activeEvent} viewerName={viewerData.name} onBack={()=>{setViewerData(null);setActiveEvent(null);setScreen("landing");}}/>}
      {screen==="dashboard"       &&activeEvent&&<Dashboard event={activeEvent} onBack={()=>{setActiveEvent(null);setScreen("landing");}} showToast={showToast}/>}
    </div>
  );
}
