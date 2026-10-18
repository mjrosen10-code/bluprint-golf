# Independent reference implementation (written separately from games.js) to cross-check every game.
import json,random,math,subprocess,sys
def rnd(x): return -math.floor(-x+0.5) if x<0 else math.floor(x+0.5)
def ch(index,slope,rating,par,n): ix=index/2 if n==9 else index; return rnd(ix*slope/113+(rating-par))
def ranks(holes):
    order=sorted(range(len(holes)),key=lambda i:(holes[i]['si'],i)); r=[0]*len(holes)
    for k,i in enumerate(order): r[i]=k+1
    return r
def strokes(ph,holes):
    n=len(holes);r=ranks(holes);out=[]
    for i in range(n):
        if ph>=0: out.append(ph//n+(1 if r[i]<=ph%n else 0))
        else:
            k=-ph; out.append(-(k//n+(1 if r[i]>n-(k%n) else 0)))
    return out
ALLOW={'stroke':1,'stableford':1,'skins':1,'match':1,'fourball':.9,'fourballStroke':.85,'lone':1}
OFFLOW={'stroke':False,'stableford':False,'skins':True,'match':True,'fourball':True,'fourballStroke':False,'nassau':True,'lone':True}
def game_strokes(g,R):
    if not g['net']: return {p['id']:[0]*len(R['holes']) for p in R['players']}
    al=ALLOW.get(g['type']) if g['type']!='nassau' else (.9 if R['layout']=='2v2' else 1)
    ph={p['id']:rnd(p['ch']*al) for p in R['players']}
    off=min(ph.values()) if OFFLOW[g['type']] else 0
    return {pid:strokes(v-off,R['holes']) for pid,v in ph.items()}
def stab(d): return 0 if d>=2 else {1:1,0:2,-1:3,-2:4,-3:5}.get(d,6)
def score(g,R):
    holes=R['holes'];n=len(holes);ps=[p['id'] for p in R['players']];st=game_strokes(g,R);S=R['scores'];stake=g.get('stake',0)
    net={p:[S[p][i]-st[p][i] for i in range(n)] for p in ps};money={p:0.0 for p in ps}
    def pay(W,L,amt):
        if not amt: return
        T=amt*max(len(W),len(L))
        for l in L: money[l]-=T/len(L)
        for w in W: money[w]+=T/len(W)
    if g['type'] in('stroke','stableford'):
        tot={p:sum(stab(net[p][i]-holes[i]['par']) if g['type']=='stableford' else net[p][i] for i in range(n)) for p in ps}
        best=(max if g['type']=='stableford' else min)(tot.values());W=[p for p in ps if tot[p]==best]
        if stake:
            for l in ps:
                if l not in W:
                    money[l]-=stake
                    for w in W: money[w]+=stake/len(W)
        return money,{'winners':sorted(W)}
    if g['type']=='skins':
        carry=0;won={p:0 for p in ps}
        for i in range(n):
            lo=min(net[p][i] for p in ps);at=[p for p in ps if net[p][i]==lo]
            if len(at)==1: won[at[0]]+=1+carry;carry=0
            else: carry=carry+1 if g.get('carry',True) else 0
        for p in ps:
            for q in ps:
                if p!=q: money[p]+=won[p]*stake;money[q]-=won[p]*stake
        return money,{'won':won,'carry':carry}
    if g['type']=='match' or (g['type']=='nassau' and R['layout']=='1v1'): A=[ps[0]];B=[ps[1]]
    else: A=[p['id'] for p in R['players'] if p['team']=='A'];B=[p['id'] for p in R['players'] if p['team']=='B']
    best=lambda T,i:min(net[p][i] for p in T)
    win=lambda i:1 if best(A,i)<best(B,i) else -1 if best(A,i)>best(B,i) else 0
    if g['type']=='fourballStroke':
        ta=sum(best(A,i) for i in range(n));tb=sum(best(B,i) for i in range(n))
        if ta<tb: pay(A,B,stake)
        elif tb<ta: pay(B,A,stake)
        return money,{'ta':ta,'tb':tb}
    if g['type'] in('match','fourball','lone'):
        up=0
        for i in range(n):
            up+=win(i)
            if abs(up)>n-1-i: break
        if up>0: pay(A,B,stake)
        elif up<0: pay(B,A,stake)
        return money,{'up':up}
    if g['type']=='nassau':
        res=[]
        for label,a,b in [('F',0,8),('B',9,17),('O',0,17)]:
            bets=[[a,b,False]];k=0
            while k<len(bets):
                fa,fb,_=bets[k];up=0;pressed=False
                for i in range(fa,fb+1):
                    up+=win(i)
                    if g.get('press',True) and label!='O' and not pressed and abs(up)>=2 and i<fb: pressed=True;bets.append([i+1,fb,False])
                res.append(up)
                if up>0: pay(A,B,stake)
                elif up<0: pay(B,A,stake)
                k+=1
        return money,{'bets':res}
def rand_round(rng):
    n=rng.choice([18,18,18,9]);base=[4,4,3,5,4,4,3,4,5,4,3,4,5,4,4,3,4,5]
    sis=list(range(1,19));rng.shuffle(sis);holes=[{'par':base[i],'si':sis[i]} for i in range(18)][:n] if n==18 else [{'par':base[i],'si':sis[i]} for i in range(9,18)]
    np_=rng.choice([2,3,4,4,4]);layout='ind'
    if np_==2: layout=rng.choice(['ind','1v1'])
    if np_==4: layout=rng.choice(['ind','2v2','2v2','3v1'])
    par=sum(h['par'] for h in holes)
    players=[]
    for k in range(np_):
        idx=round(rng.uniform(-4,40),1);slope=rng.randint(100,150);rating=round(rng.uniform(par/72*66,par/72*76),1) if n==18 else round(rng.uniform(32,38),1)
        players.append({'id':'p%d'%k,'name':'P%d'%k,'ch':ch(idx,slope,rating,par,n),'team':'A'})
    if layout in('2v2',):
        for k,p in enumerate(players): p['team']='A' if k<2 else 'B'
    if layout in('3v1','1v1'):
        for k,p in enumerate(players): p['team']='A' if k==0 else 'B'
    scores={p['id']:[h['par']+rng.choice([-1,0,0,1,1,1,2,2,3]) for h in holes] for p in players}
    types=['stroke','stableford','skins']
    if layout=='1v1': types+=['match','nassau']
    if layout=='2v2': types+=['fourball','fourballStroke','nassau']
    if layout=='3v1': types+=['lone']
    games=[{'type':t,'net':rng.random()<.8,'stake':rng.choice([0,1,2,5,10]),'carry':rng.random()<.8,'press':rng.random()<.7} for t in types if not(t=='nassau' and n!=18)]
    return {'holes':holes,'layout':layout,'players':players,'scores':scores,'games':games}
if __name__=='__main__':
    rng=random.Random(int(sys.argv[1]) if len(sys.argv)>1 else 1);rounds=[rand_round(rng) for _ in range(int(sys.argv[2]) if len(sys.argv)>2 else 300)]
    json.dump(rounds,open('rounds.json','w'))
    js=subprocess.run(['node',__import__('os').path.join(__import__('os').path.dirname(__file__),'games_reference_run.cjs')],capture_output=True,text=True)
    if js.returncode: print(js.stderr);sys.exit(1)
    out=json.loads(js.stdout);bad=0;checked=0
    for R,res in zip(rounds,out):
        for g,r in zip(R['games'],res):
            m,info=score(g,R);checked+=1
            jm={k:round(v,4) for k,v in r['money'].items()};pm={k:round(v,4) for k,v in m.items()}
            same=jm==pm
            if g['type']=='skins': same=same and r['won']==info['won'] and r['carry']==info['carry']
            if g['type'] in('match','fourball','lone'): same=same and r['up']==info['up']
            if g['type']=='nassau': same=same and r['bets']==info['bets']
            if g['type'] in('stroke','stableford') and r['winners'] is not None: same=same and sorted(r['winners'])==info['winners']
            if not same:
                bad+=1
                if bad<=5: print('MISMATCH',g,R['layout'],len(R['holes']),'\n js',r,'\n py',pm,info)
    print(f'{checked-bad}/{checked} games match the independent reference');sys.exit(1 if bad else 0)
