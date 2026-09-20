// 单机入口：解析 --host/--port/--strictPort，启动 API + 静态页服务。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { createServer } from './app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { host: '127.0.0.1', port: 5201, strictPort: false, dataDir: path.join(__dirname, '..', 'data') };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case '--host':
        args.host = argv[++i];
        break;
      case '--port':
        args.port = Number(argv[++i]);
        break;
      case '--strictPort':
        args.strictPort = true;
        break;
      case '--data-dir':
        args.dataDir = argv[++i];
        break;
      default:
        break;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const store = Store.open(args.dataDir);
const server = createServer(store);

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${args.port} 已被占用${args.strictPort ? '（strictPort 模式，退出）' : ''}`);
    process.exit(1);
  }
  throw err;
});

server.listen(args.port, args.host, () => {
  console.log(`字幕时间轴工作台已启动: http://${args.host}:${args.port}`);
  console.log(`数据目录: ${args.dataDir}`);
});

process.on('SIGINT', () => {
  store.snapshot();
  process.exit(0);
});
process.on('SIGTERM', () => {
  store.snapshot();
  process.exit(0);
});
