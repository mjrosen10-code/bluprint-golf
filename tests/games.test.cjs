// Run: node tests/games.test.cjs
const fs=require('fs'),vm=require('vm');vm.runInThisContext(fs.readFileSync(__dirname+'/../public/games.js','utf8'));const G=globalThis.BPG;
let fails=0,n=0;const eq=(name,got,want)=>{n++;const ok=JSON.stringify(got)===JSON.stringify(want);if(!ok){fails++;console.log('FAIL',name,'\n  got ',JSON.stringify(got),'\n  want',JSON.stringify(want))}};
const SI18=[7,3,15,11,1,9,17,5,13,8,16,2,12,4,10,18,6,14];const PAR18=[4,4,3,5,4,4,3,4,5,4,3,4,5,4,4,3,4,5];
const H18=PAR18.map((p,i)=>({par:p,si:SI18[i]}));
// --- Course Handicap ---
eq('CH 18.0 / 130 / 71.5 / 72',G.courseHandicap(18,130,71.5,72),20);
eq('CH plus 2.0 / 135 / 73.0 / 72',G.courseHandicap(-2,135,73,72),-1);
eq('CH 9 holes 18.0 / 130 / 35.6 / 36',G.courseHandicap(18,130,35.6,36,9),10);
eq('CH different tees: higher rating gets more strokes',[G.courseHandicap(10,125,70.1,72),G.courseHandicap(10,125,73.4,72)],[9,12]);
eq('CH rounds half away from zero',[G.rnd(2.5),G.rnd(-2.5),G.rnd(2.49)],[3,-3,2]);
eq('CH missing data is null',G.courseHandicap(null,130,71,72),null);
// --- Playing Handicap ---
eq('PH 85% of 20',G.playingHandicap(20,.85),17);
eq('PH 90% of 15',G.playingHandicap(15,.9),14);
// --- Stroke allocation ---
const s20=G.strokesByHole(20,H18);eq('20 strokes: SI 1 and 2 get two',[s20[4],s20[11],s20[1],s20[15]],[2,2,1,1]);eq('20 strokes total',s20.reduce((a,b)=>a+b),20);
const s5=G.strokesByHole(5,H18);eq('5 strokes on SI 1-5',H18.map((h,i)=>s5[i]?h.si:0).filter(Boolean).sort((a,b)=>a-b),[1,2,3,4,5]);
const sp=G.strokesByHole(-2,H18);eq('Plus 2 gives back on SI 17 and 18',H18.map((h,i)=>sp[i]?h.si:0).filter(Boolean).sort((a,b)=>a-b),[17,18]);eq('Plus 2 sign',sp.reduce((a,b)=>a+b),-2);
const s40=G.strokesByHole(40,H18);eq('40 strokes: SI 1-4 get three',H18.map((h,i)=>s40[i]===3?h.si:0).filter(Boolean).sort((a,b)=>a-b),[1,2,3,4]);
const H9=H18.slice(9);const s4=G.strokesByHole(4,H9);eq('Back 9: 4 strokes on the 4 hardest of those 9 (SI 2,4,6,8)',H9.map((h,i)=>s4[i]?h.si:0).filter(Boolean).sort((a,b)=>a-b),[2,4,6,8]);
// --- Four-ball match: 90% then off the low ---
const R4=(scores,chs,teams,layout)=>({holes:H18,layout,players:chs.map((ch,i)=>({id:'p'+i,name:'P'+i,ch,team:teams[i]})),scores:Object.fromEntries(chs.map((c,i)=>['p'+i,scores[i]]))});
const fb={type:'fourball',net:true};const r=R4([[],[],[],[]],[4,10,15,22],['A','A','B','B'],'2v2');
eq('Four-ball: 90% then off the low man',G.gameHandicaps(fb,r).receive,{p0:0,p1:5,p2:10,p3:16});
eq('Best ball stroke: 85%, full strokes',G.gameHandicaps({type:'fourballStroke',net:true},r).receive,{p0:3,p1:9,p2:13,p3:19});
eq('Stroke play foursome: 100%',G.gameHandicaps({type:'stroke',net:true},r).receive,{p0:4,p1:10,p2:15,p3:22});
eq('Skins default: off the low man',G.gameHandicaps({type:'skins',net:true},r).receive,{p0:0,p1:6,p2:11,p3:18});
eq('Nassau 2v2 inherits 90%',G.gameHandicaps({type:'nassau',net:true},r).allowance,.9);
eq('Nassau 1v1 is 100%',G.gameHandicaps({type:'nassau',net:true},{...r,layout:'1v1'}).allowance,1);
eq('Gross games give no strokes',G.gameStrokes({type:'fourball',net:false},r).p3.reduce((a,b)=>a+b),0);
// --- Match play: closeout 3 & 2 (gross for clarity) ---
const a=PAR18.map(p=>p),b=PAR18.map(p=>p+1);const m=G.scoreGame({type:'match',net:false,stake:10},{holes:H18,layout:'1v1',players:[{id:'a',name:'Al',ch:0},{id:'b',name:'Bo',ch:0}],scores:{a,b}});
eq('Match ends 10 & 8 when up more than holes left',m.headline,'Al wins 10 & 8');eq('Match money',m.money,{a:10,b:-10});
const a2=PAR18.map(p=>p),b2=PAR18.map((p,i)=>i<3?p+1:p);const m2=G.scoreGame({type:'match',net:false},{holes:H18,layout:'1v1',players:[{id:'a',name:'Al',ch:0},{id:'b',name:'Bo',ch:0}],scores:{a:a2,b:b2}});eq('Match: 3 up with 2 to play ends 3 & 2',m2.headline,'Al wins 3 & 2');
const a3=PAR18.map(p=>p),b3=PAR18.map((p,i)=>i===17?p+1:p);eq('Match decided on 18 reads 1 UP',G.scoreGame({type:'match',net:false},{holes:H18,layout:'1v1',players:[{id:'a',name:'Al',ch:0},{id:'b',name:'Bo',ch:0}],scores:{a:a3,b:b3}}).headline,'Al wins 1 UP');
// Net match: Bo gets 1 stroke on SI 1 (hole 5); tie on gross there becomes a Bo win
const mn=G.scoreGame({type:'match',net:true},{holes:H18,layout:'1v1',players:[{id:'a',name:'Al',ch:5},{id:'b',name:'Bo',ch:6}],scores:{a:PAR18.slice(),b:PAR18.slice()}});
eq('Net match: Bo wins the SI-1 hole with his stroke',mn.holes.find(x=>x.i===4).w,-1);eq('Net match final',mn.headline,'Bo wins 1 UP');
// Incomplete: missing scores are never zero
const part=G.scoreGame({type:'match',net:false},{holes:H18,layout:'1v1',players:[{id:'a',name:'Al',ch:0},{id:'b',name:'Bo',ch:0}],scores:{a:PAR18.slice(0,5),b:PAR18.slice(0,4).map(x=>x+1)}});
eq('Incomplete: only holes with every score count',[part.match.played,part.complete],[4,false]);eq('Incomplete pays nothing',part.money,{a:0,b:0});
// --- Skins with carryovers ---
const sk=G.scoreGame({type:'skins',net:false,stake:5},{holes:H18.slice(0,4),layout:'ind',players:[{id:'a',name:'A',ch:0},{id:'b',name:'B',ch:0},{id:'c',name:'C',ch:0}],scores:{a:[4,4,3,4],b:[4,5,3,6],c:[5,5,2,5]}});
eq('Skins: hole 1 tie carries, A wins 2 on hole 2, C wins 3, A wins 4',sk.won,{a:3,b:0,c:1});eq('Skins: hole 4 won by A',sk.holes[3].winner,'a');
eq('Skins money: each skin paid by every other player',sk.money,{a:3*5*2-1*5,b:-(3*5)-(1*5),c:1*5*2-3*5});
const sk2=G.scoreGame({type:'skins',net:false},{holes:H18.slice(0,3),layout:'ind',players:[{id:'a',name:'A',ch:0},{id:'b',name:'B',ch:0}],scores:{a:[4,4,3],b:[4,4,3]}});eq('Skins unclaimed carry',sk2.carry,3);
// --- Stableford ---
eq('Stableford points',[-3,-2,-1,0,1,2,3].map(G.STABLE),[5,4,3,2,1,0,0]);
const sf=G.scoreGame({type:'stableford',net:true},{holes:H18.slice(0,2),layout:'ind',players:[{id:'a',name:'A',ch:0},{id:'b',name:'B',ch:36}],scores:{a:[4,4],b:[6,6]}});
eq('Stableford net: B gets 4 strokes over 2 holes (36 on 18 → per 2-hole card base 18)',sf.standings.map(x=>[x.id,x.value]),[['b',6+6],['a',4]].sort((x,y)=>y[1]-x[1]).map(x=>x));
// --- Stroke play ---
const sp2=G.scoreGame({type:'stroke',net:true,stake:20},{holes:H18,layout:'ind',players:[{id:'a',name:'A',ch:2},{id:'b',name:'B',ch:12},{id:'c',name:'C',ch:20}],scores:{a:PAR18.map(p=>p+0),b:PAR18.map(p=>p+1),c:PAR18.map(p=>p+1)}});
eq('Net stroke: A (72-2) and C (90-20) tie at 70, B 78',sp2.standings.map(x=>[x.id,x.value]),[['a',70],['c',70],['b',78]]);eq('Stroke pot split on a tie',sp2.money,{a:10,b:-20,c:10});
// --- Best ball stroke ---
const bbs=G.scoreGame({type:'fourballStroke',net:false,stake:10},R4([PAR18,PAR18.map(p=>p+2),PAR18.map(p=>p+1),PAR18.map(p=>p+1)],[0,0,0,0],['A','A','B','B'],'2v2'));
eq('Best ball stroke totals',bbs.totals,{A:72,B:90});eq('Team money: each player wins/loses the stake',bbs.money,{p0:10,p1:10,p2:-10,p3:-10});
// --- Four-ball match, net ---
const fbm=G.scoreGame({type:'fourball',net:true,stake:5},R4([PAR18,PAR18,PAR18,PAR18],[0,0,0,2],['A','A','B','B'],'2v2'));
eq('Four-ball net: P3 gets 2 strokes (90% of 2 = 2), wins SI 1-2 holes, 2 up with 1 to play',fbm.headline,'P2 & P3 win 2 & 1');
// --- 1 v 3 money ---
const lone=G.scoreGame({type:'lone',net:false,stake:10},R4([PAR18.map(p=>p-1),PAR18,PAR18,PAR18],[0,0,0,0],['A','B','B','B'],'3v1'));
eq('1 v 3: lone player collects from each of three',lone.money,{p0:30,p1:-10,p2:-10,p3:-10});
// --- Nassau with auto-press ---
const na=PAR18.slice(),nb=PAR18.map((p,i)=>i<2?p+1:p);// Al wins holes 1 and 2 → Bo 2 down after hole 2 → press from hole 3
const nas=G.scoreGame({type:'nassau',net:false,stake:10},{holes:H18,layout:'1v1',players:[{id:'a',name:'Al',ch:0},{id:'b',name:'Bo',ch:0}],scores:{a:na,b:nb}});
eq('Nassau bets',nas.bets.map(b=>[b.label,b.up]),[['Front',2],['Front press (from 3)',0],['Back',0],['Overall',2]]);
eq('Nassau money: front + overall to Al, press and back halved',nas.money,{a:20,b:-20});
const nas9=G.scoreGame({type:'nassau',net:false},{holes:H18.slice(0,9),layout:'1v1',players:[{id:'a',name:'A',ch:0},{id:'b',name:'B',ch:0}],scores:{a:[],b:[]}});eq('Nassau needs 18',nas9.headline,'Nassau needs 18 holes');
// --- Settle-up ---
const st=G.settle([{money:{a:30,b:-10,c:-10,d:-10}},{money:{a:-5,b:5,c:0,d:0}}],[{id:'a'},{id:'b'},{id:'c'},{id:'d'}]);
eq('Settle balances',st.balance,{a:25,b:-5,c:-10,d:-10});eq('Fewest payments',st.payments.length,3);eq('Payments sum',st.payments.reduce((t,p)=>t+p.amount,0),25);
// --- SI check ---
eq('SI present and unique',[G.hasSI(H18),G.hasSI(H18.map(h=>({...h,si:''}))),G.hasSI(H18.map(h=>({...h,si:1})))],[true,false,false]);

