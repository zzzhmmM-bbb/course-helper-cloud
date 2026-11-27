import { loadConfig, Logger } from './config.js';
import { CloudDatabase } from './db.js';
import { RcAutoAnswerEngine } from './engines/rc_auto_answer.js';
import { CloudSchedulerEngine } from './engines/scheduler.js';
import { createCloudServer } from './server.js';

const config = loadConfig();
const logger = new Logger(config.logLevel);
const db = new CloudDatabase({
  dataDir: config.dataDir,
  encryptionKey: config.encryptionKey,
  maxLogsPerWorkspace: config.maxLogsPerWorkspace,
});

const rcAutoAnswer = new RcAutoAnswerEngine(db, logger);
const scheduler = new CloudSchedulerEngine(config, db, rcAutoAnswer, logger);
const server = createCloudServer({
  config,
  db,
  rcAutoAnswer,
  scheduler,
  logger,
});

server.listen(config.port, config.host, () => {
  logger.info(
    'boot',
    `轻课云端托管引擎已启动 http://${config.host}:${config.port} (dataDir=${config.dataDir}, semesterStart=${config.semesterStartMonday})`
  );
  scheduler.start();
});

function gracefulShutdown(signal: string): void {
  logger.info('boot', `收到 ${signal}，正在安全关闭云端引擎...`);
  scheduler.stop();
  rcAutoAnswer.shutdown();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => {
    db.close();
    process.exit(1);
  }, 5000).unref();
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
