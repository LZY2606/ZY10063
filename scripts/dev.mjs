#!/usr/bin/env node
import { createServer } from '../src/server/http.mjs';

function readFlag(name, fallback) {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const host = readFlag('host', process.env.HOST || '127.0.0.1');
const port = Number(readFlag('port', process.env.PORT || '5201'));
const strictPort = process.argv.includes('--strictPort');
const dataDirectory = process.env.TIMELINE_DATA_DIR || new URL('../data', import.meta.url).pathname;

const server = createServer({ dataDirectory });
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE' && strictPort) {
    console.error('Port ' + port + ' is already in use; --strictPort prevents selecting another port.');
    process.exitCode = 1;
    return;
  }
  throw error;
});
server.listen(port, host, () => {
  console.log('Subtitle timeline workbench: http://' + host + ':' + port);
  console.log('Persistent data: ' + dataDirectory);
});
