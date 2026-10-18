// BluPrint Golf: group games and handicap engine (pure functions; no app state).
// Handicap math follows the USGA Rules of Handicapping (WHS):
//   Course Handicap  = Index x Slope/113 + (Course Rating - Par), rounded (USGA: round the Course Handicap first)
//   9 holes          = (Index / 2) x Slope/113 + (9-hole Rating - 9-hole Par)
//   Playing Handicap = Course Handicap x format allowance, rounded
//   Match formats    = lowest Playing Handicap plays off zero; others receive the difference
//   Strokes go to holes by stroke index (hardest first); plus handicaps give strokes back from the easiest hole.
(function(root){
'use strict';
// Round half away from zero (so +2.5 and 2.5 behave symmetrically)
const rnd=x=>x<0?-Math.floor(-x+0.5):Math.floor(x+0.5);
const sum=a=>a.reduce((t,x)=>t+x,0);

function courseHandicap(index,slope,rating,par,holes){
  if(index==null||isNaN(index)||!slope||!rating||!par)return null;
  const ix=holes===9?index/2:index;
  return rnd(ix*(slope/113)+(rating-par));
}
function playingHandicap(ch,allowance){return ch==null?null:rnd(ch*(allowance==null?1:allowance))}

// Rank the played holes by stroke index (1 = hardest). Works for 9-hole rounds on an 18-hole card.
function siRanks(holes){
  const idx=holes.map((h,i)=>({i,si:Number(h.si)||99+i}));
  idx.sort((a,b)=>a.si-b.si||a.i-b.i);
  const r=Array(holes.length);idx.forEach((x,k)=>{r[x.i]=k+1});return r;
}
// Strokes received on each hole for a handicap (can be > number of holes, or negative for plus players)
function strokesByHole(ph,holes){
  const n=holes.length,r=siRanks(holes);
  if(!ph)return Array(n).fill(0);
  if(ph>0){const base=Math.floor(ph/n),rem=ph%n;return r.map(k=>base+(k<=rem?1:0))}
  const k=-ph,base=Math.floor(k/n),rem=k%n;return r.map(x=>-(base+(x>n-rem?1:0)));
}
function hasSI(holes){const v=holes.map(h=>Number(h.si)).filter(x=>x>0);return v.length===holes.length&&new Set(v).size===v.length}

// ---------- Game catalog (phase 1) ----------
const CATALOG={
  stroke:{name:'Stroke play',short:'Lowest total score wins.',teams:['ind'],min:2,max:8,net:true,allowance:1,offLow:false,
    how:'Everyone plays their own ball and counts every stroke. Lowest total wins. Net subtracts each player\'s handicap strokes.',
    note:'WHS recommends 95% for fields of 30 to 100 players and allows 100% for smaller groups, so a foursome plays at 100%.'},
  stableford:{name:'Stableford',short:'Points per hole vs par. Most points wins.',teams:['ind'],min:2,max:8,net:true,allowance:1,offLow:false,
    how:'Points on every hole from your net score vs par: double bogey or worse 0, bogey 1, par 2, birdie 3, eagle 4, albatross 5. Most points wins. A blow-up hole only costs you that hole.',
    note:'Net points use full handicap strokes (100% for a small group).'},
  skins:{name:'Skins',short:'Win a hole outright, win the skin. Ties carry over.',teams:['ind'],min:2,max:8,net:true,allowance:1,offLow:true,
    how:'Each hole is worth a skin. The lowest score wins it, but only outright. If two or more tie for low, the skin carries over and the next hole is worth more.',
    note:'There\'s no official allowance for skins. Default: 100%, everyone plays off the lowest handicap in the group.'},
  match:{name:'Match play',short:'Head to head, hole by hole.',teams:['1v1'],min:2,max:2,net:true,allowance:1,offLow:true,
    how:'Win a hole with the lower score; tie and it\'s halved. The match is over when one player is up by more holes than are left.',
    note:'WHS: 100%. The lower handicap plays off zero and the other player gets the difference, on the hardest holes.'},
  fourball:{name:'Best ball match',short:'2 v 2. Each team\'s best score wins the hole.',teams:['2v2'],min:4,max:4,net:true,allowance:.9,offLow:true,
    how:'Everyone plays their own ball. On each hole the team with the better best score wins the hole. Scored like match play: 2 UP, all square, 3 & 2.',
    note:'WHS: 90% of each Course Handicap, then everyone plays off the lowest player.'},
  fourballStroke:{name:'Best ball stroke',short:'2 v 2. Team\'s best score each hole, lowest total wins.',teams:['2v2'],min:4,max:4,net:true,allowance:.85,offLow:false,
    how:'Everyone plays their own ball. The team\'s better score on each hole counts. Add them up; lowest team total wins.',
    note:'WHS: 85% of each Course Handicap.'},
  nassau:{name:'Nassau',short:'Three bets: front 9, back 9 and overall.',teams:['1v1','2v2'],min:2,max:4,net:true,allowance:null,offLow:true,holes:18,
    how:'Three match-play bets in one: the front nine, the back nine and all 18. With auto-press, a new bet starts on the next hole whenever a side goes 2 down in a bet; it runs to the end of that nine.',
    note:'Handicaps follow the match: 100% for 1 v 1, 90% for 2 v 2 best ball, everyone off the lowest player.'},
  lone:{name:'1 v 3',short:'One player vs the best ball of three.',teams:['3v1'],min:4,max:4,net:true,allowance:1,offLow:true,house:true,
    how:'The lone player\'s score against the best score of the other three on each hole, scored like match play.',
    note:'House rule, no official allowance. The three-man best ball is a big edge, so many groups give the lone player extra strokes or play Wolf instead.'}
};
const TEAM_LAYOUTS={ind:'Everyone for themselves','1v1':'1 v 1','2v2':'2 v 2','3v1':'3 v 1'};
function gameAllowance(g,layout){const c=CATALOG[g.type];if(g.allowance!=null)return g.allowance;if(c.allowance!=null)return c.allowance;return g.type==='nassau'&&layout==='2v2'?.9:1}

// Per-game handicap strokes for every player on every hole
function gameStrokes(g,round){
  const c=CATALOG[g.type],ps=round.players,holes=round.holes;
  if(!g.net)return Object.fromEntries(ps.map(p=>[p.id,Array(holes.length).fill(0)]));
  const al=gameAllowance(g,round.layout);
  const ph=Object.fromEntries(ps.map(p=>[p.id,playingHandicap(p.ch,al)]));
  const off=(g.offLow??c.offLow)?Math.min(...ps.map(p=>ph[p.id]??0)):0;
  return Object.fromEntries(ps.map(p=>[p.id,strokesByHole((ph[p.id]??0)-off,holes)]));
}
function gameHandicaps(g,round){const c=CATALOG[g.type];const al=gameAllowance(g,round.layout);const ph=Object.fromEntries(round.players.map(p=>[p.id,g.net?playingHandicap(p.ch,al):0]));
  const off=g.net&&(g.offLow??c.offLow)?Math.min(...round.players.map(p=>ph[p.id]??0)):0;return {allowance:al,ph,off,receive:Object.fromEntries(round.players.map(p=>[p.id,(ph[p.id]??0)-off]))}}

const has=v=>v!=null&&v!==''&&!isNaN(v)&&Number(v)>0;
function netScores(g,round){const st=gameStrokes(g,round);const out={};for(const p of round.players){const sc=round.scores[p.id]||[];out[p.id]=round.holes.map((h,i)=>has(sc[i])?Number(sc[i])-st[p.id][i]:null)}return {net:out,strokes:st}}
function teamSides(round){const A=round.players.filter(p=>p.team==='A').map(p=>p.id),B=round.players.filter(p=>p.team==='B').map(p=>p.id);return {A,B}}
// Holes where every player has a score (we never treat a missing score as zero)
function doneHoles(round){return round.holes.map((h,i)=>round.players.every(p=>has((round.scores[p.id]||[])[i])))}

function matchTrack(holeWinner,from,to,done){ // holeWinner(i) => 1 (A), -1 (B), 0 halve
  let up=0,played=0,closed=null;const per=[];
  for(let i=from;i<=to;i++){if(!done[i])break;const w=holeWinner(i);per.push({i,w});played++;up+=w;
    const left=to-i;if(closed==null&&Math.abs(up)>left){closed={up,left,at:i}}if(closed)break}
  return {up,played,total:to-from+1,closed,per,complete:!!closed||played===to-from+1};
}
function matchText(m,aName,bName){
  if(!m.played)return 'Not started';
  const lead=m.up>0?aName:bName,u=Math.abs(m.up),v=lead.includes(' & ')?'win':'wins';
  if(m.closed&&m.closed.left>0)return `${lead} ${v} ${u} & ${m.closed.left}`;
  if(m.complete)return m.up===0?'Halved':`${lead} ${v} ${u} UP`;
  const thru=`thru ${m.played}`;
  return m.up===0?`All square ${thru}`:`${lead} ${u} UP ${thru}`+(u===m.total-m.played?' (dormie)':'');
}
const STABLE=d=>d>=2?0:d===1?1:d===0?2:d===-1?3:d===-2?4:d===-3?5:6;

// ---------- Score every game ----------
function scoreGame(g,round){
  const c=CATALOG[g.type],holes=round.holes,n=holes.length,done=doneHoles(round),ps=round.players;
  const {net,strokes}=netScores(g,round);const name=id=>(ps.find(p=>p.id===id)||{}).name||'?';
  const stake=Number(g.stake)||0;const money=Object.fromEntries(ps.map(p=>[p.id,0]));
  const thru=done.findIndex(x=>!x);const nDone=thru<0?n:thru;const complete=nDone===n;
  const res={type:g.type,name:c.name,net:!!g.net,strokes,complete,lines:[],holes:[],money,stake};
  const sideName=(ids)=>ids.map(name).join(' & ');
  const payWinners=(W,L,amt)=>{if(!W.length||!L.length||!amt)return;const T=amt*Math.max(W.length,L.length);L.forEach(id=>money[id]-=T/L.length);W.forEach(id=>money[id]+=T/W.length)};
  const indivPot=(winners)=>{if(!stake||!winners.length)return;const losers=ps.filter(p=>!winners.includes(p.id)).map(p=>p.id);losers.forEach(l=>{money[l]-=stake;winners.forEach(w=>money[w]+=stake/winners.length)})};

  if(g.type==='stroke'||g.type==='stableford'){
    const tot={};for(const p of ps){const v=[];for(let i=0;i<nDone;i++){const x=net[p.id][i];v.push(g.type==='stableford'?STABLE(x-holes[i].par):x)}tot[p.id]=sum(v)}
    const better=g.type==='stableford'?(a,b)=>b-a:(a,b)=>a-b;
    const order=[...ps].sort((a,b)=>better(tot[a.id],tot[b.id]));
    const parThru=sum(holes.slice(0,nDone).map(h=>h.par));
    res.standings=order.map(p=>({id:p.id,name:p.name,value:tot[p.id],vsPar:g.type==='stroke'?tot[p.id]-parThru:null}));
    if(nDone){const best=tot[order[0].id];res.leaders=order.filter(p=>tot[p.id]===best).map(p=>p.id)}
    res.lines=res.standings.map(s=>`${s.name}: ${g.type==='stableford'?s.value+' pts':(g.net?'net ':'')+s.value+(s.vsPar!=null?` (${s.vsPar===0?'E':s.vsPar>0?'+'+s.vsPar:s.vsPar})`:'')}`);
    res.headline=!nDone?'Not started':(complete?'Final: ':`Thru ${nDone}: `)+(res.leaders.length>1?'Tied: '+res.leaders.map(name).join(', '):name(res.leaders[0])+' leads');
    if(complete){res.winners=res.leaders;indivPot(res.winners);if(res.winners.length===1)res.headline=`${name(res.winners[0])} wins`}
    return res;
  }
  if(g.type==='skins'){
    let carry=0;const won=Object.fromEntries(ps.map(p=>[p.id,0]));
    for(let i=0;i<nDone;i++){const v=ps.map(p=>({id:p.id,s:net[p.id][i]}));const lo=Math.min(...v.map(x=>x.s));const at=v.filter(x=>x.s===lo);
      const worth=1+carry;
      if(at.length===1){won[at[0].id]+=worth;res.holes.push({i,winner:at[0].id,worth});carry=0}
      else{res.holes.push({i,winner:null,worth});carry=g.carry===false?0:carry+1}}
    res.won=won;res.carry=carry;
    const totalWon=sum(Object.values(won));
    res.lines=ps.map(p=>`${p.name}: ${won[p.id]} skin${won[p.id]===1?'':'s'}`);
    const top=Math.max(0,...Object.values(won));const lead=ps.filter(p=>won[p.id]===top&&top>0).map(p=>p.name);
    res.headline=!nDone?'Not started':(lead.length?`${lead.join(' & ')} ${complete?(lead.length>1?'tie with':'wins'):(lead.length>1?'lead with':'leads with')} ${top} skin${top===1?'':'s'}`:'No skins won yet')+(carry?(complete?` · ${carry} unclaimed`:` · ${carry} carrying`):'');
    if(complete){if(carry)res.lines.push(`${carry} skin${carry===1?'':'s'} unclaimed after the last hole`);
      if(stake)for(const p of ps)for(const q of ps)if(p.id!==q.id){money[p.id]+=won[p.id]*stake;money[q.id]-=won[p.id]*stake}}
    return res;
  }
  // ----- head-to-head formats -----
  let A,B;
  if(g.type==='match'||(g.type==='nassau'&&round.layout==='1v1')){A=[ps[0].id];B=[ps[1].id]}
  else{const t=teamSides(round);A=t.A;B=t.B}
  const best=(ids,i)=>Math.min(...ids.map(id=>net[id][i]));
  const winner=i=>{const a=best(A,i),b=best(B,i);return a<b?1:a>b?-1:0};
  const an=sideName(A),bn=sideName(B);res.sides={A,B,an,bn};
  if(g.type==='fourballStroke'){
    let ta=0,tb=0;for(let i=0;i<nDone;i++){ta+=best(A,i);tb+=best(B,i)}
    res.totals={A:ta,B:tb};res.lines=[`${an}: ${ta}`,`${bn}: ${tb}`];
    res.headline=!nDone?'Not started':(ta===tb?'All square':`${ta<tb?an:bn} by ${Math.abs(ta-tb)}`)+(complete?'':` thru ${nDone}`);
    if(complete){if(ta!==tb){const W=ta<tb?A:B,L=ta<tb?B:A;res.winners=W;payWinners(W,L,stake);res.headline=`${sideName(W)} win by ${Math.abs(ta-tb)}`}else res.headline='Tied'}
    return res;
  }
  if(g.type==='match'||g.type==='fourball'||g.type==='lone'){
    const m=matchTrack(winner,0,n-1,done);res.match=m;res.headline=matchText(m,an,bn);res.lines=[res.headline];
    res.holes=m.per.map(x=>({i:x.i,w:x.w}));
    if(m.complete){if(m.up!==0){const W=m.up>0?A:B,L=m.up>0?B:A;res.winners=W;payWinners(W,L,stake)}res.complete=true}
    return res;
  }
  if(g.type==='nassau'){
    if(n!==18){res.headline='Nassau needs 18 holes';return res}
    const segs=[['Front',0,8],['Back',9,17],['Overall',0,17]];const press=g.press!==false;
    res.bets=[];
    for(const [label,from,to] of segs){
      const bets=[{label,from,to,pressed:false}];
      for(let k=0;k<bets.length;k++){const b=bets[k];let up=0,played=0;
        for(let i=b.from;i<=b.to;i++){if(!done[i])break;up+=winner(i);played++;
          if(press&&label!=='Overall'&&!b.pressed&&Math.abs(up)>=2&&i<b.to){b.pressed=true;bets.push({label:`${label} press (from ${i+2})`,from:i+1,to:b.to,pressed:false,press:true})}}
        b.up=up;b.played=played;b.complete=played===b.to-b.from+1}
      res.bets.push(...bets);
    }
    const t=b=>!b.played?'—':b.up===0?(b.complete?'Halved':'AS'):`${b.up>0?an:bn} ${b.complete?'won':Math.abs(b.up)+' UP'}`;
    res.lines=res.bets.filter(b=>b.press).map(b=>`${b.label.replace(' press (from ',' press from hole ').replace(')','')}: ${t(b)}`);
    const main=res.bets.filter(b=>!b.press);const one=A.length===1;const sa=one?an:'Team A',sb=one?bn:'Team B';
    const short=b=>!b.played?'—':b.up===0?(b.complete?'halved':'AS'):(b.up>0?sa:sb)+(b.complete?' won':' '+Math.abs(b.up)+' up');
    res.rows=res.bets.map(b=>({label:b.press?b.label.replace(' press (from ',' press · hole ').replace(')',''):b.label,result:short(b),press:!!b.press}));
    res.headline=main.map(b=>`${b.label} ${short(b)}`).join(' · ');
    if(complete){for(const b of res.bets){if(b.up>0)payWinners(A,B,stake);else if(b.up<0)payWinners(B,A,stake)}}
    return res;
  }
  return res;
}

// Net amounts per player across all games, then the fewest payments that settle them
function settle(results,players){
  const bal=Object.fromEntries(players.map(p=>[p.id,0]));
  for(const r of results)for(const id in r.money)bal[id]=(bal[id]||0)+r.money[id];
  for(const id in bal)bal[id]=Math.round(bal[id]*100)/100;
  const cred=Object.entries(bal).filter(([,v])=>v>0.004).map(([id,v])=>({id,v})).sort((a,b)=>b.v-a.v);
  const debt=Object.entries(bal).filter(([,v])=>v<-0.004).map(([id,v])=>({id,v:-v})).sort((a,b)=>b.v-a.v);
  const pays=[];let i=0,j=0;
  while(i<debt.length&&j<cred.length){const x=Math.min(debt[i].v,cred[j].v);pays.push({from:debt[i].id,to:cred[j].id,amount:Math.round(x*100)/100});debt[i].v-=x;cred[j].v-=x;if(debt[i].v<0.005)i++;if(cred[j].v<0.005)j++}
  return {balance:bal,payments:pays};
}

const api={rnd,courseHandicap,playingHandicap,strokesByHole,siRanks,hasSI,CATALOG,TEAM_LAYOUTS,gameAllowance,gameStrokes,gameHandicaps,netScores,doneHoles,scoreGame,settle,STABLE};
if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.BPG=api;
})(typeof window!=='undefined'?window:globalThis);
