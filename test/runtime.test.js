const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const http = require('http');
const { server, io } = require('../server');

async function main() {
  for (const kind of ['exception', 'rejection']) {
    const result = spawnSync(process.execPath, [
      '--require', path.join(__dirname, 'fatal-preload.js'),
      path.join(__dirname, '..', 'server.js'),
    ], {
      env: { ...process.env, PORT: '0', POKER_TEST_FAILURE: kind },
      encoding: 'utf8', timeout: 10000,
    });
    assert.ifError(result.error);
    assert.strictEqual(result.status, 1, `${kind} 必须非零退出`);
    const record = result.stderr.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.strictEqual(record[0].level, 'fatal');
    assert.strictEqual(record[0].event, kind === 'exception' ? 'uncaughtException' : 'unhandledRejection');
    assert.match(record[0].error, /runtime-test-intentional-failure/);
  }
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${server.address().port}/healthz`, (response) => {
        let body = '';
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => {
          try {
            assert.strictEqual(response.statusCode, 200);
            assert.strictEqual(response.headers['cache-control'], 'no-store');
            assert.deepStrictEqual(JSON.parse(body), { status: 'ok' });
            resolve();
          } catch (error) { reject(error); }
        });
      }).on('error', reject);
    });
  } finally {
    await new Promise((resolve) => io.close(resolve));
  }
  console.log('运行保障通过：健康检查、严重异常和未处理拒绝退出');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
