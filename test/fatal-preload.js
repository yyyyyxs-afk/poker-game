// 仅由 runtime.test.js 在隔离子进程中预加载，不属于游戏运行入口。
setImmediate(() => {
  const error = new Error('runtime-test-intentional-failure');
  if (process.env.POKER_TEST_FAILURE === 'rejection') Promise.reject(error);
  else throw error;
});
