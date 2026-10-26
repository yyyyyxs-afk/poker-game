// 隔离本地视觉检查夹具：浏览器创建房间后加入5名虚拟好友。
const readline=require('readline');
const {io:connect}=require('socket.io-client');
const {server,io,rooms,applyAction,__test}=require('../server');
const clients=[];
let room,busy=false;
server.listen(0,'127.0.0.1',()=>console.log(`UI_PORT=${server.address().port}`));
const poll=setInterval(()=>{
  const latest=[...rooms.values()].at(-1);
  if(!latest||latest===room)return;
  room=latest;room.settings.actionTime=600;room.nextHandPaused=true;
  console.log(`UI_ROOM=${room.code}，输入 bots 3/5 加好友，turn 昵称/flop 昵称准备行动，win 昵称结算，next续局`);
},100);
readline.createInterface({input:process.stdin}).on('line',async line=>{
  if(!room)return;
  // 仅本机验收：固定合法牌面/整数投入，用生产摊牌函数生成主池/边池或平分结果。
  if(line==='review sidepots'||line==='review split'){
    if(room.players.length<3||!['preflop','flop','turn','river'].includes(room.stage))return console.log('请先加入至少3人并开局');
    const split=line==='review split',ranks=split?[10,11,12,13,14]:[2,7,9,11,12];
    room.community=ranks.map((r,i)=>({r,s:split?'s':['c','d','h','s','c'][i]}));
    room.players.forEach((p,i)=>{
      p.inHand=i<3;p.folded=i>=3||(split&&i===2);p.allIn=false;
      p.totalBet=i<3?(split?101:[100,200,200][i]):0;p.roundBet=0;
      p.chips=p.handStartChips-p.totalBet-(p.squidFrozen||0);
      if(i<3)p.hole=[{r:[14,13,10][i],s:'d'},{r:[14,13,10][i],s:'h'}];
    });
    room.pot=room.players.reduce((sum,p)=>sum+p.totalBet,0);room.stage='river';
    __test.showdown(room);
    return console.log('UI_REVIEW='+JSON.stringify({scenario:split?'split':'sidepots',pots:room.results.pots.map(p=>({amount:p.amount,winners:p.winners.map(w=>({name:w.name,amountWon:w.amountWon}))})),changes:room.results.changes.map(p=>({name:p.name,delta:p.delta}))}));
  }
  if(line==='status')return console.log('UI_STATUS='+JSON.stringify({stage:room.stage,hand:room.handNumber,players:room.players.map((p,seat)=>({seat,name:p.name,chips:p.chips,frozen:require('../squid').frozen(p),roundBet:p.roundBet}))}));
  if(line.startsWith('raise '))return console.log('UI_RAISE='+JSON.stringify(applyAction(room,room.turnSeat,'raise',Number(line.slice(6)))));
  if(line.startsWith('bots ')){
    const count=Math.min(Number(line.slice(5)),6-room.players.filter(p=>!p.left).length);
    const current=room;
    for(let i=0;i<count;i++){
      const name=['高进','陈小刀','阿星','龙五','海棠'][current.players.length-1];
      const s=connect(`http://127.0.0.1:${server.address().port}`,{transports:['websocket']});clients.push(s);
      await new Promise(r=>s.once('connect',r));await new Promise(r=>s.emit('join_room',{code:current.code,name},r));
    }
    return console.log(`UI_PLAYERS=${current.players.length}`);
  }
  if(line.startsWith('turn ')||line.startsWith('flop ')){
    const flop=line.startsWith('flop '),name=line.slice(5).trim();
    for(let i=0;i<35&&room.stage!=='handover';i++){
      const p=room.players[room.turnSeat];
      if(p?.name===name&&(!flop||room.stage==='flop'))break;
      if(!p)break;
      applyAction(room,room.turnSeat,p.roundBet===room.currentBet?'check':'call');
    }
    return console.log(`UI_TURN=${room.players[room.turnSeat]?.name} stage=${room.stage}`);
  }
  if(line==='next'){
    const host=room.players.find(p=>p.name===room.hostName);
    const s=io.sockets.sockets.get(host?.socketId);
    if(!s)return console.log('房主未连接');
    const call=(name,payload)=>s.listeners(name)[0](payload,r=>{if(!r.ok)console.log(r);});
    call('set_next_hand_paused',{paused:false});call('next_hand',null);call('set_next_hand_paused',{paused:true});
    return console.log(`UI_NEXT=${room.handNumber}`);
  }
  if(line.startsWith('win ')){
    const name=line.slice(4).trim();
    for(let i=0;i<40&&room.stage!=='handover';i++){
      const p=room.players[room.turnSeat];if(!p)break;
      applyAction(room,room.turnSeat,p.name===name?(p.roundBet===room.currentBet?'check':'call'):'fold');
    }
    console.log(`UI_HAND=${room.handNumber} stage=${room.stage} winner=${room.results?.pots[0].winners[0].name}`);
  }
});
async function stop(){clearInterval(poll);clients.forEach(s=>s.disconnect());await new Promise(r=>io.close(r));for(const r of rooms.values()){clearTimeout(r.timer);clearTimeout(r.nextHandTimer);clearTimeout(r.waitingCleanupTimer);}process.exit();}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
