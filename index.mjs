import { createServer } from 'node:http';

createServer(function (req, res) {
  res.end('OK');
}).listen(process.env.PORT);
