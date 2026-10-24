// 仅管理大厅请求生命周期；不改变服务端协议、凭证校验或牌局请求。
function createLobbyRequests({socket,onChange,queryWaitMs=8000,mutationWaitMs=10000}) {
  let pending=null,unknown=null,replacement=false,message='';
  let connectedBefore=socket.connected,connection=socket.connected?'ready':'connecting';
  const snapshot=()=>({connection,message,replacement,pendingKind:pending?.kind||'',pendingCode:pending?.payload.code||'',unknown:unknown?{...unknown}:null});
  const notify=()=>onChange(snapshot());
  const unknownMessage=kind=>`${kind==='create'?'创建':'加入'}结果未确认，原操作可能已成功；不会自动重发。`;
  function unconfirmed(request) {
    if(pending!==request)return;
    pending=null;
    if(request.kind==='preview')message='查询未完成，资料已保留；可手动重新查询。';
    else {unknown={kind:request.kind,name:request.payload.name,code:request.payload.code||''};message=unknownMessage(request.kind);}
    notify();
  }
  socket.on('connect',()=>{
    connection=connectedBefore||connection==='failed'||connection==='offline'?'recovered':'ready';connectedBefore=true;
    if(message.startsWith('尚未连接'))message='之前操作未发送；请主动提交。';
    notify();
  });
  socket.on('connect_error',()=>{connection='failed';if(pending)unconfirmed(pending);else notify();});
  socket.on('disconnect',()=>{connection='offline';if(pending)unconfirmed(pending);else notify();});
  return {
    snapshot,refresh:notify,
    send(kind,payload,{success,rejected=()=>{}}) {
      if(pending||unknown||(replacement&&kind!=='create'))return false;
      if(!socket.connected){message='尚未连接，未发送请求；资料已保留，请连接恢复后主动提交。';notify();return false;}
      const request={kind,payload};pending=request;
      message=kind==='preview'?'正在查询房间…':kind==='create'?'正在创建房间…':'正在加入房间…';notify();
      const event=kind==='create'?'create_room':kind==='join'?'join_room':'room_info';
      try {
        socket.timeout(kind==='preview'?queryWaitMs:mutationWaitMs).volatile.emit(event,payload,(error,response)=>{
          if(pending!==request)return; // 已退出、过期或放弃的回执不能开预览、存凭证或跳房。
          if(error||typeof response?.ok!=='boolean')return unconfirmed(request);
          if(response.ok&&kind!=='preview'&&(!/^[A-Z0-9]{6}$/.test(response.code)||typeof response.token!=='string'||!response.token))return unconfirmed(request);
          if(response.ok&&kind==='preview'&&(!response.info||!response.info.settings))return unconfirmed(request);
          pending=null;
          if(response.ok){message='';if(kind!=='preview')replacement=false;notify();success(response);}
          else {message=response.err||'请求被拒绝，请检查资料。';notify();rejected(response);}
        });
      } catch (_) {unconfirmed(request);}
      return true;
    },
    leaveView() {
      if(!pending)return;
      if(pending.kind!=='preview')unconfirmed(pending);
      else {pending=null;message='已退出查询，资料已保留；可主动重新查询。';notify();}
    },
    cancelQuery() {
      if(pending?.kind==='preview'){pending=null;message='查询资料已变化，请主动重新查询。';notify();}
    },
    abandonForNewRoom(confirmed) {
      if(!confirmed||!unknown||pending)return false;
      pending=null;unknown=null;replacement=true;
      message='已放弃等待；原房可能仍存在。连接恢复后，请主动点击“创建新房间”。';
      // 原连接可能已占有旧房。明确放弃后仅重建连接，不自动发任何业务请求。
      socket.disconnect();connection='connecting';socket.connect();notify();
      return true;
    },
  };
}
if(typeof module!=='undefined')module.exports={createLobbyRequests};
