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
}finally{clients.forEach(s=>s.disconnect());for(const r of rooms.values()){clearTimeout(r.timer);clearTimeout(r.nextHandTimer);clearTimeout(r.waitingCleanupTimer)}await new Promise(r=>io.close(r))}})().catch(e=>{console.error(e);process.exitCode=1});
