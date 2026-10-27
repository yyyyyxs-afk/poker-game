// 单桌锦标赛的计时与名次；不读取底牌，也不负责下注或分池。
const BLIND_CAP = 1000000;
function makeTournament(intervalMinutes, smallBlind, bigBlind) {
  let maxLevel=1, limit=bigBlind;
  while (limit <= Math.floor(BLIND_CAP / 2)) { limit *= 2; maxLevel++; }
  return { status:'waiting', intervalMinutes, initialSmall:smallBlind, initialBig:bigBlind,
    maxLevel, startAt:null, appliedLevel:1, finishedAt:null, members:[], blindTimer:null };
}
function levelAt(t, now) {
  if (t.startAt === null) return 1;
  return Math.min(t.maxLevel, Math.floor(Math.max(0, now-t.startAt)/(t.intervalMinutes*60000))+1);
}
function blindsAt(t, level) {
  const factor=2**(Math.max(1,Math.min(t.maxLevel,level))-1);
  return {smallBlind:t.initialSmall*factor,bigBlind:t.initialBig*factor};
}
function start(t, players, now) {
  t.status='running'; t.startAt=now;
  t.members=players.map((p,index)=>{p.tournamentIndex=index;return {name:p.name,status:'active',rank:null,withdrawnChips:null,reason:null};});
}
function settle(t, players, handNumber, now) {
  if (t.status!=='running') return false;
  const active=t.members.map((m,index)=>({m,index,p:players.find(p=>p&&p.tournamentIndex===index)})).filter(x=>x.m.status==='active');
  const out=active.filter(({p})=>p&&(p.left||p.chips===0));
  const survivors=active.length-out.length;
  for(const {m,p} of out) {
    const startChips=Number.isFinite(p.handStartChips)?p.handStartChips:p.chips;
    m.rank=survivors+1+out.filter(x=>(Number.isFinite(x.p.handStartChips)?x.p.handStartChips:x.p.chips)>startChips).length;
    m.status=p.left?'withdrawn':'eliminated'; m.handNumber=handNumber;
    m.withdrawnChips=p.left?p.chips:null; m.reason=p.left?(p.tournamentWithdrawReason||'主动退赛'):null;
  }
  if(survivors===1) {
    const winner=active.find(({p})=>p&&!p.left&&p.chips>0);
    if(winner){winner.m.rank=1;winner.m.status='champion';t.status='finished';t.finishedAt=now;return true;}
  }
  if(survivors===0){t.status='finished';t.finishedAt=now;t.noChampion=true;return true;}
  return false;
}
function snapshot(t, now) {
  const elapsedLevel=t.status==='finished'?t.appliedLevel:levelAt(t,now), applied=blindsAt(t,t.appliedLevel);
  const nextAt=t.status==='running'&&elapsedLevel<t.maxLevel?t.startAt+elapsedLevel*t.intervalMinutes*60000:null;
  const upcoming=t.status==='running'&&elapsedLevel<t.maxLevel?blindsAt(t,elapsedLevel+1):null;
  return {status:t.status,intervalMinutes:t.intervalMinutes,level:t.appliedLevel,maxLevel:t.maxLevel,
    smallBlind:applied.smallBlind,bigBlind:applied.bigBlind,pendingLevel:elapsedLevel,
    pendingBlinds:blindsAt(t,elapsedLevel),nextAt,upcoming,serverNow:now,
    noChampion:!!t.noChampion,members:t.members.map(m=>({...m}))};
}
module.exports={BLIND_CAP,makeTournament,levelAt,blindsAt,start,settle,snapshot};
