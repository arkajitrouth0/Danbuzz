import { useState, useEffect, useMemo, useCallback, useRef } from "react";
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
const genEmceeCode  = () => `EMCEE-${randAlpha(4)}-${rand4()}`;

const genJudgeCodes = (prefix, categories, judgeCounts={}) => {
  const codes = [];
  categories.forEach(cat => {
    const slug  = cat.replace(/\s+/g,"").slice(0,3).toUpperCase();
    const count = Math.max(1, parseInt(judgeCounts[cat])||1);
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
//                 Judges give 1-10 scores. Total score across all judges = rank.
//                 Top N advance to the first knockout round.
//
//   2. KNOCKOUT — RedBull BC One style. Top vs Bottom seeding.
//                 Seed 1 vs Seed N, Seed 2 vs Seed N-1, etc.
//                 Winners re-rank: winner of Battle 1 = Rank 1, Battle 2 = Rank 2...
//                 Next round is seeded from that new winner list (Top vs Bottom again).
//                 Each round is judged INDEPENDENTLY via Name Card.
//
//   3. TIE RULE — Judges submit a TIE CARD. Both battle again (tie_round++).
//                 Ties are allowed any number of times — tie_round keeps incrementing.
//
// ─────────────────────────────────────────────────────────────────

// ── KNOCKOUT JUDGE DECISION ENGINE ─────────────────────────────
// 5 rules (2-way and 3-way battles):
//   a) UNANIMOUS  — all judges pick same dancer → that dancer wins
//   b) MAJORITY   — more judges pick A than any other choice → A wins
//   c) ALL TIE    — every judge submits a tie card → re-battle
//   d) SPLIT EVEN — even number of judges, two dancers tied in wins
//                   (regardless of tie votes) → re-battle
//   e) TIE + WIN  — one judge picks X, one judge marks tie (no other picks) → X wins
//                   (tie vote only counts as a real tie when it creates a genuine deadlock)
// Only resolves once ALL registered judges for that category have voted.
const resolveBattle = (decisions = []) => {
  if (!decisions.length) return { status: "pending", tie_round: 0 };
  const maxTieRound = Math.max(...decisions.map(d => d.tie_round ?? 0));
  const current = decisions.filter(d => (d.tie_round ?? 0) === maxTieRound);
  if (!current.length) return { status: "pending", tie_round: maxTieRound };

  const p1Id = current[0].p1_id;
  const p2Id = current[0].p2_id;
  const p3Id = current[0].p3_id || null;
  const totalJudges = current.length;

  const tieVotes = current.filter(d => d.is_tie).length;
  const p1Wins   = current.filter(d => !d.is_tie && d.winner_id === p1Id).length;
  const p2Wins   = current.filter(d => !d.is_tie && d.winner_id === p2Id).length;
  const p3Wins   = p3Id ? current.filter(d => !d.is_tie && d.winner_id === p3Id).length : 0;

  const allParticipantWins = p3Id ? [p1Wins, p2Wins, p3Wins] : [p1Wins, p2Wins];
  const maxWins = Math.max(...allParticipantWins);

  // Rule (c): all judges gave tie → re-battle
  if (tieVotes === totalJudges) {
    return { status: "tied", winner_id: null, winner_name: null, tie_round: maxTieRound };
  }

  // Rule (a) + (b): unanimous or clear majority
  // Count how many dancers share the max win count (excluding tie)
  const leadersCount = allParticipantWins.filter(w => w === maxWins).length;

  if (maxWins > 0 && leadersCount === 1) {
    // One dancer leads — check rule (e): ties only block if they would flip the result
    // If winning dancer's wins > tieVotes, they win outright (ties can't swing it)
    // If winning dancer's wins <= tieVotes, it's still a tie deadlock
    const leader = p3Id
      ? (p1Wins===maxWins ? {id:p1Id, name:current[0].p1_name}
        : p2Wins===maxWins ? {id:p2Id, name:current[0].p2_name}
        : {id:p3Id, name:current[0].p3_name})
      : (p1Wins===maxWins ? {id:p1Id, name:current[0].p1_name} : {id:p2Id, name:current[0].p2_name});

    // Rule (e): if 1 judge gave win to X and 1 judge gave tie → X wins
    // More generally: leader wins > 0 and no other dancer ties the lead
    return { status: "decided", winner_id: leader.id, winner_name: leader.name, tie_round: maxTieRound };
  }

  // Rule (d): even number of judges, two+ dancers tied in wins → re-battle
  // Also handles odd judges where tie votes create deadlock
  if (leadersCount > 1) {
    // Check if tie votes could resolve the deadlock (they cannot — they just re-battle)
    return { status: "tied", winner_id: null, winner_name: null, tie_round: maxTieRound };
  }

  // No votes yet from all judges / only tie votes with no winner
  return { status: "pending", tie_round: maxTieRound };
};

// Get the ordered list of rounds from the event (excluding Prelims)
const getKnockoutRounds = (eventRounds) =>
  (eventRounds || []).filter(r => r !== "Prelims");

// Given prelim-ranked list, build the battles for the FIRST knockout round.
// match_index 0 = Seed1 vs SeedN, index 1 = Seed2 vs Seed(N-1), …
// If pool is ODD: the middle battle becomes a 3-way (p1, p2, p3).
const buildBattlesFromSeeds = (seededList, roundName) => {
  const limit = ROUND_LIMIT[roundName] ?? 2;
  const pool  = seededList.slice(0, limit);
  const n     = pool.length;
  if (n < 2) return [];

  const result = [];
  if (n % 2 === 0) {
    // Even: standard 1 vs N pairing
    const half = n / 2;
    for (let i = 0; i < half; i++) {
      result.push({ match_index: i, round: roundName, p1: pool[i], p2: pool[n - 1 - i] });
    }
  } else {
    // Odd: pair first (n-3) normally, last battle is 3-way with the middle 3 seeds
    // e.g. 9 dancers: battles are [1v9, 2v8, 3v7v4] — seeds 3,4,7 fight together
    const pairs = Math.floor((n - 1) / 2); // normal pairs before the 3-way
    // Actually: pair outermost until 3 remain in the middle
    // e.g. 9: [0v8, 1v7, 2v6v3] — wait, cleaner is:
    // pair from outside in until 3 left: pair count = (n-3)/2, then 3-way for middle 3
    const normalPairs = (n - 3) / 2; // only integer when n is odd
    for (let i = 0; i < normalPairs; i++) {
      result.push({ match_index: i, round: roundName, p1: pool[i], p2: pool[n - 1 - i] });
    }
    // The 3 middle dancers: indices normalPairs, normalPairs+1, normalPairs+2
    const mi = normalPairs;
    result.push({
      match_index: mi,
      round: roundName,
      p1: pool[mi],
      p2: pool[mi + 2], // top seed of the 3 vs bottom seed
      p3: pool[mi + 1], // middle seed is p3
      is3way: true,
    });
  }
  return result;
};

// Given all battle_decisions for a category, compute the seeded winner list
// that exits a given round (used to seed the NEXT round).
// Returns participants in winner-rank order: winner of match 0 = rank 1, match 1 = rank 2...
// Works for both 2-way and 3-way battles — each battle always produces exactly 1 winner.
const getWinnersOfRound = (roundName, allDecisions, participantMap) => {
  const roundDecs = allDecisions.filter(d => d.round === roundName);
  const matchIndices = [...new Set(roundDecs.map(d => d.match_index))].sort((a,b)=>a-b);
  const winners = [];
  for (const mi of matchIndices) {
    const decs = roundDecs.filter(d => d.match_index === mi);
    const result = resolveBattle(decs);
    if (result.status === "decided" && result.winner_id) {
      const p = participantMap[result.winner_id];
      if (p) winners.push(p);
    }
  }
  return winners;
};

// Build the battles for any round, accounting for progressive seeding.
// For the first knockout round → seed from prelim ranking.
// For subsequent rounds → seed from winners of the previous round.
const buildRoundBattles = (roundName, eventRounds, prelimRanked, allDecisions, participantMap) => {
  const knockoutRounds = getKnockoutRounds(eventRounds);
  const roundIndex = knockoutRounds.indexOf(roundName);
  if (roundIndex < 0) return [];

  let seededList;
  if (roundIndex === 0) {
    // First knockout round — seed from prelim ranking
    seededList = prelimRanked;
  } else {
    // Subsequent rounds — seed from winners of the previous round
    const prevRound = knockoutRounds[roundIndex - 1];
    seededList = getWinnersOfRound(prevRound, allDecisions, participantMap);
  }
  return buildBattlesFromSeeds(seededList, roundName);
};

// ─────────────────────────────────────────────────────────────────
// CSS
// ─────────────────────────────────────────────────────────────────
const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Barlow:wght@300;400;600;700&display=swap');
  *{box-sizing:border-box;} body{margin:0;background:#0a0612;}
  ::-webkit-scrollbar{width:4px;} ::-webkit-scrollbar-track{background:#0d0a1a;} ::-webkit-scrollbar-thumb{background:#3d2080;}
  .tbtn{font-family:'Bebas Neue',sans-serif;font-size:12px;letter-spacing:2px;padding:9px 14px;border:none;cursor:pointer;transition:all .2s;border-bottom:3px solid transparent;background:transparent;color:#554488;white-space:nowrap;}
  .tbtn:hover{color:#c084fc;}
  .card{background:#120e22;border:1px solid #2a1f4a;border-radius:12px;padding:18px;margin-bottom:12px;}
  .inp{background:#160e2a;border:1px solid #3d2080;color:#fff;padding:9px 13px;border-radius:8px;font-family:'Barlow',sans-serif;font-size:13px;width:100%;outline:none;transition:border-color .2s;}
  .inp:focus{border-color:#7c3aed;}
  .btn{font-family:'Bebas Neue',sans-serif;letter-spacing:2px;padding:9px 18px;border:none;border-radius:8px;cursor:pointer;font-size:13px;transition:all .2s;}
  .btn:hover{opacity:.85;transform:translateY(-1px);}
  .btn:disabled{opacity:.35;cursor:not-allowed;transform:none;}
  .badge{display:inline-block;padding:3px 10px;border-radius:20px;font-family:'Barlow',sans-serif;font-size:10px;font-weight:700;letter-spacing:1px;}
  .pulse{animation:pulse 1.5s infinite;}
  @keyframes pulse{0%,100%{opacity:1;}50%{opacity:.4;}}
  .slide{animation:slideIn .2s ease;}
  @keyframes slideIn{from{transform:translateY(-6px);opacity:0;}to{transform:translateY(0);opacity:1;}}
  .lrow{display:flex;align-items:center;gap:13px;padding:11px 16px;border-bottom:1px solid #1a1030;transition:background .15s;}
  .lrow:hover{background:#160e28;}
  .chip{font-family:'Barlow',sans-serif;font-size:11px;padding:5px 12px;border-radius:20px;border:1px solid #2a1f4a;background:#120e22;color:#7755aa;cursor:pointer;transition:all .15s;white-space:nowrap;}
  .chip:hover{border-color:#7c3aed;color:#c084fc;}
  .chip.active{background:#7c3aed22;border-color:#7c3aed;color:#c084fc;}
  select{appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='7' fill='%237c3aed'%3E%3Cpath d='M0 0l5 7 5-7z'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 11px center;}
  .spin{display:inline-block;width:16px;height:16px;border:2px solid #7c3aed44;border-top-color:#c084fc;border-radius:50%;animation:spinner .6s linear infinite;vertical-align:middle;}
  @keyframes spinner{to{transform:rotate(360deg);}}
  .rchip{font-family:'Barlow',sans-serif;font-size:10px;padding:4px 10px;border-radius:20px;border:1px solid #2a1f4a;background:#120e22;color:#554488;cursor:pointer;transition:all .15s;}
  .rchip.on{background:#7c3aed22;border-color:#7c3aed;color:#c084fc;}
  .battle-card{background:#120e22;border:1px solid #2a1f4a;border-radius:14px;padding:0;overflow:hidden;margin-bottom:14px;}
  .fighter{display:flex;align-items:center;gap:12px;padding:14px 18px;cursor:pointer;transition:background .15s;}
  .fighter:hover{background:#1a1230;}
  .fighter.selected{background:#1a2a1a;}
  .fighter.winner{background:#0a1e0a;}
  .fighter.loser{opacity:0.4;}
  .vs-bar{display:flex;align-items:center;justify-content:center;padding:6px;background:#0a0612;font-family:'Bebas Neue',sans-serif;font-size:11px;letter-spacing:3px;color:#3d2080;}
  /* BATTLE RESULT COLORS: winner=green, loser=red, tie=white-tinted */
  .result-winner{background:#051a07 !important;}
  .result-loser{background:#1a0505 !important;opacity:0.45 !important;}
  .result-tie{background:#161616 !important;}
  /* HIP-HOP DOODLE BACKGROUND */
  .hiphop-bg{position:relative;}
  .hiphop-bg::before{content:'';position:fixed;inset:0;pointer-events:none;z-index:0;opacity:1;background-image:
    url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='600' height='600'%3E%3Ctext x='10' y='80' font-size='72' fill='%237c3aed07' font-family='Impact,sans-serif' transform='rotate(-18,10,80)'%3EBREAK%3C/text%3E%3Ctext x='200' y='180' font-size='44' fill='%233b82f606' font-family='Impact,sans-serif' transform='rotate(12,200,180)'%3EBBOY%3C/text%3E%3Ctext x='5' y='280' font-size='88' fill='%237c3aed05' font-family='Impact,sans-serif' transform='rotate(-9,5,280)'%3EFREEZE%3C/text%3E%3Ctext x='280' y='360' font-size='56' fill='%233b82f605' font-family='Impact,sans-serif' transform='rotate(22,280,360)'%3EBATTLE%3C/text%3E%3Ctext x='40' y='460' font-size='36' fill='%237c3aed06' font-family='Impact,sans-serif' transform='rotate(-14,40,460)'%3EPOWERMOVE%3C/text%3E%3Ctext x='300' y='540' font-size='64' fill='%233b82f604' font-family='Impact,sans-serif' transform='rotate(6,300,540)'%3EFLOOR%3C/text%3E%3Ccircle cx='480' cy='100' r='55' fill='none' stroke='%237c3aed05' stroke-width='4'/%3E%3Ccircle cx='100' cy='480' r='70' fill='none' stroke='%233b82f604' stroke-width='3'/%3E%3Cpath d='M450 200 Q520 130 560 280 Q520 430 450 360 Z' fill='%237c3aed03'/%3E%3Cpath d='M0 0 L600 600' stroke='%237c3aed03' stroke-width='1.5'/%3E%3Cpath d='M600 0 L0 600' stroke='%233b82f602' stroke-width='1'/%3E%3Ctext x='420' y='480' font-size='28' fill='%237c3aed06' font-family='Impact,sans-serif' transform='rotate(-20,420,480)'%3EDANBUZZ%3C/text%3E%3C/svg%3E");background-size:600px 600px;}
  .hiphop-bg>*{position:relative;z-index:1;}
`;

function Spinner() { return <span className="spin"/>; }
function Toast({toast}) {
  if (!toast) return null;
  return <div className="slide" style={{position:"fixed",top:16,right:16,zIndex:9999,background:toast.type==="error"?"#200a0a":"#0a200a",border:`1px solid ${toast.type==="error"?"#ff4d4d":"#00c853"}`,borderRadius:10,padding:"10px 18px",fontFamily:"Barlow,sans-serif",fontSize:13,color:toast.type==="error"?"#ff4d4d":"#00c853",maxWidth:300}}>{toast.msg}</div>;
}

// ─────────────────────────────────────────────────────────────────
// TIME AGO HELPER
// ─────────────────────────────────────────────────────────────────
function timeAgo(dateStr) {
  if (!dateStr) return "";
  const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff/60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff/3600)}h ago`;
  return `${Math.floor(diff/86400)}d ago`;
}

// ─────────────────────────────────────────────────────────────────
// LIVE NOTIFICATION HOOK
// Rules:
//   - Default popup window: 30 minutes from creation time.
//   - On mount: load most recent notification within 30 min that is not
//     disabled for this role. Show with REMAINING time (30min - age).
//   - New notification sent: always replaces current popup, fresh 30-min timer.
//   - Host disables for a specific recipient group (disabled_for: string[]):
//       If this role is added to disabled_for -> close popup immediately.
//       Other recipient groups are NOT affected.
//   - User taps X -> local dismiss only, does not affect other recipients.
//   - disabled_for is a JSON array in DB, e.g. ["judge","attendee"]
// ─────────────────────────────────────────────────────────────────
const POPUP_DURATION_MS = 30 * 60 * 1000;

function isDisabledFor(notif, role) {
  if (!role) return false;
  const df = notif.disabled_for;
  if (!df) return false;
  const arr = Array.isArray(df) ? df : (typeof df === "string" ? JSON.parse(df) : []);
  return arr.includes(role);
}

function useLiveNotifications(eventId, recipientRole) {
  const [popup, setPopup]     = useState(null);
  const [history, setHistory] = useState([]);
  const popupTimerRef         = useRef(null);

  const showPopup = useCallback((n) => {
    if (popupTimerRef.current) clearTimeout(popupTimerRef.current);
    const age = Date.now() - new Date(n.created_at).getTime();
    const remaining = Math.max(0, POPUP_DURATION_MS - age);
    if (remaining === 0) return;
    setPopup(n);
    popupTimerRef.current = setTimeout(() => setPopup(null), remaining);
  }, []);

  useEffect(() => {
    if (!eventId) return;
    const since = new Date(Date.now() - POPUP_DURATION_MS).toISOString();
    supabase.from("event_notifications")
      .select("*")
      .eq("event_id", eventId)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .then(({ data }) => {
        if (!data) return;
        const filtered = recipientRole
          ? data.filter(n => !n.recipients || n.recipients.includes(recipientRole))
          : data;
        setHistory(filtered);
        const recent = filtered.find(n => !isDisabledFor(n, recipientRole));
        if (recent) showPopup(recent);
      });
  }, [eventId, recipientRole]); // eslint-disable-line

  useEffect(() => {
    if (!eventId) return;
    const ch = supabase.channel(`notif-${eventId}-${recipientRole || "all"}`)
      .on("postgres_changes", {
        event: "INSERT", schema: "public",
        table: "event_notifications",
        filter: `event_id=eq.${eventId}`
      }, (p) => {
        const n = p.new;
        if (recipientRole && n.recipients && !n.recipients.includes(recipientRole)) return;
        setHistory(prev => [n, ...prev]);
        if (!isDisabledFor(n, recipientRole)) showPopup(n);
      })
      .on("postgres_changes", {
        event: "UPDATE", schema: "public",
        table: "event_notifications",
        filter: `event_id=eq.${eventId}`
      }, (p) => {
        const n = p.new;
        setHistory(prev => prev.map(x => x.id === n.id ? n : x));
        if (isDisabledFor(n, recipientRole)) {
          setPopup(prev => {
            if (prev?.id === n.id) {
              if (popupTimerRef.current) clearTimeout(popupTimerRef.current);
              return null;
            }
            return prev;
          });
        }
      })
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
      if (popupTimerRef.current) clearTimeout(popupTimerRef.current);
    };
  }, [eventId, recipientRole, showPopup]);

  return {
    popup,
    history,
    dismissPopup: () => {
      if (popupTimerRef.current) clearTimeout(popupTimerRef.current);
      setPopup(null);
    },
  };
}

function LiveNotifBanner({ popup, onDismiss }) {
  const [, forceUpdate] = useState(0);
  useEffect(() => {
    const t = setInterval(() => forceUpdate(n => n+1), 30000);
    return () => clearInterval(t);
  }, []);
  if (!popup) return null;
  const age = Math.floor((Date.now() - new Date(popup.created_at).getTime()) / 1000);
  const remainingSec = Math.max(0, POPUP_DURATION_MS / 1000 - age);
  const remainingLabel = remainingSec > 60
    ? `auto-closes in ${Math.ceil(remainingSec / 60)} min`
    : remainingSec > 0 ? `auto-closes in ${remainingSec}s` : "";
  return (
    <div className="slide" style={{
      position:"fixed",top:0,left:0,right:0,zIndex:9998,
      background:"linear-gradient(135deg,#1a0800,#2a1200)",
      border:"none",borderBottom:"3px solid #ff9800",
      padding:"14px 24px",display:"flex",alignItems:"center",gap:14,
      boxShadow:"0 4px 32px #ff980044"
    }}>
      <div className="pulse" style={{width:10,height:10,borderRadius:"50%",background:"#ff9800",flexShrink:0}}/>
      <div style={{flex:1}}>
        <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:11,color:"#ff9800",letterSpacing:4,marginBottom:2}}>ANNOUNCEMENT</div>
        <div style={{fontFamily:"Barlow,sans-serif",fontSize:15,color:"#fff",fontWeight:700}}>{popup.message}</div>
        <div style={{display:"flex",gap:10,marginTop:3,alignItems:"center",flexWrap:"wrap"}}>
          <span style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#ff980088"}}>{timeAgo(popup.created_at)}</span>
          {remainingLabel&&<span style={{fontFamily:"Barlow,sans-serif",fontSize:9,color:"#ff980055"}}>{remainingLabel}</span>}
        </div>
      </div>
      {popup.round&&<span style={{fontFamily:"Bebas Neue,sans-serif",fontSize:12,color:"#ff9800",letterSpacing:2,background:"#ff980022",border:"1px solid #ff980044",borderRadius:6,padding:"4px 12px"}}>{popup.round}</span>}
      <button onClick={onDismiss} title="Dismiss for yourself only" style={{background:"#ff980022",border:"1px solid #ff980044",color:"#ff9800",borderRadius:6,padding:"4px 10px",cursor:"pointer",fontFamily:"Bebas Neue,sans-serif",fontSize:12,letterSpacing:1}}>X</button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// NOTIFICATION HISTORY PANEL
// isHost=true shows per-recipient group disable toggles per notification
// ─────────────────────────────────────────────────────────────────
const RECIPIENT_LABELS = { judge:"Judges", emcee:"Emcee", attendee:"Attendees", organizer:"Organizers" };

function NotificationHistoryPanel({ history, isHost, showToast }) {
  const [, forceUpdate] = useState(0);
  useEffect(() => {
    const t = setInterval(() => forceUpdate(n => n+1), 30000);
    return () => clearInterval(t);
  }, []);

  const toggleDisableFor = async (notif, role) => {
    const current = Array.isArray(notif.disabled_for)
      ? notif.disabled_for
      : (notif.disabled_for ? JSON.parse(notif.disabled_for) : []);
    const updated = current.includes(role)
      ? current.filter(r => r !== role)
      : [...current, role];
    const { error } = await supabase.from("event_notifications")
      .update({ disabled_for: updated })
      .eq("id", notif.id);
    if (error && showToast) showToast("Failed: " + error.message, "error");
  };

  return (
    <div style={{background:"#0f0b1e",border:"1px solid #1a1a1a",borderRadius:12,overflow:"hidden"}}>
      <div style={{padding:"10px 16px",background:"#120e22",borderBottom:"1px solid #1a1a1a",display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
        <span style={{fontFamily:"Bebas Neue,sans-serif",fontSize:13,letterSpacing:3,color:"#ff9800"}}>ANNOUNCEMENTS</span>
        <span style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#55449a",marginLeft:4}}>({history.length})</span>
        {isHost&&<span style={{fontFamily:"Barlow,sans-serif",fontSize:9,color:"#7755aa",marginLeft:"auto"}}>tap a group button to turn off popup for that group only</span>}
      </div>
      {history.length === 0 ? (
        <div style={{padding:"24px",textAlign:"center",fontFamily:"Barlow,sans-serif",fontSize:11,color:"#3d2080"}}>No announcements yet</div>
      ) : (
        history.map(n => {
          const disabledFor = Array.isArray(n.disabled_for)
            ? n.disabled_for
            : (n.disabled_for ? JSON.parse(n.disabled_for) : []);
          const sentTo = n.recipients || ["judge","emcee","attendee","organizer"];
          const allDisabled = sentTo.every(r => disabledFor.includes(r));
          return (
            <div key={n.id} style={{padding:"12px 16px",borderBottom:"1px solid #111",opacity:allDisabled?0.4:1}}>
              <div style={{display:"flex",alignItems:"flex-start",gap:10}}>
                <div style={{width:8,height:8,borderRadius:"50%",background:allDisabled?"#55449a":"#ff9800",marginTop:5,flexShrink:0}}/>
                <div style={{flex:1}}>
                  <div style={{fontFamily:"Barlow,sans-serif",fontSize:13,color:allDisabled?"#7755aa":"#fff",lineHeight:1.4}}>{n.message}</div>
                  <div style={{display:"flex",gap:8,marginTop:4,flexWrap:"wrap",alignItems:"center"}}>
                    <span style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#7755aa"}}>{timeAgo(n.created_at)}</span>
                    {n.round&&<span style={{fontFamily:"Bebas Neue,sans-serif",fontSize:9,color:"#ff9800",background:"#ff980011",border:"1px solid #ff980033",borderRadius:4,padding:"1px 6px"}}>{n.round}</span>}
                    <span style={{fontFamily:"Barlow,sans-serif",fontSize:9,color:"#55449a"}}>sent to: {sentTo.map(r=>RECIPIENT_LABELS[r]||r).join(", ")}</span>
                  </div>
                  {isHost && (
                    <div style={{display:"flex",gap:6,marginTop:8,flexWrap:"wrap",alignItems:"center"}}>
                      <span style={{fontFamily:"Barlow,sans-serif",fontSize:9,color:"#7755aa",marginRight:2}}>Turn off popup for:</span>
                      {sentTo.map(role => {
                        const isOff = disabledFor.includes(role);
                        return (
                          <button key={role} onClick={() => toggleDisableFor(n, role)}
                            title={isOff ? "Re-enable popup for "+( RECIPIENT_LABELS[role]||role) : "Turn off popup for "+(RECIPIENT_LABELS[role]||role)}
                            style={{
                              fontFamily:"Barlow,sans-serif",fontSize:9,padding:"3px 9px",borderRadius:20,cursor:"pointer",
                              background: isOff ? "#2a0a0a" : "#0a1a0a",
                              border: "1px solid "+(isOff ? "#ff4d4d44" : "#00c85344"),
                              color: isOff ? "#ff4d4d" : "#00c853",
                              transition:"all .15s",
                            }}>
                            {isOff ? ("ON "+( RECIPIENT_LABELS[role]||role)) : ("OFF "+(RECIPIENT_LABELS[role]||role))}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {!isHost && disabledFor.length > 0 && (
                    <div style={{fontFamily:"Barlow,sans-serif",fontSize:9,color:"#7755aa",marginTop:4}}>
                      popup off for: {disabledFor.map(r => RECIPIENT_LABELS[r]||r).join(", ")}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}


// ─────────────────────────────────────────────────────────────────
// LANDING
// ─────────────────────────────────────────────────────────────────
function LandingScreen({ onAdminLogin, onOrgLogin, onJudgeLogin, onViewerLogin, onEmceeLogin }) {
  return (
    <div style={{minHeight:"100vh",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:32,textAlign:"center",background:"#0a0612"}}>
      <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:64,letterSpacing:6,lineHeight:1}}>DAN<span style={{color:"#ff4d4d"}}>BUZZ</span></div>
      <div style={{fontFamily:"Barlow,sans-serif",fontSize:11,color:"#55449a",letterSpacing:4,marginBottom:52}}>BATTLE MANAGEMENT SYSTEM</div>
      <div style={{display:"flex",flexDirection:"column",gap:14,width:"100%",maxWidth:320}}>
        <button className="btn" style={{background:"#ff4d4d",color:"#000",fontSize:14,padding:"15px"}} onClick={onOrgLogin}>🔑 ORGANIZER LOGIN</button>
        <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#3d2080",marginTop:-6,marginBottom:2}}>Code sent to you by DanBuzz team</div>
        <button className="btn" style={{background:"#120e22",color:"#c0a8e8",border:"1px solid #2a1840",fontSize:13,padding:"14px"}} onClick={onJudgeLogin}>⚖️ JUDGE LOGIN</button>
        <button className="btn" style={{background:"#120e22",color:"#ff9800",border:"1px solid #ff980033",fontSize:13,padding:"14px"}} onClick={onEmceeLogin}>🎤 EMCEE DASHBOARD</button>
        <button className="btn" style={{background:"#120e22",color:"#00e5ff",border:"1px solid #00e5ff33",fontSize:13,padding:"14px"}} onClick={onViewerLogin}>🎟 ATTENDEE LIVE VIEW</button>
        <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#3d2080",marginTop:4}}>First time as a judge? Judge Login handles registration too.</div>
      </div>
      <div style={{marginTop:52,borderTop:"1px solid #111",paddingTop:20}}>
        <button style={{background:"none",border:"none",color:"#2a1f4a",cursor:"pointer",fontFamily:"Barlow,sans-serif",fontSize:9,letterSpacing:3}} onClick={onAdminLogin}>ADMIN</button>
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
    <div style={{minHeight:"100vh",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:32,background:"linear-gradient(160deg,#0a0612,#0d0a22,#0a0e1a)"}}>
      <div style={{width:"100%",maxWidth:360}}>
        <button className="btn" style={{background:"transparent",color:"#3d2080",border:"none",padding:0,marginBottom:24,fontSize:12,letterSpacing:2}} onClick={onBack}>← BACK</button>
        <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:12,background:"linear-gradient(90deg,#a855f7,#60a5fa)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent",letterSpacing:4,marginBottom:4}}>DANBUZZ</div>
        <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:26,letterSpacing:3,marginBottom:4}}>ADMIN LOGIN</div>
        <div style={{fontFamily:"Barlow,sans-serif",fontSize:12,color:"#7755aa",marginBottom:28}}>Restricted to DanBuzz administrators only.</div>
        <div style={{marginBottom:14}}>
          <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#7755aa",letterSpacing:2,marginBottom:6}}>EMAIL</div>
          <input className="inp" type="email" placeholder="admin@danbuzz.com" value={email} onChange={e=>setEmail(e.target.value)}/>
        </div>
        <div style={{marginBottom:20}}>
          <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#7755aa",letterSpacing:2,marginBottom:6}}>PASSWORD</div>
          <input className="inp" type="password" placeholder="••••••••" value={password} onChange={e=>setPassword(e.target.value)} onKeyDown={e=>e.key==="Enter"&&handleLogin()}/>
        </div>
        <button className="btn" style={{background:"linear-gradient(135deg,#7c3aed,#3b82f6)",color:"#fff",width:"100%",fontSize:14,padding:"13px"}} onClick={handleLogin} disabled={loading}>{loading?<Spinner/>:"LOGIN →"}</button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// ADMIN DASHBOARD
// ─────────────────────────────────────────────────────────────────
// Shows judge codes for a single event in the admin list — loads on demand
function AdminEventJudgeCodes({ eventId, categories }) {
  const [open, setOpen] = useState(false);
  const [codes, setCodes] = useState([]);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(null);
  const copy = (val) => { navigator.clipboard?.writeText(val).catch(()=>{}); setCopied(val); setTimeout(()=>setCopied(null),1500); };

  const load = async () => {
    if (codes.length > 0) { setOpen(o=>!o); return; }
    setLoading(true);
    const { data } = await supabase.from("judge_codes").select("*").eq("event_id", eventId).order("category").order("slot");
    setCodes(data||[]);
    setLoading(false);
    setOpen(true);
  };

  return (
    <div style={{marginTop:10}}>
      <button onClick={load} style={{background:"none",border:"none",cursor:"pointer",fontFamily:"Barlow,sans-serif",fontSize:10,color:"#55449a",letterSpacing:1,padding:0,display:"flex",alignItems:"center",gap:5}}>
        {loading?<span style={{display:"inline-block",width:10,height:10,border:"1px solid #7c3aed44",borderTopColor:"#c084fc",borderRadius:"50%",animation:"spinner .6s linear infinite"}}/>:<span>{open?"▲":"▼"}</span>}
        {open?"HIDE JUDGE CODES":"SHOW JUDGE CODES"} ({categories.length} {categories.length===1?"category":"categories"})
      </button>
      {open&&codes.length>0&&(
        <div style={{marginTop:8,display:"flex",flexWrap:"wrap",gap:6}}>
          {codes.map(j=>{
            const ci=categories.indexOf(j.category);
            const c=PALETTE[ci>=0?ci%PALETTE.length:0];
            return (
              <div key={j.code} style={{background:"#0b0818",border:`1px solid ${c.border}`,borderRadius:6,padding:"5px 10px",display:"flex",alignItems:"center",gap:8}}>
                <div>
                  <div style={{fontFamily:"Barlow,sans-serif",fontSize:8,color:c.primary,letterSpacing:1}}>{j.category} · J{j.slot}{j.judge_name?" · "+j.judge_name:""}</div>
                  <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:12,letterSpacing:2,color:j.used?"#00c853":"#fff"}}>{j.code}</div>
                </div>
                <button onClick={()=>copy(j.code)} style={{background:"none",border:`1px solid ${c.border}`,borderRadius:4,color:c.primary,cursor:"pointer",fontFamily:"Bebas Neue,sans-serif",fontSize:9,padding:"2px 7px"}}>
                  {copied===j.code?"✓":"COPY"}
                </button>
              </div>
            );
          })}
        </div>
      )}
      {open&&codes.length===0&&!loading&&(
        <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#3d2080",marginTop:6}}>No judge codes found for this event.</div>
      )}
    </div>
  );
}

function AdminDashboard({ onBack, showToast }) {
  const [tab,setTab]=useState("events"); const [events,setEvents]=useState([]); const [loading,setLoading]=useState(true);
  const loadEvents=async()=>{setLoading(true);const{data}=await supabase.from("events").select("*").order("created_at",{ascending:false});setEvents(data||[]);setLoading(false);};
  useEffect(()=>{loadEvents();},[]);
  const deleteEvent=async(id,name)=>{if(!window.confirm(`Delete "${name}"?`))return;const{error}=await supabase.from("events").delete().eq("id",id);if(error)return showToast("Delete failed","error");showToast("Event deleted ✓");loadEvents();};
  return (
    <div className="hiphop-bg" style={{fontFamily:"'Bebas Neue',Impact,sans-serif",background:"linear-gradient(160deg,#0a0612 0%,#0d0a22 60%,#0a0e1a 100%)",minHeight:"100vh",color:"#fff"}}>
      <div style={{padding:"22px 22px 0",maxWidth:1100,margin:"0 auto"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:12,marginBottom:16}}>
          <div>
            <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:36,letterSpacing:4}}>DAN<span style={{color:"#a855f7"}}>BUZZ</span> <span style={{fontSize:14,color:"#60a5fa",letterSpacing:3}}>ADMIN</span></div>
            <div style={{fontFamily:"Barlow,sans-serif",fontSize:11,color:"#7755aa",marginTop:4}}>{events.length} events · Round flow is managed by Organizer</div>
          </div>
          <div style={{display:"flex",gap:8}}><button className="btn" style={{background:"#1c1232",color:"#c084fc",border:"1px solid #7c3aed44",fontSize:11}} onClick={loadEvents}>🔄 REFRESH</button><button className="btn" style={{background:"transparent",color:"#7755aa",border:"1px solid #2a1840",fontSize:11}} onClick={onBack}>← LOGOUT</button></div>
        </div>
        <div style={{display:"flex",borderBottom:"1px solid #1a1030"}}>
          {[{key:"events",label:"ALL EVENTS"},{key:"create",label:"+ CREATE EVENT"}].map(t=>(
            <button key={t.key} className="tbtn" style={{color:tab===t.key?"#ff4d4d":"#7755aa",borderBottom:tab===t.key?"3px solid #ff4d4d":"3px solid transparent"}} onClick={()=>setTab(t.key)}>{t.label}</button>
          ))}
        </div>
      </div>
      <div style={{padding:"20px 22px 40px",maxWidth:1100,margin:"0 auto"}}>
        {tab==="events"&&(
          <div className="slide">
            {loading?<div style={{textAlign:"center",padding:48}}><Spinner/></div>:events.length===0?(
              <div style={{textAlign:"center",padding:"48px",fontFamily:"Barlow,sans-serif",color:"#3d2080"}}>No events yet.</div>
            ):events.map(ev=>{
              const cats=ev.categories||[];
              return (
                <div key={ev.id} style={{background:"#120e22",border:"1px solid #2a1f4a",borderRadius:12,padding:"16px 20px",marginBottom:12}}>
                  {/* Top row: name + delete */}
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:10,marginBottom:10}}>
                    <div>
                      <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:18,letterSpacing:2}}>{ev.name}</div>
                      <div style={{fontFamily:"Barlow,sans-serif",fontSize:11,color:"#7755aa",marginTop:2}}>{ev.city} · {ev.start_date||ev.date}{ev.end_date&&ev.end_date!==ev.start_date?" → "+ev.end_date:""}</div>
                      <div style={{display:"flex",flexWrap:"wrap",gap:4,marginTop:6}}>
                        {cats.slice(0,5).map((cat,i)=>{const c=PALETTE[i%PALETTE.length];return <span key={cat} style={{fontFamily:"Barlow,sans-serif",fontSize:9,padding:"2px 8px",borderRadius:10,background:c.bg,border:`1px solid ${c.border}`,color:c.primary}}>{cat}</span>;})}
                        {cats.length>5&&<span style={{fontFamily:"Barlow,sans-serif",fontSize:9,color:"#55449a"}}>+{cats.length-5} more</span>}
                      </div>
                    </div>
                    <button className="btn" style={{fontSize:10,background:"#150608",color:"#ff4d4d",border:"1px solid #ff4d4d33"}} onClick={()=>deleteEvent(ev.id,ev.name)}>DELETE</button>
                  </div>
                  {/* All codes row */}
                  <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                    <div style={{background:"#0f0b1e",border:"1px solid #ff4d4d33",borderRadius:7,padding:"6px 12px"}}>
                      <div style={{fontFamily:"Barlow,sans-serif",fontSize:8,color:"#ff4d4d88",letterSpacing:2,marginBottom:2}}>ORG CODE</div>
                      <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:14,color:"#ff4d4d",letterSpacing:2}}>{ev.org_code}</div>
                    </div>
                    {ev.viewer_code&&<div style={{background:"#0f0b1e",border:"1px solid #00e5ff33",borderRadius:7,padding:"6px 12px"}}>
                      <div style={{fontFamily:"Barlow,sans-serif",fontSize:8,color:"#00e5ff88",letterSpacing:2,marginBottom:2}}>VIEWER CODE</div>
                      <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:14,color:"#00e5ff",letterSpacing:2}}>{ev.viewer_code}</div>
                    </div>}
                    {ev.emcee_code&&<div style={{background:"#0f0b1e",border:"1px solid #ff980033",borderRadius:7,padding:"6px 12px"}}>
                      <div style={{fontFamily:"Barlow,sans-serif",fontSize:8,color:"#ff980088",letterSpacing:2,marginBottom:2}}>EMCEE CODE</div>
                      <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:14,color:"#ff9800",letterSpacing:2}}>{ev.emcee_code}</div>
                    </div>}
                  </div>
                  {/* Judge codes (expandable) */}
                  <AdminEventJudgeCodes eventId={ev.id} categories={cats}/>
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
  const [form,setForm]=useState({name:"",start_date:"",end_date:"",city:"",organizer:""});
  const [categories,setCategories]=useState([]);
  const [customInput,setCustomInput]=useState("");
  const [judgeCounts,setJudgeCounts]=useState({});
  const [loading,setLoading]=useState(false);
  const [createdEvent,setCreatedEvent]=useState(null);
  const [copied,setCopied]=useState(null);

  const copy=(val)=>{navigator.clipboard?.writeText(val).catch(()=>{});setCopied(val);setTimeout(()=>setCopied(null),1500);};
  const addCategory=(cat)=>{const t=cat.trim();if(!t)return;if(categories.map(c=>c.toLowerCase()).includes(t.toLowerCase()))return showToast(`"${t}" already added!`,"error");setCategories(p=>[...p,t]);setCustomInput("");};
  const removeCategory=(cat)=>{setCategories(p=>p.filter(c=>c!==cat));setJudgeCounts(p=>{const n={...p};delete n[cat];return n;});};
  const toggleSuggested=(cat)=>categories.map(c=>c.toLowerCase()).includes(cat.toLowerCase())?removeCategory(cat):addCategory(cat);
  const submit=async()=>{
    if(!form.name.trim()||!form.start_date||!form.city.trim())return showToast("Fill event name, start date and city!","error");
    if(categories.length===0)return showToast("Add at least one category!","error");
    setLoading(true);
    const orgCode=genOrgCode(); const viewerCode=genViewerCode(); const emceeCode=genEmceeCode(); const prefix=randAlpha(3);
    const jCodes=genJudgeCodes(prefix,categories,judgeCounts);
    const{data:ev,error:evErr}=await supabase.from("events").insert({
      name:form.name.trim(),city:form.city.trim(),start_date:form.start_date,end_date:form.end_date||null,
      org_code:orgCode,viewer_code:viewerCode,emcee_code:emceeCode,categories,
      organizer_name:form.organizer.trim()||null,
      judge_counts:judgeCounts,rounds:["Prelims"]  // organizer will configure knockout rounds
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
        <div style={{fontFamily:"Barlow,sans-serif",fontSize:12,color:"#7755aa",marginBottom:20}}>{createdEvent.city} · {createdEvent.start_date}{createdEvent.end_date&&createdEvent.end_date!==createdEvent.start_date?" → "+createdEvent.end_date:""}</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:20}}>
          <div style={{background:"#110d22",border:"1px solid #ff4d4d44",borderRadius:12,padding:20}}>
            <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#ff4d4d",letterSpacing:3,marginBottom:8}}>ORGANIZER CODE</div>
            <div style={{display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
              <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:28,letterSpacing:5,color:"#ff4d4d"}}>{createdEvent.org_code}</div>
              <button className="btn" style={{fontSize:10,padding:"6px 14px",background:"transparent",border:"1px solid #ff4d4d44",color:"#ff4d4d"}} onClick={()=>copy(createdEvent.org_code)}>{copied===createdEvent.org_code?"✓ COPIED":"COPY"}</button>
            </div>
          </div>
          <div style={{background:"#110d22",border:"1px solid #00e5ff44",borderRadius:12,padding:20}}>
            <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#00e5ff",letterSpacing:3,marginBottom:8}}>VIEWER CODE</div>
            <div style={{display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
              <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:22,letterSpacing:3,color:"#00e5ff"}}>{createdEvent.viewer_code}</div>
              <button className="btn" style={{fontSize:10,padding:"6px 14px",background:"transparent",border:"1px solid #00e5ff44",color:"#00e5ff"}} onClick={()=>copy(createdEvent.viewer_code)}>{copied===createdEvent.viewer_code?"✓ COPIED":"COPY"}</button>
            </div>
            <div style={{fontFamily:"Barlow,sans-serif",fontSize:9,color:"#55449a",marginTop:4}}>Share with attendees for live event updates</div>
          </div>
          <div style={{background:"#110d22",border:"1px solid #ff980044",borderRadius:12,padding:20,gridColumn:"1 / -1"}}>
            <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#ff9800",letterSpacing:3,marginBottom:8}}>🎤 EMCEE CODE</div>
            <div style={{display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
              <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:28,letterSpacing:5,color:"#ff9800"}}>{createdEvent.emcee_code}</div>
              <button className="btn" style={{fontSize:10,padding:"6px 14px",background:"transparent",border:"1px solid #ff980044",color:"#ff9800"}} onClick={()=>copy(createdEvent.emcee_code)}>{copied===createdEvent.emcee_code?"✓ COPIED":"COPY"}</button>
            </div>
            <div style={{fontFamily:"Barlow,sans-serif",fontSize:9,color:"#55449a",marginTop:4}}>Separate code for Emcee only — different from the viewer code</div>
          </div>
        </div>
        <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#7755aa",letterSpacing:3,marginBottom:14}}>JUDGE CODES</div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(260px,1fr))",gap:12,marginBottom:24}}>
          {(createdEvent.categories||[]).map((cat,ci)=>{
            const c=PALETTE[ci%PALETTE.length];
            const catCodes=codes.filter(j=>j.category===cat);
            return (
              <div key={cat} style={{background:"#110d22",border:`1px solid ${c.border}`,borderRadius:10,padding:16}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                  <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:14,color:c.primary}}>{cat}</div>
                  <span style={{fontFamily:"Barlow,sans-serif",fontSize:9,padding:"2px 8px",borderRadius:20,background:"#ffd70011",border:"1px solid #ffd70044",color:"#ffd700"}}>PRELIMS: SCORE · KNOCKOUT: CHOICE</span>
                </div>
                {catCodes.map(j=>(
                  <div key={j.code} style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:7,padding:"7px 10px",background:"#160e2a",borderRadius:7}}>
                    <div><div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:13,letterSpacing:2}}>{j.code}</div><div style={{fontFamily:"Barlow,sans-serif",fontSize:9,color:"#7755aa"}}>Judge {j.slot}</div></div>
                    <button className="btn" style={{fontSize:9,padding:"4px 9px",background:"transparent",border:`1px solid ${c.primary}`,color:c.primary}} onClick={()=>copy(j.code)}>{copied===j.code?"✓":"COPY"}</button>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
        {/* ── SEND TO ORGANIZER ── */}
        <div style={{background:"#0a1a0a",border:"1px solid #00c85333",borderRadius:12,padding:20,marginBottom:16}}>
          <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:14,letterSpacing:3,color:"#00c853",marginBottom:4}}>📤 SEND CODES TO ORGANIZER</div>
          <div style={{fontFamily:"Barlow,sans-serif",fontSize:11,color:"#7755aa",marginBottom:14}}>Send all codes to the organizer via email or WhatsApp so they can log in and manage the event.</div>
          <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
            <a href={"mailto:?subject=Your DanBuzz Event: "+createdEvent.name+"&body=Hi,%0A%0AYour event has been set up on DanBuzz.%0A%0A--- YOUR CODES ---%0A%0AORGANIZER CODE (login to manage your event):%0A"+createdEvent.org_code+"%0A%0AATTENDEE %26 EMCEE CODE (share with emcee and audience):%0A"+createdEvent.viewer_code+"%0A%0AJUDGE CODES:%0A"+(createdEvent.judgeCodes||[]).map(j=>j.category+" - Judge "+j.slot+": "+j.code).join("%0A")+"%0A%0ALogin at: "+encodeURIComponent(window.location.origin)+"%0A%0A%E2%80%94 DanBuzz Team"}
              className="btn" style={{background:"#00c853",color:"#000",fontSize:12,padding:"10px 20px",textDecoration:"none",display:"inline-block"}}>
              ✉️ SEND VIA EMAIL
            </a>
            <a href={"https://wa.me/?text="+encodeURIComponent("*DanBuzz Event: "+createdEvent.name+"*\n\n*ORGANIZER CODE* (login to manage):\n"+createdEvent.org_code+"\n\n*ATTENDEE & EMCEE CODE:*\n"+createdEvent.viewer_code+"\n\n*JUDGE CODES:*\n"+(createdEvent.judgeCodes||[]).map(j=>j.category+" - Judge "+j.slot+": "+j.code).join("\n")+"\n\nLogin at: "+window.location.origin)}
              target="_blank" rel="noopener noreferrer"
              className="btn" style={{background:"#25D366",color:"#000",fontSize:12,padding:"10px 20px",textDecoration:"none",display:"inline-block"}}>
              💬 SEND VIA WHATSAPP
            </a>
            <button className="btn" style={{background:"#120e22",color:"#fff",border:"1px solid #3d2080",fontSize:12,padding:"10px 20px"}}
              onClick={()=>{
                const text="DanBuzz Event: "+createdEvent.name+"\n\nORGANIZER CODE:\n"+createdEvent.org_code+"\n\nATTENDEE & EMCEE CODE:\n"+createdEvent.viewer_code+"\n\nJUDGE CODES:\n"+(createdEvent.judgeCodes||[]).map(j=>j.category+" - Judge "+j.slot+": "+j.code).join("\n")+"\n\nLogin at: "+window.location.origin;
                navigator.clipboard?.writeText(text).catch(()=>{});
                setCopied("all");setTimeout(()=>setCopied(null),2000);
              }}>
              {copied==="all"?"✓ COPIED ALL":"📋 COPY ALL"}
            </button>
          </div>
        </div>
        <button className="btn" style={{background:"#120e22",color:"#fff",border:"1px solid #3d2080",fontSize:12}} onClick={()=>{setCreatedEvent(null);setForm({name:"",start_date:"",end_date:"",city:"",organizer:""});setCategories([]);setJudgeCounts({});onCreated();}}>← BACK TO ALL EVENTS</button>
      </div>
    );
  }

  return (
    <div className="slide" style={{maxWidth:640}}>
      <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:22,letterSpacing:3,marginBottom:20}}>CREATE NEW EVENT</div>
      <div style={{marginBottom:14}}>
        <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#7755aa",letterSpacing:2,marginBottom:6}}>ORGANIZER NAME <span style={{color:"#3d2080"}}>(optional)</span></div>
        <input className="inp" placeholder="e.g. Rhythmix Crew" value={form.organizer} onChange={e=>setForm(f=>({...f,organizer:e.target.value}))}/>
      </div>
      {[["Event Name","name","text","e.g. Danbuzz Open 2025"],["City / Venue","city","text","e.g. Imphal, Manipur"]].map(([label,key,type,ph])=>(
        <div key={key} style={{marginBottom:14}}>
          <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#7755aa",letterSpacing:2,marginBottom:6}}>{label}</div>
          <input className="inp" type={type} placeholder={ph} value={form[key]} onChange={e=>setForm(f=>({...f,[key]:e.target.value}))}/>
        </div>
      ))}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:14}}>
        <div>
          <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#7755aa",letterSpacing:2,marginBottom:6}}>START DATE <span style={{color:"#ff4d4d"}}>*</span></div>
          <input className="inp" type="date" value={form.start_date} onChange={e=>setForm(f=>({...f,start_date:e.target.value}))}/>
        </div>
        <div>
          <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#7755aa",letterSpacing:2,marginBottom:6}}>END DATE <span style={{color:"#3d2080"}}>(optional)</span></div>
          <input className="inp" type="date" value={form.end_date} onChange={e=>setForm(f=>({...f,end_date:e.target.value}))}/>
        </div>
      </div>

      {/* Categories */}
      <div>
        <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#7755aa",letterSpacing:2,marginBottom:10}}>CATEGORIES <span style={{color:"#ff4d4d"}}>*</span></div>
        <div style={{display:"flex",flexWrap:"wrap",gap:8,marginBottom:12}}>
          {SUGGESTED_CATEGORIES.map(cat=>{const isAdded=categories.map(c=>c.toLowerCase()).includes(cat.toLowerCase());return <button key={cat} className={`chip${isAdded?" active":""}`} onClick={()=>toggleSuggested(cat)}>{isAdded?"✓ ":"+ "}{cat}</button>;})}
        </div>
        <div style={{display:"flex",gap:8,marginBottom:16}}>
          <input className="inp" placeholder="Custom category..." value={customInput} onChange={e=>setCustomInput(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"){e.preventDefault();addCategory(customInput);}}}/>
          <button className="btn" style={{background:"#1c1232",color:"#fff",border:"1px solid #3d2080",whiteSpace:"nowrap"}} onClick={()=>addCategory(customInput)}>+ ADD</button>
        </div>
        {categories.length>0&&(
          <div style={{background:"#110d22",border:"1px solid #2a1f4a",borderRadius:12,padding:14,marginBottom:8}}>
            <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#7755aa",letterSpacing:2,marginBottom:10}}>CATEGORIES — Judges per category & Prelim scoring type</div>
            <div style={{display:"flex",flexDirection:"column",gap:7}}>
              {categories.map((cat,i)=>{
                const c=PALETTE[i%PALETTE.length]; const count=judgeCounts[cat]||3;
                return (
                  <div key={cat} style={{background:c.bg,border:`1px solid ${c.border}`,borderRadius:8,padding:"10px 12px"}}>
                    <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
                      <span style={{fontFamily:"Bebas Neue,sans-serif",fontSize:13,color:c.primary,flex:1}}>{cat}</span>
                      <span style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#7755aa"}}>Judges:</span>
                      <div style={{display:"flex",alignItems:"center",gap:4}}>
                        <button onClick={()=>setJudgeCounts(p=>({...p,[cat]:Math.max(1,(parseInt(p[cat])||1)-1)}))} style={{background:"#1c1232",border:"1px solid #3d2080",color:"#c0a8e8",borderRadius:4,width:28,height:28,cursor:"pointer",fontFamily:"Bebas Neue,sans-serif",fontSize:16,lineHeight:1}}>−</button>
                        <input
                          type="number" min="1"
                          value={judgeCounts[cat]||1}
                          onChange={e=>{const v=parseInt(e.target.value);if(!isNaN(v)&&v>=1)setJudgeCounts(p=>({...p,[cat]:v}));}}
                          style={{background:"#1c1232",border:"1px solid #3d2080",color:c.primary,borderRadius:4,width:48,height:28,textAlign:"center",fontFamily:"Bebas Neue,sans-serif",fontSize:16,outline:"none"}}
                        />
                        <button onClick={()=>setJudgeCounts(p=>({...p,[cat]:(parseInt(p[cat])||1)+1}))} style={{background:"#1c1232",border:"1px solid #3d2080",color:"#c0a8e8",borderRadius:4,width:28,height:28,cursor:"pointer",fontFamily:"Bebas Neue,sans-serif",fontSize:16,lineHeight:1}}>+</button>
                      </div>
                      <button onClick={()=>removeCategory(cat)} style={{background:"none",border:"none",color:"#7755aa",cursor:"pointer",fontSize:14,padding:0}}>✕</button>
                    </div>
                    <div style={{fontFamily:"Barlow,sans-serif",fontSize:9,color:"#55449a",marginTop:6}}>Prelims: score-based ranking → Knockout: 1v1 judge choice</div>
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
  const [orgCode,setOrgCode]=useState(""); const [memberName,setMemberName]=useState(""); const [loading,setLoading]=useState(false);
  const handleSubmit=async()=>{
    if(!orgCode.trim())return showToast("Enter the organizer code sent to you by DanBuzz!","error");
    if(!memberName.trim())return showToast("Enter your name (team member)!","error");
    setLoading(true);
    const{data,error}=await supabase.from("events").select("*").eq("org_code",orgCode.trim().toUpperCase()).single();
    if(error||!data){showToast("Invalid organizer code!","error");setLoading(false);return;}
    onLogin(data, memberName.trim());setLoading(false);
  };
  return (
    <div style={{minHeight:"100vh",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:32,background:"linear-gradient(160deg,#0a0612,#0d0a22,#0a0e1a)"}}>
      <div style={{width:"100%",maxWidth:360}}>
        <button className="btn" style={{background:"transparent",color:"#7755aa",border:"none",padding:0,marginBottom:24,fontSize:12,letterSpacing:2}} onClick={onBack}>← BACK</button>
        <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:26,letterSpacing:3,marginBottom:4}}>ORGANIZER LOGIN</div>
        <div style={{fontFamily:"Barlow,sans-serif",fontSize:12,color:"#7755aa",marginBottom:28}}>Enter the organizer code sent to you by DanBuzz. Multiple team members can log in with the same code.</div>
        <div style={{marginBottom:14}}>
          <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#7755aa",letterSpacing:2,marginBottom:6}}>YOUR NAME <span style={{color:"#ff4d4d"}}>*</span></div>
          <input className="inp" placeholder="e.g. Roshan / Team Lead" value={memberName} onChange={e=>setMemberName(e.target.value)} onKeyDown={e=>e.key==="Enter"&&handleSubmit()}/>
          <div style={{fontFamily:"Barlow,sans-serif",fontSize:9,color:"#55449a",marginTop:4}}>Multiple team members can access simultaneously with the same code</div>
        </div>
        <div style={{marginBottom:14}}>
          <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#7755aa",letterSpacing:2,marginBottom:6}}>ORGANIZER CODE</div>
          <input className="inp" placeholder="e.g. ORG-XYZ-1234" value={orgCode} onChange={e=>setOrgCode(e.target.value.toUpperCase())} onKeyDown={e=>e.key==="Enter"&&handleSubmit()} style={{letterSpacing:3,fontFamily:"Bebas Neue,sans-serif",fontSize:20}}/>
        </div>
        <button className="btn" style={{background:"linear-gradient(135deg,#7c3aed,#3b82f6)",color:"#fff",width:"100%",fontSize:14,padding:"13px"}} onClick={handleSubmit} disabled={loading}>{loading?<Spinner/>:"ENTER DASHBOARD →"}</button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// VIEWER LOGIN
// ─────────────────────────────────────────────────────────────────
function AttendeeLoginScreen({ onBack, onLogin, showToast }) {
  const [viewerCode,setViewerCode]=useState(""); const [name,setName]=useState(""); const [city,setCity]=useState("");
  const [phone,setPhone]=useState(""); const [loading,setLoading]=useState(false); const [event,setEvent]=useState(null);

  const lookupEvent=async()=>{
    if(!viewerCode.trim())return showToast("Enter the event code sent to you by the organizer!","error");
    setLoading(true);
    const{data,error}=await supabase.from("events").select("*").eq("viewer_code",viewerCode.trim().toUpperCase()).single();
    if(error||!data){showToast("Invalid event code!","error");setLoading(false);return;}
    setEvent(data);setLoading(false);
  };

  const handleRegister=async()=>{
    if(!name.trim()||!city.trim()||!phone.trim())return showToast("Fill in name, city and phone!","error");
    setLoading(true);
    let{error}=await supabase.from("attendees").insert({event_id:event.id,name:name.trim(),city:city.trim(),phone:phone.trim(),role:"attendee",category:null});
    if(error&&error.message&&error.message.toLowerCase().includes("category"))({error}=await supabase.from("attendees").insert({event_id:event.id,name:name.trim(),city:city.trim(),phone:phone.trim(),role:"attendee"}));
    if(error){showToast("Registration failed: "+error.message,"error");setLoading(false);return;}
    showToast("Registered! Loading live view...");
    onLogin({event,name:name.trim(),role:"attendee"});setLoading(false);
  };

  return (
    <div style={{minHeight:"100vh",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:32,background:"linear-gradient(160deg,#0a0612,#0d0a22,#0a0e1a)"}}>
      <div style={{width:"100%",maxWidth:400}}>
        <button className="btn" style={{background:"transparent",color:"#7755aa",border:"none",padding:0,marginBottom:24,fontSize:12,letterSpacing:2}} onClick={()=>{if(event)setEvent(null);else onBack();}}>← BACK</button>
        <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:26,letterSpacing:3,marginBottom:4}}>ATTENDEE REGISTRATION</div>
        <div style={{fontFamily:"Barlow,sans-serif",fontSize:12,color:"#7755aa",marginBottom:28}}>{!event?"Enter the event code sent to you by the organizer.":"Register as an attendee to follow this event live."}</div>
        {!event?(
          <>
            <div style={{marginBottom:14}}>
              <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#7755aa",letterSpacing:2,marginBottom:6}}>EVENT CODE</div>
              <input className="inp" placeholder="e.g. VIEW-ABCD-1234" value={viewerCode} onChange={e=>setViewerCode(e.target.value.toUpperCase())} onKeyDown={e=>e.key==="Enter"&&lookupEvent()} style={{letterSpacing:2,fontFamily:"Bebas Neue,sans-serif",fontSize:18}}/>
            </div>
            <button className="btn" style={{background:"linear-gradient(135deg,#00e5ff,#3b82f6)",color:"#000",width:"100%",fontSize:14,padding:"13px"}} onClick={lookupEvent} disabled={loading}>{loading?<Spinner/>:"FIND EVENT →"}</button>
          </>
        ):(
          <>
            <div style={{background:"#0d2222",border:"1px solid #00e5ff33",borderRadius:12,padding:"14px 18px",marginBottom:20}}>
              <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:20,letterSpacing:2,color:"#00e5ff"}}>{event.name}</div>
              <div style={{fontFamily:"Barlow,sans-serif",fontSize:11,color:"#7755aa"}}>{event.city} · {event.date}</div>
            </div>
            <div style={{background:"#001a1a",border:"1px solid #00e5ff22",borderRadius:8,padding:"8px 14px",marginBottom:14,fontFamily:"Barlow,sans-serif",fontSize:11,color:"#00e5ff88"}}>
              🎟 Registering as an Attendee — participants register via check-in at the event.
            </div>
            {[["Name",name,setName,"text"],["City",city,setCity,"text"],["Phone",phone,setPhone,"tel"]].map(([label,val,setter,type])=>(
              <div key={label} style={{marginBottom:12}}>
                <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#7755aa",letterSpacing:2,marginBottom:5}}>{label.toUpperCase()}</div>
                <input className="inp" type={type} placeholder={label} value={val} onChange={e=>setter(e.target.value)}/>
              </div>
            ))}
            <button className="btn" style={{background:"linear-gradient(135deg,#00e5ff,#3b82f6)",color:"#000",width:"100%",fontSize:14,padding:"13px",marginTop:8}} onClick={handleRegister} disabled={loading}>{loading?<Spinner/>:"REGISTER & FOLLOW LIVE →"}</button>
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
    if(!code.trim())return showToast("Enter the judge code sent to you by the organizer!","error");
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
    <div style={{minHeight:"100vh",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:32,background:"linear-gradient(160deg,#0a0612,#0d0a22,#0a0e1a)"}}>
      <div style={{width:"100%",maxWidth:400}}>
        <button className="btn" style={{background:"transparent",color:"#7755aa",border:"none",padding:0,marginBottom:24,fontSize:12,letterSpacing:2}} onClick={onBack}>← BACK</button>
        <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:26,letterSpacing:3,marginBottom:4}}>JUDGE LOGIN</div>
        <div style={{fontFamily:"Barlow,sans-serif",fontSize:12,color:"#7755aa",marginBottom:28}}>Enter the judge code sent to you by the organizer. First time? You'll be registered automatically.</div>
        <div style={{marginBottom:16}}>
          <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#7755aa",letterSpacing:2,marginBottom:6}}>JUDGE CODE</div>
          <input className="inp" placeholder="Code from your organizer" value={code} onChange={e=>setCode(e.target.value.toUpperCase())} style={{letterSpacing:2,fontFamily:"Bebas Neue,sans-serif",fontSize:18}}/>
        </div>
        <div style={{marginBottom:20}}>
          <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#7755aa",letterSpacing:2,marginBottom:6}}>YOUR NAME</div>
          <input className="inp" placeholder="Your full name" value={name} onChange={e=>setName(e.target.value)} onKeyDown={e=>e.key==="Enter"&&doLogin()}/>
        </div>
        <button className="btn" style={{background:"linear-gradient(135deg,#7c3aed,#3b82f6)",color:"#fff",width:"100%",fontSize:14,padding:"13px"}} onClick={doLogin} disabled={loading}>{loading?<Spinner/>:"LOGIN →"}</button>
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
  const { popup: liveNotif, history: notifHistory, dismissPopup } = useLiveNotifications(event.id, "judge");
  const [showNotifHistory, setShowNotifHistory] = useState(false);
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
    const [pRes,jcRes,bRes] = await Promise.all([
      supabase.from("participants").select("*").eq("event_id",event.id).eq("category",myCategory),
      supabase.from("judge_codes").select("*").eq("event_id",event.id).eq("category",myCategory),
      supabase.from("battle_decisions").select("*").eq("event_id",event.id).eq("category",myCategory),
    ]);
    // Load scores with category filter; fall back to event-only if category column is missing
    let sRes = await supabase.from("scores").select("*").eq("event_id",event.id).eq("category",myCategory);
    if(sRes.error && sRes.error.message && sRes.error.message.toLowerCase().includes("category")){
      sRes = await supabase.from("scores").select("*").eq("event_id",event.id);
    }
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
  // Total score = sum of all judge scores (not average) for ranking
  const getTotalScore = useCallback((pid)=>{
    const vals = Object.values(scoreMap[pid]||{});
    return vals.length ? vals.reduce((a,b)=>a+b,0) : 0;
  },[scoreMap]);
  const getScore   = useCallback((pid)=>getTotalScore(pid),[getTotalScore]);
  const getMyScore = useCallback((pid)=>scoreMap[pid]?.[myKey],[scoreMap,myKey]);
  const checkedIn  = useMemo(()=>participants.filter(p=>p.checked_in),[participants]);
  const prelimRanked = useMemo(()=>{
    return [...checkedIn].sort((a,b)=>{
      const sa = getTotalScore(a.id), sb = getTotalScore(b.id);
      if (sb !== sa) return sb - sa;
      // Tiebreaker 1: highest single judge score
      const aMax = Math.max(0, ...Object.values(scoreMap[a.id]||{}));
      const bMax = Math.max(0, ...Object.values(scoreMap[b.id]||{}));
      if (bMax !== aMax) return bMax - aMax;
      // Tiebreaker 2: name alphabetical (stable)
      return a.name.localeCompare(b.name);
    });
  },[checkedIn,getTotalScore,scoreMap]);

  // Participant lookup map for progressive seeding
  const participantMap = useMemo(()=>{
    const m={};participants.forEach(p=>{m[p.id]=p;});return m;
  },[participants]);

  // Build current round's battles using progressive seeding
  const currentBattles = useMemo(()=>{
    if(isPrelim) return [];
    return buildRoundBattles(currentRound, rounds, prelimRanked, battles, participantMap);
  },[isPrelim, currentRound, rounds, prelimRanked, battles, participantMap]);

  // Get my existing decision for a battle at the current active tie_round
  const getBattleDecisions = (mi) => battles.filter(b=>b.round===currentRound&&b.match_index===mi);
  const getMyDecision = (mi, tieRound) => battles.find(b=>b.round===currentRound&&b.match_index===mi&&b.judge_key===myKey&&(b.tie_round??0)===tieRound);

  const submitPrelimScore=async(pid)=>{
    const val=parseFloat(scoreInputs[pid]);
    if(isNaN(val)||val<1||val>10)return showToast("Score must be 1–10","error");
    const existing=scores.find(s=>s.participant_id===pid&&s.judge_key===myKey&&s.event_id===event.id);
    let error;
    if(existing){
      ({error}=await supabase.from("scores").update({score:val}).eq("id",existing.id));
    } else {
      ({error}=await supabase.from("scores").insert({participant_id:pid,event_id:event.id,category:myCategory,judge_key:myKey,score:val}));
      // If category column doesn't exist in schema, retry without it
      if(error&&error.message&&error.message.includes("category")){
        ({error}=await supabase.from("scores").insert({participant_id:pid,event_id:event.id,judge_key:myKey,score:val}));
      }
    }
    if(error)return showToast("Score failed: "+error.message,"error");
    setScoreInputs(prev=>({...prev,[pid]:""}));
    showToast("Score submitted ✓");
  };

  const submitBattleDecision=async(battle, winnerId, isTie, tieRound)=>{
    const winnerP = isTie ? null : [battle.p1,battle.p2,...(battle.p3?[battle.p3]:[])].find(p=>p.id===winnerId);
    const payload={
      event_id:event.id, category:myCategory, round:currentRound,
      match_index:battle.match_index,
      p1_id:battle.p1.id, p1_name:battle.p1.name,
      p2_id:battle.p2.id, p2_name:battle.p2.name,
      winner_id:isTie?null:winnerId,
      winner_name:isTie?null:winnerP?.name,
      is_tie:isTie,
      tie_round: tieRound,
      judge_key:myKey,
    };
    if(battle.p3){payload.p3_id=battle.p3.id;payload.p3_name=battle.p3.name;}
    const{error}=await supabase.from("battle_decisions").upsert(payload,{onConflict:"event_id,category,round,match_index,tie_round,judge_key"});
    if(error)return showToast("Failed to submit: "+error.message,"error");
    showToast(isTie?"🤝 Tie declared — extra battle required":"🏆 Winner submitted ✓");
    setBattleChoices(prev=>({...prev,[`${battle.match_index}-${tieRound}`]:null}));
  };

  if(loading)return <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:"#0a0612"}}><Spinner/></div>;

  return (
    <div className="hiphop-bg" style={{fontFamily:"'Bebas Neue',Impact,sans-serif",background:"linear-gradient(160deg,#0a0612 0%,#0d0a22 60%,#0a0e1a 100%)",minHeight:"100vh",color:"#fff"}}>
      <LiveNotifBanner popup={liveNotif} onDismiss={dismissPopup}/>
      <div style={{padding:"22px 22px 0",maxWidth:900,margin:"0 auto",marginTop:liveNotif?"60px":0}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:12,marginBottom:16}}>
          <div>
            <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:42,letterSpacing:5,lineHeight:1}}>{event.name}</div>
            <div style={{background:col.bg,border:`1px solid ${col.border}`,borderRadius:8,padding:"8px 14px",marginTop:8,display:"inline-flex",alignItems:"center",gap:10}}>
              <div className="pulse" style={{width:7,height:7,borderRadius:"50%",background:"#00c853"}}/>
              <div>
                <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:15,color:col.primary}}>{judgeCode.judge_name}</div>
                <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#7755aa"}}>Judge {judgeCode.slot} · {myCategory} · {isPrelim?"Prelims (score each dancer)":"Knockout (choose winner per battle)"}</div>
              </div>
            </div>
          </div>
          <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
            {rounds.length>0?(
              <select className="inp" style={{width:"auto",padding:"7px 32px 7px 11px",fontSize:12}} value={currentRound} onChange={e=>setCurrentRound(e.target.value)}>
                {rounds.map(r=><option key={r}>{r}</option>)}
              </select>
            ):(
              <div style={{fontFamily:"Barlow,sans-serif",fontSize:11,color:"#7755aa",padding:"7px 12px",background:"#120e22",borderRadius:8,border:"1px solid #2a1840"}}>Knockout not started yet</div>
            )}
            <button className="btn" style={{background:"#1c1232",color:"#c084fc",border:"1px solid #7c3aed44",fontSize:11}} onClick={()=>loadAll()}>🔄</button>
            <button className="btn" style={{background:showNotifHistory?"#ff980022":"transparent",color:"#ff9800",border:"1px solid #ff980033",fontSize:11,position:"relative"}} onClick={()=>setShowNotifHistory(p=>!p)}>
              🔔{notifHistory.length>0&&<span style={{position:"absolute",top:-4,right:-4,background:"#ff9800",color:"#000",borderRadius:"50%",width:14,height:14,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"Barlow,sans-serif",fontSize:8,fontWeight:700}}>{notifHistory.length}</span>}
            </button>
            <button className="btn" style={{background:"transparent",color:"#7755aa",border:"1px solid #2a1840",fontSize:11}} onClick={onBack}>← LOGOUT</button>
          </div>
        </div>
        {showNotifHistory&&(
          <div style={{marginBottom:16}}><NotificationHistoryPanel history={notifHistory} isHost={false}/></div>
        )}
        <div style={{display:"flex",borderBottom:"1px solid #1a1a1a",overflowX:"auto"}}>
          {[{key:"scoring",label:isPrelim?"PRELIM SCORING":"BATTLE JUDGING"},{key:"leaderboard",label:"LEADERBOARD"}].map(t=>(
            <button key={t.key} className="tbtn" style={{color:tab===t.key?col.primary:"#7755aa",borderBottom:tab===t.key?`3px solid ${col.primary}`:"3px solid transparent"}} onClick={()=>setTab(t.key)}>{t.label}</button>
          ))}
        </div>
      </div>

      <div style={{padding:"20px 22px 40px",maxWidth:900,margin:"0 auto"}}>

        {/* ── PRELIM SCORING ── */}
        {tab==="scoring"&&isPrelim&&(
          <div className="slide">
            <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:18,letterSpacing:3,color:col.primary,marginBottom:4}}>PRELIMS · {myCategory} · SCORE EACH DANCER</div>
            <div style={{fontFamily:"Barlow,sans-serif",fontSize:12,color:"#7755aa",marginBottom:6}}>
              Scoring as <span style={{color:col.primary}}>{judgeCode.judge_name}</span>. Give each dancer a score from 1–10 based on their solo performance.
            </div>
            <div style={{background:"#1a1a0a",border:"1px solid #ffd70033",borderRadius:8,padding:"8px 14px",marginBottom:18,fontFamily:"Barlow,sans-serif",fontSize:11,color:"#ffd700"}}>
              ⚡ Total score from all judges in this category determines prelim ranking and knockout seeding.
            </div>
            {checkedIn.length===0&&<div style={{textAlign:"center",padding:"48px",fontFamily:"Barlow,sans-serif",color:"#3d2080"}}>No checked-in participants yet</div>}
            {checkedIn.map(p=>{
              const myScore=getMyScore(p.id);
              return (
                <div key={p.id} className="card" style={{display:"flex",alignItems:"center",gap:12,flexWrap:"wrap",border:myScore!==undefined?`1px solid ${col.border}`:"1px solid #1e1e1e"}}>
                  <div style={{flex:1,minWidth:110}}>
                    <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:16}}>{p.name}</div>
                    <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#7755aa"}}>{p.city}</div>
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
            <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:18,letterSpacing:3,color:col.primary,marginBottom:4}}>{currentRound} · {myCategory} · PICK YOUR WINNER</div>
            <div style={{fontFamily:"Barlow,sans-serif",fontSize:12,color:"#7755aa",marginBottom:4}}>
              Tap a name card to vote. Battles with 3 dancers pick 1 winner from all three.
            </div>
            <div style={{background:"#1a1a0a",border:"1px solid #ffd70033",borderRadius:8,padding:"8px 14px",marginBottom:20,fontFamily:"Barlow,sans-serif",fontSize:11,color:"#ffd700"}}>
              ⚡ Each battle is judged independently. The winner advances to the next round.
            </div>
            {currentBattles.length===0&&<div style={{textAlign:"center",padding:"48px",fontFamily:"Barlow,sans-serif",color:"#3d2080"}}>No battles yet — prelim scores needed to seed matchups.</div>}
            {currentBattles.map(battle=>{
              const allDecs        = getBattleDecisions(battle.match_index);
              const resolved       = resolveBattle(allDecs);
              const activeTieRound = resolved.tie_round ?? 0;
              const currentTieRound = resolved.status === "tied" ? activeTieRound + 1 : activeTieRound;
              const myDec          = getMyDecision(battle.match_index, currentTieRound);
              const uiKey          = `${battle.match_index}-${currentTieRound}`;
              const uiChoice       = battleChoices[uiKey];
              const fighters       = [battle.p1, battle.p2, ...(battle.p3 ? [battle.p3] : [])];
              const is3way         = !!battle.p3;
              const chosen         = uiChoice?.winner_id ?? myDec?.winner_id;
              const tieChosen      = uiChoice?.is_tie ?? (!!myDec && myDec.is_tie);
              const isTieBreaker   = currentTieRound > 0;
              const isDecided      = resolved.status === "decided";

              return (
                <div key={battle.match_index} className="battle-card" style={{opacity:isDecided?0.75:1,marginBottom:20}}>
                  {/* Battle header */}
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 18px",background:"#0f0b1e",borderBottom:"1px solid #1a1a1a"}}>
                    <span style={{fontFamily:"Bebas Neue,sans-serif",fontSize:11,color:col.primary,letterSpacing:3}}>
                      BATTLE {battle.match_index+1}{is3way?" · 3-WAY":""}
                    </span>
                    <div style={{display:"flex",gap:6,alignItems:"center"}}>
                      {is3way&&<span className="badge" style={{background:"#ff980022",color:"#ff9800",border:"1px solid #ff980044"}}>3-WAY BATTLE</span>}
                      {isTieBreaker&&<span className="badge" style={{background:"#ffd70022",color:"#ffd700",border:"1px solid #ffd70044"}}>🔄 TIE BREAK ×{currentTieRound}</span>}
                      {isDecided&&<span className="badge" style={{background:"#00c85322",color:"#00c853",border:"1px solid #00c85344"}}>✓ DECIDED</span>}
                      {resolved.status==="tied"&&<span className="badge" style={{background:"#ffd70022",color:"#ffd700",border:"1px solid #ffd70044"}}>🤝 TIE — EXTRA BATTLE</span>}
                      {myDec&&!isDecided&&resolved.status!=="tied"&&<span className="badge" style={{background:"#00c85322",color:"#00c853",border:"1px solid #00c85344"}}>✓ VOTED</span>}
                    </div>
                  </div>

                  {isDecided?(
                    <div>
                      {fighters.map(p=>{
                        const isW=resolved.winner_id===p.id;
                        return (
                          <div key={p.id} style={{display:"flex",alignItems:"center",gap:12,padding:"14px 18px",background:isW?"#051a07":"#150608",borderBottom:"1px solid #1a1a1a",opacity:isW?1:0.4}}>
                            <div style={{flex:1}}><div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:20,color:isW?col.primary:"#fff"}}>{p.name}</div><div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#7755aa"}}>{p.city}</div></div>
                            {isW&&<span style={{fontFamily:"Bebas Neue,sans-serif",fontSize:14,color:col.primary}}>🏆 WINNER · ADVANCES</span>}
                          </div>
                        );
                      })}
                    </div>
                  ):(
                    <div>
                      {/* Name cards — 2-col for 2-way, 3-col for 3-way */}
                      <div style={{display:"grid",gridTemplateColumns:is3way?"1fr 1fr 1fr":"1fr 1fr",gap:0}}>
                        {fighters.map((p,fi)=>{
                          const isSelected = chosen===p.id && !tieChosen;
                          return (
                            <div key={p.id}
                              onClick={()=>setBattleChoices(prev=>({...prev,[uiKey]:{winner_id:p.id,is_tie:false}}))}
                              style={{
                                padding:"20px 14px",
                                background:isSelected?col.bg:"#160e2a",
                                border:`2px solid ${isSelected?col.primary:"transparent"}`,
                                borderRight:fi<fighters.length-1?"1px solid #1a1a1a":undefined,
                                cursor:"pointer",
                                textAlign:"center",
                                transition:"all .15s",
                              }}>
                              <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:9,color:"#55449a",marginBottom:6,letterSpacing:2}}>SEED #{fi+1+battle.match_index}</div>
                              <div style={{background:isSelected?col.primary:"#1c1232",borderRadius:10,padding:"14px 10px",margin:"0 auto",border:`1px solid ${isSelected?col.primary:"#3d2080"}`,transition:"all .15s"}}>
                                <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:is3way?17:22,color:isSelected?"#000":"#fff",lineHeight:1.1,wordBreak:"break-word"}}>{p.name}</div>
                                <div style={{fontFamily:"Barlow,sans-serif",fontSize:9,color:isSelected?"#00000088":"#7755aa",marginTop:3}}>{p.city}</div>
                              </div>
                              {isSelected&&<div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:10,color:col.primary,letterSpacing:2,marginTop:8}}>✓ SELECTED</div>}
                            </div>
                          );
                        })}
                      </div>

                      {/* Actions */}
                      <div style={{padding:"12px 18px",background:"#0b0818",display:"flex",gap:10,flexWrap:"wrap",alignItems:"center",borderTop:"1px solid #1a1a1a"}}>
                        {!is3way&&(
                          <button className="btn" style={{fontSize:11,background:tieChosen?"#ffd70022":"#1c1232",color:tieChosen?"#ffd700":"#7755aa",border:`1px solid ${tieChosen?"#ffd700":"#3d2080"}`}}
                            onClick={()=>setBattleChoices(prev=>({...prev,[uiKey]:{winner_id:null,is_tie:true}}))}>
                            🤝 {tieChosen?"✓ TIE CARD SELECTED":"TIE CARD"}
                          </button>
                        )}
                        {isTieBreaker&&(
                          <span style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#ffd700"}}>🔄 Extra battle ×{currentTieRound} — pick a winner</span>
                        )}
                        <button className="btn" style={{background:col.primary,color:"#000",fontSize:11}}
                          disabled={!uiChoice&&!myDec}
                          onClick={()=>{
                            const ch=uiChoice||{winner_id:chosen,is_tie:tieChosen};
                            if(!ch.is_tie&&!ch.winner_id)return showToast("Select a name card first!","error");
                            submitBattleDecision(battle,ch.winner_id,ch.is_tie,currentTieRound);
                          }}>
                          {myDec?"UPDATE →":"SUBMIT CARD →"}
                        </button>
                        {tieChosen&&!is3way&&<span style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#9980cc"}}>Both battle again · same dancers</span>}
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
              {isPrelim?"PRELIM RANKINGS · LIVE":"CURRENT ROUND MATCHUPS"} · {myCategory}
            </div>
            <div style={{fontFamily:"Barlow,sans-serif",fontSize:11,color:"#7755aa",marginBottom:4}}>
              {isPrelim?"Ranked by total score from all judges. Top qualifiers advance to knockout.":"Winners progress. Each round re-seeded from previous round's results."}
            </div>
            {isPrelim?(
              <div style={{background:"#0d0a1a",border:"1px solid #161616",borderRadius:12,overflow:"hidden"}}>
                {prelimRanked.map((p,i)=>(
                  <div key={p.id} className="lrow">
                    <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:20,color:i<3?col.primary:"#2a1840",minWidth:36}}>#{i+1}</div>
                    <div style={{flex:1}}>
                      <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:15}}>{p.name}</div>
                      <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#7755aa"}}>{p.city}</div>
                    </div>
                    <div style={{fontFamily:"Barlow,sans-serif",fontSize:9,color:"#7755aa",marginRight:8}}>TOTAL</div>
                    <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:22,color:i<3?col.primary:"#fff",minWidth:40,textAlign:"right"}}>{getScore(p.id)||"—"}</div>
                  </div>
                ))}
                {prelimRanked.length===0&&<div style={{padding:"40px",textAlign:"center",fontFamily:"Barlow,sans-serif",color:"#3d2080"}}>No scored participants yet</div>}
              </div>
            ):(
              <div style={{display:"flex",flexDirection:"column",gap:10}}>
                {currentBattles.map((b,i)=>{
                  const fighters=[b.p1,b.p2,...(b.p3?[b.p3]:[])];
                  return (
                  <div key={i} style={{background:"#120e22",border:"1px solid #2a1f4a",borderRadius:10,overflow:"hidden"}}>
                    <div style={{padding:"5px 14px",background:"#0b0818",fontFamily:"Bebas Neue,sans-serif",fontSize:10,letterSpacing:2,color:"#55449a"}}>BATTLE {i+1}{b.p3?" · 3-WAY":""}</div>
                    <div style={{display:"grid",gridTemplateColumns:b.p3?"1fr 1fr 1fr":"1fr auto 1fr"}}>
                      {fighters.map((p,fi)=>(
                        <div key={p.id} style={{padding:"12px 14px",borderRight:fi<fighters.length-1?"1px solid #1a1a1a":"none"}}>
                          <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:14,color:col.primary}}>{p.name}</div>
                          <div style={{fontFamily:"Barlow,sans-serif",fontSize:9,color:"#7755aa"}}>{p.city}</div>
                        </div>
                      ))}
                      {!b.p3&&<div style={{display:"flex",alignItems:"center",padding:"0 10px",fontFamily:"Bebas Neue,sans-serif",fontSize:12,color:"#3d2080"}}>VS</div>}
                    </div>
                  </div>
                  );
                })}
                {currentBattles.length===0&&<div style={{padding:"40px",textAlign:"center",fontFamily:"Barlow,sans-serif",color:"#3d2080"}}>Waiting for previous round results…</div>}
              </div>
            )}
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
  const [form,setForm]=useState({name:"",city:"",phone:"",payment_method:"cash"});
  const [loading,setLoading]=useState(false);
  const submit=async()=>{setLoading(true);await onAdd({...form,category:activeCat});setForm({name:"",city:"",phone:"",payment_method:"cash"});setLoading(false);};
  return (
    <div className="slide">
      <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:18,letterSpacing:3,color:col.primary,marginBottom:12}}>ADD PARTICIPANT · {activeCat}</div>
      <div className="card" style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr auto",gap:10,alignItems:"end"}}>
        {[["Dancer Name","name"],["City","city"],["Phone","phone"]].map(([label,key])=>(
          <div key={key}>
            <div style={{fontFamily:"Barlow,sans-serif",fontSize:9,color:"#7755aa",letterSpacing:2,marginBottom:5}}>{label.toUpperCase()}</div>
            <input className="inp" placeholder={label} value={form[key]} onChange={e=>setForm(f=>({...f,[key]:e.target.value}))} onKeyDown={e=>e.key==="Enter"&&submit()}/>
          </div>
        ))}
        <button className="btn" style={{background:col.primary,color:"#000"}} onClick={submit} disabled={loading}>{loading?<Spinner/>:"+ ADD"}</button>
      </div>
      <div className="card" style={{marginBottom:12,padding:"12px 18px"}}>
        <div style={{fontFamily:"Barlow,sans-serif",fontSize:9,color:"#7755aa",letterSpacing:2,marginBottom:8}}>PAYMENT METHOD</div>
        <div style={{display:"flex",gap:14}}>
          {[["cash","💵 Cash"],["online","📲 Online"]].map(([val,label])=>(
            <label key={val} style={{display:"flex",alignItems:"center",gap:7,cursor:"pointer",fontFamily:"Barlow,sans-serif",fontSize:12,color:form.payment_method===val?col.primary:"#8866bb",transition:"color .15s"}}>
              <input type="radio" name="payment_method" value={val} checked={form.payment_method===val} onChange={()=>setForm(f=>({...f,payment_method:val}))}
                style={{accentColor:col.primary,width:15,height:15,cursor:"pointer"}}/>
              {label}
            </label>
          ))}
        </div>
      </div>
      <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#55449a",letterSpacing:2,marginBottom:10}}>{catSorted.length} PARTICIPANTS</div>
      {catSorted.map((p,i)=>(
        <div key={p.id} className="lrow" style={{borderRadius:10,marginBottom:5,background:"#0d0a1a",border:"1px solid #161616"}}>
          <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:20,color:i<3?col.primary:"#2a1840",minWidth:36}}>#{i+1}</div>
          <div style={{flex:1}}>
            <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:15}}>{p.name}</div>
            <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#7755aa"}}>{p.city}{p.phone?` · ${p.phone}`:""}</div>
          </div>
          <span className="badge" style={{background:p.payment_method==="online"?"#00e5ff22":"#ffd70022",color:p.payment_method==="online"?"#00e5ff":"#ffd700",border:`1px solid ${p.payment_method==="online"?"#00e5ff44":"#ffd70044"}`,marginRight:4}}>{p.payment_method==="online"?"📲 ONLINE":"💵 CASH"}</span>
          <span className="badge" style={{background:p.checked_in?"#00c85322":"#ff4d4d22",color:p.checked_in?"#00c853":"#ff4d4d"}}>{p.checked_in?"✓ IN":"PENDING"}</span>
          <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:20,color:col.primary,minWidth:40,textAlign:"right"}}>{getScore(p.id)||"—"}</div>
        </div>
      ))}
      {catSorted.length===0&&<div style={{textAlign:"center",padding:"48px",fontFamily:"Barlow,sans-serif",color:"#3d2080",fontSize:13}}>No {activeCat} participants yet — add one above ↑</div>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// ORGANIZER: Attendee tab
// ─────────────────────────────────────────────────────────────────
function AttendeeTab({ event, col, showToast }) {
  const [form,setForm]=useState({name:"",city:"",phone:"",payment_method:"cash"});
  const [attendees,setAttendees]=useState([]);
  const [loading,setLoading]=useState(false); const [listLoading,setListLoading]=useState(true);
  const load=async()=>{setListLoading(true);const{data}=await supabase.from("attendees").select("*").eq("event_id",event.id).eq("role","attendee");setAttendees(data||[]);setListLoading(false);};
  useEffect(()=>{load();},[event.id]);
  const submit=async()=>{
    if(!form.name.trim()||!form.city.trim()||!form.phone.trim())return showToast("Fill name, city and phone!","error");
    setLoading(true);
    let{error}=await supabase.from("attendees").insert({event_id:event.id,name:form.name.trim(),city:form.city.trim(),phone:form.phone.trim(),role:"attendee",category:null,payment_method:form.payment_method||"cash"});
    if(error&&error.message&&(error.message.toLowerCase().includes("category")||error.message.toLowerCase().includes("payment_method")))({error}=await supabase.from("attendees").insert({event_id:event.id,name:form.name.trim(),city:form.city.trim(),phone:form.phone.trim(),role:"attendee"}));
    if(error){showToast("Failed: "+error.message,"error");setLoading(false);return;}
    showToast(`${form.name} registered as Viewer ✓`);
    setForm({name:"",city:"",phone:"",payment_method:"cash"});setLoading(false);load();
  };
  return (
    <div className="slide">
      <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:18,letterSpacing:3,color:col.primary,marginBottom:4}}>REGISTER VIEWER</div>
      <div style={{fontFamily:"Barlow,sans-serif",fontSize:11,color:"#7755aa",marginBottom:12}}>Participants register via check-in. Use this to manually register viewers/attendees.</div>
      <div className="card">
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10}}>
          {[["Name","name"],["City","city"],["Phone","phone"]].map(([label,key])=>(
            <div key={key}>
              <div style={{fontFamily:"Barlow,sans-serif",fontSize:9,color:"#7755aa",letterSpacing:2,marginBottom:5}}>{label.toUpperCase()}</div>
              <input className="inp" placeholder={label} value={form[key]} onChange={e=>setForm(f=>({...f,[key]:e.target.value}))}/>
            </div>
          ))}
        </div>
        <div style={{marginBottom:10}}>
          <div style={{fontFamily:"Barlow,sans-serif",fontSize:9,color:"#7755aa",letterSpacing:2,marginBottom:6}}>PAYMENT METHOD</div>
          <div style={{display:"flex",gap:14}}>
            {[["cash","💵 Cash"],["online","📲 Online"]].map(([val,label])=>(
              <label key={val} style={{display:"flex",alignItems:"center",gap:7,cursor:"pointer",fontFamily:"Barlow,sans-serif",fontSize:12,color:form.payment_method===val?col.primary:"#7755aa",transition:"color .15s"}}>
                <input type="radio" name="atab_payment" value={val} checked={form.payment_method===val} onChange={()=>setForm(f=>({...f,payment_method:val}))} style={{accentColor:col.primary,width:14,height:14,cursor:"pointer"}}/>
                {label}
              </label>
            ))}
          </div>
        </div>
        <button className="btn" style={{background:col.primary,color:"#000",width:"100%",marginTop:4}} onClick={submit} disabled={loading}>{loading?<Spinner/>:"+ REGISTER VIEWER"}</button>
      </div>
      <div style={{marginTop:8}}>
        <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:14,letterSpacing:3,color:"#00e5ff",marginBottom:8}}>VIEWERS ({attendees.length})</div>
        {listLoading?<Spinner/>:attendees.map(a=>(
          <div key={a.id} className="lrow" style={{borderRadius:8,background:"#0d0a1a",border:"1px solid #161616",marginBottom:5}}>
            <div style={{flex:1}}>
              <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:14}}>{a.name}</div>
              <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#7755aa"}}>{a.city}{a.phone?` · ${a.phone}`:""}</div>
            </div>
            <span className="badge" style={{background:a.payment_method==="online"?"#00e5ff22":"#ffd70022",color:a.payment_method==="online"?"#00e5ff":"#ffd700",border:`1px solid ${a.payment_method==="online"?"#00e5ff44":"#ffd70044"}`,fontSize:9,marginRight:4}}>{a.payment_method==="online"?"📲 ONLINE":"💵 CASH"}</span>
            <span className="badge" style={{background:"#00e5ff22",color:"#00e5ff",border:"1px solid #00e5ff44",fontSize:9}}>VIEWER</span>
          </div>
        ))}
        {attendees.length===0&&!listLoading&&<div style={{fontFamily:"Barlow,sans-serif",color:"#3d2080",fontSize:12,padding:"20px 0"}}>No viewers registered yet</div>}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// ORGANIZER: Bracket view — reads battle_decisions, shows majority winner
// ─────────────────────────────────────────────────────────────────
function BracketTab({ event, activeCat, col, prelimRanked, participantMap, showToast }) {
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
      <div style={{fontFamily:"Barlow,sans-serif",fontSize:11,color:"#55449a",marginBottom:4}}>RedBull BC One style — winners re-seed each round. Top vs Bottom matchups.</div>
      <div style={{background:"#1a1a0a",border:"1px solid #ffd70022",borderRadius:8,padding:"8px 14px",marginBottom:20,fontFamily:"Barlow,sans-serif",fontSize:10,color:"#9980cc"}}>
        Rank 1 vs Rank N · Rank 2 vs Rank N-1 · Winners form new ranking for next round
      </div>
      {loading?<Spinner/>:(
        <div style={{display:"flex",gap:24,overflowX:"auto",paddingBottom:20}}>
          {rounds.map(roundName=>{
            const roundBattles = buildRoundBattles(roundName, event.rounds||[], prelimRanked, battles, participantMap);
            const prevRoundDone = (() => {
              const ko = getKnockoutRounds(event.rounds||[]);
              const idx = ko.indexOf(roundName);
              if(idx===0) return true; // first round always available once prelims done
              const prev = ko[idx-1];
              const prevBattles = buildRoundBattles(prev, event.rounds||[], prelimRanked, battles, participantMap);
              return prevBattles.length > 0 && prevBattles.every(b=>{
                const decs = battles.filter(d=>d.round===prev&&d.match_index===b.match_index);
                return resolveBattle(decs).status==="decided";
              });
            })();
            return (
              <div key={roundName} style={{display:"flex",flexDirection:"column",gap:14,minWidth:220}}>
                <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:13,letterSpacing:3,color:prevRoundDone?col.primary:"#3d2080",textAlign:"center",marginBottom:4}}>{roundName}</div>
                {!prevRoundDone&&roundBattles.length===0?(
                  <div style={{fontFamily:"Barlow,sans-serif",color:"#3d2080",fontSize:11,textAlign:"center",padding:"20px 0"}}>Waiting for previous round…</div>
                ):roundBattles.length===0?(
                  <div style={{fontFamily:"Barlow,sans-serif",color:"#3d2080",fontSize:11,textAlign:"center",padding:"20px 0"}}>Need prelim scores to seed</div>
                ):roundBattles.map(battle=>{
                  const fighters = [battle.p1, battle.p2, ...(battle.p3?[battle.p3]:[])];
                  const is3way = !!battle.p3;
                  const decs   = battles.filter(b=>b.round===roundName&&b.match_index===battle.match_index);
                  const result = resolveBattle(decs);
                  const judgeCount = [...new Set(decs.filter(d=>(d.tie_round??0)===result.tie_round).map(d=>d.judge_key))].length;
                  const isTied = result.status === "tied";
                  const isDecided = result.status === "decided";
                  return (
                    <div key={battle.match_index} style={{background:"#120e22",border:`1px solid ${isDecided?col.border:isTied?"#ffd70044":"#2a1f4a"}`,borderRadius:10,overflow:"hidden"}}>
                      {is3way&&<div style={{padding:"3px 10px",background:"#1a0f00",fontFamily:"Barlow,sans-serif",fontSize:9,color:"#ff9800"}}>3-WAY BATTLE</div>}
                      {fighters.map((p,fi)=>{
                        const isWinner = isDecided && result.winner_id===p.id;
                        const isLoser  = isDecided && result.winner_id!==p.id;
                        return (
                          <div key={p.id} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 14px",background:isWinner?"#051a07":isLoser?"#150608":"#110d22",borderBottom:fi<fighters.length-1?"1px solid #1a1a1a":"none",opacity:isLoser?0.45:1}}>
                            <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:10,color:"#55449a",minWidth:20}}>#{fi+1}</div>
                            <div style={{flex:1}}>
                              <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:14,color:isWinner?col.primary:"#fff"}}>{p.name}</div>
                              <div style={{fontFamily:"Barlow,sans-serif",fontSize:9,color:"#7755aa"}}>{p.city}</div>
                            </div>
                            {isWinner&&<span style={{fontFamily:"Bebas Neue,sans-serif",fontSize:10,color:col.primary,letterSpacing:1}}>🏆 WIN</span>}
                          </div>
                        );
                      })}
                      <div style={{padding:"5px 14px",background:"#0b0818",fontFamily:"Barlow,sans-serif",fontSize:9,color:isTied?"#ffd700":isDecided?"#00c853":"#55449a"}}>
                        {isTied?`🤝 TIE × ${result.tie_round+1} — extra battle needed`:isDecided?`🏆 ${result.winner_name} advances`:`${judgeCount} judge${judgeCount!==1?"s":""} voted`}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// WINNER DASHBOARD — shown after Finals are decided
// Displayed in Attendee, Emcee, and Host views
// ─────────────────────────────────────────────────────────────────
function WinnerDashboard({ event, categories, participants, battles, allRounds }) {
  const knockoutRounds = (allRounds||[]).filter(r=>r!=="Prelims");
  const finalsRound = knockoutRounds[knockoutRounds.length-1];
  if (!finalsRound) return null;

  // For each category, find if finals are decided
  const results = categories.map(cat => {
    const catBattles = battles.filter(b=>b.category===cat);
    const scoreMap = {};
    // build a simple participantMap from participants
    const pMap = {};
    participants.filter(p=>p.category===cat).forEach(p=>{pMap[p.id]=p;});

    const finalsDecs = catBattles.filter(b=>b.round===finalsRound);
    if (!finalsDecs.length) return null;
    const matchIndices = [...new Set(finalsDecs.map(d=>d.match_index))];
    const matchIndex = matchIndices[0]; // finals should be 1 battle
    const decs = finalsDecs.filter(d=>d.match_index===matchIndex);
    const result = resolveBattle(decs);
    if (result.status !== "decided") return null;

    const champ = pMap[result.winner_id];
    // runner-up is the other finalist
    const p1Id = decs[0]?.p1_id;
    const p2Id = decs[0]?.p2_id;
    const runnerUpId = p1Id===result.winner_id ? p2Id : p1Id;
    const runnerUp = pMap[runnerUpId];
    if (!champ) return null;
    return { cat, champ, runnerUp };
  }).filter(Boolean);

  if (!results.length) return null;

  const col = (cat) => getCatColor(categories, cat);

  return (
    <div style={{padding:"0 22px 40px",maxWidth:900,margin:"0 auto"}}>
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:24,marginTop:8}}>
        <div style={{flex:1,height:1,background:"linear-gradient(to right,transparent,#ffd70044)"}}/>
        <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:11,letterSpacing:6,color:"#ffd700"}}>🏆 FINAL RESULTS</div>
        <div style={{flex:1,height:1,background:"linear-gradient(to left,transparent,#ffd70044)"}}/>
      </div>
      {results.map(({cat,champ,runnerUp})=>{
        const c = col(cat);
        return (
          <div key={cat} style={{marginBottom:32}}>
            <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:12,letterSpacing:4,color:c.primary,textAlign:"center",marginBottom:14}}>{cat}</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
              {/* Champion Card */}
              <div style={{
                background:`linear-gradient(160deg,#1c1400,#0e0a00)`,
                border:`2px solid ${c.primary}`,
                borderRadius:18,
                padding:"32px 20px 24px",
                textAlign:"center",
                position:"relative",
                boxShadow:`0 0 32px ${c.primary}22`,
              }}>
                <div style={{position:"absolute",top:-1,left:"50%",transform:"translateX(-50%)"}}>
                  <span style={{
                    fontFamily:"Barlow,sans-serif",fontSize:9,letterSpacing:3,
                    color:"#000",background:c.primary,
                    padding:"3px 16px",borderRadius:"0 0 10px 10px",
                    fontWeight:700,
                  }}>CHAMPION</span>
                </div>
                <div style={{fontSize:44,marginBottom:8,marginTop:8}}>🏆</div>
                <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:38,color:c.primary,lineHeight:1,marginBottom:6,letterSpacing:1}}>{champ.name}</div>
                <div style={{width:40,height:2,background:c.primary,margin:"0 auto 12px",borderRadius:2,opacity:.5}}/>
                <div style={{fontFamily:"Barlow,sans-serif",fontSize:11,color:"#9980cc",marginBottom:4,letterSpacing:1}}>{cat}</div>
                <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#7755aa"}}>{event.name}</div>
              </div>
              {/* Runner-Up Card */}
              {runnerUp ? (
                <div style={{
                  background:"linear-gradient(160deg,#141414,#0a0a0a)",
                  border:"2px solid #aaa",
                  borderRadius:18,
                  padding:"32px 20px 24px",
                  textAlign:"center",
                  position:"relative",
                  boxShadow:"0 0 20px #aaaaaa18",
                }}>
                  <div style={{position:"absolute",top:-1,left:"50%",transform:"translateX(-50%)"}}>
                    <span style={{
                      fontFamily:"Barlow,sans-serif",fontSize:9,letterSpacing:3,
                      color:"#000",background:"#bbb",
                      padding:"3px 16px",borderRadius:"0 0 10px 10px",
                      fontWeight:700,
                    }}>RUNNER-UP</span>
                  </div>
                  <div style={{fontSize:44,marginBottom:8,marginTop:8}}>🥈</div>
                  <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:38,color:"#ccc",lineHeight:1,marginBottom:6,letterSpacing:1}}>{runnerUp.name}</div>
                  <div style={{width:40,height:2,background:"#9980cc",margin:"0 auto 12px",borderRadius:2,opacity:.5}}/>
                  <div style={{fontFamily:"Barlow,sans-serif",fontSize:11,color:"#9980cc",marginBottom:4,letterSpacing:1}}>{cat}</div>
                  <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#7755aa"}}>{event.name}</div>
                </div>
              ):<div/>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// ATTENDEE DASHBOARD
// ─────────────────────────────────────────────────────────────────
function AttendeeDashboard({ event, attendeeName, onBack }) {
  const categories = event.categories||[];
  const allRounds  = event.rounds||["Prelims","Finals"];
  const { popup: liveNotif, history: notifHistory, dismissPopup } = useLiveNotifications(event.id, "attendee");
  const [showNotifHistory, setShowNotifHistory] = useState(false);
  // Attendees see knockout rounds in selector; prelims shown as leaderboard when no knockout active
  const rounds     = allRounds.filter(r=>r!=="Prelims");
  const [activeCat,setActiveCat]=useState(categories[0]||"");
  const [currentRound,setCurrentRound]=useState(rounds[0]||"");
  const col=getCatColor(categories,activeCat);
  const isPrelim=false; // attendees never see prelims scoring — only total leaderboard

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
  const getScore=(pid)=>{const vals=Object.values(scoreMap[pid]||{});return vals.length?vals.reduce((a,b)=>a+b,0):0;};
  const checkedIn=participants.filter(p=>p.category===activeCat&&p.checked_in);
  const prelimRanked=[...checkedIn].sort((a,b)=>{
    const sa=getScore(a.id),sb=getScore(b.id);
    if(sb!==sa)return sb-sa;
    const aMax=Math.max(0,...Object.values(scoreMap[a.id]||{}));
    const bMax=Math.max(0,...Object.values(scoreMap[b.id]||{}));
    if(bMax!==aMax)return bMax-aMax;
    return a.name.localeCompare(b.name);
  });
  const participantMap={};participants.forEach(p=>{participantMap[p.id]=p;});
  const currentBattles=currentRound?buildRoundBattles(currentRound, allRounds, prelimRanked, battles.filter(b=>b.category===activeCat), participantMap):[];

  if(loading)return <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:"#0a0612"}}><Spinner/></div>;

  return (
    <div className="hiphop-bg" style={{fontFamily:"'Bebas Neue',Impact,sans-serif",background:"linear-gradient(160deg,#0a0612 0%,#0d0a22 60%,#0a0e1a 100%)",minHeight:"100vh",color:"#fff"}}>
      <LiveNotifBanner popup={liveNotif} onDismiss={dismissPopup}/>
      <div style={{padding:"22px 22px 0",maxWidth:900,margin:"0 auto",marginTop:liveNotif?"60px":0}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:12,marginBottom:16}}>
          <div>
            <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:48,letterSpacing:5,lineHeight:1}}>{event.name}</div>
            <div style={{fontFamily:"Barlow,sans-serif",fontSize:11,color:col.primary,letterSpacing:4,marginTop:2}}>{event.city} · {event.start_date||event.date}{event.end_date&&event.end_date!==event.start_date?" → "+event.end_date:""}</div>
            <div style={{display:"flex",alignItems:"center",gap:6,marginTop:6}}>
              <div className="pulse" style={{width:7,height:7,borderRadius:"50%",background:"#00c853"}}/>
              <span style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#55449a",letterSpacing:2}}>LIVE · Attendee: {attendeeName}</span>
            </div>
          </div>
          <div style={{display:"flex",gap:8,alignItems:"center"}}>
            <select className="inp" style={{width:"auto",padding:"7px 32px 7px 11px",fontSize:12}} value={currentRound} onChange={e=>setCurrentRound(e.target.value)}>
              <option value="">📊 Prelim Rankings</option>
              {rounds.map(r=><option key={r}>{r}</option>)}
            </select>
            <button className="btn" style={{background:"#1c1232",color:"#c084fc",border:"1px solid #7c3aed44",fontSize:11}} onClick={()=>{setLoading(true);Promise.all([supabase.from("participants").select("*").eq("event_id",event.id),supabase.from("scores").select("*").eq("event_id",event.id),supabase.from("battle_decisions").select("*").eq("event_id",event.id)]).then(([p,s,b])=>{if(p.data)setParticipants(p.data);if(s.data)setScores(s.data);if(b.data)setBattles(b.data);setLoading(false);})}}>🔄</button>
            <button className="btn" style={{background:"transparent",color:"#7755aa",border:"1px solid #2a1840",fontSize:11}} onClick={onBack}>← EXIT</button>
            <button className="btn" style={{background:showNotifHistory?"#ff980022":"transparent",color:"#ff9800",border:"1px solid #ff980033",fontSize:11,position:"relative"}} onClick={()=>setShowNotifHistory(p=>!p)}>
              🔔{notifHistory.length>0&&<span style={{position:"absolute",top:-4,right:-4,background:"#ff9800",color:"#000",borderRadius:"50%",width:14,height:14,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"Barlow,sans-serif",fontSize:8,fontWeight:700}}>{notifHistory.length}</span>}
            </button>
          </div>
        </div>
        {showNotifHistory&&(
          <div style={{marginBottom:16}}>
            <NotificationHistoryPanel history={notifHistory} isHost={false}/>
          </div>
        )}
        <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:0}}>
          {categories.map(cat=>{const c=getCatColor(categories,cat);const cnt=participants.filter(p=>p.category===cat&&p.checked_in).length;const active=activeCat===cat;return <button key={cat} className="btn" style={{fontSize:11,padding:"7px 14px",background:active?c.primary:"#120e22",color:active?"#000":"#7755aa",border:`1px solid ${active?c.primary:"#2a1840"}`}} onClick={()=>setActiveCat(cat)}>{cat} <span style={{opacity:.7}}>({cnt})</span></button>;})}
        </div>
      </div>

      <div style={{padding:"20px 22px 40px",maxWidth:900,margin:"0 auto"}}>
        {/* Check if finals are decided across any category — show winner dashboard */}
        {(()=>{
          const knockoutRounds=(allRounds||[]).filter(r=>r!=="Prelims");
          const finalsRound=knockoutRounds[knockoutRounds.length-1];
          const finalsDecided=finalsRound&&categories.some(cat=>{
            const decs=battles.filter(b=>b.category===cat&&b.round===finalsRound);
            if(!decs.length)return false;
            const mi=[...new Set(decs.map(d=>d.match_index))][0];
            return resolveBattle(decs.filter(d=>d.match_index===mi)).status==="decided";
          });
          if(finalsDecided){
            return <WinnerDashboard event={event} categories={categories} participants={participants} battles={battles} allRounds={allRounds}/>;
          }
          return (
            <>
              <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:18,letterSpacing:3,color:col.primary,marginBottom:16}}>{currentRound} · {activeCat}</div>
              {!currentRound?(
                <div>
                  <div style={{background:"#110d22",border:"1px solid #ffd70022",borderRadius:8,padding:"8px 14px",marginBottom:14,fontFamily:"Barlow,sans-serif",fontSize:11,color:"#ffd700"}}>
                    🎵 Prelims in progress — live rankings update as judges score each dancer.
                  </div>
                  <div style={{background:"#0d0a1a",border:"1px solid #170f2c",borderRadius:12,overflow:"hidden"}}>
                    {prelimRanked.length===0&&(
                      <div style={{padding:"40px",textAlign:"center",fontFamily:"Barlow,sans-serif",color:"#3d2080"}}>Scoring in progress — rankings will appear here soon</div>
                    )}
                    {prelimRanked.map((p,i)=>(
                      <div key={p.id} className="lrow" style={{background:i===0?"#091407":i===1?"#080f05":i===2?"#070d04":"transparent"}}>
                        <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:22,color:i<3?col.primary:"#2a1840",minWidth:40}}>#{i+1}</div>
                        <div style={{flex:1}}>
                          <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:16}}>{p.name}</div>
                          <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#7755aa"}}>{p.city}</div>
                        </div>
                        {getScore(p.id)>0?(
                          <div style={{textAlign:"right"}}>
                            <div style={{fontFamily:"Barlow,sans-serif",fontSize:8,color:"#55449a",letterSpacing:2,marginBottom:1}}>TOTAL</div>
                            <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:24,color:i<3?col.primary:"#fff",lineHeight:1}}>{getScore(p.id)}</div>
                          </div>
                        ):(
                          <span style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#3d2080"}}>scoring…</span>
                        )}
                      </div>
                    ))}
                  </div>
                  <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#3d2080",textAlign:"center",marginTop:10}}>
                    Showing total score only · Individual judge scores are private
                  </div>
                </div>
              ):(
                <div style={{display:"flex",flexDirection:"column",gap:14}}>
                  {currentBattles.map(battle=>{
                    const fighters=[battle.p1,battle.p2,...(battle.p3?[battle.p3]:[])];
                    const is3way=!!battle.p3;
                    const decs=battles.filter(b=>b.round===currentRound&&b.match_index===battle.match_index&&b.category===activeCat);
                    const result=resolveBattle(decs);
                    const isDecided=result.status==="decided";
                    const isTied=result.status==="tied";
                    return (
                      <div key={battle.match_index} className="battle-card">
                        <div style={{padding:"8px 18px",background:"#0b0818",fontFamily:"Bebas Neue,sans-serif",fontSize:11,color:col.primary,letterSpacing:3,borderBottom:"1px solid #1a1a1a"}}>
                          BATTLE {battle.match_index+1}{is3way?" · 3-WAY":""}
                          {isDecided&&<span style={{color:"#00c853",marginLeft:12}}>✓ DECIDED</span>}
                          {isTied&&<span style={{color:"#e2e8f0",marginLeft:12,background:"#ffffff15",padding:"2px 8px",borderRadius:6,border:"1px solid #ffffff33"}}>🤝 TIE — EXTRA BATTLE × {result.tie_round+1}</span>}
                        </div>
                        {fighters.map((p,fi)=>{
                          const isWinner=isDecided&&result.winner_id===p.id;
                          const isLoser=isDecided&&result.winner_id!==p.id;
                          return (
                            <div key={p.id} style={{display:"flex",alignItems:"center",gap:12,padding:"14px 18px",background:isWinner?"#051a07":isLoser?"#150608":"#110d22",borderBottom:fi<fighters.length-1?"1px solid #1a1a1a":"none",opacity:isLoser?0.45:1}}>
                              <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:10,color:"#55449a",minWidth:24}}>#{fi+1}</div>
                              <div style={{flex:1}}><div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:20,color:isWinner?col.primary:"#fff"}}>{p.name}</div><div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#7755aa"}}>{p.city}</div></div>
                              {isWinner&&<span style={{fontFamily:"Bebas Neue,sans-serif",fontSize:14,color:col.primary,letterSpacing:2}}>🏆 WINNER → ADVANCES</span>}
                            </div>
                          );
                        })}
                        {result.status==="pending"&&<div style={{padding:"8px 18px",background:"#0a0612",fontFamily:"Barlow,sans-serif",fontSize:10,color:"#55449a"}}>Judges deciding…</div>}
                        {isTied&&<div style={{padding:"8px 18px",background:"#13111a",fontFamily:"Barlow,sans-serif",fontSize:10,color:"#ffd700"}}>🔄 Same dancers battle again — tie ×{result.tie_round+1}</div>}
                      </div>
                    );
                  })}
                  {currentBattles.length===0&&<div style={{textAlign:"center",padding:"48px",fontFamily:"Barlow,sans-serif",color:"#3d2080"}}>Waiting for bracket to begin…</div>}
                </div>
              )}
            </>
          );
        })()}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// EMCEE LOGIN
