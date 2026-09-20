// 测试入口：忽略透传参数（如 `-- --run`），保证 `npm test -- --run` 可用。
import { spawnSync } from 'node:child_process';

const result = spawnSync(process.execPath, ['--test', 'tests/*.test.js'], {
  stdio: 'inherit',
  env: process.env,
});
process.exit(result.status ?? 1);
