const assert=require('assert');
const {io:connect}=require('socket.io-client');
const {server,io,rooms}=require('../server');
const clients=[];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const wait=async fn=>{const until=Date.now()+3000;while(!fn()){assert.ok(Date.now()<until,'等待状态超时');await sleep(20)}};
const req=(s,e,p=null)=>new Promise((resolve,reject)=>s.timeout(3000).emit(e,p,(err,r)=>err?reject(err):resolve(r)));
const ok=async(...a)=>{const r=await req(...a);assert.strictEqual(r.ok,true,r.err);return r};
async function open(){const s=connect(`http://127.0.0.1:${server.address().port}`,{transports:['websocket']});clients.push(s);s.on('state',v=>{s.latest=v;s.count=(s.count||0)+1});await new Promise(r=>s.once('connect',r));return s}
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));try{
for(const first of [0,1]){
const a=await open();let b=await open();const cr=await ok(a,'create_room',{name:'甲'});const br=await ok(b,'join_room',{code:cr.code,name:'乙'});const room=rooms.get(cr.code);
assert.strictEqual((await req(b,'show_winner_cards',{handNumber:0,indices:[first]})).ok,false);
await ok(a,'start_game');await ok(a,'set_next_hand_paused',{paused:true});
assert.strictEqual((await req(b,'show_winner_cards',{handNumber:1,indices:[first]})).ok,false);
const winner=room.players[1];const privateHole=JSON.parse(JSON.stringify(winner.hole));
await ok(a,'action',{type:'fold'});await wait(()=>a.latest.stage==='handover');
assert.strictEqual(a.latest.players[1].hole,null);assert.deepStrictEqual(a.latest.players[1].shownCards,[]);
assert.strictEqual(a.latest.results.pots[0].winners[0].hole,undefined);assert.strictEqual(a.latest.results.pots[0].winners[0].voluntaryCards,undefined);
assert.strictEqual((await req(a,'show_winner_cards',{handNumber:1,indices:[first]})).ok,false);
for(const data of [{handNumber:0,indices:[0]},{handNumber:1,indices:[2]},{handNumber:1,indices:['0']},{indices:[0]}])assert.strictEqual((await req(b,'show_winner_cards',data)).ok,false);
const chips=room.players.map(p=>p.chips), timer=room.nextHandTimer, deadline=room.nextHandDeadline;
await ok(b,'show_winner_cards',{handNumber:1,indices:[first]});await wait(()=>a.latest.players[1].shownCards.length===1);
assert.deepStrictEqual(a.latest.players[1].shownCards,[{index:first,card:privateHole[first]}]);
assert.strictEqual(a.latest.players[1].hole,null);
const count=a.count;await ok(b,'show_winner_cards',{handNumber:1,indices:[first]});await sleep(40);assert.strictEqual(a.count,count);
b.disconnect();await wait(()=>!winner.connected);b=await open();await ok(b,'join_room',{code:cr.code,name:'乙',token:br.token});
await wait(()=>b.latest&&b.latest.stage==='handover');assert.strictEqual(b.latest.players[1].shownCards.length,1);
if(first===1){await ok(b,'show_winner_cards',{handNumber:1,indices:[0,1]});await wait(()=>a.latest.players[1].shownCards.length===2)}
assert.deepStrictEqual(room.players.map(p=>p.chips),chips);assert.strictEqual(room.nextHandTimer,timer);assert.strictEqual(room.nextHandDeadline,deadline);
assert.strictEqual(room.results.pots[0].winners[0].hole,undefined);
await ok(a,'set_next_hand_paused',{paused:false});await ok(a,'next_hand');await wait(()=>a.latest.handNumber===2);
assert.deepStrictEqual(a.latest.players[1].shownCards,[]);assert.strictEqual(a.latest.players[1].hole,null);
assert.deepStrictEqual(a.latest.lastResult.pots[0].winners[0].voluntaryCards,(first===0 ? [{index:0,card:privateHole[0]}] : privateHole.map((card,index)=>({index,card}))));
assert.strictEqual((await req(b,'show_winner_cards',{handNumber:1,indices:[0]})).ok,false);
await ok(a,'set_next_hand_paused',{paused:true});
while(room.stage!=='handover'){
 const p=room.players[room.turnSeat];await ok(clients.find(s=>s.connected&&s.id===p.socketId),'action',{type:p.roundBet===room.currentBet?'check':'call'});
}
assert.strictEqual(room.results.forfeit,false);
assert.strictEqual((await req(b,'show_winner_cards',{handNumber:2,indices:[0]})).ok,false);
await ok(a,'set_next_hand_paused',{paused:false});await ok(a,'next_hand');await ok(a,'set_next_hand_paused',{paused:true});
const actor=room.players[room.turnSeat];await ok(clients.find(s=>s.connected&&s.id===actor.socketId),'action',{type:'fold'});
assert.strictEqual(room.results.forfeit,true);
const newWinner=room.players[room.results.pots[0].winners[0].seat];
assert.strictEqual((await req(clients.find(s=>s.connected&&s.id===newWinner.socketId),'show_winner_cards',{handNumber:1,indices:[0]})).ok,false);
assert.strictEqual(room.results.pots[0].winners[0].voluntaryCards,undefined);
console.log(`✓ 首次只亮${first===0?'左':'右'}张：默认隐私、权限与参数、重复幂等、重连与补亮边界、筹码和计时不变、跨局公开子集复盘、正常摊牌拒绝`);
}
for (const paused of [false,true]) for (const expire of [false,true]) {
  let a=await open(),b=await open();
  const cr=await ok(a,'create_room',{name:'生命周期甲'}),br=await ok(b,'join_room',{code:cr.code,name:'生命周期乙'});
  const r=rooms.get(cr.code);r.settings.nextHandDelay=1;
  await ok(a,'choose_avatar',{avatarId:6});await ok(b,'choose_avatar',{avatarId:11});
  await ok(a,'start_game');if(paused)await ok(a,'set_next_hand_paused',{paused:true});
  await ok(a,'action',{type:'fold'});
  const identity=()=>r.players.map(p=>({name:p.name,token:p.token,avatarId:p.avatarId,chips:p.chips,lobbySeat:p.lobbySeat}));
  const snapshot=identity(),economy=r.economyTotal,deadline=r.nextHandDeadline;
  a.disconnect();await wait(()=>!r.players[0].connected);
  assert.strictEqual(r.hostName,'生命周期乙');assert.strictEqual(r.nextHandDeadline,deadline);assert.strictEqual(r.waitingCleanupTimer,null,'还有人在线时不应安排清理');
  b.disconnect();await wait(()=>r.players.every(p=>!p.connected));
  const originalCleanup=r.waitingCleanupTimer;
  if(!paused)await wait(()=>r.stage==='waiting');else assert.strictEqual(r.stage,'handover');
  assert.strictEqual(r.handNumber,1);
  const cleanup=r.waitingCleanupTimer;assert.strictEqual(cleanup,originalCleanup,'阶段切换不延长无人在线保留时间');assert.ok(cleanup,'保留房间全离线必须安排有限清理');assert.strictEqual(cleanup._idleTimeout,600000);
  const fireCleanup=cleanup._onTimeout;
  if(expire){
    clearTimeout(cleanup);fireCleanup();assert.strictEqual(rooms.has(r.code),false);assert.strictEqual(r.nextHandTimer,null);
    console.log(`✓ ${paused?'暂停局间':'退回waiting且handNumber=1'}全离线：触发10分钟清理回调后房间销毁`);continue;
  }
  b=await open();assert.strictEqual((await req(b,'join_room',{code:cr.code,name:'生命周期乙',token:'invalid'})).ok,false);
  assert.strictEqual(r.waitingCleanupTimer,cleanup);
  await ok(b,'join_room',{code:cr.code,name:'生命周期乙',token:br.token});
  assert.strictEqual(r.hostName,'生命周期乙');assert.strictEqual(r.waitingCleanupTimer,null);assert.ok(cleanup._destroyed);
  fireCleanup();assert.strictEqual(rooms.get(r.code),r,'迟到清理回调不能删除有人在线的房间');
  assert.strictEqual(r.nextHandPaused,paused);assert.strictEqual(r.nextHandDeadline,0);
  a=await open();await ok(a,'join_room',{code:cr.code,name:'生命周期甲',token:cr.token});
  assert.strictEqual(r.hostName,'生命周期乙');assert.deepStrictEqual(identity(),snapshot);assert.strictEqual(r.economyTotal,economy);
  assert.strictEqual((await req(a,'start_game')).ok,false);
  if(paused){assert.strictEqual((await req(b,'next_hand')).ok,false);await ok(b,'set_next_hand_paused',{paused:false})}
  await ok(b,'start_game');assert.strictEqual(r.handNumber,2);
  console.log(`✓ ${paused?'暂停局间':'退回waiting且handNumber=1'}恢复：乙先返回接任、清理取消、甲不夺权、身份筹码不变、乙可显式开局`);
}
// 截止时间尚未到时合法重连不延长自动发牌。
{
 const a=await open();let b=await open();const cr=await ok(a,'create_room',{name:'计时甲'}),br=await ok(b,'join_room',{code:cr.code,name:'计时乙'});
 const r=rooms.get(cr.code);await ok(a,'start_game');await ok(a,'action',{type:'fold'});const deadline=r.nextHandDeadline,timer=r.nextHandTimer;
 b.disconnect();await wait(()=>!r.players[1].connected);b=await open();await ok(b,'join_room',{code:cr.code,name:'计时乙',token:br.token});
 assert.strictEqual(r.nextHandDeadline,deadline);assert.strictEqual(r.nextHandTimer,timer);
 console.log('✓ 正常局间重连保持原自动发牌截止时间与计时器');
}
}finally{clients.forEach(s=>s.disconnect());await new Promise(r=>io.close(r));for(const r of rooms.values()){clearTimeout(r.timer);clearTimeout(r.nextHandTimer);clearTimeout(r.waitingCleanupTimer)}}})().catch(e=>{console.error(e);process.exitCode=1});