// --- Nassau 2v2 money: every bet pays each player the stake ---
const n22=G.scoreGame({type:'nassau',net:false,stake:5,press:false},R4([PAR18.map((p,i)=>i===0?p-1:p),PAR18,PAR18,PAR18],[0,0,0,0],['A','A','B','B'],'2v2'));
eq('Nassau 2v2: A wins front and overall 1 up, back halved',n22.money,{p0:10,p1:10,p2:-10,p3:-10});
// --- 1 v 3 net: lone player's strokes vs the low man ---
eq('1 v 3 strokes off the low man at 100%',G.gameHandicaps({type:'lone',net:true},R4([[],[],[],[]],[10,4,12,20],['A','B','B','B'],'3v1')).receive,{p0:6,p1:0,p2:8,p3:16});
// --- Plus player in match play gives no strokes back when he's the low man (others receive the difference) ---
eq('Match: plus 2 vs 10 means 12 strokes to the 10',G.gameHandicaps({type:'match',net:true},{holes:H18,layout:'1v1',players:[{id:'a',ch:-2},{id:'b',ch:10}],scores:{}}).receive,{a:0,b:12});
// --- Stroke play with a plus player: gives back on SI 17-18 ---
const plus=G.gameStrokes({type:'stroke',net:true},{holes:H18,layout:'ind',players:[{id:'a',ch:-2}],scores:{}}).a;eq('Plus 2 in stroke play: net = gross + 1 on SI 17 and 18',H18.map((h,i)=>plus[i]?h.si:0).filter(Boolean).sort((x,y)=>x-y),[17,18]);
// --- Edited scores recalculate ---
const sc1={a:PAR18.slice(),b:PAR18.slice()};const g1={type:'match',net:false};const rr={holes:H18,layout:'1v1',players:[{id:'a',name:'Al',ch:0},{id:'b',name:'Bo',ch:0}],scores:sc1};
const before=G.scoreGame(g1,rr).headline;sc1.b[0]=3;const after=G.scoreGame(g1,rr).headline;eq('Edited score changes the result',[before,after],['Halved','Bo wins 1 UP']);
console.log(`${n-fails}/${n} passed`);process.exit(fails?1:0);
