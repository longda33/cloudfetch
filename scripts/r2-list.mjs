import crypto from 'node:crypto';

const AK = process.env.R2_ACCESS_KEY_ID;
const SK = process.env.R2_SECRET_ACCESS_KEY;
const BUCKET = process.env.R2_BUCKET || 'cloudfetch';
const ACCT = process.env.R2_ACCOUNT_ID;
const HOST = `${ACCT}.r2.cloudflarestorage.com`;

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();

/**
 * ListObjectsV2，自动翻页。
 *
 * 不用 HEAD 猜路径 —— 那只能证明"这个 key 不存在"，
 * 不能证明"桶里没有数据"（这个错误我之前犯过）。
 */
async function listAll(prefix = '') {
  const out = [];
  let token = null;
  for (;;) {
    const d = new Date();
    const amzDate = d.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const scope = `${dateStamp}/auto/s3/aws4_request`;

    const params = ['list-type=2', 'max-keys=1000'];
    if (prefix) params.push(`prefix=${encodeURIComponent(prefix)}`);
    if (token) params.push(`continuation-token=${encodeURIComponent(token)}`);
    const query = params.join('&');

    const payloadHash = sha('');
    const ch = `host:${HOST}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
    const sh = 'host;x-amz-content-sha256;x-amz-date';
    const cr = ['GET', `/${BUCKET}`, query, ch, sh, payloadHash].join('\n');
    const sts = ['AWS4-HMAC-SHA256', amzDate, scope, sha(cr)].join('\n');
    const k = hmac(hmac(hmac(hmac(`AWS4${SK}`, dateStamp), 'auto'), 's3'), 'aws4_request');
    const sig = crypto.createHmac('sha256', k).update(sts).digest('hex');

    const res = await fetch(`https://${HOST}/${BUCKET}?${query}`, {
      headers: {
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': amzDate,
        Authorization: `AWS4-HMAC-SHA256 Credential=${AK}/${scope}, SignedHeaders=${sh}, Signature=${sig}`,
      },
    });
    if (!res.ok) throw new Error(`LIST HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);

    const body = await res.text();
    const keys = [...body.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
    const sizes = [...body.matchAll(/<Size>(\d+)<\/Size>/g)].map((m) => Number(m[1]));
    keys.forEach((key, i) => out.push({ key, size: sizes[i] || 0 }));

    const next = body.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);
    if (!next) break;
    token = next[1];
  }
  return out;
}

const objs = await listAll();
console.log(`TOTAL ${objs.length} objects, ${(objs.reduce((a, o) => a + o.size, 0) / 1048576).toFixed(1)} MB`);

// 按目录聚合，输出紧凑
const dirs = new Map();
for (const o of objs) {
  const parts = o.key.split('/');
  const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '(root)';
  const e = dirs.get(dir) || { n: 0, bytes: 0 };
  e.n += 1;
  e.bytes += o.size;
  dirs.set(dir, e);
}
for (const [dir, e] of dirs) {
  console.log(`DIR ${dir}  ${e.n} 个  ${(e.bytes / 1048576).toFixed(1)} MB`);
}

// 输出 JSON 供后续步骤使用
console.log('---JSON---');
console.log(JSON.stringify(objs));
