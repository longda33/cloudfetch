/**
 * 带错误传播的写流封装。
 *
 * 直接用 fs.createWriteStream 有两个坑，在本项目的运行环境（1GB 内存 / 5GB 磁盘）
 * 里都会真实发生：
 *
 *  1) 'error'（ENOSPC / EACCES / ENFILE）没有监听时会被抛成 uncaughtException。
 *     server.js 只记日志不退出，进程进入"半死"状态，后续任务全部行为异常。
 *  2) write() 返回 false 之后等 'drain'，可一旦流已经出错，'drain' 永远不会触发，
 *     任务会永久挂起并一直占着并发位，最终把整个服务拖垮。
 *
 * 这里把两种情况统一成 Promise 拒绝，调用方用普通的 try/catch 就能处理。
 */
import fs from 'node:fs';

/**
 * 打开一个可安全写入的流。
 * @param {string} file
 * @param {string} [flags] 'w' 覆盖 / 'a' 追加
 */
export function openWriter(file, flags = 'w') {
  const ws = fs.createWriteStream(file, { flags });
  let err = null;
  const waiters = new Set();

  const fail = (e) => {
    if (err) return;
    err = e;
    for (const w of waiters) w.reject(e);
    waiters.clear();
  };

  ws.on('error', fail);
  // 没写完就 close（磁盘满时内核会直接关闭）也要让等待方立刻失败
  ws.on('close', () => {
    if (!ws.writableFinished) fail(err || new Error('写入流异常关闭'));
  });

  return {
    stream: ws,
    get error() {
      return err;
    },

    /** 写一块数据，自动处理背压 */
    async write(chunk) {
      if (err) throw err;
      if (ws.write(chunk)) return;
      await new Promise((resolve, reject) => {
        const w = { resolve, reject };
        waiters.add(w);
        ws.once('drain', () => {
          if (waiters.delete(w)) resolve();
        });
      });
      if (err) throw err;
    },

    /** 结束写入并等待落盘。失败会抛出，不会静默丢数据 */
    async end() {
      if (err) {
        try {
          ws.destroy();
        } catch {
          /* ignore */
        }
        throw err;
      }
      await new Promise((resolve, reject) => {
        const onErr = (e) => {
          ws.off('finish', onFinish);
          reject(e);
        };
        const onFinish = () => {
          ws.off('error', onErr);
          resolve();
        };
        ws.once('error', onErr);
        ws.once('finish', onFinish);
        ws.end();
      });
    },

    destroy() {
      try {
        ws.destroy();
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * 把一个文件的内容顺序写进已打开的 writer。
 * 用 for-await 而不是 pipe：背压由 async 迭代器负责，读端错误也会自然抛出。
 */
export async function pipeInto(writer, srcPath) {
  const rs = fs.createReadStream(srcPath, { highWaterMark: 1024 * 1024 });
  try {
    for await (const chunk of rs) {
      await writer.write(chunk);
    }
  } finally {
    rs.destroy();
  }
}
