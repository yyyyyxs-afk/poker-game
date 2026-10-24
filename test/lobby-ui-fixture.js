// 大厅只读诊断夹具：真实业务处理不改，只控制本机测试连接和回执。
const fs=require('node:fs');
const readline=require('node:readline');
const {io:connect}=require('socket.io-client');
const {server,io,rooms}=require('../server');
const faults={create_room:'normal',room_info:'normal',join_room:'normal'};
let offline=false,current,seed,connection=0;
const logFile=process.argv[2];
function log(event,detail={}) {
  const row={at:new Date().toISOString(),event,...detail};
  console.log(JSON.stringify(row));
  if(logFile)fs.appendFileSync(logFile,JSON.stringify(row)+'\n');
}
io.engine.use((req,res,next)=>{
  if(offline&&!req._query.sid){log('handshake_refused');return next(new Error('isolated fixture offline'));}
  next();
});
server.on('request',(req,res)=>{
  const path=req.url.split('?')[0];
  if(['/', '/client.js','/chat-delivery.js'].includes(path))res.once('finish',()=>log('static_response',{path,status:res.statusCode}));
});
io.on('connection',socket=>{
  if(socket.handshake.auth.fixtureSeed)return;
  current=socket;const id=++connection;
  log('connected',{connection:id});
  socket.on('disconnect',reason=>log('disconnected',{connection:id,reason}));
  socket.onAnyOutgoing((event,s)=>{if(event==='state')log('state_sent',{connection:id,code:s.code,youSeat:s.youSeat});});
  for(const event of Object.keys(faults)){
    const handler=socket.listeners(event)[0];socket.removeListener(event,handler);
    socket.on(event,(payload,ack)=>{
      const fault=faults[event];log('request',{connection:id,type:event,fault,name:payload?.name,code:payload?.code});
      handler(payload,result=>{
        log('result',{connection:id,type:event,ok:result?.ok,code:result?.code,err:result?.err,ack:fault==='lost'?'dropped':'delivered'});
        if(fault!=='lost')ack?.(result);
      });
    });
  }
});
server.listen(0,'127.0.0.1',async()=>{
  const port=server.address().port;
  seed=connect(`http://127.0.0.1:${port}`,{transports:['websocket'],auth:{fixtureSeed:true}});
  await new Promise(r=>seed.once('connect',r));
  const result=await new Promise(r=>seed.emit('create_room',{name:'隔离房主'},r));
  log('ready',{port,seedCode:result.code});
});
readline.createInterface({input:process.stdin}).on('line',line=>{
  const [command,event,mode]=line.split(' ');
  if(command==='fault'&&Object.hasOwn(faults,event)&&['normal','lost'].includes(mode))faults[event]=mode;
  else if(command==='offline'){offline=true;current?.conn.close();}
  else if(command==='online')offline=false;
  else if(command==='status')log('rooms',{rooms:[...rooms.values()].map(r=>({code:r.code,stage:r.stage,players:r.players.map(p=>({name:p.name,connected:p.connected,left:p.left}))}))});
  else if(command==='mark')log('checkpoint',{label:line.slice(5)});
  log('control',{offline,faults:{...faults}});
});
function stop(){seed?.disconnect();for(const r of rooms.values())for(const k of ['timer','nextHandTimer','waitingCleanupTimer'])clearTimeout(r[k]);io.close(()=>process.exit());}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