// Uses the same viewer_code as attendees, but with role "emcee"
// ─────────────────────────────────────────────────────────────────
function EmceeLoginScreen({ onBack, onLogin, showToast }) {
  const [code,setCode]=useState(""); const [name,setName]=useState(""); const [loading,setLoading]=useState(false);
  const handleLogin=async()=>{
    if(!code.trim())return showToast("Enter the event code sent to you by the organizer!","error");
    if(!name.trim())return showToast("Enter your name!","error");
    setLoading(true);
    const upper=code.trim().toUpperCase();
    // Try emcee_code first (new), fall back to viewer_code for backwards compat
    let{data,error}=await supabase.from("events").select("*").eq("emcee_code",upper).single();
    if(error||!data)({data,error}=await supabase.from("events").select("*").eq("viewer_code",upper).single());
    if(error||!data){showToast("Invalid emcee code!","error");setLoading(false);return;}
    showToast(`Welcome, ${name.trim()}! Loading Emcee dashboard…`);
    onLogin({event:data,name:name.trim()});setLoading(false);
  };
  return (
    <div style={{minHeight:"100vh",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:32,background:"linear-gradient(160deg,#0a0612,#0d0a22,#0a0e1a)"}}>
      <div style={{width:"100%",maxWidth:400}}>
        <button className="btn" style={{background:"transparent",color:"#7755aa",border:"none",padding:0,marginBottom:24,fontSize:12,letterSpacing:2}} onClick={onBack}>← BACK</button>
        <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:26,letterSpacing:3,marginBottom:4}}>🎤 EMCEE LOGIN</div>
        <div style={{fontFamily:"Barlow,sans-serif",fontSize:12,color:"#7755aa",marginBottom:28}}>Enter the event code sent to you by the organizer and your name to access the Emcee dashboard.</div>
        <div style={{marginBottom:14}}>
          <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#7755aa",letterSpacing:2,marginBottom:6}}>EVENT CODE</div>
          <input className="inp" placeholder="e.g. EMCEE-ABCD-1234" value={code} onChange={e=>setCode(e.target.value.toUpperCase())} style={{letterSpacing:2,fontFamily:"Bebas Neue,sans-serif",fontSize:18}} onKeyDown={e=>e.key==="Enter"&&handleLogin()}/>
        </div>
        <div style={{marginBottom:20}}>
          <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#7755aa",letterSpacing:2,marginBottom:6}}>YOUR NAME</div>
          <input className="inp" placeholder="Your full name" value={name} onChange={e=>setName(e.target.value)} onKeyDown={e=>e.key==="Enter"&&handleLogin()}/>
        </div>
        <button className="btn" style={{background:"linear-gradient(135deg,#ff9800,#ff6b00)",color:"#000",width:"100%",fontSize:14,padding:"13px"}} onClick={handleLogin} disabled={loading}>{loading?<Spinner/>:"ENTER EMCEE DASHBOARD →"}</button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// EMCEE DASHBOARD
