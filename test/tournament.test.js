const assert=require('node:assert/strict');
const {io:connect}=require('socket.io-client');
const {server,io,rooms,__test}=require('../server');
const tmod=require('../tournament');
const {parseCreate}=require('../room-config');
const sockets=[];
const req=(s,e,p=null)=>new Promise((resolve,reject)=>s.timeout(3000).emit(e,p,(err,r)=>err?reject(err):resolve(r)));
const ok=async(...a)=>{const r=await req(...a);assert.equal(r.ok,true,r.err);return r;};
const pause=(s,value)=>ok(s,'set_next_hand_paused',{paused:value});
async function open(){const s=connect(`http://127.0.0.1:${server.address().port}`,{transports:['websocket']});sockets.push(s);s.on('state',x=>s.latest=x);await new Promise(r=>s.once('connect',r));return s;}
async function waitFor(f){const limit=Date.now()+3000;while(!f()){if(Date.now()>limit)throw Error('等待状态超时');await new Promise(r=>setTimeout(r,10));}}
async function table(count){const ss=[await open()],created=await ok(ss[0],'create_room',{name:'甲',mode:'tournament',blindIntervalMinutes:5});for(let i=1;i<count;i++){ss.push(await open());await ok(ss[i],'join_room',{code:created.code,name:['甲','乙','丙','丁','戊','己'][i]});}return {ss,created,room:rooms.get(created.code)};}
async function foldTo(room,winner){for(let i=0;room.stage!=='handover';i++){assert.ok(i<40,'牌局未推进');const p=room.players[room.turnSeat];await ok(sockets.find(s=>s.id===p.socketId),'action',{type:p.name===winner?(p.roundBet===room.currentBet?'check':'call'):'fold'});}}
async function next(host){await pause(host,false);await ok(host,'next_hand');await pause(host,true);}
const card=(r,s)=>({r,s});

