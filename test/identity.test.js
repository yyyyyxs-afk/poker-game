const assert = require('assert');
const {io:connect} = require('socket.io-client');
const {server,io,rooms}=require('../server');
const clients=[];
const request=(s,e,p=null)=>new Promise((resolve,reject)=>s.timeout(3000).emit(e,p,(err,r)=>err?reject(err):resolve(r)));
const ok=async(...a)=>{const r=await request(...a);assert.strictEqual(r.ok,true,r.err);return r};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function open(){const s=connect(`http://127.0.0.1:${server.address().port}`,{transports:['websocket']});clients.push(s);await new Promise(r=>s.once('connect',r));return s}
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));try{
const a=await open(),b=await open(),c=await open();
const created=await ok(a,'create_room',{name:'甲'});
const rb=await ok(b,'join_room',{name:'乙',code:created.code});
await ok(c,'join_room',{name:'丙',code:created.code});
const room=rooms.get(created.code), before=room.players.map(p=>({name:p.name,token:p.token,chips:p.chips,avatarId:p.avatarId}));
for(const avatarId of [-1,6,0.5,'0','https://example.com/x'])assert.strictEqual((await request(a,'choose_avatar',{avatarId})).ok,false);
await ok(a,'choose_avatar',{avatarId:5});assert.strictEqual(room.players.find(p=>p.name==='甲').avatarId,5);
assert.strictEqual(room.players.find(p=>p.name==='乙').avatarId,before[1].avatarId);
await ok(b,'choose_avatar',{avatarId:3});
for(const seat of [-1,6,0.5,'0'])assert.strictEqual((await request(a,'choose_seat',{seat})).ok,false);
assert.strictEqual((await request(a,'choose_seat',{seat:1})).ok,false);
const race=await Promise.all([request(a,'choose_seat',{seat:5}),request(b,'choose_seat',{seat:5})]);
assert.strictEqual(race.filter(r=>r.ok).length,1);
await ok(a,'choose_seat',{seat:4});await ok(b,'choose_seat',{seat:0});await ok(c,'choose_seat',{seat:2});
for(const old of before){const p=room.players.find(x=>x.name===old.name);assert.strictEqual(p.token,old.token);assert.strictEqual(p.chips,old.chips)}
assert.strictEqual(room.economyTotal,6000);assert.ok(room.players.every(Boolean));
assert.deepStrictEqual(room.players.map(p=>p.name),['乙','丙','甲']);
b.disconnect();await sleep(100);const br=await open();await ok(br,'join_room',{name:'乙',code:created.code,token:rb.token});
assert.strictEqual(room.players[0].avatarId,3);assert.strictEqual(room.players[0].lobbySeat,0);
assert.strictEqual(room.hostName,'甲');await ok(a,'start_game');
assert.strictEqual(room.dealerSeat,0);assert.strictEqual(room.players[1].isSB,true);assert.strictEqual(room.players[2].isBB,true);assert.strictEqual(room.turnSeat,0);
assert.strictEqual((await request(a,'choose_seat',{seat:3})).ok,false);
await ok(a,'set_next_hand_paused',{paused:true});
while(room.stage!=='handover'){const p=room.players[room.turnSeat];await ok(clients.find(x=>x.connected&&x.id===p.socketId),'action',{type:'fold'})}
assert.strictEqual((await request(a,'choose_seat',{seat:3})).ok,false);
assert.strictEqual(room.players.reduce((sum,p)=>sum+p.chips,0),6000);
console.log('身份与座位检查通过：头像白名单、本人权限、占位竞态、身份筹码、重连、座次与盲注顺序、开局后拒绝换座');
}finally{clients.forEach(s=>s.disconnect());for(const r of rooms.values()){clearTimeout(r.timer);clearTimeout(r.nextHandTimer)}await new Promise(r=>io.close(r))}})().catch(e=>{console.error(e);process.exitCode=1});
