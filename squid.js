// 经典鱿鱼：金额仅为虚拟筹码，冻结始终属于本人。
const frozen = p => p.squidFrozen || 0;
const estate = p => p.chips + frozen(p);
function init(room) { return room.squid ||= { enabled:false, round:0, current:null, waitingReason:null }; }
function event(room, entry) {
  const s=init(room);
  const value={...entry,handNumber:room.handNumber+(entry.type==='round'?1:0),seq:(s.seq||0)+1};s.seq=value.seq;
  (s.history ||= []).push(value);s.history=s.history.slice(-30);
  (room.handSquidEvents ||= []).push(value);
}
function cancel(room, reason) {
  const s=init(room);if(!s.current)return;
  for(const p of room.players){if(!p)continue;p.chips+=frozen(p);p.squidFrozen=0;}
  event(room,{type:'cancel',round:s.current.round,reason});s.current=null;s.waitingReason=null;
  if(room.stage==='handover' && room.results){
    room.results.squidEvents=[...(room.results.squidEvents||[]),...room.handSquidEvents];room.handSquidEvents=[];
  }
}
function check(room) {
  const s=init(room);if(!s.enabled)return null;
  if(s.current){
    const online=room.players.filter(p=>p&&!p.left&&p.connected&&!p.sittingOut&&p.chips>0&&s.current.members.some(m=>m.name===p.name));
    s.waitingReason=online.length<3?'本轮可行动参与者不足3人，请重连、重买或由房主局间取消鱿鱼':null;
    return s.waitingReason;
  }
  const players=room.players.filter(p=>p&&!p.left&&p.connected&&!p.sittingOut);
  let reason=null;
  const reserve=(players.length-1)*room.settings.bigBlind;
  if(players.length<3)reason='经典鱿鱼需3–6人，请等待玩家或取消模式';
  else if(players.some(p=>p.chips<=reserve))reason=`新轮需每人冻结${reserve}且保留可下注筹码；不足者可重买或房主取消模式`;
  s.waitingReason=reason;return reason;
}
function prepare(room) {
  const s=init(room);const reason=check(room);if(reason||!s.enabled||s.current)return reason;
  const players=room.players.filter(p=>p&&!p.left&&p.connected&&!p.sittingOut);
  const reserve=(players.length-1)*room.settings.bigBlind;
  s.round++;s.current={round:s.round,bb:room.settings.bigBlind,members:players.map(p=>({name:p.name,marked:false})),lastHand:-1};
  for(const p of players){p.chips-=reserve;p.squidFrozen=reserve;}
  event(room,{type:'round',round:s.round,bb:s.current.bb,names:players.map(p=>p.name)});
  return null;
}
function finishHand(room) {
  const s=init(room),r=s.current;if(!s.enabled||!r||r.lastHand===room.handNumber)return;
  r.lastHand=room.handNumber;
  const winners=room.results&&room.results.pots[0]&&room.results.pots[0].winners;
  if(!winners||winners.length!==1)return;
  const w=winners[0],member=r.members.find(m=>m.name===w.name),p=room.players[w.seat];
  if(!member||member.marked||!p||p.name!==w.name||!room.players.some(x=>x&&x!==p&&x.totalBet>0))return;
  member.marked=true;p.chips+=frozen(p);p.squidFrozen=0;
  event(room,{type:'mark',round:r.round,name:p.name});
  const remaining=r.members.filter(m=>!m.marked);
  if(remaining.length!==1)return;
  const loser=room.players.find(p=>p&&p.name===remaining[0].name),amount=(r.members.length-1)*r.bb;
  if(!loser||frozen(loser)!==amount)throw Error('鱿鱼冻结资产不一致');
  loser.squidFrozen=0;
  for(const m of r.members){if(m.name===loser.name)continue;room.players.find(p=>p&&p.name===m.name).chips+=r.bb;}
  event(room,{type:'payment',round:r.round,from:loser.name,total:amount,bb:r.bb,to:r.members.filter(m=>m.name!==loser.name).map(m=>m.name)});
  s.current=null;s.waitingReason=null;
}
function canRebuy(room,p) {
  const s=init(room);if(!s.enabled||s.current||!s.waitingReason)return false;
  const n=room.players.filter(x=>x&&!x.left&&x.connected&&!x.sittingOut).length;
  return n>=3&&p.chips<=(n-1)*room.settings.bigBlind;
}
function snapshot(room){const s=init(room);return{enabled:s.enabled,round:s.round,waitingReason:s.waitingReason,history:s.history||[],current:s.current?{round:s.current.round,bb:s.current.bb,members:s.current.members.map(m=>({...m}))}:null};}
module.exports={frozen,estate,init,cancel,check,prepare,finishHand,canRebuy,snapshot};
