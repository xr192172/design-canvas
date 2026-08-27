// 本地 LLM mock：返回固定补丁 JSON，用于 diagnose_loop_cli 完整闭环冒烟
import http from 'node:http';
const port = Number(process.argv[2] || 8899);
const content = JSON.stringify({
  patches: [
    {
      file: 'src/service.js',
      start_line: 6,
      end_line: 6,
      new_content: '  return row ? row.name : undefined;',
    },
  ],
  rationale: 'row 可能为空，先判空再取 name',
});
http
  .createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  })
  .listen(port, '127.0.0.1', () => console.log(`mock-llm on 127.0.0.1:${port}`));