// Full read-only view: all participants, all rounds, all battle
// results live. Plus live notification banner. No scoring/voting.
// ─────────────────────────────────────────────────────────────────
function EmceeDashboard({ event, emceeName, onBack }) {
  const categories   = event.categories||[];
  const rounds       = event.rounds||["Prelims","Finals"];
  const [activeCat,setActiveCat]     = useState(categories[0]||"");
  const [currentRound,setCurrentRound] = useState(rounds[0]||"Prelims");
  const col          = getCatColor(categories,activeCat);
  const isPrelim     = currentRound==="Prelims";
  const { popup: liveNotif, history: notifHistory, dismissPopup } = useLiveNotifications(event.id, "emcee");
  const [showNotifHistory, setShowNotifHistory] = useState(false);

  const [participants,setParticipants] = useState([]);
  const [scores,setScores]             = useState([]);
  const [battles,setBattles]           = useState([]);
  const [loading,setLoading]           = useState(true);

  const loadEmcee=useCallback(async()=>{
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
  },[event.id]);

  useEffect(()=>{
    loadEmcee();
    const pCh=supabase.channel(`ep-${event.id}`).on("postgres_changes",{event:"INSERT",schema:"public",table:"participants",filter:`event_id=eq.${event.id}`},(p)=>setParticipants(prev=>[...prev,p.new])).on("postgres_changes",{event:"UPDATE",schema:"public",table:"participants",filter:`event_id=eq.${event.id}`},(p)=>setParticipants(prev=>prev.map(x=>x.id===p.new.id?p.new:x))).subscribe();
    const sCh=supabase.channel(`es-${event.id}`).on("postgres_changes",{event:"INSERT",schema:"public",table:"scores",filter:`event_id=eq.${event.id}`},(p)=>setScores(prev=>[...prev,p.new])).on("postgres_changes",{event:"UPDATE",schema:"public",table:"scores",filter:`event_id=eq.${event.id}`},(p)=>setScores(prev=>prev.map(s=>s.id===p.new.id?p.new:s))).subscribe();
    const bCh=supabase.channel(`eb-${event.id}`).on("postgres_changes",{event:"INSERT",schema:"public",table:"battle_decisions",filter:`event_id=eq.${event.id}`},(p)=>setBattles(prev=>[...prev,p.new])).on("postgres_changes",{event:"UPDATE",schema:"public",table:"battle_decisions",filter:`event_id=eq.${event.id}`},(p)=>setBattles(prev=>prev.map(b=>b.id===p.new.id?p.new:b))).subscribe();
    return()=>{supabase.removeChannel(pCh);supabase.removeChannel(sCh);supabase.removeChannel(bCh);};
  },[event.id]);

  const scoreMap={};
  scores.forEach(s=>{if(!scoreMap[s.participant_id])scoreMap[s.participant_id]={};scoreMap[s.participant_id][s.judge_key]=s.score;});
  const getScore=(pid)=>{const vals=Object.values(scoreMap[pid]||{});return vals.length?vals.reduce((a,b)=>a+b,0):0;};
  const catParts     = participants.filter(p=>p.category===activeCat);
  const checkedIn    = catParts.filter(p=>p.checked_in);
  const prelimRanked = [...checkedIn].sort((a,b)=>{
    const sa=getScore(a.id),sb=getScore(b.id);
    if(sb!==sa)return sb-sa;
    const aMax=Math.max(0,...Object.values(scoreMap[a.id]||{}));
    const bMax=Math.max(0,...Object.values(scoreMap[b.id]||{}));
    if(bMax!==aMax)return bMax-aMax;
    return a.name.localeCompare(b.name);
  });
  const participantMap={};participants.forEach(p=>{participantMap[p.id]=p;});
  const currentBattles=isPrelim?[]:buildRoundBattles(currentRound,rounds,prelimRanked,battles.filter(b=>b.category===activeCat),participantMap);

  if(loading)return <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:"#0a0612"}}><Spinner/></div>;

  return (
    <div className="hiphop-bg" style={{fontFamily:"'Bebas Neue',Impact,sans-serif",background:"linear-gradient(160deg,#0a0612 0%,#0d0a22 60%,#0a0e1a 100%)",minHeight:"100vh",color:"#fff"}}>
      <LiveNotifBanner popup={liveNotif} onDismiss={dismissPopup}/>
      <div style={{padding:"22px 22px 0",maxWidth:1000,margin:"0 auto",marginTop:liveNotif?"60px":0}}>

        {/* Header */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:12,marginBottom:12}}>
          <div>
            <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:48,letterSpacing:5,lineHeight:1}}>{event.name}</div>
            <div style={{fontFamily:"Barlow,sans-serif",fontSize:11,color:col.primary,letterSpacing:3,marginTop:2}}>
              {event.city} · {event.start_date||event.date}{event.end_date&&event.end_date!==event.start_date?" → "+event.end_date:""}
            </div>
            <div style={{display:"flex",alignItems:"center",gap:6,marginTop:6}}>
              <div className="pulse" style={{width:7,height:7,borderRadius:"50%",background:"#ff9800"}}/>
              <span style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#ff9800",letterSpacing:2}}>🎤 EMCEE · {emceeName}</span>
            </div>
          </div>
          <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
            <select className="inp" style={{width:"auto",padding:"7px 32px 7px 11px",fontSize:12}} value={currentRound} onChange={e=>setCurrentRound(e.target.value)}>
              {rounds.map(r=><option key={r}>{r}</option>)}
            </select>
            <button className="btn" style={{background:"#1c1232",color:"#c084fc",border:"1px solid #7c3aed44",fontSize:11}} onClick={loadEmcee}>🔄</button>
            <button className="btn" style={{background:showNotifHistory?"#ff980022":"transparent",color:"#ff9800",border:"1px solid #ff980033",fontSize:11,position:"relative"}} onClick={()=>setShowNotifHistory(p=>!p)}>
              🔔{notifHistory.length>0&&<span style={{position:"absolute",top:-4,right:-4,background:"#ff9800",color:"#000",borderRadius:"50%",width:14,height:14,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"Barlow,sans-serif",fontSize:8,fontWeight:700}}>{notifHistory.length}</span>}
            </button>
            <button className="btn" style={{background:"transparent",color:"#7755aa",border:"1px solid #2a1840",fontSize:11}} onClick={onBack}>← EXIT</button>
          </div>
        </div>
        {showNotifHistory&&(
          <div style={{marginBottom:16}}><NotificationHistoryPanel history={notifHistory} isHost={false}/></div>
        )}

        {/* Category tabs */}
        <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:16}}>
          {categories.map(cat=>{const c=getCatColor(categories,cat);const cnt=participants.filter(p=>p.category===cat&&p.checked_in).length;const active=activeCat===cat;return <button key={cat} className="btn" style={{fontSize:11,padding:"7px 14px",background:active?c.primary:"#120e22",color:active?"#000":"#7755aa",border:`1px solid ${active?c.primary:"#2a1840"}`}} onClick={()=>setActiveCat(cat)}>{cat} <span style={{opacity:.7}}>({cnt})</span></button>;})}
        </div>

        {/* Stats bar */}
        <div style={{display:"flex",gap:10,marginBottom:16,flexWrap:"wrap"}}>
          {[
            {label:"TOTAL IN CATEGORY",val:catParts.length,color:"#fff"},
            {label:"CHECKED IN",val:checkedIn.length,color:"#00c853"},
            {label:"SCORED",val:checkedIn.filter(p=>getScore(p.id)>0).length,color:"#ffd700"},
            {label:"BATTLES",val:battles.filter(b=>b.category===activeCat).length,color:"#ff9800"},
          ].map(s=>(
            <div key={s.label} style={{background:"#110d22",border:"1px solid #181818",borderRadius:8,padding:"8px 14px",textAlign:"center"}}>
              <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:24,color:s.color,lineHeight:1}}>{s.val}</div>
              <div style={{fontFamily:"Barlow,sans-serif",fontSize:8,color:"#55449a",letterSpacing:2,marginTop:2}}>{s.label}</div>
            </div>
          ))}
        </div>
      </div>

      <div style={{padding:"0 22px 40px",maxWidth:1000,margin:"0 auto"}}>
        {(()=>{
          const knockoutRounds2=rounds.filter(r=>r!=="Prelims");
          const finalsRound2=knockoutRounds2[knockoutRounds2.length-1];
          const finalsDecided2=finalsRound2&&categories.some(cat=>{
            const decs=battles.filter(b=>b.category===cat&&b.round===finalsRound2);
            if(!decs.length)return false;
            const mi=[...new Set(decs.map(d=>d.match_index))][0];
            return resolveBattle(decs.filter(d=>d.match_index===mi)).status==="decided";
          });
          if(finalsDecided2){
            return <WinnerDashboard event={event} categories={categories} participants={participants} battles={battles} allRounds={rounds}/>;
          }
          return (
            <>
              <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:16,letterSpacing:3,color:col.primary,marginBottom:14}}>{currentRound} · {activeCat}</div>
              {isPrelim?(
                <div>
                  <div style={{background:"#110d22",border:"1px solid #ff980022",borderRadius:8,padding:"8px 14px",marginBottom:14,fontFamily:"Barlow,sans-serif",fontSize:11,color:"#ff9800"}}>
                    🎤 Prelims in progress — dancers are performing and being scored by judges.
                  </div>
                  <div style={{background:"#0d0a1a",border:"1px solid #161616",borderRadius:12,overflow:"hidden"}}>
                    {prelimRanked.length===0&&<div style={{padding:"40px",textAlign:"center",fontFamily:"Barlow,sans-serif",color:"#3d2080"}}>No scored dancers yet</div>}
                    {prelimRanked.map((p,i)=>(
                      <div key={p.id} className="lrow" style={{background:i===0?"#0a1200":i===1?"#0a1000":i===2?"#0a0e00":"transparent"}}>
                        <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:20,color:i<3?col.primary:"#2a1840",minWidth:36}}>#{i+1}</div>
                        <div style={{flex:1}}>
                          <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:15}}>{p.name}</div>
                          <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#7755aa"}}>{p.city}</div>
                        </div>
                        <span className="badge" style={{background:p.checked_in?"#00c85322":"#ff4d4d22",color:p.checked_in?"#00c853":"#ff4d4d",marginRight:8}}>{p.checked_in?"✓ IN":"PENDING"}</span>
                        <div style={{fontFamily:"Barlow,sans-serif",fontSize:9,color:"#7755aa",marginRight:6}}>SCORE</div>
                        <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:22,color:i<3?col.primary:"#fff",minWidth:40,textAlign:"right"}}>{getScore(p.id)||"—"}</div>
                      </div>
                    ))}
                  </div>
                </div>
              ):(
                <div>
                  <div style={{background:"#110d22",border:"1px solid #ff980022",borderRadius:8,padding:"8px 14px",marginBottom:14,fontFamily:"Barlow,sans-serif",fontSize:11,color:"#ff9800"}}>
                    🎤 {currentRound} battles — announce each battle as judges decide the winner.
                  </div>
                  <div style={{display:"flex",flexDirection:"column",gap:14}}>
                    {currentBattles.length===0&&<div style={{textAlign:"center",padding:"48px",fontFamily:"Barlow,sans-serif",color:"#3d2080"}}>Waiting for bracket to be seeded…</div>}
                    {currentBattles.map((battle,bi)=>{
                      const fighters=[battle.p1,battle.p2,...(battle.p3?[battle.p3]:[])];
                      const is3way=!!battle.p3;
                      const decs=battles.filter(b=>b.round===currentRound&&b.match_index===battle.match_index&&b.category===activeCat);
                      const result=resolveBattle(decs);
                      const isDecided=result.status==="decided";
                      const isTied=result.status==="tied";
                      return (
                        <div key={battle.match_index} className="battle-card">
                          <div style={{padding:"10px 18px",background:"#0b0818",fontFamily:"Bebas Neue,sans-serif",fontSize:12,color:col.primary,letterSpacing:3,borderBottom:"1px solid #1a1a1a",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                            <span>BATTLE {battle.match_index+1}{is3way?" · 3-WAY":""}</span>
                            <div style={{display:"flex",gap:8}}>
                              {isDecided&&<span style={{fontFamily:"Barlow,sans-serif",fontSize:11,color:"#00c853"}}>🏆 {result.winner_name} WINS</span>}
                              {isTied&&<span style={{fontFamily:"Barlow,sans-serif",fontSize:11,color:"#e2e8f0",background:"#ffffff15",padding:"2px 8px",borderRadius:6,border:"1px solid #ffffff33"}}>🤝 TIE × {result.tie_round+1} — EXTRA BATTLE</span>}
                              {result.status==="pending"&&<span style={{fontFamily:"Barlow,sans-serif",fontSize:11,color:"#7755aa"}}>Judges deciding…</span>}
                            </div>
                          </div>
                          <div style={{display:"grid",gridTemplateColumns:is3way?"1fr 1fr 1fr":"1fr auto 1fr",alignItems:"stretch"}}>
                            {fighters.map((p,fi)=>{
                              const isWinner=isDecided&&result.winner_id===p.id;
                              const isLoser=isDecided&&result.winner_id!==p.id;
                              return (
                                <div key={p.id} style={{padding:"16px 18px",textAlign:"center",background:isWinner?"#051a07":isLoser?"#150608":"#110d22",opacity:isLoser?0.45:1,borderRight:fi<fighters.length-1?"1px solid #1a1a1a":"none"}}>
                                  <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:9,color:"#55449a",letterSpacing:2,marginBottom:4}}>SEED #{battle.match_index*fighters.length+fi+1}</div>
                                  <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:22,color:isWinner?col.primary:"#fff",lineHeight:1}}>{p.name}</div>
                                  <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#7755aa",marginTop:3}}>{p.city}</div>
                                  {isWinner&&<div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:11,color:col.primary,marginTop:6,letterSpacing:1}}>🏆 WINNER</div>}
                                </div>
                              );
                            })}
                            {!is3way&&<div style={{display:"flex",alignItems:"center",padding:"0 10px",fontFamily:"Bebas Neue,sans-serif",fontSize:14,color:"#2a1840"}}>VS</div>}
                          </div>
                          {isTied&&<div style={{padding:"8px 18px",background:"#13111a",fontFamily:"Barlow,sans-serif",fontSize:11,color:"#ffd700",borderTop:"1px solid #2a2000"}}>🔄 Tie — same dancers battle again</div>}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          );
        })()}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────
