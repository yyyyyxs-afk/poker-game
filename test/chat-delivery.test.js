const assert=require('node:assert/strict');
const {createChatDelivery}=require('../public/chat-delivery');
function setup() {
  let room='ABC123',value='',version=0,view;
  const requests=[],listeners={};
  const socket={connected:true,on:(name,fn)=>listeners[name]=fn,timeout(ms){this.ms=ms;return this;},get volatile(){this.lossy=true;return this;},emit(event,payload,callback){requests.push({event,payload,callback,ms:this.ms,volatile:this.lossy});this.lossy=false;}};
  const edit=text=>{value=text;version++;};
  const controller=createChatDelivery({socket,getRoom:()=>room,getDraft:()=>({value,version}),clearDraft:()=>edit(''),onChange:s=>view=s});
  controller.setReadyRoom(room,true);
  return {controller,requests,socket,edit,get value(){return value;},get view(){return view;},disconnect(){socket.connected=false;listeners.disconnect();},reconnect(){socket.connected=true;controller.setReadyRoom(room,true);},room(code){room=code;controller.refresh();controller.setReadyRoom(code,true);}};
}
{
  const f=setup();f.edit('中文长消息 <script>原文</script>');f.controller.send();
  assert.equal(f.view.pending,true);assert.equal(f.requests[0].ms,8000);assert.equal(f.requests[0].volatile,true);
  assert.equal(f.controller.send(),false);assert.equal(f.requests.length,1,'发送中不重复提交');
  f.edit('下一条草稿');f.requests[0].callback(null,{ok:true});assert.equal(f.value,'下一条草稿');assert.equal(f.view.status,'已确认发送');
  f.controller.send();f.requests[1].callback(null,{ok:true});assert.equal(f.value,'');
}
{
  const f=setup();f.edit('同样的文字');f.controller.send();f.edit('修改');f.edit('同样的文字');f.requests[0].callback(null,{ok:true});
  assert.equal(f.value,'同样的文字','编辑后改回原文也不能被旧回执清空');
}
{
  const f=setup();f.edit('A');f.controller.send();const old=f.requests[0];f.edit('B');old.callback(new Error('timeout'));
  assert.equal(f.view.pending,false);assert.equal(f.view.records[0].raw,'A');assert.equal(f.value,'B');assert.match(f.view.status,/未确认/);
  f.controller.send();old.callback(null,{ok:true});assert.equal(f.view.pending,true);assert.equal(f.value,'B','旧回执不得影响新请求');
  f.requests[1].callback(null,{ok:true});assert.equal(f.value,'');assert.equal(f.view.records[0].raw,'A');
  f.edit('Ａ');assert.equal(f.controller.send(),false,'同一未确认原文不能从主发送按钮盲目重复');
  f.edit('C');f.controller.send(f.view.records[0].id);assert.equal(f.requests[2].payload.text,'A');assert.equal(f.value,'C');
  f.requests[2].callback(null,{ok:true});assert.equal(f.value,'C');assert.equal(f.view.records.length,0);
}
{
  const f=setup();f.edit('断线原文');f.controller.send();const old=f.requests[0];f.edit('新草稿');f.disconnect();
  assert.equal(f.view.ready,false);assert.equal(f.view.pending,false);assert.match(f.view.status,/连接中断.*未确认/);
  assert.equal(f.controller.send(),false);assert.equal(f.requests.length,1,'离线不能排队');
  old.callback(null,{ok:true});assert.equal(f.value,'新草稿');assert.equal(f.view.records[0].raw,'断线原文');
  f.socket.connected=true;assert.equal(f.controller.send(),false,'传输恢复但房间未恢复时仍不能发送');
  f.reconnect();assert.equal(f.requests.length,1,'重连不自动重发');assert.equal(f.view.ready,true);
}
{
  const f=setup();f.edit('拒绝原文');f.controller.send();f.edit('后续草稿');f.requests[0].callback(null,{ok:false,err:'消息发得太快了'});
  assert.match(f.view.status,/未发送：消息发得太快了/);assert.equal(f.view.records[0].kind,'rejected');assert.equal(f.value,'后续草稿');
  f.controller.send();f.requests[1].callback(null,undefined);assert.match(f.view.status,/未确认/,'无效回执不能误报失败或成功');
}
{
  const f=setup();f.edit('旧房间');f.controller.send();const old=f.requests[0];f.room('DEF456');f.edit('新房间');f.controller.send();
  old.callback(null,{ok:true});assert.equal(f.value,'新房间');assert.equal(f.view.pending,true);
}
console.log('PASS 聊天回执：确认、8秒边界、草稿版本、旧回执隔离、手动重发、拒绝/未确认、离线无排队和房间隔离');
