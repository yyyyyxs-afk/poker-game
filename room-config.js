// 创建房间先完整校验，再建立房间和买入；金额单位均为虚拟筹码。
const DEFAULTS=Object.freeze({startChips:2000,smallBlind:10,bigBlind:20,actionTime:45,nextHandDelay:20,rebuyAllowed:true,locked:false});
const MAX_PAYMENT=1000000;
function paymentError(value){
  return Number.isSafeInteger(value)&&value>=1&&value<=MAX_PAYMENT?null:'每人支付额须为1–1,000,000的整数筹码';
}
function parseCreate(data){
  if(Object.keys(data).some(k=>!['name','mode','settings','squidPayment'].includes(k)))return {err:'创建参数无效'};
  const mode=data.mode===undefined?'classic':data.mode;
  if(!['classic','squid'].includes(mode))return {err:'玩法无效'};
  if(data.settings!==undefined&&(!data.settings||typeof data.settings!=='object'||Array.isArray(data.settings)))return {err:'房间设置无效'};
  const source=data.settings||{};
  if(Object.keys(source).some(k=>!Object.hasOwn(DEFAULTS,k)))return {err:'房间设置字段无效'};
  const settings={...DEFAULTS,...source};
  const {startChips:sc,smallBlind:sb,bigBlind:bb,actionTime:at,nextHandDelay:nh,rebuyAllowed:rb,locked}=settings;
  if(!Number.isSafeInteger(sc)||sc<100||sc>1000000)return {err:'起始筹码需为100–1,000,000的整数'};
  if(!Number.isSafeInteger(sb)||!Number.isSafeInteger(bb)||sb<1||bb<sb||bb>Math.floor(sc/20))return {err:'盲注须为正整数，大盲≥小盲，起始筹码至少为大盲的20倍'};
  if(![20,30,45,60].includes(at)||![5,10,20].includes(nh))return {err:'行动/局间时长无效'};
  if(typeof rb!=='boolean'||typeof locked!=='boolean')return {err:'重买/锁房设置无效'};
  if(mode==='classic'&&data.squidPayment!==undefined)return {err:'经典德州不使用鱿鱼支付设置'};
  const payment=data.squidPayment===undefined?bb:data.squidPayment;
  if(mode==='squid'&&paymentError(payment))return {err:paymentError(payment)};
  return {mode,settings,payment};
}
module.exports={DEFAULTS,MAX_PAYMENT,paymentError,parseCreate};
