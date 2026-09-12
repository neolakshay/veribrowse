const http = require('http');
const fs = require('fs');
const path = require('path');
const { runAgent } = require('./index');

let activeTask = null;
let eventClients = [];
let pendingAskUserResolve = null;

function broadcast(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  eventClients.forEach(client => client.write(data));
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    eventClients.push(res);
    req.on('close', () => {
      eventClients = eventClients.filter(c => c !== res);
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/task') {
    if (activeTask) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Task already running' }));
    }

    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', async () => {
      try {
        const { task } = JSON.parse(body);
        if (!task) throw new Error('Task required');

        activeTask = task;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'started' }));

        try {
          await runAgent(task, {
            onEvent: (event) => broadcast(event),
            askUser: (question) => {
              return new Promise(resolve => {
                pendingAskUserResolve = resolve;
              });
            }
          });
        } catch (e) {
          broadcast({ type: 'error', message: 'Fatal error: ' + e.message });
        } finally {
          activeTask = null;
          pendingAskUserResolve = null;
          broadcast({ type: 'task_completed_internal' });
        }
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/continue') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      const { answer = 'done' } = JSON.parse(body || '{}');
      if (pendingAskUserResolve) {
        pendingAskUserResolve(answer);
        pendingAskUserResolve = null;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'resumed' }));
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No pending intervention' }));
      }
    });
    return;
  }

  // Serve static files
  let filePath = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url);
  const ext = path.extname(filePath);
  const mimeTypes = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript'
  };

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404);
      return res.end('Not Found');
    }
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'text/plain' });
    fs.createReadStream(filePath).pipe(res);
  });
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`UI Server running at http://localhost:${PORT}`);
});
