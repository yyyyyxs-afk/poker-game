// 独立本机界面夹具：以真实 Socket.IO 加入测试玩家；终局仅在本进程内构造，不暴露网络测试接口。
const readline=require('node:readline');
const {io:connect}=require('socket.io-client');
const {server,io,rooms,applyAction,__test}=require('../server');
const bots=[];let room;
server.listen(0,'127.0.0.1',()=>console.log(`UI_PORT=${server.address().port}`));
const poll=setInterval(()=>{const last=[...rooms.values()].at(-1);if(last&&!room){room=last;room.settings.actionTime=600;room.nextHandPaused=true;console.log(`UI_ROOM=${room.code}`);}},100);
readline.createInterface({input:process.stdin}).on('line',async line=>{
  if(!room)return;
  if(line.startsWith('bots ')){
    const count=Math.min(Number(line.slice(5)),6-room.players.length);
    for(let i=0;i<count;i++){
      const name=['高进','陈小刀','阿星','龙五','海棠'][room.players.length-1];
      const s=connect(`http://127.0.0.1:${server.address().port}`,{transports:['websocket']});bots.push(s);
      await new Promise(r=>s.once('connect',r));await new Promise(r=>s.emit('join_room',{code:room.code,name},r));
    }
    return console.log(`UI_PLAYERS=${room.players.length}`);
  }
  if(line.startsWith('turn ')){
    const name=line.slice(5).trim();
    for(let i=0;i<40&&room.stage!=='handover';i++){
      const p=room.players[room.turnSeat];if(!p||p.name===name)break;
      applyAction(room,room.turnSeat,p.roundBet===room.currentBet?'check':'call');
    }
    return console.log(`UI_TURN=${room.players[room.turnSeat]?.name} stage=${room.stage}`);
  }
  if(line==='void'){
    if(room.tournament?.status!=='running')return console.log('请先开赛');
    room.players.forEach(p=>{p.left=true;p.folded=true;p.tournamentWithdrawReason='主动退赛';});
    __test.consumeQueueAndAdvance(room,-1);return console.log(`UI_VOID=${room.tournament.status}`);
  }
  if(line==='finish'){
    if(room.tournament?.status!=='running')return console.log('请先开赛');
    const cards=[14,13,12,11,10,9];
    room.players.forEach((p,i)=>{p.handStartChips=room.settings.startChips;p.totalBet=room.settings.startChips;p.roundBet=0;p.chips=0;p.folded=false;p.inHand=true;p.allIn=true;p.hole=[{r:cards[i],s:'s'},{r:cards[i],s:'h'}];});
    room.community=[{r:2,s:'c'},{r:4,s:'d'},{r:6,s:'h'},{r:8,s:'s'},{r:3,s:'c'}];room.stage='river';
    __test.showdown(room);return console.log(`UI_FINISHED=${room.tournament.status}`);
  }
});
async function stop(){clearInterval(poll);bots.forEach(s=>s.disconnect());await new Promise(r=>io.close(r));for(const r of rooms.values()){clearTimeout(r.timer);clearTimeout(r.nextHandTimer);clearTimeout(r.waitingCleanupTimer);clearTimeout(r.tournament?.blindTimer);r.players.forEach(p=>clearTimeout(p.tournamentOfflineTimer));}process.exit();}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
