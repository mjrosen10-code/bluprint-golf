const fs=require('fs'),vm=require('vm');vm.runInThisContext(fs.readFileSync(__dirname+'/../public/games.js','utf8'));const G=globalThis.BPG;
const rounds=JSON.parse(fs.readFileSync('rounds.json','utf8'));
const out=rounds.map(R=>R.games.map(g=>{const r=G.scoreGame(g,R);return {money:r.money,won:r.won||null,carry:r.carry??null,up:r.match?r.match.up:null,bets:r.bets?r.bets.map(b=>b.up):null,winners:r.winners||null}}));
process.stdout.write(JSON.stringify(out));
