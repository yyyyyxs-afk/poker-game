// 隔离本地视觉检查夹具：浏览器创建房间后加入5名虚拟好友。
const readline=require('readline');
const {io:connect}=require('socket.io-client');
const {server,io,rooms,applyAction}=require('../server');
const clients=[];
let room,busy=false;
server.listen(0,'127.0.0.1',()=>console.log(`UI_PORT=${server.address().port}`));
const poll=setInterval(async()=>{
  if(busy||room||!rooms.size)return;busy=true;room=[...rooms.values()][0];
  for(const name of ['高进','陈小刀','阿星','龙五','海棠']){
    const s=connect(`http://127.0.0.1:${server.address().port}`,{transports:['websocket']});clients.push(s);
    await new Promise(r=>s.once('connect',r));await new Promise(r=>s.emit('join_room',{code:room.code,name},r));
  }
  room.settings.actionTime=600;room.nextHandPaused=true;
  console.log(`UI_ROOM=${room.code}，6人就绪；输入 win 昵称 可确定性结束本手`);
},100);
readline.createInterface({input:process.stdin}).on('line',line=>{
  if(!room)return;
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
