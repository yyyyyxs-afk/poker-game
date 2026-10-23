const assert=require('assert');
const {io:connect}=require('socket.io-client');
const {server,io,rooms}=require('../server');
const squid=require('../squid');
const {parseCreate,paymentError}=require('../room-config');
const sockets=[];
const req=(s,e,p=null)=>new Promise((resolve,reject)=>s.timeout(3000).emit(e,p,(err,r)=>err?reject(err):resolve(r)));
const ok=async(...a)=>{const r=await req(...a);assert.strictEqual(r.ok,true,r.err);return r;};
async function open(){const s=connect(`http://127.0.0.1:${server.address().port}`,{transports:['websocket']});sockets.push(s);s.on('state',v=>s.latest=v);await new Promise(r=>s.once('connect',r));return s;}
async function table(n,config){const ss=[await open()],cr=await ok(ss[0],'create_room',{name:'甲',...config});for(let i=1;i<n;i++){ss.push(await open());await ok(ss[i],'join_room',{code:cr.code,name:['甲','乙','丙','丁','戊','己'][i]});}return {ss,r:rooms.get(cr.code),cr};}
const assets=r=>r.players.reduce((s,p)=>s+squid.estate(p)+(['handover','showdown','waiting'].includes(r.stage)?0:p.totalBet),0);
async function foldTo(r,name){for(let n=0;r.stage!=='handover';n++){assert.ok(n<30);const p=r.players[r.turnSeat];await ok(sockets.find(s=>s.id===p.socketId),'action',{type:p.name===name?(p.roundBet===r.currentBet?'check':'call'):'fold'});}}
async function next(host){await ok(host,'set_next_hand_paused',{paused:false});await ok(host,'next_hand');await ok(host,'set_next_hand_paused',{paused:true});}
for(const value of [0,-1,1.1,'50',null,NaN,Infinity,1000001,Number.MAX_SAFE_INTEGER])assert.ok(paymentError(value));
for(const value of [1,20,50,100,1000000])assert.strictEqual(paymentError(value),null);
for(const settings of [{startChips:99},{startChips:1000001},{smallBlind:0},{bigBlind:1.5},{bigBlind:101},{actionTime:1},{nextHandDelay:1},{rebuyAllowed:'true'},{locked:1},{x:1}])assert.ok(parseCreate({name:'甲',settings}).err);
assert.strictEqual(parseCreate({name:'甲',mode:'squid',settings:{bigBlind:50}}).payment,50);
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));try{
  const invalid=await open();
  for(const config of [{mode:'short'},{settings:[]},{settings:{rebuyAllowed:'false'}},{settings:{startChips:10}},{mode:'squid',squidPayment:0},{mode:'squid',squidPayment:'50'},{mode:'squid',squidPayment:1.2},{mode:'classic',squidPayment:50},{mode:'squid',squidPayment:1000001}]){
    const size=rooms.size;assert.strictEqual((await req(invalid,'create_room',{name:'无效配置',...config})).ok,false);assert.strictEqual(rooms.size,size,'失败不能遗留半配置房间');
  }
  const legacy=await table(1,{});assert.strictEqual(legacy.r.mode,'classic');assert.strictEqual(legacy.r.squid.enabled,false);assert.strictEqual(legacy.r.players[0].chips,2000);
  const custom=await table(1,{mode:'classic',settings:{startChips:5000,smallBlind:25,bigBlind:50,actionTime:30,nextHandDelay:10,rebuyAllowed:false}});
  assert.strictEqual(custom.r.players[0].chips,5000);assert.strictEqual(custom.r.session.get('甲').buyIn,5000);assert.strictEqual(custom.r.economyTotal,5000);
  const size=rooms.size;assert.strictEqual((await req(custom.ss[0],'create_room',{name:'重复',mode:'squid',squidPayment:50})).ok,false);assert.strictEqual(rooms.size,size);
  const visitor=await open(),info=await ok(visitor,'room_info',{code:custom.r.code});
  assert.deepStrictEqual(Object.keys(info.info).sort(),['code','mode','settings','squidPayment']);assert.strictEqual(info.info.mode,'classic');assert.strictEqual(info.info.settings.startChips,5000);
  for(const key of ['hole','token','socketId','players','session','logs','results'])assert.ok(!Object.hasOwn(info.info,key));
  await ok(custom.ss[0],'update_settings',{...custom.r.settings,locked:true});
  const locked=await req(visitor,'room_info',{code:custom.r.code});assert.strictEqual(locked.ok,false);assert.strictEqual(locked.info,undefined);
  assert.strictEqual((await req(visitor,'join_room',{code:custom.r.code,name:'被锁访客'})).ok,false);assert.strictEqual(custom.r.players.length,1);
  assert.strictEqual((await req(legacy.ss[0],'set_squid',{enabled:true})).ok,false);assert.strictEqual((await req(legacy.ss[0],'set_squid_payment',{payment:50})).ok,false);
  console.log('✓ 创建：两玩法、旧协议默认经典、设置/买入原子生效、非法配置不留房、重复创建拒绝；加入说明最小白名单且锁房拒绝');
  const {ss,r}=await table(4,{mode:'squid',squidPayment:50});
  const squidInfo=await ok(visitor,'room_info',{code:r.code});assert.strictEqual(squidInfo.info.squidPayment,50);assert.strictEqual(squidInfo.info.mode,'squid');
  assert.strictEqual(r.squid.payment,50);assert.ok(r.players.every(p=>!p.squidFrozen));
  assert.strictEqual((await req(ss[0],'set_squid',{enabled:false})).ok,false);
  assert.strictEqual((await req(ss[0],'update_settings',{...r.settings,mode:'classic'})).ok,false);
  await ok(ss[0],'start_game');assert.strictEqual(r.squid.current.bb,20);assert.strictEqual(r.squid.current.payment,50);assert.ok(r.players.every(p=>p.squidFrozen===150));
  const noActiveInfo=await req(visitor,'room_info',{code:r.code});assert.strictEqual(noActiveInfo.ok,false);assert.strictEqual(noActiveInfo.info,undefined);
  assert.strictEqual((await req(ss[0],'set_squid_payment',{payment:100})).ok,false,'主局进行中拒绝修改');
  await foldTo(r,'甲');
  const round=r.squid.current,frozen=r.players.map(squid.frozen),estates=r.players.map(squid.estate),marked=round.members.map(m=>m.marked),timer=r.nextHandTimer,deadline=r.nextHandDeadline;
  assert.strictEqual((await req(ss[1],'set_squid_payment',{payment:100})).ok,false);
  for(const payment of [0,-1,1.1,'100',1000001])assert.strictEqual((await req(ss[0],'set_squid_payment',{payment})).ok,false);
  await ok(ss[0],'set_squid_payment',{payment:100});await ok(ss[0],'set_squid_payment',{payment:100});
  assert.strictEqual(r.nextHandTimer,timer);assert.strictEqual(r.nextHandDeadline,deadline);assert.strictEqual(r.squid.current,round);assert.strictEqual(round.payment,50);
  assert.deepStrictEqual(r.players.map(squid.frozen),frozen);assert.deepStrictEqual(r.players.map(squid.estate),estates);assert.deepStrictEqual(round.members.map(m=>m.marked),marked);
  assert.strictEqual(r.squid.history.find(e=>e.type==='round').payment,50);
  await ok(ss[0],'set_next_hand_paused',{paused:true});
  for(const winner of ['乙','丙']){await next(ss[0]);await foldTo(r,winner);}
  let pay=r.results.squidEvents.find(e=>e.type==='payment');assert.strictEqual(pay.total,150);assert.strictEqual(pay.payment,50);assert.strictEqual(pay.bb,20);assert.strictEqual(pay.to.length,3);
  assert.strictEqual(r.squid.current,null);assert.strictEqual(assets(r),8000);assert.strictEqual(r.results.changes.reduce((s,e)=>s+e.delta,0),0);
  const export1=await ok(ss[0],'export_session');assert.ok(export1.csv.includes('总资产'));assert.strictEqual(r.results.pots[0].winners[0].amountWon,r.results.pots[0].amount);
  await next(ss[0]);assert.strictEqual(r.squid.current.payment,100);assert.ok(r.players.every(p=>p.squidFrozen===300));
  for(const [i,winner]of ['甲','乙','丙'].entries()){if(i)await next(ss[0]);await foldTo(r,winner);}
  pay=r.results.squidEvents.find(e=>e.type==='payment');assert.strictEqual(pay.total,300);assert.strictEqual(pay.payment,100);assert.strictEqual(assets(r),8000);
  assert.deepStrictEqual(r.squid.history.filter(e=>e.type==='payment').map(e=>e.payment),[50,100]);
  const after=r.players.map(squid.estate);squid.finishHand(r);assert.deepStrictEqual(r.players.map(squid.estate),after);
  await ok(ss[0],'set_squid_payment',{payment:200});await next(ss[0]);assert.ok(r.players.every(p=>p.squidFrozen===600));await foldTo(r,'甲');
  const beforeCancel=r.players.map(squid.estate);await ok(ss[0],'cancel_squid_round');assert.deepStrictEqual(r.players.map(squid.estate),beforeCancel);assert.ok(r.players.every(p=>!p.squidFrozen));assert.strictEqual(r.mode,'squid');assert.strictEqual(r.squid.enabled,true);
  console.log('✓ 四人50：每人冻150/末位付150；本轮50下轮100分别兑现，BB独立；修改/重复保存不动冻结/标记/计时；重复结算与取消守恒');
  const funds=await table(3,{mode:'squid',squidPayment:1000});assert.strictEqual((await req(funds.ss[0],'start_game')).ok,false);assert.ok(funds.r.players.every(p=>!p.squidFrozen));
  for(const s of funds.ss)await ok(s,'rebuy');await ok(funds.ss[0],'start_game');await ok(funds.ss[0],'set_next_hand_paused',{paused:true});
  assert.ok(funds.r.players.every(p=>p.squidFrozen===2000));assert.strictEqual(assets(funds.r),12000);assert.ok([...funds.r.session.values()].every(s=>s.buyIn===4000));
  const boundary=await table(3,{mode:'squid',squidPayment:1000000});assert.strictEqual((await req(boundary.ss[0],'start_game')).ok,false);assert.ok(boundary.r.players.every(p=>!p.squidFrozen));
  await ok(boundary.ss[0],'set_squid_payment',{payment:1});await ok(boundary.ss[0],'start_game');await ok(boundary.ss[0],'set_next_hand_paused',{paused:true});assert.ok(boundary.r.players.every(p=>p.squidFrozen===2));assert.strictEqual(assets(boundary.r),6000);
  // 最后耗尽共用的查询/入房配额：不能用只读说明绕过入房限频。
  let limited=false;for(let i=0;i<65;i++){const res=await req(visitor,'room_info',{code:legacy.r.code});if(!res.ok){assert.ok(res.retryAfterMs>0);limited=true;break;}}
  assert.ok(limited);assert.strictEqual((await req(visitor,'join_room',{code:legacy.r.code,name:'超额访客'})).ok,false);
  console.log('✓ 金额上下界/乘法安全，资金不足原子拒绝和正筹码补买，查询与加入共享限频且不泄露私有状态');
}finally{sockets.forEach(s=>s.disconnect());await new Promise(r=>io.close(r));for(const r of rooms.values()){clearTimeout(r.timer);clearTimeout(r.nextHandTimer);clearTimeout(r.waitingCleanupTimer);}}})().catch(e=>{console.error(e);process.exitCode=1;});