for(const bad of [0,6,'10',20,null,5.5])assert.ok(parseCreate({name:'甲',mode:'tournament',blindIntervalMinutes:bad}).err);
assert.ok(parseCreate({name:'甲',mode:'classic',blindIntervalMinutes:10}).err);
assert.ok(parseCreate({name:'甲',mode:'tournament',squidPayment:10}).err);
assert.equal(parseCreate({name:'甲',mode:'tournament'}).settings.rebuyAllowed,false);
{
  const t=tmod.makeTournament(5,10,20);const p=[{name:'甲'},{name:'乙'}];tmod.start(t,p,1000);
  assert.equal(tmod.levelAt(t,1000),1);assert.equal(tmod.levelAt(t,301000),2);
  assert.equal(tmod.levelAt(t,901000),4);assert.deepEqual(tmod.blindsAt(t,4),{smallBlind:80,bigBlind:160});
  const max=tmod.levelAt(t,Number.MAX_SAFE_INTEGER);const b=tmod.blindsAt(t,max);
  assert.equal(max,t.maxLevel);assert.ok(b.bigBlind<=1000000&&b.bigBlind*2>1000000);assert.ok(Number.isSafeInteger(b.bigBlind));
  t.appliedLevel=2;t.status='finished';t.finishedAt=301000;
  const x=tmod.snapshot(t,301000),y=tmod.snapshot(t,Number.MAX_SAFE_INTEGER);
  assert.deepEqual([x.pendingLevel,x.pendingBlinds,x.nextAt,x.upcoming],[y.pendingLevel,y.pendingBlinds,y.nextAt,y.upcoming]);
  assert.equal(y.nextAt,null);assert.equal(y.upcoming,null);
}
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));try{
  // 开赛前仅房主可设置合法整数和升盲间隔；离线报名者不能被悄悄排除。
  const config=await table(2),cr=config.room;
  const settings={...cr.settings,startChips:3000,smallBlind:15,bigBlind:30,blindIntervalMinutes:15};
  assert.equal((await req(config.ss[1],'update_settings',settings)).ok,false);
  assert.equal((await req(config.ss[0],'update_settings',{...settings,bigBlind:30.5})).ok,false);
  assert.equal((await req(config.ss[0],'update_settings',{...settings,rebuyAllowed:true})).ok,false);
  await ok(config.ss[0],'update_settings',settings);assert.equal(cr.tournament.intervalMinutes,15);
  assert.ok(cr.players.every(p=>p.chips===3000));assert.equal(cr.tournament.initialBig,30);
  config.ss[1].disconnect();await waitFor(()=>!cr.players[1].connected);
  assert.equal((await req(config.ss[0],'start_game')).ok,false);assert.equal(cr.tournament.startAt,null);

  // 2人真实联机：断线/凭证、当前手盲注不变、跨级、全押淘汰和冠军。
  const a=await table(2),[host,guest]=a.ss,r=a.room,oldToken=r.players.find(p=>p.name==='乙').token;
  assert.equal(r.tournament.status,'waiting');assert.equal(r.tournament.startAt,null);
  await ok(host,'start_game');await pause(host,true);assert.equal(r.tournament.status,'running');
  assert.equal((await req(host,'rebuy')).ok,false);assert.equal((await req(host,'sit_out')).ok,false);
  assert.equal((await req(host,'update_settings',{...r.settings,blindIntervalMinutes:10})).ok,false);
  assert.equal((await req(host,'kick_player',{seat:1})).ok,false);
  const stranger=await open();assert.equal((await req(stranger,'join_room',{code:r.code,name:'新玩家'})).ok,false);
  assert.equal((await req(stranger,'room_info',{code:r.code})).ok,false);
  const prior=[r.settings.smallBlind,r.settings.bigBlind,r.currentBet,r.minRaise];
  r.tournament.startAt=Date.now()-3*300000-1000;
  await pause(host,false);await pause(host,true);
  assert.deepEqual([r.settings.smallBlind,r.settings.bigBlind,r.currentBet,r.minRaise],prior,'进行中的盲注与最小加注不能改变');
  await waitFor(()=>host.latest?.tournament.pendingLevel===4);assert.equal(host.latest.tournament.level,1);
  await pause(host,false);await pause(host,true);assert.equal(r.tournament.appliedLevel,1,'重复广播不能重复升盲');
  guest.disconnect();await waitFor(()=>!r.players.find(p=>p.name==='乙').connected);
  const offline=r.players.find(p=>p.name==='乙');assert.equal(r.tournament.members[offline.tournamentIndex].status,'active');
  assert.ok(offline.tournamentOfflineTimer);assert.equal((await req(stranger,'join_room',{code:r.code,name:'乙',token:'wrong'})).ok,false);
  const restored=await open();await ok(restored,'join_room',{code:r.code,name:'乙',token:oldToken});
  assert.equal(offline.connected,true);assert.equal(offline.tournamentOfflineTimer,null);
  assert.equal(r.players.length,2);assert.equal(restored.latest?.players?.find(p=>p.name==='甲')?.hole,null);
  await foldTo(r,'甲');await next(host);
  assert.deepEqual([r.settings.smallBlind,r.settings.bigBlind],[80,160]);assert.equal(r.tournament.appliedLevel,4);
  r.players[0].hole=[card(14,'s'),card(14,'h')];r.players[1].hole=[card(13,'s'),card(13,'h')];
  r.deck=[card(9,'c'),card(8,'s'),card(6,'h'),card(4,'d'),card(2,'c')];
  const first=r.players[r.turnSeat];await ok(sockets.find(s=>s.id===first.socketId),'action',{type:'allin'});
  const second=r.players[r.turnSeat];await ok(sockets.find(s=>s.id===second.socketId),'action',{type:'call'});
  assert.equal(r.stage,'handover');assert.equal(r.tournament.status,'finished');assert.equal(r.gameOver,true);
  assert.equal(r.tournament.members.find(m=>m.name==='甲').status,'champion');
  assert.equal(r.tournament.members.find(m=>m.name==='乙').rank,2);assert.equal(r.players[1].chips,0);
  assert.equal((await req(host,'next_hand')).ok,false);assert.equal((await req(host,'start_game')).ok,false);
  assert.equal((await req(host,'set_next_hand_paused',{paused:false})).ok,false);
  assert.equal((await req(host,'action',{type:'check'})).ok,false);
  const f1=tmod.snapshot(r.tournament,Date.now()),f2=tmod.snapshot(r.tournament,Date.now()+9000000);
  assert.deepEqual([f1.pendingLevel,f1.pendingBlinds,f1.nextAt,f1.upcoming],[f2.pendingLevel,f2.pendingBlinds,f2.nextAt,f2.upcoming]);
  assert.equal(r.players.reduce((sum,p)=>sum+p.chips,0),r.economyTotal);

  // 6人真实加入开赛；构造合法摊牌检验同手多淘汰、相同开手筹码并列。
  const six=await table(6),s=six.room;await ok(six.ss[0],'start_game');await pause(six.ss[0],true);
  assert.equal(s.tournament.members.length,6);assert.ok(s.players.every(p=>p.hole.length===2));
  const bustedOffline=s.players[2],bustedToken=bustedOffline.token;six.ss[2].disconnect();await waitFor(()=>!bustedOffline.connected&&bustedOffline.tournamentOfflineTimer);
  const starts=[2000,300,200,200,1000,1000],bets=[300,300,200,200,0,0];
  for(let i=0;i<6;i++){const p=s.players[i];p.handStartChips=starts[i];p.totalBet=bets[i];p.roundBet=0;p.chips=starts[i]-bets[i];p.inHand=true;p.folded=i>=4;p.allIn=p.chips===0;}
  s.players[0].hole=[card(14,'s'),card(14,'h')];s.players[1].hole=[card(13,'s'),card(13,'h')];
  s.players[2].hole=[card(12,'s'),card(12,'h')];s.players[3].hole=[card(11,'s'),card(11,'h')];
  s.community=[card(2,'c'),card(4,'d'),card(6,'h'),card(8,'s'),card(9,'c')];s.economyTotal=starts.reduce((x,y)=>x+y,0);
  __test.showdown(s);assert.equal(s.stage,'handover');
  assert.equal(s.tournament.members[1].rank,4);assert.equal(s.tournament.members[2].rank,5);assert.equal(s.tournament.members[3].rank,5);
  assert.equal(bustedOffline.tournamentOfflineTimer,null,'淘汰后应取消离线退赛计时');
  const bustedReturn=await open();await ok(bustedReturn,'join_room',{code:s.code,name:bustedOffline.name,token:bustedToken});
  assert.equal(bustedOffline.chips,0);assert.equal(s.tournament.members[2].status,'eliminated');
  assert.equal(s.players.reduce((sum,p)=>sum+p.chips,0),s.economyTotal);
  await next(six.ss[0]);assert.ok(s.players.filter(p=>p.chips===0).every(p=>!p.inHand&&p.hole.length===0));
  const p0=s.players[0],p4=s.players[4],p5=s.players[5];
  const p0start=p0.chips+p0.totalBet,p4start=p4.chips+p4.totalBet,p5start=p5.chips+p5.totalBet;
  p0.handStartChips=p0start;p4.handStartChips=p4start;p5.handStartChips=p5start;
  p0.totalBet=p4start;p0.chips=p0start-p4start;p0.inHand=true;p0.folded=false;
  p4.totalBet=p4start;p4.chips=0;p4.inHand=true;p4.folded=false;
  p5.totalBet=0;p5.chips=p5start;p5.inHand=true;p5.folded=true;
  p0.hole=[card(14,'s'),card(14,'h')];p4.hole=[card(13,'s'),card(13,'h')];
  s.community=[card(2,'c'),card(4,'d'),card(6,'h'),card(8,'s'),card(9,'c')];
  __test.showdown(s);await next(six.ss[0]);
  assert.equal(s.players.filter(p=>p.inHand).length,2);
  assert.equal(s.players[s.dealerSeat].isSB,true,'只剩两位时庄家应为小盲');

  // 六名真实 Socket 客户端通过生产行动完成整场；只拨快服务器比赛时钟，不改牌面或生产校验。
  const full=await table(6),fr=full.room;await ok(full.ss[0],'start_game');await pause(full.ss[0],true);
  await foldTo(fr,'甲');fr.tournament.startAt=Date.now()-fr.tournament.maxLevel*fr.tournament.intervalMinutes*60000;
  for(let hand=0;fr.tournament.status==='running';hand++){
    assert.ok(hand<10,'六人比赛未在合理手数结束');
    if(fr.stage==='handover'){await pause(full.ss[0],false);await ok(full.ss[0],'next_hand');if(fr.tournament.status==='running')await pause(full.ss[0],true);}
    for(let actions=0;fr.tournament.status==='running'&&fr.stage!=='handover';actions++){
      assert.ok(actions<30);const player=fr.players[fr.turnSeat];
      await ok(full.ss.find(x=>x.id===player.socketId),'action',{type:player.roundBet===fr.currentBet?'check':'call'});
    }
    assert.equal(fr.players.reduce((sum,p)=>sum+p.chips,0),fr.economyTotal);
  }
  assert.equal(fr.tournament.members.filter(m=>m.status==='champion').length,1);
  assert.ok(fr.tournament.members.every(m=>Number.isInteger(m.rank)));

  // 离线参赛者继续发牌和支付盲注，仍可凭原 token 重新进入。
  const off=await table(3),orr=off.room;await ok(off.ss[0],'start_game');await pause(off.ss[0],true);
  const op=orr.players.find(p=>p.name==='乙'),otoken=op.token;off.ss[1].disconnect();await waitFor(()=>!op.connected);
  for(let i=0;orr.stage!=='handover';i++){
    assert.ok(i<40);const actor=orr.players[orr.turnSeat];
    if(!actor.connected){const fire=orr.timer._onTimeout;clearTimeout(orr.timer);fire();}
    else await ok(sockets.find(x=>x.id===actor.socketId),'action',{type:actor.name==='甲'?(actor.roundBet===orr.currentBet?'check':'call'):'fold'});
  }
  await next(off.ss[0]);assert.equal(op.inHand,true);assert.equal(op.hole.length,2);
  const reconnected=await open();await ok(reconnected,'join_room',{code:orr.code,name:'乙',token:otoken});
  assert.equal(op.connected,true);assert.equal(op.tournamentOfflineTimer,null);

  // 升盲超过筹码：双方全押和小盲全押且大盲无需跟注时自动发完；大盲短全押仍需小盲决定跟注。
  for(const stacks of [[50,50],[300,50],[50,300]]){
    const b=await table(2),br=b.room;await ok(b.ss[0],'start_game');await pause(b.ss[0],true);await foldTo(br,'甲');
    br.players.forEach((p,i)=>{p.chips=stacks[i];});br.economyTotal=stacks[0]+stacks[1];
    br.tournament.startAt=Date.now()-3*300000-1000;
    await pause(b.ss[0],false);await ok(b.ss[0],'next_hand');
    if(stacks[0]===50&&stacks[1]===300){
      assert.equal(br.stage,'preflop');assert.equal(br.turnSeat,1,'短大盲时小盲仍需决定是否跟注');
      await ok(b.ss[1],'action',{type:'call'});
    }
    assert.equal(br.stage,'handover','无人需要决定时必须自动完成本手');
    assert.equal(br.turnSeat,-1);assert.equal(br.players.reduce((sum,p)=>sum+p.chips,0),br.economyTotal);
    assert.ok(br.tournament.status==='finished'||br.nextHandTimer,'冠军或下一手应明确推进');
  }

  // 非行动者退赛不重置当前计时；已投入不退回、剩余筹码退出，房主交接。
  const w=await table(4),wr=w.room;await ok(w.ss[0],'start_game');await pause(w.ss[0],true);
  const leaving=wr.players.find(p=>p.name==='甲');assert.notEqual(wr.players[wr.turnSeat],leaving);
  const turnDeadline=wr.turnDeadline,actor=wr.turnSeat;await ok(w.ss[0],'leave_room');
  assert.equal(wr.turnSeat,actor);assert.equal(wr.turnDeadline,turnDeadline);assert.notEqual(wr.hostName,'甲');
  assert.equal(leaving.left,true);assert.equal(leaving.folded,true);await foldTo(wr,'乙');
  const entry=wr.tournament.members.find(m=>m.name==='甲');assert.equal(entry.status,'withdrawn');assert.equal(entry.rank,4);
  assert.equal(entry.withdrawnChips,leaving.chips);assert.ok(wr.results.pots.every(p=>p.winners.every(w=>w.name!=='甲')));
  assert.equal(wr.players.reduce((sum,p)=>sum+p.chips,0),wr.economyTotal);
  const nextHost=w.ss.find(x=>x.id===wr.players.find(p=>p.name===wr.hostName)?.socketId);await next(nextHost);
  assert.equal(wr.players.some(p=>p.name==='甲'),false);assert.equal(wr.players.reduce((sum,p)=>sum+p.chips+p.totalBet,0),wr.economyTotal);

  // 断线保留身份，触发既有10分钟回调模拟到期，不等待真实十分钟。
  const d=await table(2),dr=d.room;await ok(d.ss[0],'start_game');await pause(d.ss[0],true);
  d.ss[1].disconnect();const dp=dr.players.find(p=>p.name==='乙');await waitFor(()=>!dp.connected&&dp.tournamentOfflineTimer);
  assert.equal(dr.tournament.members[dp.tournamentIndex].status,'active');
  const early=dp.tournamentOfflineTimer._onTimeout;clearTimeout(dp.tournamentOfflineTimer);early();
  assert.ok(dp.tournamentOfflineTimer,'时钟回拨或提前触发不能丢失退赛计时');
  const callback=dp.tournamentOfflineTimer._onTimeout;clearTimeout(dp.tournamentOfflineTimer);dp.tournamentOfflineDeadline=Date.now()-1;callback();
  assert.equal(dr.tournament.status,'finished');assert.equal(dr.tournament.members.find(m=>m.name==='乙').reason,'离线超过10分钟');
  assert.equal(dr.tournament.members.find(m=>m.name==='甲').status,'champion');

  // 多人离线期限同时到达时批量退赛，不能因定时器回调顺序产生虚假冠军。
  const allOff=await table(3),ar=allOff.room;await ok(allOff.ss[0],'start_game');await pause(allOff.ss[0],true);
  allOff.ss.forEach(s=>s.disconnect());await waitFor(()=>ar.players.every(p=>!p.connected&&p.tournamentOfflineTimer));
  const fireBatch=ar.players[0].tournamentOfflineTimer._onTimeout;clearTimeout(ar.players[0].tournamentOfflineTimer);
  ar.players.forEach(p=>{p.tournamentOfflineDeadline=Date.now()-1;});fireBatch();
  assert.equal(ar.tournament.status,'finished');assert.equal(ar.tournament.noChampion,true);
  assert.equal(ar.results.noWinner,true);assert.ok(ar.tournament.members.every(m=>m.status==='withdrawn'));
  assert.equal(ar.players.reduce((sum,p)=>sum+p.chips,0),ar.economyTotal);

  // 零有效玩家边界：本手投入原路退回、无赢家、比赛结束而不死锁。
  const z=await table(2),zr=z.room;await ok(z.ss[0],'start_game');await pause(z.ss[0],true);
  const committed=zr.players.map(p=>p.totalBet),funds=zr.economyTotal;
  zr.players.forEach(p=>{p.left=true;p.folded=true;p.tournamentWithdrawReason='主动退赛';});
  __test.consumeQueueAndAdvance(zr,-1);
  assert.equal(zr.stage,'handover');assert.equal(zr.results.noWinner,true);assert.deepEqual(zr.results.pots[0].winners,[]);
  assert.deepEqual(zr.results.refunds.map(x=>x.amount),committed);assert.equal(zr.players.reduce((n,p)=>n+p.chips,0),funds);
  assert.equal(zr.tournament.status,'finished');assert.equal(zr.tournament.noChampion,true);assert.ok(zr.tournament.members.every(m=>m.status==='withdrawn'));
  console.log('锦标赛检查通过：跨级/封顶/冻结、2人与6人联机、淘汰并列、断线恢复/到期、退赛交接/守恒、零赢家退款与终止');
}finally{sockets.forEach(s=>s.disconnect());await new Promise(resolve=>io.close(resolve));for(const r of rooms.values()){clearTimeout(r.timer);clearTimeout(r.nextHandTimer);clearTimeout(r.waitingCleanupTimer);clearTimeout(r.tournament?.blindTimer);r.players.forEach(p=>clearTimeout(p.tournamentOfflineTimer));}}})().catch(e=>{console.error(e);process.exitCode=1;});
