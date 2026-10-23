const assert=require('assert');
const squid=require('../squid');
const {io:connect}=require('socket.io-client');
const {server,io,rooms,__test:{showdown}}=require('../server');
const sockets=[];
const req=(s,e,p=null)=>new Promise((resolve,reject)=>s.timeout(3000).emit(e,p,(err,r)=>err?reject(err):resolve(r)));
const ok=async(...a)=>{const r=await req(...a);assert.strictEqual(r.ok,true,r.err);return r;};
const wait=async fn=>{const end=Date.now()+3000;while(!fn()){assert.ok(Date.now()<end,'状态超时');await new Promise(r=>setTimeout(r,15));}};
const assets=r=>r.players.reduce((s,p)=>s+squid.estate(p)+(['handover','showdown','waiting'].includes(r.stage)?0:p.totalBet),0);
function fixture(n=3){return {stage:'waiting',handNumber:0,settings:{bigBlind:20},players:Array.from({length:n},(_,i)=>({name:`玩家${i}`,chips:2000,totalBet:0,connected:true})),squid:{enabled:true,round:0,current:null}};}
function win(r,seats){r.handNumber++;r.results={pots:[{amount:20,winners:seats.map(seat=>({name:r.players[seat].name,seat}))}]};r.players.forEach(p=>p.totalBet=10);squid.finishHand(r);}
for(let n=3;n<=6;n++){
  const r=fixture(n),total=assets(r);assert.strictEqual(squid.prepare(r),null);
  assert.ok(r.players.every(p=>p.squidFrozen===(n-1)*20));assert.strictEqual(assets(r),total);
  const round=r.squid.current;squid.prepare(r);assert.strictEqual(r.squid.current,round);
  r.settings.bigBlind=100; // 固定轮次快照不随外部配置变化。
  win(r,[0,1]);assert.ok(round.members.every(m=>!m.marked),'主池平分不能标记');
  win(r,[0]);const once=r.players.map(squid.estate);squid.finishHand(r);assert.deepStrictEqual(r.players.map(squid.estate),once);
  win(r,[0]);assert.strictEqual(round.members.filter(m=>m.marked).length,1,'重复独赢不重复得标记');
  for(let i=1;i<n-1;i++)win(r,[i]);
  assert.strictEqual(r.squid.current,null);assert.strictEqual(assets(r),total);
  assert.deepStrictEqual(r.players.map(squid.estate),Array.from({length:n},(_,i)=>i===n-1?2000-(n-1)*20:2020));
  assert.ok(r.players.every(p=>p.squidFrozen===0));squid.finishHand(r);assert.strictEqual(assets(r),total);
  assert.strictEqual(r.squid.history.filter(e=>e.type==='payment').length,1);
  squid.prepare(r);assert.strictEqual(r.squid.current.round,2);assert.strictEqual(r.squid.current.bb,100);assert.strictEqual(assets(r),total);
  squid.cancel(r,'验证取消');assert.strictEqual(assets(r),total);assert.ok(r.players.every(p=>!p.squidFrozen));
}
{
  const r=fixture(2);assert.ok(squid.prepare(r));assert.ok(r.players.every(p=>!p.squidFrozen));
  const f=fixture(3);f.players[2].chips=40;assert.ok(squid.prepare(f));assert.ok(f.players.every(p=>!p.squidFrozen),'不足必须原子拒绝');
  const refund=fixture();squid.prepare(refund);refund.players.forEach(p=>p.totalBet=0);refund.players[0].totalBet=10;
  refund.handNumber=1;refund.results={pots:[{winners:[{seat:0,name:refund.players[0].name}]}]};squid.finishHand(refund);
  assert.ok(refund.squid.current.members.every(m=>!m.marked),'只有退回未跟注额不标记');
}
// 用真实德州主池/边池结算验证：只赢边池的人不得标记；主池平分全员不标记。
for(const split of [false,true]){
  const r=fixture();squid.prepare(r);r.stage='river';r.handNumber=1;r.dealerSeat=0;
  Object.assign(r,{community:split?[14,13,12,11,10].map(v=>({r:v,s:'s'})):[{r:2,s:'s'},{r:4,s:'h'},{r:6,s:'d'},{r:8,s:'c'},{r:10,s:'s'}],pot:0,currentBet:0,minRaise:20,turnSeat:-1,queue:[],logs:[],handActions:[],session:new Map(),sessionLeft:[],settings:{bigBlind:20,nextHandDelay:20},nextHandPaused:true});
  r.players.forEach((p,i)=>Object.assign(p,{inHand:true,folded:false,totalBet:i===0?10:30,roundBet:0,hole:[{r:14-i,s:'h'},{r:14-i,s:'d'}],handStartChips:2000,connected:false}));
  r.players.forEach(p=>p.chips-=p.totalBet);
  showdown(r);
  assert.strictEqual(r.results.pots.length,2);
  assert.deepStrictEqual(r.squid.current.members.map(m=>m.marked),split?[false,false,false]:[true,false,false]);
  assert.strictEqual(r.results.changes.reduce((s,p)=>s+p.delta,0),0);assert.strictEqual(assets(r),6000);
}
console.log('✓ 确定性：3–6人冻结/解冻/逐轮固定1BB支付守恒，重复处理幂等，平分、边池及纯退款排除，原子资金检查');
{
  const r=fixture(4);squid.prepare(r);win(r,[0]);win(r,[1]);
  Object.assign(r,{stage:'river',handNumber:3,dealerSeat:0,community:[{r:2,s:'s'},{r:4,s:'h'},{r:6,s:'d'},{r:8,s:'c'},{r:10,s:'s'}],pot:0,currentBet:0,minRaise:20,turnSeat:-1,queue:[],logs:[],handActions:[],session:new Map(),sessionLeft:[],settings:{bigBlind:20,nextHandDelay:20},nextHandPaused:true});
  r.players.forEach((p,i)=>{p.handStartChips=squid.estate(p);Object.assign(p,{inHand:i!==0,folded:i===0,totalBet:i===0?0:10,roundBet:0,hole:[{r:i===2?14:11+i,s:'h'},{r:i===2?14:11+i,s:'d'}],connected:false});p.chips-=p.totalBet;});
  // 第3位为唯一AA，第4位改为QQ，避免牌面重复。
  r.players[3].hole=[{r:12,s:'c'},{r:12,s:'s'}];
  showdown(r);assert.strictEqual(r.squid.current,null);
  assert.strictEqual(r.results.changes.find(p=>p.name==='玩家0').delta,20,'未参与本手的已标记者仍收到1BB并计入本手盈亏');
  assert.strictEqual(r.results.changes.reduce((s,p)=>s+p.delta,0),0);assert.strictEqual(assets(r),8000);
}
async function open(){const s=connect(`http://127.0.0.1:${server.address().port}`,{transports:['websocket']});sockets.push(s);s.on('state',v=>s.latest=v);await new Promise(r=>s.once('connect',r));return s;}
async function table(n,config={mode:'squid'}){const ss=[];for(let i=0;i<n;i++)ss.push(await open());const cr=await ok(ss[0],'create_room',{name:'甲',...config});const names=['甲','乙','丙','丁','戊','己'];const joins=[cr];for(let i=1;i<n;i++)joins.push(await ok(ss[i],'join_room',{code:cr.code,name:names[i]}));return {ss,r:rooms.get(cr.code),joins};}
async function foldTo(r,name){let turns=0;while(r.stage!=='handover'){assert.ok(turns++<25);const p=r.players[r.turnSeat],s=sockets.find(s=>s.id===p.socketId);await ok(s,'action',{type:p.name===name?(p.roundBet===r.currentBet?'check':'call'):'fold'});}}
async function next(host,r){await ok(host,'set_next_hand_paused',{paused:false});await ok(host,'next_hand');await ok(host,'set_next_hand_paused',{paused:true});}
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));try{
  {const {ss,r}=await table(2,{});assert.strictEqual(ss[0].latest.squid.enabled,false);assert.strictEqual((await req(ss[0],'set_squid',{enabled:true})).ok,false);assert.strictEqual(r.mode,'classic');}
  const {ss,r,joins}=await table(3);assert.strictEqual(ss[0].latest.squid.enabled,true);
  for(const data of [null,{enabled:'true'},{enabled:true,amount:999}])assert.strictEqual((await req(ss[0],'set_squid',data)).ok,false);
  assert.strictEqual((await req(ss[1],'set_squid',{enabled:true})).ok,false);
  assert.ok(r.players.every(p=>!p.squidFrozen),'创建鱿鱼房后仍要到开轮才冻结');
  await ok(ss[0],'start_game');await ok(ss[0],'set_next_hand_paused',{paused:true});
  assert.strictEqual(assets(r),r.economyTotal);assert.ok(r.players.every(p=>p.handStartChips===2000));
  assert.strictEqual((await req(ss[0],'set_squid',{enabled:false})).ok,false);assert.strictEqual((await req(ss[0],'cancel_squid_round')).ok,false);
  assert.strictEqual((await req(ss[0],'update_settings',{startChips:2000,smallBlind:20,bigBlind:40})).ok,false);
  await foldTo(r,'甲');await wait(()=>ss[1].latest.results?.squidEvents?.some(e=>e.type==='mark'));
  assert.strictEqual(r.squid.current.members[0].marked,true);assert.strictEqual(r.players[0].squidFrozen,0);
  assert.strictEqual(ss[1].latest.players[0].hole,null);assert.strictEqual(ss[1].latest.results.pots[0].winners[0].hole,undefined,'弃牌单赢不强制亮牌');
  const frozenBefore=r.players.map(p=>p.squidFrozen),current=r.squid.current;ss[2].disconnect();await wait(()=>!r.players[2].connected);
  assert.strictEqual(r.squid.current,current);assert.deepStrictEqual(r.players.map(p=>p.squidFrozen),frozenBefore);
  assert.ok(ss[0].latest.squid.waitingReason);ss[2]=await open();await ok(ss[2],'join_room',{code:r.code,name:'丙',token:joins[2].token});
  assert.strictEqual(r.squid.current,current);assert.deepStrictEqual(r.players.map(p=>p.squidFrozen),frozenBefore);
  const exported=await ok(ss[0],'export_session');assert.ok(exported.csv.includes('冻结筹码'));assert.ok(exported.csv.includes('总资产'));
  const csvRows=exported.csv.split('\r\n').slice(1,-1).map(line=>line.slice(1,-1).split('\",\"'));
  assert.strictEqual(csvRows.reduce((s,row)=>s+Number(row[6]),0),6000);
  assert.strictEqual(csvRows.reduce((s,row)=>s+Number(row[7]),0),0);
  for(const row of csvRows){assert.strictEqual(Number(row[4])+Number(row[5]),Number(row[6]));assert.strictEqual(Number(row[6])-Number(row[3]),Number(row[7]));}
  for(const p of r.players)assert.ok(!exported.csv.includes(p.token));
  await next(ss[0],r);await foldTo(r,'甲');assert.strictEqual(r.squid.current.members.filter(m=>m.marked).length,1);
  await next(ss[0],r);await foldTo(r,'乙');assert.strictEqual(r.squid.current,null);
  assert.strictEqual(r.results.squidEvents.filter(e=>e.type==='payment').length,1);
  const main=r.results.pots[0];assert.strictEqual(main.winners[0].amountWon,main.amount);
  assert.strictEqual(r.results.changes.reduce((s,p)=>s+p.delta,0),0);assert.strictEqual(assets(r),r.economyTotal);
  await wait(()=>ss[0].latest.results?.handNumber===3);assert.strictEqual(ss[0].latest.session.reduce((s,e)=>s+e.pl,0),0);
  const snapshot=r.players.map(squid.estate);squid.finishHand(r);assert.deepStrictEqual(r.players.map(squid.estate),snapshot);
  await next(ss[0],r);assert.strictEqual(r.squid.current.round,2);assert.ok(r.players.every(p=>p.squidFrozen===40));
  await foldTo(r,'甲');assert.strictEqual((await req(ss[1],'cancel_squid_round')).ok,false);await ok(ss[0],'cancel_squid_round');assert.strictEqual(r.squid.current,null);assert.strictEqual(r.squid.enabled,true);assert.ok(r.players.every(p=>!p.squidFrozen));
  assert.strictEqual((await req(ss[0],'set_squid',{enabled:false})).ok,false);assert.strictEqual(r.squid.enabled,true);
  console.log('✓ Socket：权限/参数/默认关闭，固定开轮，弃牌单赢隐私，断线重连保留，重复获胜，支付一次，跨轮，局间取消、固定模式及CSV/盈亏');
  for(const operation of ['leave_room','kick_player']){
    const {ss,r}=await table(4);await ok(ss[0],'start_game');await ok(ss[0],'set_next_hand_paused',{paused:true});
    const identities=[...r.players],before=assets(r);await ok(operation==='leave_room'?ss[2]:ss[0],operation,operation==='kick_player'?{seat:2}:null);
    assert.strictEqual(r.squid.current,null);assert.strictEqual(r.squid.enabled,true);assert.ok(r.players.every(p=>!p.squidFrozen));
    assert.strictEqual(r.stage,'preflop');assert.deepStrictEqual(r.players,identities);assert.strictEqual(assets(r),before);
    await foldTo(r,'甲');assert.strictEqual(r.results.changes.reduce((s,p)=>s+p.delta,0),0);
    await wait(()=>ss[0].latest.stage==='handover');assert.strictEqual(ss[0].latest.session.reduce((s,e)=>s+e.pl,0),0);
    assert.ok(r.results.squidEvents.some(e=>e.type==='cancel'));
  }
  {
    const {ss,r}=await table(3);r.players[2].chips=40;r.economyTotal-=1960;
    assert.strictEqual((await req(ss[0],'start_game')).ok,false);assert.ok(r.players.every(p=>!p.squidFrozen));
    const buyIn=r.session.get('丙').buyIn;await ok(ss[2],'rebuy');assert.strictEqual(r.players[2].chips,2040);assert.strictEqual(r.session.get('丙').buyIn,buyIn+2000);
    await ok(ss[0],'start_game');assert.strictEqual(assets(r),r.economyTotal);
    await ok(ss[0],'set_next_hand_paused',{paused:true});await foldTo(r,'甲');
    const fourth=await open();await ok(fourth,'join_room',{code:r.code,name:'丁'});assert.strictEqual(r.squid.current.members.length,3);
    await next(ss[0],r);await foldTo(r,'丁');assert.strictEqual(r.squid.current.members.filter(m=>m.marked).length,1,'新玩家仅下轮有资格');
  }
  console.log('✓ Socket：局中主动退出/移除立即解冻且保留主局座序，离场存档守恒，资金不足原子拒绝与正筹码重买，新人下轮参加');
  {
    const {ss,r}=await table(3);await ok(ss[0],'start_game');await ok(ss[0],'set_next_hand_paused',{paused:true});
    const p=r.players[r.turnSeat],seat=r.turnSeat;await ok(ss[seat],'action',{type:'allin'});
    assert.strictEqual(p.chips,0);assert.strictEqual(p.totalBet,1960);assert.strictEqual(p.squidFrozen,40,'全押不能动用冻结资产');
    assert.strictEqual(assets(r),r.economyTotal);
  }
  // 不调用 next 辅助函数：条件恢复后必须靠原自动续局流程发第二手。
  for(const restore of ['reconnect','sit_back']) for(const paused of [false,true]){
    const {ss,r,joins}=await table(3);r.settings.nextHandDelay=1;

    assert.strictEqual(r.handNumber,0);assert.strictEqual(r.nextHandTimer,null,'初始等待不能自动开第一手');
    await ok(ss[0],'start_game');await foldTo(r,'甲');
    const round=r.squid.current,frozen=r.players.map(squid.frozen),marked=round.members.map(m=>m.marked);
    if(restore==='reconnect'){ss[2].disconnect();await wait(()=>!r.players[2].connected);}
    else await ok(ss[2],'sit_out');
    await wait(()=>!r.nextHandTimer&&!r.nextHandDeadline);
    assert.strictEqual(r.handNumber,1);assert.strictEqual(r.stage,'handover');assert.ok(r.squid.waitingReason);
    if(paused)await ok(ss[0],'set_next_hand_paused',{paused:true});
    if(restore==='reconnect'){ss[2]=await open();await ok(ss[2],'join_room',{code:r.code,name:'丙',token:joins[2].token});}
    else await ok(ss[2],'sit_back');
    assert.strictEqual(r.squid.waitingReason,null);
    if(paused){await new Promise(resolve=>setTimeout(resolve,1250));assert.strictEqual(r.handNumber,1);assert.strictEqual(r.nextHandTimer,null);assert.strictEqual(r.nextHandDeadline,0);}
    else{assert.ok(r.nextHandTimer,'恢复人数后应重建已耗尽的自动续局排期');await wait(()=>r.handNumber===2);await ok(ss[0],'set_next_hand_paused',{paused:true});}
    assert.strictEqual(r.squid.current,round);assert.deepStrictEqual(r.players.map(squid.frozen),frozen);assert.deepStrictEqual(round.members.map(m=>m.marked),marked);assert.strictEqual(assets(r),r.economyTotal);
    console.log(`✓ 自动续局：${restore}恢复已耗尽的倒计时，${paused?'显式暂停保持不发牌':'无需手动next即发第二手'}，轮次/标记/冻结不变`);
  }
  {
    const {ss,r,joins}=await table(3);r.settings.nextHandDelay=5;
    await ok(ss[0],'start_game');await foldTo(r,'甲');
    const timer=r.nextHandTimer,deadline=r.nextHandDeadline;
    ss[2].disconnect();await wait(()=>!r.players[2].connected);ss[2]=await open();await ok(ss[2],'join_room',{code:r.code,name:'丙',token:joins[2].token});
    assert.strictEqual(r.nextHandTimer,timer);assert.strictEqual(r.nextHandDeadline,deadline,'有效原截止时间不被重连延长');
    await ok(ss[2],'sit_out');await ok(ss[2],'sit_back');assert.strictEqual(r.nextHandTimer,timer);assert.strictEqual(r.nextHandDeadline,deadline);
    await ok(ss[0],'set_next_hand_paused',{paused:true});
    console.log('✓ 正常未到期：重连/坐回均保持原计时器与截止时间，初始waiting不自动开局');
  }
}finally{sockets.forEach(s=>s.disconnect());await new Promise(r=>io.close(r));for(const r of rooms.values()){clearTimeout(r.timer);clearTimeout(r.nextHandTimer);clearTimeout(r.waitingCleanupTimer);}}})().catch(e=>{console.error(e);process.exitCode=1;});
