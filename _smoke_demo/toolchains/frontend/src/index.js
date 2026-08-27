// 声明 Node 18，但下面用了旧版废弃 API——契约对不上，需重写
import { createCipher } from 'crypto';
import { parse } from 'url';

export function legacy(name) {
  const buf = new Buffer(name); // 废弃(6) → Buffer.from
  const u = parse('https://a.b'); // 废弃(11) → new URL
  const c = crypto.createCipher('aes-256-gcm', 'k'); // 废弃(10) → createCipheriv
  return { buf, u, c };
}