// ROUND SETUP TAB — organizer configures knockout rounds after prelims
// ─────────────────────────────────────────────────────────────────
function RoundSetupTab({ col, eventRounds, onSave, saving, participants, categories }) {
  const currentKnockout = (eventRounds||[]).filter(r => r !== "Prelims");
  const [selected, setSelected] = useState(currentKnockout);
  const [hasChanges, setHasChanges] = useState(false);

  const toggle = (r) => {
    const next = selected.includes(r) ? selected.filter(x=>x!==r) : [...selected, r];
    setSelected(next);
    setHasChanges(true);
  };

  const orderedSelected = ALL_POST_PRELIM_ROUNDS.filter(r => selected.includes(r));
  const fullFlow = ["Prelims", ...orderedSelected];

  // Participant count summary per category
  const totalCheckedIn = participants.filter(p=>p.checked_in).length;
  const totalParticipants = participants.length;

  const handleSave = () => {
    if (orderedSelected.length === 0) return;
    onSave(["Prelims", ...orderedSelected]);
    setHasChanges(false);
  };

  return (
    <div className="slide">
      <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:18,letterSpacing:3,color:col.primary,marginBottom:4}}>⚡ ROUND SETUP</div>
      <div style={{fontFamily:"Barlow,sans-serif",fontSize:12,color:"#9980cc",marginBottom:20}}>
        Configure which knockout rounds happen after Prelims. Based on your participant count, select the rounds that make sense for this event.
      </div>

      {/* Participant count hint */}
      <div style={{background:"#110d22",border:`1px solid ${col.border}`,borderRadius:10,padding:"12px 16px",marginBottom:20,display:"flex",gap:20,flexWrap:"wrap"}}>
        <div style={{textAlign:"center"}}>
          <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:28,color:col.primary,lineHeight:1}}>{totalParticipants}</div>
          <div style={{fontFamily:"Barlow,sans-serif",fontSize:9,color:"#7755aa",letterSpacing:2,marginTop:2}}>REGISTERED</div>
        </div>
        <div style={{textAlign:"center"}}>
          <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:28,color:"#00c853",lineHeight:1}}>{totalCheckedIn}</div>
          <div style={{fontFamily:"Barlow,sans-serif",fontSize:9,color:"#7755aa",letterSpacing:2,marginTop:2}}>CHECKED IN</div>
        </div>
        <div style={{flex:1,fontFamily:"Barlow,sans-serif",fontSize:11,color:"#7755aa",display:"flex",alignItems:"center"}}>
          {totalCheckedIn>=32?"💡 32+ dancers → Top 32 → Top 16 → Top 8 → Top 4 → Finals recommended"
          :totalCheckedIn>=16?"💡 16–31 dancers → Top 16 → Top 8 → Top 4 → Finals recommended"
          :totalCheckedIn>=8?"💡 8–15 dancers → Top 8 → Top 4 → Finals recommended"
          :totalCheckedIn>=4?"💡 4–7 dancers → Top 4 → Finals recommended"
          :"💡 Under 4 checked in — Finals only recommended"}
        </div>
      </div>

      {/* Round toggles */}
      <div style={{background:"#120e22",border:"1px solid #2a1f4a",borderRadius:12,padding:"18px 20px",marginBottom:16}}>
        <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#7755aa",letterSpacing:2,marginBottom:12}}>SELECT KNOCKOUT ROUNDS AFTER PRELIMS</div>
        <div style={{display:"flex",flexWrap:"wrap",gap:10,marginBottom:16}}>
          {ALL_POST_PRELIM_ROUNDS.map(r => {
            const isOn = selected.includes(r);
            const limit = ROUND_LIMIT[r] ?? 0;
            const fits = limit === 2 || totalCheckedIn === 0 || totalCheckedIn >= limit * 0.5;
            return (
              <button key={r}
                onClick={()=>toggle(r)}
                style={{
                  fontFamily:"Bebas Neue,sans-serif",fontSize:14,letterSpacing:2,
                  padding:"10px 20px",borderRadius:8,cursor:"pointer",transition:"all .15s",
                  background:isOn?col.bg:"#160e2a",
                  border:`2px solid ${isOn?col.primary:"#3d2080"}`,
                  color:isOn?col.primary:"#55449a",
                }}>
                {isOn?"✓ ":""}{r}
                <div style={{fontFamily:"Barlow,sans-serif",fontSize:9,color:isOn?col.primary+"aa":"#3d2080",letterSpacing:0,marginTop:2}}>
                  {r==="Finals"?"2 dancers":r==="Top 4"?"4 dancers":r==="Top 8"?"8 dancers":r==="Top 16"?"16 dancers":"32 dancers"}
                </div>
              </button>
            );
          })}
        </div>

        {/* Flow preview */}
        <div style={{background:"#0b0818",border:"1px solid #2a1f4a",borderRadius:8,padding:"10px 14px"}}>
          <div style={{fontFamily:"Barlow,sans-serif",fontSize:9,color:"#55449a",letterSpacing:2,marginBottom:6}}>FLOW PREVIEW</div>
          <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
            {fullFlow.map((r,i) => (
              <span key={r} style={{display:"flex",alignItems:"center",gap:8}}>
                <span style={{
                  fontFamily:"Bebas Neue,sans-serif",fontSize:13,letterSpacing:2,
                  padding:"4px 12px",borderRadius:6,
                  background:r==="Prelims"?"#1a1428":col.bg,
                  border:`1px solid ${r==="Prelims"?"#ffd70033":col.border}`,
                  color:r==="Prelims"?"#ffd700":col.primary
                }}>{r}</span>
                {i < fullFlow.length-1 && <span style={{color:"#3d2080",fontSize:12}}>→</span>}
              </span>
            ))}
            {orderedSelected.length===0 && <span style={{fontFamily:"Barlow,sans-serif",fontSize:11,color:"#ff4d4d"}}>⚠ Select at least one knockout round</span>}
          </div>
        </div>
      </div>

      {/* Quick presets */}
      <div style={{marginBottom:20}}>
        <div style={{fontFamily:"Barlow,sans-serif",fontSize:9,color:"#55449a",letterSpacing:2,marginBottom:8}}>QUICK PRESETS</div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          {[
            {label:"Top 4 → Finals",rounds:["Top 4","Finals"]},
            {label:"Top 8 → Finals",rounds:["Top 8","Top 4","Finals"]},
            {label:"Top 16 → Finals",rounds:["Top 16","Top 8","Top 4","Finals"]},
            {label:"Top 32 → Finals",rounds:["Top 32","Top 16","Top 8","Top 4","Finals"]},
            {label:"Finals Only",rounds:["Finals"]},
          ].map(p=>(
            <button key={p.label}
              onClick={()=>{setSelected(p.rounds);setHasChanges(true);}}
              style={{fontFamily:"Barlow,sans-serif",fontSize:11,padding:"6px 14px",borderRadius:6,
                background:"#160e2a",border:"1px solid #3d2080",color:"#9980cc",cursor:"pointer",
                transition:"all .15s"}}>
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Current saved flow */}
      <div style={{background:"#0a1a0a",border:"1px solid #00c85333",borderRadius:8,padding:"10px 14px",marginBottom:20,fontFamily:"Barlow,sans-serif",fontSize:11,color:"#00c853"}}>
        💾 Currently saved: <strong>{(eventRounds||[]).join(" → ")||"Prelims only"}</strong>
      </div>

      <button className="btn"
        style={{background:orderedSelected.length>0?col.primary:"#1c1232",color:orderedSelected.length>0?"#000":"#55449a",fontSize:14,padding:"13px 32px",opacity:hasChanges?1:0.5}}
        onClick={handleSave}
        disabled={saving||orderedSelected.length===0||!hasChanges}>
        {saving?<Spinner/>:hasChanges?"💾 SAVE ROUND FLOW →":"✓ SAVED"}
      </button>

      {!hasChanges&&orderedSelected.length>0&&(
        <div style={{fontFamily:"Barlow,sans-serif",fontSize:11,color:"#55449a",marginTop:10}}>
          Round flow is saved. Judges and attendees will see these rounds live.
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// HOST DASHBOARD TAB — live event flow controller
// ─────────────────────────────────────────────────────────────────
function HostTab({ event, eventRounds, activeCat, col, checkedIn, prelimRanked, getScore, battles, participantMap, showToast }) {
  const allRounds  = eventRounds || event.rounds || ["Prelims"];
  const knockoutRounds = allRounds.filter(r => r !== "Prelims");

  const [advanceN, setAdvanceN] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [forceWinners, setForceWinners] = useState({});
  const [expandedRound, setExpandedRound] = useState(null);

  // ── Notification sender ──────────────────────────────────────
  const [notifMsg, setNotifMsg] = useState("");
  const [notifRound, setNotifRound] = useState("");
  const [notifSending, setNotifSending] = useState(false);
  const [notifRecipients, setNotifRecipients] = useState(["judge","emcee","attendee","organizer"]);
  const RECIPIENT_OPTIONS = [
    {key:"judge",   label:"Judges",     color:"#ffd700"},
    {key:"emcee",   label:"Emcee",      color:"#ff9800"},
    {key:"attendee",label:"Attendees",  color:"#00e5ff"},
    {key:"organizer",label:"Organizers",color:"#ff4d4d"},
  ];
  const toggleRecipient = (key) => setNotifRecipients(prev =>
    prev.includes(key) ? prev.filter(r=>r!==key) : [...prev, key]
  );

  const sendNotification = async (msg, round, recipients) => {
    const rcpts = recipients || notifRecipients;
    if (!msg.trim()) return showToast("Enter a message!","error");
    if (!rcpts.length) return showToast("Select at least one recipient!","error");
    setNotifSending(true);
    const { error } = await supabase.from("event_notifications").insert({
      event_id: event.id,
      message: msg.trim(),
      round: round || null,
      recipients: rcpts,
    });
    if (error) { showToast("Failed to send: "+error.message,"error"); setNotifSending(false); return; }
    showToast("📢 Announcement sent to: "+rcpts.join(", ")+"!");
    setNotifMsg(""); setNotifRound(""); setNotifSending(false);
  };

  const QUICK_ANNOUNCEMENTS = [
    { label:"PRELIMS STARTING", msg:"Prelims are starting now! All participants please get ready.", round:"Prelims" },
    { label:"TOP 32 STARTING",  msg:"Top 32 battles are about to begin! Take your positions.", round:"Top 32" },
    { label:"TOP 16 STARTING",  msg:"Top 16 is starting now! The bracket heats up.", round:"Top 16" },
    { label:"TOP 8 STARTING",   msg:"Top 8 — Quarterfinals starting now!", round:"Top 8" },
    { label:"TOP 4 STARTING",   msg:"Top 4 — Semifinals starting now!", round:"Top 4" },
    { label:"FINALS STARTING",  msg:"THE FINALS ARE STARTING! The crowd goes wild!", round:"Finals" },
    { label:"SHORT BREAK",      msg:"Short break — back in 10 minutes.", round:"" },
    { label:"RESULTS SOON",     msg:"Results coming up shortly. Stay tuned!", round:"" },
  ];

  const totalIn = checkedIn.length;
  const parsed  = parseInt(advanceN);

  // ANY number ≥ 2 up to totalIn is valid.
  // Odd numbers: the middle battle becomes a 3-way (handled by buildBattlesFromSeeds).
  const maxAllowedBracket = totalIn;

  const validN       = !isNaN(parsed) && parsed >= 2 && parsed <= totalIn;
  const bracketTooLarge = false; // no cap — any number is allowed
  const activeN      = confirmed && validN ? parsed : null;

  // Quick pick buttons — common bracket sizes that fit
  const quickOpts = [4,8,16,20,32].filter(n => n <= totalIn).concat(totalIn>=3&&totalIn<32?[totalIn]:[])

  const advancing  = activeN ? prelimRanked.slice(0, activeN) : [];

  // Active rounds: any knockout round whose limit fits within activeN (after making pool even)
  // We pair down to nearest even number if needed
  const activeRounds = activeN
    ? knockoutRounds.filter(r => {
        const limit = ROUND_LIMIT[r] ?? 0;
        return limit >= 2 && limit <= activeN;
      })
    : knockoutRounds;

  // Build battles using shared buildBattlesFromSeeds (handles odd → 3-way last battle)
  const buildRoundBattlesFixed = (roundName, seedList) => {
    const limit = ROUND_LIMIT[roundName] ?? 2;
    const pool = seedList.slice(0, limit);
    if (pool.length < 2) return [];
    return buildBattlesFromSeeds(pool, roundName);
  };

  // Resolve a battle, also checking host force-overrides
  const resolveWithForce = (roundName, matchIndex, decs, roundBattles) => {
    const forceKey = `${roundName}-${matchIndex}`;
    const forced = forceWinners[forceKey];
    if (forced) {
      const p = participantMap[forced];
      return { status: "decided", winner_id: forced, winner_name: p?.name || "?", tie_round: 0, forced: true };
    }
    return resolveBattle(decs);
  };

  // Get seeded list entering a round, respecting force-overrides
  const getSeedListForRound = (roundName) => {
    const ko = activeRounds;
    const idx = ko.indexOf(roundName);
    if (idx < 0) return [];
    if (idx === 0) return advancing;
    const prevRound = ko[idx - 1];
    const prevBattles = buildRoundBattlesFixed(prevRound, getSeedListForRound(prevRound));
    const winners = [];
    for (const b of prevBattles) {
      const decs = battles.filter(d => d.round === prevRound && d.match_index === b.match_index);
      const result = resolveWithForce(prevRound, b.match_index, decs);
      if (result.status === "decided" && result.winner_id) {
        const p = participantMap[result.winner_id];
        if (p) winners.push(p);
      }
    }
    return winners;
  };

  const getRoundStatus = (roundName) => {
    const seedList = getSeedListForRound(roundName);
    const roundBattles = buildRoundBattlesFixed(roundName, seedList);
    if (!roundBattles.length) return "locked";
    const allDecided = roundBattles.every(b => {
      const decs = battles.filter(d => d.round === roundName && d.match_index === b.match_index);
      return resolveWithForce(roundName, b.match_index, decs).status === "decided";
    });
    const anyVotes = roundBattles.some(b => {
      const decs = battles.filter(d => d.round === roundName && d.match_index === b.match_index);
      return decs.length > 0 || forceWinners[`${roundName}-${b.match_index}`];
    });
    if (allDecided) return "done";
    if (anyVotes)   return "live";
    return "ready";
  };

  // Can a round be accessed? Always yes once prelims confirmed — host can always override
  const canAccess = (roundName) => {
    if (!confirmed || !activeN) return false;
    const ko = activeRounds;
    const idx = ko.indexOf(roundName);
    if (idx === 0) return true; // first round always accessible
    // Previous round must have all battles decided OR have at least been started
    const prevRound = ko[idx - 1];
    const prevStatus = getRoundStatus(prevRound);
    return prevStatus === "done" || prevStatus === "live";
  };

  const prelimDone = prelimRanked.length > 0 && activeN !== null;

  return (
    <div className="slide">
      <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:18,letterSpacing:3,color:col.primary,marginBottom:4}}>HOST FLOW · {activeCat}</div>
      <div style={{fontFamily:"Barlow,sans-serif",fontSize:12,color:"#7755aa",marginBottom:20}}>
        Control the live event flow. Decide how many advance from prelims, then run the bracket. Use <strong style={{color:"#ffd700"}}>Force Advance</strong> anytime to manually pick a winner and keep the event moving.
      </div>

      {/* ── ANNOUNCEMENTS ── */}
      <div style={{background:"#120e22",border:"1px solid #ff980033",borderRadius:12,overflow:"hidden",marginBottom:20}}>
        <div style={{display:"flex",alignItems:"center",gap:10,padding:"12px 16px",background:"#0d0900",borderBottom:"1px solid #1a1a1a"}}>
          <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:22,color:"#ff9800",minWidth:28}}>📢</div>
          <div>
            <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:14,letterSpacing:2,color:"#ff9800"}}>SEND ANNOUNCEMENT</div>
            <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#7755aa"}}>Send live notifications to selected recipients</div>
          </div>
        </div>
        <div style={{padding:"14px 16px"}}>
          {/* Recipient selector */}
          <div style={{marginBottom:12}}>
            <div style={{fontFamily:"Barlow,sans-serif",fontSize:9,color:"#7755aa",letterSpacing:2,marginBottom:7}}>SEND TO <span style={{color:"#ff4d4d"}}>*</span></div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
              {RECIPIENT_OPTIONS.map(r=>{
                const isOn = notifRecipients.includes(r.key);
                return (
                  <button key={r.key} onClick={()=>toggleRecipient(r.key)}
                    style={{fontFamily:"Barlow,sans-serif",fontSize:11,padding:"5px 12px",borderRadius:20,
                      background:isOn?`${r.color}22`:"#120e22",
                      border:`1px solid ${isOn?r.color:"#3d2080"}`,
                      color:isOn?r.color:"#7755aa",cursor:"pointer",transition:"all .15s"}}>
                    {isOn?"✓ ":""}{r.label}
                  </button>
                );
              })}
            </div>
          </div>
          <div style={{display:"flex",flexWrap:"wrap",gap:7,marginBottom:12}}>
            {QUICK_ANNOUNCEMENTS.map(q=>(
              <button key={q.label} className="btn"
                style={{fontSize:10,padding:"6px 12px",background:"#1a0e00",color:"#ff9800",border:"1px solid #ff980044"}}
                onClick={()=>sendNotification(q.msg, q.round, notifRecipients)}
                disabled={notifSending}>
                {q.label}
              </button>
            ))}
          </div>
          <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
            <input className="inp" placeholder="Or type a custom announcement…" value={notifMsg}
              onChange={e=>setNotifMsg(e.target.value)}
              onKeyDown={e=>e.key==="Enter"&&sendNotification(notifMsg,notifRound,notifRecipients)}
              style={{flex:1,minWidth:200}}/>
            <select className="inp" value={notifRound} onChange={e=>setNotifRound(e.target.value)}
              style={{width:"auto",padding:"9px 32px 9px 11px"}}>
              <option value="">No round tag</option>
              {allRounds.map(r=><option key={r}>{r}</option>)}
            </select>
            <button className="btn" style={{background:"#ff9800",color:"#000",fontSize:12,padding:"9px 18px"}}
              onClick={()=>sendNotification(notifMsg,notifRound,notifRecipients)} disabled={notifSending||!notifMsg.trim()}>
              {notifSending?<Spinner/>:"SEND →"}
            </button>
          </div>
          {notifRecipients.length===0&&<div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#ff4d4d",marginTop:6}}>⚠ Select at least one recipient</div>}
        </div>
      </div>

      {/* ── STEP 1: PRELIMS ── */}
      <div style={{background:"#120e22",border:`1px solid ${prelimDone?"#00c85344":"#2a1f4a"}`,borderRadius:12,overflow:"hidden",marginBottom:14}}>
        <div style={{display:"flex",alignItems:"center",gap:10,padding:"12px 16px",background:prelimDone?"#051a07":"#0f0b1e",borderBottom:"1px solid #1a1a1a"}}>
          <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:22,color:prelimDone?"#00c853":col.primary,minWidth:28}}>1</div>
          <div style={{flex:1}}>
            <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:14,letterSpacing:2,color:prelimDone?"#00c853":col.primary}}>PRELIMS</div>
            <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#7755aa"}}>Judges score all checked-in dancers · ranked by total score</div>
          </div>
          <span className="badge" style={{background:totalIn>0?"#00c85322":"#1c1232",color:totalIn>0?"#00c853":"#55449a",border:`1px solid ${totalIn>0?"#00c85344":"#3d2080"}`}}>
            {totalIn} checked in
          </span>
        </div>

        <div style={{padding:"14px 16px"}}>
          {totalIn === 0 ? (
            <div style={{fontFamily:"Barlow,sans-serif",fontSize:12,color:"#55449a",textAlign:"center",padding:"8px 0"}}>No dancers checked in yet</div>
          ) : (
            <>
              <div style={{display:"flex",flexDirection:"column",gap:4,marginBottom:14}}>
                {prelimRanked.slice(0,5).map((p,i)=>(
                  <div key={p.id} style={{display:"flex",alignItems:"center",gap:10,padding:"6px 10px",background:activeN&&i<activeN?"#0d1a0d":"#0b0818",borderRadius:6,border:`1px solid ${activeN&&i<activeN?col.border+"44":"#170f2c"}`}}>
                    <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:16,color:i<3?col.primary:"#3d2080",minWidth:28}}>#{i+1}</div>
                    <div style={{flex:1,fontFamily:"Bebas Neue,sans-serif",fontSize:13}}>{p.name}</div>
                    <div style={{fontFamily:"Barlow,sans-serif",fontSize:9,color:"#7755aa",marginRight:4}}>TOTAL</div>
                    <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:16,color:col.primary}}>{getScore(p.id)||"—"}</div>
                    {activeN&&i<activeN&&<span style={{fontFamily:"Bebas Neue,sans-serif",fontSize:9,color:"#00c853",letterSpacing:1}}>✓ IN</span>}
                    {activeN&&i>=activeN&&<span style={{fontFamily:"Bebas Neue,sans-serif",fontSize:9,color:"#ff4d4d",letterSpacing:1}}>OUT</span>}
                  </div>
                ))}
                {prelimRanked.length>5&&<div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#55449a",textAlign:"center",padding:"4px 0"}}>+{prelimRanked.length-5} more in leaderboard tab</div>}
              </div>

              <div style={{background:"#0b0818",border:"1px solid #2a1f4a",borderRadius:10,padding:"14px 16px"}}>
                <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:12,letterSpacing:3,color:col.primary,marginBottom:6}}>HOW MANY ADVANCE TO KNOCKOUT?</div>
                {totalIn>0&&<div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#7755aa",marginBottom:10,padding:"5px 10px",background:"#0b0818",borderRadius:6,border:"1px solid #161616"}}>
                  📋 <strong style={{color:"#fff"}}>{totalIn}</strong> checked in · Max bracket allowed: <strong style={{color:col.primary}}>Top {maxAllowedBracket}</strong>
                  {totalIn>35?" (35+ → max Top 32)":totalIn>=25?" (25–35 → max Top 16)":""}
                </div>}
                <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:10,alignItems:"center"}}>
                  {quickOpts.map(n=>(
                    <button key={n} onClick={()=>{setAdvanceN(String(n));setConfirmed(false);}}
                      style={{fontFamily:"Bebas Neue,sans-serif",fontSize:14,padding:"7px 16px",borderRadius:8,
                        border:`1px solid ${advanceN===String(n)?col.primary:"#3d2080"}`,
                        background:advanceN===String(n)?col.bg:"#160e2a",
                        color:advanceN===String(n)?col.primary:"#7755aa",cursor:"pointer",transition:"all .15s"}}>
                      TOP {n}
                    </button>
                  ))}
                  <input className="inp" type="number" min={2} max={totalIn} placeholder={`2–${totalIn}`}
                    value={advanceN} onChange={e=>{setAdvanceN(e.target.value);setConfirmed(false);}}
                    style={{width:80,fontFamily:"Bebas Neue,sans-serif",fontSize:14}}/>
                </div>
                {validN&&!confirmed&&(
                  <div style={{display:"flex",gap:10,alignItems:"center",marginTop:8,flexWrap:"wrap"}}>
                    <div style={{fontFamily:"Barlow,sans-serif",fontSize:11,color:"#9980cc",flex:1}}>
                      Top <strong style={{color:col.primary}}>{parsed}</strong> advance · <strong style={{color:"#ff4d4d"}}>{totalIn-parsed}</strong> eliminated
                      {activeRounds.length>0&&<span style={{color:"#7755aa"}}> · Rounds: {activeRounds.join(" → ")}</span>}
                    </div>
                    <button className="btn" style={{background:col.primary,color:"#000",fontSize:12,padding:"9px 22px"}}
                      disabled={false}
                      onClick={()=>setConfirmed(true)}>
                      ✓ CONFIRM & START BRACKET
                    </button>
                  </div>
                )}
                {confirmed&&activeN&&(
                  <div style={{marginTop:8}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:8,marginBottom:8}}>
                      <div style={{fontFamily:"Barlow,sans-serif",fontSize:11,color:"#00c853"}}>✓ Top <strong>{activeN}</strong> confirmed · Bracket running</div>
                      <button className="btn" style={{background:"#1c1232",color:"#7755aa",border:"1px solid #3d2080",fontSize:11}} onClick={()=>setConfirmed(false)}>✎ CHANGE</button>
                    </div>
                    <div style={{background:"#001a0a",border:"1px solid #00c85333",borderRadius:8,padding:"8px 12px",fontFamily:"Barlow,sans-serif",fontSize:10,color:"#00c853"}}>
                      🔒 Prelim scoring locked. Knockout rounds use name card judging only.
                    </div>
                  </div>
                )}
                {advanceN&&bracketTooLarge&&(
                  <div style={{background:"#1a0000",border:"1px solid #ff4d4d44",borderRadius:8,padding:"10px 14px",marginTop:8}}>
                    <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:12,color:"#ff4d4d",letterSpacing:2,marginBottom:3}}>⛔ BRACKET TOO LARGE</div>
                    <div style={{fontFamily:"Barlow,sans-serif",fontSize:11,color:"#cc4444"}}>
                      With <strong style={{color:"#fff"}}>{totalIn}</strong> dancers, the maximum starting bracket is <strong style={{color:"#fff"}}>Top {maxAllowedBracket}</strong>.
                    </div>
                  </div>
                )}
                {advanceN&&!validN&&!bracketTooLarge&&!isNaN(parsed)&&(
                  <div style={{fontFamily:"Barlow,sans-serif",fontSize:11,color:"#ff4d4d",marginTop:6}}>
                    Must be between 2 and {Math.min(totalIn,maxAllowedBracket)}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── KNOCKOUT ROUNDS ── */}
      {confirmed&&activeN&&activeRounds.map((roundName,idx)=>{
        const seedList = getSeedListForRound(roundName);
        const roundBattles = buildRoundBattlesFixed(roundName, seedList);
        const status = getRoundStatus(roundName);
        const accessible = canAccess(roundName);
        const statusColor = status==="done"?"#00c853":status==="live"?col.primary:status==="ready"?"#ffd700":"#3d2080";
        const statusLabel = status==="done"?"✓ COMPLETE":status==="live"?"● LIVE":status==="ready"?"READY":"WAITING";
        const isExpanded = expandedRound === roundName;

        return (
          <div key={roundName} style={{background:"#120e22",border:`1px solid ${status==="done"?"#00c85333":status==="live"?col.border:"#2a1f4a"}`,borderRadius:12,overflow:"hidden",marginBottom:14,opacity:accessible?1:0.5}}>
            <div style={{display:"flex",alignItems:"center",gap:10,padding:"12px 16px",background:status==="done"?"#051a07":status==="live"?col.bg:"#0f0b1e",borderBottom:"1px solid #1a1a1a",cursor:"pointer"}}
              onClick={()=>setExpandedRound(isExpanded?null:roundName)}>
              <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:22,color:statusColor,minWidth:28}}>{idx+2}</div>
              <div style={{flex:1}}>
                <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:14,letterSpacing:2,color:statusColor}}>{roundName}</div>
                <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#7755aa"}}>
                  {roundBattles.length} battle{roundBattles.length!==1?"s":""} · {seedList.length} dancers seeded
                  {!accessible&&<span style={{color:"#ff4d4d",marginLeft:8}}>— previous round in progress</span>}
                </div>
              </div>
              <span className="badge" style={{background:status==="done"?"#00c85322":status==="live"?col.bg:"#1c1232",color:statusColor,border:`1px solid ${statusColor}44`}}>{statusLabel}</span>
              <span style={{color:"#55449a",fontSize:12,marginLeft:4}}>{isExpanded?"▲":"▼"}</span>
            </div>

            {isExpanded&&(
              <div style={{padding:"12px 16px",display:"flex",flexDirection:"column",gap:8}}>
                {/* Force-advance notice */}
                <div style={{background:"#13111a",border:"1px solid #ffd70033",borderRadius:8,padding:"8px 13px",marginBottom:4,fontFamily:"Barlow,sans-serif",fontSize:10,color:"#ffd700"}}>
                  ⚡ <strong>HOST OVERRIDE:</strong> If judges are stuck or tied, tap a fighter below to force-advance them and keep the event moving.
                </div>

                {roundBattles.length===0?(
                  <div style={{fontFamily:"Barlow,sans-serif",fontSize:11,color:"#55449a",textAlign:"center",padding:"8px 0"}}>
                    Waiting for previous round winners to seed this round…
                  </div>
                ):roundBattles.map((b,i)=>{
                  const fighters = [b.p1, b.p2, ...(b.p3?[b.p3]:[])];
                  const is3way = !!b.p3;
                  const decs = battles.filter(d=>d.round===roundName&&d.match_index===b.match_index);
                  const result = resolveWithForce(roundName,b.match_index,decs);
                  const isDecided = result.status==="decided";
                  const isTied    = result.status==="tied";
                  const isForced  = result.forced;
                  const forceKey  = `${roundName}-${b.match_index}`;

                  return (
                    <div key={i} style={{background:"#0b0818",border:`1px solid ${isDecided?col.border+"55":isTied?"#ffd70033":"#170f2c"}`,borderRadius:8,overflow:"hidden"}}>
                      <div style={{padding:"5px 14px",background:"#0a0612",fontFamily:"Bebas Neue,sans-serif",fontSize:10,color:"#55449a",letterSpacing:2}}>
                        BATTLE {i+1}{is3way&&<span style={{color:"#ff9800",marginLeft:8}}>3-WAY</span>}{isForced&&<span style={{color:"#ffd700",marginLeft:8}}>★ HOST OVERRIDE</span>}
                      </div>
                      <div style={{display:"grid",gridTemplateColumns:is3way?"1fr 1fr 1fr":"1fr auto 1fr",alignItems:"stretch"}}>
                        {fighters.map((p,fi)=>{
                          const isWinner=isDecided&&result.winner_id===p.id;
                          const isLoser=isDecided&&result.winner_id!==p.id;
                          return (
                            <div key={p.id}
                              onClick={()=>{
                                setForceWinners(fw=>({...fw,[forceKey]:fw[forceKey]===p.id?undefined:p.id}));
                              }}
                              style={{padding:"12px 14px",textAlign:"center",
                                opacity:isLoser?0.4:1,cursor:"pointer",
                                background:isWinner?"#051a07":isLoser?"#150608":"#110d22",
                                borderRight:fi<fighters.length-1?"1px solid #1a1a1a":"none",
                                transition:"background .15s"}}>
                              <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:13,color:isWinner?col.primary:"#fff"}}>{p.name}</div>
                              <div style={{fontFamily:"Barlow,sans-serif",fontSize:9,color:"#7755aa"}}>{p.city}</div>
                              {isWinner&&<div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:9,color:col.primary,marginTop:3,letterSpacing:1}}>🏆 WINNER</div>}
                              {!isDecided&&<div style={{fontFamily:"Barlow,sans-serif",fontSize:8,color:"#55449a",marginTop:3}}>tap to force</div>}
                              {!isDecided&&!isForced&&(
                                <button
                                  onClick={e=>{e.stopPropagation();
                                    // Auto-advance the opponent(s)
                                    const opponents=fighters.filter(f=>f.id!==p.id);
                                    if(opponents.length===1){setForceWinners(fw=>({...fw,[forceKey]:opponents[0].id}));}
                                    showToast(`${p.name} marked absent — opponent advances`);
                                  }}
                                  style={{fontFamily:"Barlow,sans-serif",fontSize:8,color:"#ff9800",background:"#1a0e00",border:"1px solid #ff980033",borderRadius:4,padding:"2px 6px",marginTop:5,cursor:"pointer",display:"block",width:"100%"}}>
                                  ⚠ ABSENT
                                </button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                      <div style={{padding:"5px 14px",background:"#0a0612",fontFamily:"Barlow,sans-serif",fontSize:9,
                        color:isTied?"#ffd700":isDecided&&!isForced?"#00c853":isDecided&&isForced?"#ffd700":"#55449a"}}>
                        {isTied?`🤝 TIE ×${result.tie_round+1} — use host override to advance`
                          :isDecided&&isForced?`★ Host advanced: ${result.winner_name}`
                          :isDecided?`🏆 ${result.winner_name} advances (judges decided)`
                          :"Judges voting…"}
                      </div>
                      {isForced&&(
                        <div style={{padding:"4px 14px 8px",background:"#0a0612"}}>
                          <button style={{fontFamily:"Barlow,sans-serif",fontSize:9,color:"#7755aa",background:"none",border:"1px solid #3d2080",borderRadius:4,padding:"2px 8px",cursor:"pointer"}}
                            onClick={()=>setForceWinners(fw=>{const n={...fw};delete n[forceKey];return n;})}>
                            ✕ clear override
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      {/* ── WINNER DASHBOARD ── */}
      {(()=>{
        if(!confirmed||!activeN)return null;
        const finalsRound=activeRounds[activeRounds.length-1];
        if(!finalsRound)return null;
        const finalsStatus=getRoundStatus(finalsRound);
        if(finalsStatus!=="done")return null;
        const finalsSeed=getSeedListForRound(finalsRound);
        const finalsBattles=buildRoundBattlesFixed(finalsRound,finalsSeed);
        if(!finalsBattles.length)return null;
        const champBattle=finalsBattles.find(b=>{
          const decs=battles.filter(d=>d.round===finalsRound&&d.match_index===b.match_index);
          return resolveWithForce(finalsRound,b.match_index,decs).status==="decided";
        });
        if(!champBattle)return null;
        const decs=battles.filter(d=>d.round===finalsRound&&d.match_index===champBattle.match_index);
        const res=resolveWithForce(finalsRound,champBattle.match_index,decs);
        const champ=participantMap[res.winner_id];
        const finalists=[champBattle.p1,champBattle.p2];
        const runnerUp=finalists.find(p=>p.id!==res.winner_id);
        if(!champ)return null;
        return (
          <div style={{marginBottom:16}}>
            <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:11,letterSpacing:6,color:col.primary,marginBottom:12,textAlign:"center"}}>🏆 FINAL RESULTS · {activeCat}</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
              {/* Champion */}
              <div style={{background:"linear-gradient(135deg,#1a1200,#0f0a00)",border:`2px solid ${col.primary}`,borderRadius:16,padding:"28px 20px",textAlign:"center",position:"relative"}}>
                <div style={{position:"absolute",top:10,left:0,right:0,display:"flex",justifyContent:"center"}}>
                  <span style={{fontFamily:"Barlow,sans-serif",fontSize:9,letterSpacing:3,color:col.primary,background:col.bg,padding:"3px 12px",borderRadius:20,border:`1px solid ${col.border}`}}>CHAMPION</span>
                </div>
                <div style={{fontSize:36,marginBottom:4,marginTop:10}}>🏆</div>
                <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:34,color:col.primary,lineHeight:1,marginBottom:4}}>{champ.name}</div>
                <div style={{fontFamily:"Barlow,sans-serif",fontSize:11,color:"#9980cc",marginBottom:6}}>{champ.city}</div>
                <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#7755aa"}}>{event.name}</div>
                <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:11,letterSpacing:2,color:col.primary,marginTop:4}}>{activeCat}</div>
              </div>
              {/* Runner-Up */}
              {runnerUp&&(
                <div style={{background:"linear-gradient(135deg,#141414,#0a0a0a)",border:"2px solid #aaaaaa88",borderRadius:16,padding:"28px 20px",textAlign:"center",position:"relative"}}>
                  <div style={{position:"absolute",top:10,left:0,right:0,display:"flex",justifyContent:"center"}}>
                    <span style={{fontFamily:"Barlow,sans-serif",fontSize:9,letterSpacing:3,color:"#c0a8e8",background:"#1c1232",padding:"3px 12px",borderRadius:20,border:"1px solid #44444488"}}>RUNNER-UP</span>
                  </div>
                  <div style={{fontSize:36,marginBottom:4,marginTop:10}}>🥈</div>
                  <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:34,color:"#ccc",lineHeight:1,marginBottom:4}}>{runnerUp.name}</div>
                  <div style={{fontFamily:"Barlow,sans-serif",fontSize:11,color:"#9980cc",marginBottom:6}}>{runnerUp.city}</div>
                  <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#7755aa"}}>{event.name}</div>
                  <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:11,letterSpacing:2,color:"#c0a8e8",marginTop:4}}>{activeCat}</div>
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {confirmed&&activeN&&activeRounds.length===0&&(
        <div style={{background:"#1a0a00",border:"1px solid #ff4d4d33",borderRadius:10,padding:"14px 16px",marginBottom:14}}>
          <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:13,color:"#ff4d4d",letterSpacing:2,marginBottom:4}}>NO MATCHING KNOCKOUT ROUNDS</div>
          <div style={{fontFamily:"Barlow,sans-serif",fontSize:11,color:"#9980cc"}}>
            The event was configured with rounds: {allRounds.join(", ")}. With {activeN} advancing, none of the configured knockout rounds fit. Ask the admin to add Top {activeN % 2 === 0 ? activeN : activeN - 1} or Finals to the event rounds.
          </div>
        </div>
      )}

      {!confirmed&&totalIn>0&&(
        <div style={{background:"#0f0b1e",border:"1px solid #1a1a1a",borderRadius:12,padding:"24px",textAlign:"center"}}>
          <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:14,color:"#55449a",letterSpacing:2,marginBottom:6}}>BRACKET LOCKED UNTIL PRELIMS CLOSE</div>
          <div style={{fontFamily:"Barlow,sans-serif",fontSize:11,color:"#3d2080"}}>Select how many advance above, then confirm to generate the bracket.</div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// ORGANIZER DASHBOARD
// ─────────────────────────────────────────────────────────────────
function Dashboard({ event, memberName, onBack, showToast }) {
  const categories = event.categories||[];
  const [tab,setTab]=useState("organizer");
  const [activeCat,setActiveCat]=useState(categories[0]||"");
  const [searchQr,setSearchQr]=useState(""); const [showQrFor,setShowQrFor]=useState(null);
  const [overlayActive,setOverlayActive]=useState(false); const [showConfirm,setShowConfirm]=useState(false);
  const { popup: liveNotif, history: notifHistory, dismissPopup } = useLiveNotifications(event.id, "organizer");

  const [judgeCodes,setJudgeCodes]=useState([]);
  const [participants,setParticipants]=useState([]);
  const [scores,setScores]=useState([]);
  const [battles,setBattles]=useState([]);
  const [attendees,setAttendees]=useState([]);
  const [loading,setLoading]=useState(true);
  const [eventRounds,setEventRounds]=useState(event.rounds||["Prelims"]);
  const [roundsSaving,setRoundsSaving]=useState(false);

  // rounds always stays in sync with eventRounds state
  const rounds = eventRounds||["Prelims"];
  const [currentRound,setCurrentRound]=useState((event.rounds||["Prelims"])[0]||"Prelims");

  const loadDashboard=useCallback(async()=>{
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
  },[event.id]);

  useEffect(()=>{ loadDashboard(); },[loadDashboard]);

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
  // Total score = sum of all judge scores for ranking
  const getScore=useCallback((pid)=>{
    const vals=Object.values(scoreMap[pid]||{});
    return vals.length?vals.reduce((a,b)=>a+b,0):0;
  },[scoreMap]);
  const catSorted=useMemo(()=>[...catParts].sort((a,b)=>getScore(b.id)-getScore(a.id)),[catParts,getScore]);
  const regJudges=useMemo(()=>judgeCodes.filter(j=>j.used),[judgeCodes]);
  const checkedIn=useMemo(()=>catParts.filter(p=>p.checked_in),[catParts]);
  const prelimRanked=useMemo(()=>[...checkedIn].sort((a,b)=>{
    const sa=getScore(a.id),sb=getScore(b.id);
    if(sb!==sa)return sb-sa;
    const aMax=Math.max(0,...Object.values(scoreMap[a.id]||{}));
    const bMax=Math.max(0,...Object.values(scoreMap[b.id]||{}));
    if(bMax!==aMax)return bMax-aMax;
    return a.name.localeCompare(b.name);
  }),[checkedIn,getScore,scoreMap]);
  const participantMap=useMemo(()=>{const m={};participants.forEach(p=>{m[p.id]=p;});return m;},[participants]);

  const addParticipant=useCallback(async(form)=>{
    if(!form.name.trim()||!form.city.trim())return showToast("Fill name and city!","error");
    const payload={event_id:event.id,name:form.name.trim(),city:form.city.trim(),phone:form.phone?.trim()||null,category:activeCat,payment_method:form.payment_method||"cash"};
    let{error}=await supabase.from("participants").insert(payload);
    if(error&&error.message&&error.message.toLowerCase().includes("payment_method")){
      const{payment_method:_,...fallback}=payload;
      ({error}=await supabase.from("participants").insert(fallback));
    }
    if(error)return showToast("Failed: "+error.message,"error");
    showToast(`${form.name} added to ${activeCat}!`);
  },[activeCat,event.id,showToast]);
  const checkIn=useCallback(async(id)=>{const{error}=await supabase.from("participants").update({checked_in:true}).eq("id",id);if(error)return showToast("Check-in failed!","error");showToast("Dancer checked in ✓");},[showToast]);
  const endEvent=async()=>{const{error}=await supabase.from("events").delete().eq("id",event.id);if(error)return showToast("Failed!","error");onBack();};
  const saveRounds=async(newRounds)=>{
    setRoundsSaving(true);
    const{error}=await supabase.from("events").update({rounds:newRounds}).eq("id",event.id);
    if(error){showToast("Failed to save rounds: "+error.message,"error");setRoundsSaving(false);return;}
    setEventRounds(newRounds);
    showToast("Round flow saved ✓");
    setRoundsSaving(false);
  };

  const downloadXLSX=(sheetData,filename)=>{
    const XLSX=window.XLSX;
    if(!XLSX){showToast("Excel library not loaded yet, try again","error");return;}
    const ws=XLSX.utils.aoa_to_sheet(sheetData);
    // Auto column widths
    const colWidths=sheetData[0].map((_,ci)=>({wch:Math.max(...sheetData.map(r=>String(r[ci]||"").length),10)+2}));
    ws["!cols"]=colWidths;
    const wb=XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb,ws,"Sheet1");
    XLSX.writeFile(wb,filename);
  };

  const exportParticipantsCSV=()=>{
    const knockoutRounds=rounds.filter(r=>r!=="Prelims");
    const headers=["Category","Name","City","Phone","Payment","Checked In","Prelim Score",...knockoutRounds.map(r=>`${r} Result`)];
    const rows=[headers];
    participants.forEach(p=>{
      const prelimScore=getScore(p.id)||"";
      const roundResults=knockoutRounds.map(r=>{
        const bds=battles.filter(b=>b.category===p.category&&b.round===r&&(b.p1_id===p.id||b.p2_id===p.id));
        if(!bds.length)return "";
        const mi=bds[0].match_index;
        const allDecs=battles.filter(b=>b.category===p.category&&b.round===r&&b.match_index===mi);
        const result=resolveBattle(allDecs);
        if(!result)return "Pending";
        if(result.status==="tied")return "Tie";
        return result.winner_id===p.id?"WIN":"LOSS";
      });
      rows.push([p.category,p.name,p.city||"",p.phone||"",p.payment_method==="online"?"Online":"Cash",p.checked_in?"Yes":"No",prelimScore,...roundResults]);
    });
    downloadXLSX(rows,`${event.name.replace(/\s+/g,"-")}-participants.xlsx`);
    showToast("Participants Excel exported ✓");
  };

  const exportViewersCSV=()=>{
    const viewers=attendees.filter(a=>a.role==="attendee");
    const headers=["Name","Phone","City","Payment","Registered At"];
    const rows=[headers];
    viewers.forEach(a=>{rows.push([a.name,a.phone||"",a.city||"",a.payment_method==="online"?"Online":"Cash",a.created_at?new Date(a.created_at).toLocaleString():""]);});
    if(viewers.length===0)rows.push(["(no viewers registered)","","","",""]);
    downloadXLSX(rows,`${event.name.replace(/\s+/g,"-")}-viewers.xlsx`);
    showToast("Viewers Excel exported ✓");
  };

  if(loading)return <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:"#0a0612"}}><Spinner/></div>;
  if(categories.length===0)return <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:"#0a0612",flexDirection:"column",gap:16}}><div style={{fontFamily:"Barlow,sans-serif",color:"#7755aa"}}>No categories configured.</div><button className="btn" style={{background:"#120e22",color:"#777",border:"1px solid #2a1840"}} onClick={onBack}>← BACK</button></div>;

  return (
    <div className="hiphop-bg" style={{fontFamily:"'Bebas Neue',Impact,sans-serif",background:"linear-gradient(160deg,#0a0612 0%,#0d0a22 60%,#0a0e1a 100%)",minHeight:"100vh",color:"#fff"}}>
      <LiveNotifBanner popup={liveNotif} onDismiss={dismissPopup}/>

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
            <div style={{fontFamily:"Barlow,sans-serif",fontSize:11,color:"#7755aa",letterSpacing:2,marginBottom:24}}>{event.city}</div>
            {list.map((p,i)=>(
              <div key={p.id} style={{display:"flex",alignItems:"center",gap:12,background:i<3?col.bg:"#0f0b1e",border:`1px solid ${i<3?col.border:"#170f2c"}`,borderRadius:8,padding:"9px 13px",marginBottom:6}}>
                <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:20,color:i<3?col.primary:"#3d2080",minWidth:34}}>#{i+1}</div>
                <div style={{flex:1}}><div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:15}}>{p.name}</div><div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#7755aa"}}>{p.city}</div></div>
                {isPrelimOv&&<div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:16,color:i<3?col.primary:"#fff",minWidth:28,textAlign:"right"}}>{getScore(p.id)||"—"}</div>}
              </div>
            ))}
            <button className="btn" style={{marginTop:22,alignSelf:"flex-start",background:"#1c1232",color:"#777",border:"1px solid #3d2080",fontSize:11}} onClick={()=>setOverlayActive(false)}>✕ CLOSE</button>
          </div>
        );
      })()}

      {/* End event confirm */}
      {showConfirm&&(
        <div style={{position:"fixed",inset:0,background:"#000000cc",zIndex:300,display:"flex",alignItems:"center",justifyContent:"center",padding:24}}>
          <div style={{background:"#120e22",border:"1px solid #ff4d4d44",borderRadius:14,padding:28,maxWidth:380,width:"100%",textAlign:"center"}}>
            <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:22,color:"#ff4d4d",marginBottom:8}}>END EVENT?</div>
            <div style={{fontFamily:"Barlow,sans-serif",fontSize:13,color:"#8866bb",marginBottom:24}}>All data for "<strong style={{color:"#fff"}}>{event.name}</strong>" will be permanently deleted.</div>
            <div style={{display:"flex",gap:10}}>
              <button className="btn" style={{flex:1,background:"#1c1232",color:"#777",border:"1px solid #3d2080"}} onClick={()=>setShowConfirm(false)}>CANCEL</button>
              <button className="btn" style={{flex:1,background:"#ff4d4d",color:"#000"}} onClick={endEvent}>YES, DELETE</button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div style={{padding:"22px 22px 0",maxWidth:1100,margin:"0 auto"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:12}}>
          <div>
            <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:52,letterSpacing:5,lineHeight:1,background:"linear-gradient(135deg,#c084fc,#60a5fa)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>{event.name}</div>
            <div style={{fontFamily:"Barlow,sans-serif",fontSize:11,color:col.primary,letterSpacing:3,marginTop:2}}>DanBuzz · {event.city} · {event.start_date||event.date}{event.end_date&&event.end_date!==event.start_date?" → "+event.end_date:""}</div>
            {memberName&&<div style={{display:"flex",alignItems:"center",gap:6,marginTop:4}}><div style={{width:6,height:6,borderRadius:"50%",background:"#a855f7"}}/><span style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#c084fc",letterSpacing:2}}>ORGANIZER · {memberName}</span></div>}
          </div>
          <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
            {rounds.length>0?(
              <select className="inp" style={{width:"auto",padding:"7px 32px 7px 11px",fontSize:12}} value={currentRound} onChange={e=>setCurrentRound(e.target.value)}>
                {rounds.map(r=><option key={r}>{r}</option>)}
              </select>
            ):(
              <div style={{fontFamily:"Barlow,sans-serif",fontSize:11,color:"#7755aa",padding:"7px 12px",background:"#120e22",borderRadius:8,border:"1px solid #2a1840"}}>Knockout not started yet</div>
            )}
            <button className="btn" style={{background:"#120e22",color:"#777",border:"1px solid #3d2080",fontSize:11}} onClick={()=>setOverlayActive(true)}>⬛ STREAM</button>
            <button className="btn" style={{background:"transparent",color:"#7755aa",border:"1px solid #2a1840",fontSize:11}} onClick={onBack}>← LOGOUT</button>
            <button className="btn" style={{background:"#150608",color:"#ff4d4d",border:"1px solid #ff4d4d33",fontSize:11}} onClick={()=>setShowConfirm(true)}>END EVENT</button>
          </div>
        </div>

        <div style={{display:"flex",gap:10,marginTop:16,flexWrap:"wrap"}}>
          {[{label:"PARTICIPANTS",val:participants.length,color:"#fff"},{label:"CHECKED IN",val:participants.filter(p=>p.checked_in).length,color:"#00c853"},{label:"CATEGORIES",val:categories.length,color:col.primary},{label:"JUDGES",val:regJudges.length,color:"#ffd700"},{label:"SCORES",val:scores.length,color:"#00e5ff"},{label:"BATTLES",val:battles.length,color:"#ff9800"}].map(s=>(
            <div key={s.label} style={{background:"#110d22",border:"1px solid #181818",borderRadius:8,padding:"8px 14px",textAlign:"center"}}>
              <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:24,color:s.color,lineHeight:1}}>{s.val}</div>
              <div style={{fontFamily:"Barlow,sans-serif",fontSize:8,color:"#55449a",letterSpacing:2,marginTop:2}}>{s.label}</div>
            </div>
          ))}
        </div>

        <div style={{display:"flex",gap:8,marginTop:16,flexWrap:"wrap"}}>
          {categories.map(cat=>{const c=getCatColor(categories,cat);const count=participants.filter(p=>p.category===cat).length;const judgesIn=judgeCodes.filter(j=>j.category===cat&&j.used).length;const active=activeCat===cat;return <button key={cat} className="btn" style={{fontSize:11,padding:"7px 14px",background:active?c.primary:"#120e22",color:active?"#000":"#7755aa",border:`1px solid ${active?c.primary:"#2a1840"}`}} onClick={()=>setActiveCat(cat)}>{cat} <span style={{opacity:.7}}>({count}p · {judgesIn}j)</span></button>;})}
        </div>

        <div style={{display:"flex",borderBottom:"1px solid #1a1a1a",marginTop:12,overflowX:"auto"}}>
          {[
            {key:"organizer",label:"PARTICIPANTS"},
            {key:"attendees",label:"VIEWERS"},
            {key:"judges",label:`JUDGES (${regJudges.length})`},
            {key:"checkin",label:"CHECK-IN"},
            {key:"host",label:"HOST"},
            {key:"roundsetup",label:"⚡ ROUND SETUP"},
            {key:"scores",label:"SCORES (VIEW)"},
            {key:"bracket",label:"BRACKET"},
            {key:"leaderboard",label:"LEADERBOARD"},
            {key:"notifications",label:`🔔 ANNOUNCEMENTS${notifHistory.length>0?" ("+notifHistory.length+")":""}`},
            {key:"export",label:"EXPORT"},
          ].map(t=><button key={t.key} className="tbtn" style={{color:tab===t.key?col.primary:"#7755aa",borderBottom:tab===t.key?`3px solid ${col.primary}`:"3px solid transparent"}} onClick={()=>setTab(t.key)}>{t.label}</button>)}
        </div>
      </div>

      <div style={{padding:"20px 22px 40px",maxWidth:1100,margin:"0 auto"}}>
        {/* Category banner */}
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16,padding:"9px 14px",background:col.bg,border:`1px solid ${col.border}`,borderRadius:9}}>
          <div style={{width:8,height:8,borderRadius:"50%",background:col.primary}}/>
          <span style={{fontFamily:"Bebas Neue,sans-serif",fontSize:13,letterSpacing:3,color:col.primary}}>{activeCat}</span>
          <span style={{fontFamily:"Barlow,sans-serif",fontSize:11,color:"#7755aa",marginLeft:4}}>{catParts.length} participants · {catJudges.length>0?catJudges.map(j=>j.judge_name).join(" · "):"No judges yet"}</span>
          <span style={{fontFamily:"Barlow,sans-serif",fontSize:9,color:currentRound==="Prelims"?"#ffd700":"#00e5ff",marginLeft:8}}>
            {currentRound==="Prelims"?"PRELIMS (SCORE-BASED)":"KNOCKOUT (1V1)"}
          </span>
          <div style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:6}}>
            <div className="pulse" style={{width:5,height:5,borderRadius:"50%",background:"#00c853"}}/>
            <span style={{fontFamily:"Barlow,sans-serif",fontSize:9,color:"#55449a",letterSpacing:2}}>LIVE</span>
          </div>
        </div>

        {tab==="organizer"&&<OrganizerTab activeCat={activeCat} catSorted={catSorted} col={col} onAdd={addParticipant} getScore={getScore}/>}
        {tab==="attendees"&&<AttendeeTab event={event} col={col} showToast={showToast}/>}
        {tab==="host"&&<HostTab event={event} eventRounds={eventRounds} activeCat={activeCat} col={col} checkedIn={checkedIn} prelimRanked={prelimRanked} getScore={getScore} battles={battles.filter(b=>b.category===activeCat)} participantMap={participantMap} showToast={showToast}/>}
        {tab==="roundsetup"&&<RoundSetupTab col={col} eventRounds={eventRounds} onSave={saveRounds} saving={roundsSaving} participants={participants} categories={categories}/>}

        {tab==="judges"&&(
          <div className="slide">
            <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:18,letterSpacing:3,color:col.primary,marginBottom:6}}>JUDGES · {activeCat}</div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(240px,1fr))",gap:12,marginBottom:32}}>
              {judgeCodes.filter(j=>j.category===activeCat).map(j=>(
                <div key={j.code} className="card" style={{border:`1px solid ${j.used?col.border:"#2a1f4a"}`}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}>
                    <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:15,color:j.used?col.primary:"#3d2080",letterSpacing:2}}>{activeCat} · Judge {j.slot}</div>
                    <span className="badge" style={{background:j.used?"#00c85322":"#1c1232",color:j.used?"#00c853":"#3d2080",border:`1px solid ${j.used?"#00c85344":"#3d2080"}`}}>{j.used?"REGISTERED":"WAITING"}</span>
                  </div>
                  {j.used?<div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:20}}>{j.judge_name}</div>:<div style={{fontFamily:"Barlow,sans-serif",fontSize:12,color:"#7755aa"}}>Waiting for judge</div>}
                  <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:12,letterSpacing:2,color:"#3d2080",marginTop:10,padding:"6px 10px",background:"#160e2a",borderRadius:6}}>{j.code}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab==="checkin"&&(
          <div className="slide">
            <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:18,letterSpacing:3,color:col.primary,marginBottom:6}}>CHECK-IN · {activeCat}</div>
            {/* Legend */}
            <div style={{display:"flex",gap:8,marginBottom:14,flexWrap:"wrap"}}>
              {[{label:"REGISTERED",bg:"#ff4d4d22",c:"#ff4d4d"},{label:"CHECKED IN",bg:"#00c85322",c:"#00c853"},{label:"DISQUALIFIED",bg:"#55555522",c:"#9980cc"}].map(s=>(
                <span key={s.label} className="badge" style={{background:s.bg,color:s.c,border:`1px solid ${s.c}44`,fontSize:9}}>{s.label}</span>
              ))}
            </div>
            <input className="inp" placeholder="Search dancer..." value={searchQr} onChange={e=>setSearchQr(e.target.value)} style={{maxWidth:300,marginBottom:16}}/>
            {/* Summary counts */}
            <div style={{display:"flex",gap:10,marginBottom:16,flexWrap:"wrap"}}>
              {[
                {label:"REGISTERED",val:catParts.length,color:"#fff"},
                {label:"CHECKED IN",val:catParts.filter(p=>p.checked_in).length,color:"#00c853"},
                {label:"NOT CHECKED IN",val:catParts.filter(p=>!p.checked_in&&!p.disqualified).length,color:"#ff4d4d"},
                {label:"DISQUALIFIED",val:catParts.filter(p=>p.disqualified).length,color:"#9980cc"},
              ].map(s=>(
                <div key={s.label} style={{background:"#110d22",border:"1px solid #181818",borderRadius:8,padding:"6px 12px",textAlign:"center"}}>
                  <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:20,color:s.color,lineHeight:1}}>{s.val}</div>
                  <div style={{fontFamily:"Barlow,sans-serif",fontSize:8,color:"#55449a",letterSpacing:2,marginTop:2}}>{s.label}</div>
                </div>
              ))}
            </div>
            {/* Push not-checked-in to Emcee */}
            {catParts.filter(p=>!p.checked_in&&!p.disqualified).length>0&&(
              <div style={{background:"#0a1a00",border:"1px solid #7fff0033",borderRadius:10,padding:"12px 16px",marginBottom:16}}>
                <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:12,letterSpacing:2,color:"#7fff00",marginBottom:6}}>📣 LAST CALL — NOT YET CHECKED IN</div>
                <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#9980cc",marginBottom:8}}>
                  Push these names to the Emcee for a final announcement before disqualification:
                </div>
                <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:10}}>
                  {catParts.filter(p=>!p.checked_in&&!p.disqualified).map(p=>(
                    <span key={p.id} style={{fontFamily:"Bebas Neue,sans-serif",fontSize:11,padding:"4px 10px",background:"#120e22",border:"1px solid #ff4d4d44",borderRadius:20,color:"#ff4d4d"}}>{p.name}</span>
                  ))}
                </div>
                <button className="btn" style={{background:"#7fff00",color:"#000",fontSize:11,padding:"8px 18px"}}
                  onClick={async()=>{
                    const names=catParts.filter(p=>!p.checked_in&&!p.disqualified).map(p=>p.name).join(", ");
                    const msg=`🎤 LAST CALL — Please check in NOW or you will be disqualified: ${names}`;
                    const{error}=await supabase.from("event_notifications").insert({event_id:event.id,message:msg,round:"Check-In"});
                    if(error)showToast("Failed to push to Emcee","error");
                    else showToast("📣 Last call pushed to Emcee screen ✓");
                  }}>
                  📣 PUSH LAST CALL TO EMCEE
                </button>
              </div>
            )}
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(185px,1fr))",gap:12}}>
              {catParts.filter(p=>p.name.toLowerCase().includes(searchQr.toLowerCase())).map(p=>(
                <div key={p.id} className="card" style={{textAlign:"center",border:`1px solid ${p.disqualified?"#33333388":p.checked_in?col.border:"#2a1f4a"}`,opacity:p.disqualified?0.5:1}}>
                  <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:15,marginBottom:2}}>{p.name}</div>
                  <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#7755aa",marginBottom:6}}>{p.city}</div>
                  {p.payment_method&&<div style={{marginBottom:8}}><span className="badge" style={{background:p.payment_method==="online"?"#00e5ff22":"#ffd70022",color:p.payment_method==="online"?"#00e5ff":"#ffd700",fontSize:9}}>{p.payment_method==="online"?"📲 Online":"💵 Cash"}</span></div>}
                  {p.disqualified?(
                    <div>
                      <span className="badge" style={{background:"#22222244",color:"#9980cc",border:"1px solid #44444444",display:"block",marginBottom:6}}>✗ DISQUALIFIED</span>
                      <button style={{fontFamily:"Barlow,sans-serif",fontSize:9,color:"#7755aa",background:"none",border:"1px solid #3d2080",borderRadius:4,padding:"2px 8px",cursor:"pointer",width:"100%"}}
                        onClick={async()=>{await supabase.from("participants").update({disqualified:false}).eq("id",p.id);showToast("Reinstated ✓");}}>
                        ↩ Reinstate
                      </button>
                    </div>
                  ):p.checked_in?(
                    <span className="badge" style={{background:"#00c85322",color:"#00c853",border:"1px solid #00c85344"}}>✓ CHECKED IN</span>
                  ):(
                    <div style={{display:"flex",flexDirection:"column",gap:6}}>
                      <button className="btn" style={{background:"#00c853",color:"#000",fontSize:11,width:"100%"}} onClick={()=>checkIn(p.id)}>CHECK IN</button>
                      <button className="btn" style={{background:"#150608",color:"#ff4d4d",border:"1px solid #ff4d4d44",fontSize:10,width:"100%",padding:"6px"}}
                        onClick={async()=>{const{error}=await supabase.from("participants").update({disqualified:true}).eq("id",p.id);if(error)showToast("Failed","error");else showToast(`${p.name} disqualified`,"error");}}>
                        ✗ DISQUALIFY
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {tab==="scores"&&(
          <div className="slide">
            <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:18,letterSpacing:3,color:col.primary,marginBottom:4}}>SCORES (VIEW ONLY) · {activeCat}</div>
            <div style={{fontFamily:"Barlow,sans-serif",fontSize:12,color:"#7755aa",marginBottom:8}}>Prelim scores only — entered by judges. Read-only for organizers.</div>
            <div style={{background:"#1a1a0a",border:"1px solid #ffd70022",borderRadius:8,padding:"8px 14px",marginBottom:18,fontFamily:"Barlow,sans-serif",fontSize:11,color:"#9980cc"}}>
              ⚡ These scores are used only for seeding. They do not carry into knockout rounds.
            </div>
            {checkedIn.map(p=>{
              const sm=scoreMap[p.id]||{};
              return (
                <div key={p.id} className="card" style={{marginBottom:10}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10,flexWrap:"wrap",gap:6}}>
                    <div><div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:16}}>{p.name}</div><div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#7755aa"}}>{p.city}</div></div>
                    <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:28,color:col.primary}}>{getScore(p.id)||"—"}</div>
                  </div>
                  <div style={{display:"flex",gap:7,flexWrap:"wrap"}}>
                    {catJudges.map(j=>{const key=`${j.category}-J${j.slot}`;return <div key={key} style={{background:"#1c1232",border:"1px solid #3d2080",borderRadius:6,padding:"5px 9px",textAlign:"center",minWidth:64}}><div style={{fontFamily:"Barlow,sans-serif",fontSize:8,color:"#7755aa",marginBottom:1}}>{j.judge_name}</div><div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:20,color:"#fff"}}>{sm[key]??"—"}</div></div>;})}
                  </div>
                </div>
              );
            })}
            {checkedIn.length===0&&<div style={{textAlign:"center",padding:"48px",fontFamily:"Barlow,sans-serif",color:"#3d2080"}}>No checked-in participants yet</div>}
          </div>
        )}

        {tab==="bracket"&&<BracketTab event={event} activeCat={activeCat} col={col} prelimRanked={prelimRanked} participantMap={participantMap} showToast={showToast}/>}

        {tab==="leaderboard"&&(
          <div className="slide">
            <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:18,letterSpacing:3,color:col.primary,marginBottom:4}}>PRELIM RANKING · {activeCat}</div>
            <div style={{fontFamily:"Barlow,sans-serif",fontSize:11,color:"#7755aa",marginBottom:4}}>Ranked by total scores from all judges. Sets seeds for knockout brackets.</div>
            <div style={{background:"#1a1a0a",border:"1px solid #ffd70022",borderRadius:8,padding:"8px 14px",marginBottom:16,fontFamily:"Barlow,sans-serif",fontSize:11,color:"#9980cc"}}>
              Total score = sum of all judge scores in this category. Top N advance to knockout.
            </div>
            {catSorted.length>=2&&(
              <div style={{display:"flex",gap:10,marginBottom:22,flexWrap:"wrap"}}>
                {[{p:catSorted[1],rank:2,pt:55},{p:catSorted[0],rank:1,pt:85},{p:catSorted[2],rank:3,pt:38}].map(({p,rank,pt})=>p&&(
                  <div key={p.id} style={{flex:1,minWidth:120,background:rank===1?col.bg:"#0f0b1e",border:`1px solid ${rank===1?col.border:"#1c1232"}`,borderRadius:12,padding:"14px",paddingTop:pt+"px",textAlign:"center"}}>
                    <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:38,color:rank===1?col.primary:rank===2?"#c0a8e8":"#cd7f32",lineHeight:1}}>#{rank}</div>
                    <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:17,marginBottom:2}}>{p.name}</div>
                    <div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#7755aa",marginBottom:6}}>{p.city}</div>
                    <div style={{fontFamily:"Barlow,sans-serif",fontSize:9,color:"#7755aa",marginBottom:2}}>TOTAL</div>
                    <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:36,color:rank===1?col.primary:"#fff"}}>{getScore(p.id)}</div>
                  </div>
                ))}
              </div>
            )}
            <div style={{background:"#0d0a1a",border:"1px solid #161616",borderRadius:12,overflow:"hidden"}}>
              {catSorted.map((p,i)=>(
                <div key={p.id} className="lrow">
                  <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:20,color:i<3?col.primary:"#2a1840",minWidth:36}}>#{i+1}</div>
                  <div style={{flex:1}}><div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:15}}>{p.name}</div><div style={{fontFamily:"Barlow,sans-serif",fontSize:10,color:"#7755aa"}}>{p.city}</div></div>
                  <div style={{fontFamily:"Barlow,sans-serif",fontSize:9,color:"#7755aa",marginRight:6}}>TOTAL</div>
                  <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:18,color:i<3?col.primary:"#fff",minWidth:32,textAlign:"right"}}>{getScore(p.id)||"—"}</div>
                  <span className="badge" style={{background:p.checked_in?"#00c85322":"#ff4d4d22",color:p.checked_in?"#00c853":"#ff4d4d"}}>{p.checked_in?"✓":"⌛"}</span>
                </div>
              ))}
              {catParts.length===0&&<div style={{padding:"40px",textAlign:"center",fontFamily:"Barlow,sans-serif",color:"#3d2080"}}>No participants yet</div>}
            </div>
          </div>
        )}




        {tab==="notifications"&&(
          <div className="slide">
            <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:18,letterSpacing:3,color:col.primary,marginBottom:4}}>ANNOUNCEMENTS LOG</div>
            <div style={{fontFamily:"Barlow,sans-serif",fontSize:11,color:"#7755aa",marginBottom:16}}>All announcements sent during this event. As host you can hide/show any announcement's popup on recipient screens.</div>
            <NotificationHistoryPanel history={notifHistory} isHost={true} eventId={event.id} showToast={showToast}/>
          </div>
        )}

        {tab==="export"&&(
          <div className="slide">
            <div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:18,letterSpacing:3,color:col.primary,marginBottom:4}}>EXPORT EVENT DATA</div>
            <div style={{fontFamily:"Barlow,sans-serif",fontSize:12,color:"#7755aa",marginBottom:16}}>Download Excel sheets for participants (name, phone, payment, category, check-in, scores & results) or viewers (name, phone, city, payment).</div>
            <div style={{display:"flex",gap:10,marginBottom:20,flexWrap:"wrap"}}>
              <div style={{background:"#110d22",border:"1px solid #181818",borderRadius:8,padding:"8px 14px",fontFamily:"Barlow,sans-serif",fontSize:11,color:"#9980cc"}}>
                📋 <strong style={{color:"#fff"}}>{participants.length}</strong> competition participants · <strong style={{color:"#00e5ff"}}>{attendees.filter(a=>a.role==="attendee").length}</strong> viewers
              </div>
            </div>
            <div style={{background:"#0a1a0a",border:"1px solid #00c85322",borderRadius:8,padding:"8px 14px",marginBottom:16,fontFamily:"Barlow,sans-serif",fontSize:11,color:"#00c853"}}>
              📊 Exports as <strong>.xlsx</strong> Excel file — opens directly in Excel, Google Sheets, or Numbers.
            </div>
            <div style={{display:"flex",gap:12,flexWrap:"wrap"}}>
              <button className="btn" style={{background:"#ffd700",color:"#000",fontSize:13,padding:"13px 28px"}} onClick={exportParticipantsCSV}>⬇ EXPORT PARTICIPANTS (.xlsx)</button>
              <button className="btn" style={{background:"#00e5ff",color:"#000",fontSize:13,padding:"13px 28px"}} onClick={exportViewersCSV}>⬇ EXPORT VIEWERS (.xlsx)</button>
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
  const [emceeData,setEmceeData]=useState(null);
  const [orgMemberName,setOrgMemberName]=useState(null);
  const [toast,setToast]=useState(null);
  const showToast=(msg,type="success")=>{setToast({msg,type});setTimeout(()=>setToast(null),3000);};

  useEffect(()=>{
    // Load SheetJS for Excel exports
    if(!window.XLSX){
      const s=document.createElement("script");
      s.src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
      document.head.appendChild(s);
    }
    supabase.auth.getSession().then(({data:{session}})=>{if(session?.user)setScreen("adminDashboard");else setScreen("landing");});
    const{data:{subscription}}=supabase.auth.onAuthStateChange((_e,session)=>{if(!session?.user&&screen==="adminDashboard")setScreen("landing");});
    return()=>subscription.unsubscribe();
  },[]);

  const handleAdminLogout=async()=>{await supabase.auth.signOut();setScreen("landing");};

  if(screen==="loading")return <div style={{fontFamily:"'Bebas Neue',sans-serif",background:"#0a0612",minHeight:"100vh",color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:24}}><style>{CSS}</style><div style={{fontFamily:"Bebas Neue,sans-serif",fontSize:48,letterSpacing:5}}>DAN<span style={{color:"#a855f7"}}>BUZZ</span></div><Spinner/></div>;

  return (
    <div style={{fontFamily:"'Bebas Neue',sans-serif",background:"#0a0612",minHeight:"100vh",color:"#fff"}}>
      <style>{CSS}</style>
      <Toast toast={toast}/>
      {screen==="landing"         &&<LandingScreen onAdminLogin={()=>setScreen("adminLogin")} onOrgLogin={()=>setScreen("orgLogin")} onJudgeLogin={()=>setScreen("judgeLogin")} onViewerLogin={()=>setScreen("attendeeLogin")} onEmceeLogin={()=>setScreen("emceeLogin")}/>}
      {screen==="adminLogin"      &&<AdminLoginScreen onBack={()=>setScreen("landing")} onLogin={()=>setScreen("adminDashboard")} showToast={showToast}/>}
      {screen==="adminDashboard"  &&<AdminDashboard onBack={handleAdminLogout} showToast={showToast}/>}
      {screen==="orgLogin"        &&<OrgLoginScreen onBack={()=>setScreen("landing")} onLogin={(ev, memberName)=>{setActiveEvent(ev);setOrgMemberName(memberName);setScreen("dashboard");}} showToast={showToast}/>}
      {screen==="judgeLogin"      &&<JudgeLoginScreen onBack={()=>setScreen("landing")} onLogin={({judgeCode,event})=>{setJudgeData(judgeCode);setActiveEvent(event);setScreen("judgeDashboard");}} showToast={showToast}/>}
      {screen==="attendeeLogin"     &&<AttendeeLoginScreen onBack={()=>setScreen("landing")} onLogin={({event,name,role})=>{setActiveEvent(event);setViewerData({name,role});setScreen("attendeeDashboard");}} showToast={showToast}/>}
      {screen==="judgeDashboard"  &&judgeData&&activeEvent&&<JudgeDashboard judgeCode={judgeData} event={activeEvent} onBack={()=>{setJudgeData(null);setActiveEvent(null);setScreen("landing");}} showToast={showToast}/>}
      {screen==="attendeeDashboard"&&viewerData&&activeEvent&&<AttendeeDashboard event={activeEvent} attendeeName={viewerData.name} onBack={()=>{setViewerData(null);setActiveEvent(null);setScreen("landing");}}/>}
      {screen==="emceeLogin"      &&<EmceeLoginScreen onBack={()=>setScreen("landing")} onLogin={({event,name})=>{setActiveEvent(event);setEmceeData({name});setScreen("emceeDashboard");}} showToast={showToast}/>}
      {screen==="emceeDashboard"  &&emceeData&&activeEvent&&<EmceeDashboard event={activeEvent} emceeName={emceeData.name} onBack={()=>{setEmceeData(null);setActiveEvent(null);setScreen("landing");}}/>}
      {screen==="dashboard"       &&activeEvent&&<Dashboard event={activeEvent} memberName={orgMemberName} onBack={()=>{setActiveEvent(null);setOrgMemberName(null);setScreen("landing");}} showToast={showToast}/>}
    </div>
  );
}
