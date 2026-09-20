const http = require('http');
const fs = require('fs');
const path = require('path');
const { runAgent, getSnapshot } = require('./index');
const { getCheckpoint, getLatestCheckpoint, saveCheckpoint } = require('./checkpoint');

let activeTask = null;
let currentRunId = null;
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

        currentRunId = `run-${Date.now()}`;
        activeTask = task;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'started', runId: currentRunId }));

        try {
          await runAgent(task, {
            runId: currentRunId,
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
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/checkpoint/check') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const cp = getCheckpoint(payload.runId) || getLatestCheckpoint();
        
        if (!cp) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'No checkpoint found' }));
        }

        broadcast({ type: 'checkpoint_checking', runId: cp.runId });
        
        let liveSnapshot = null;
        try {
          liveSnapshot = await getSnapshot();
        } catch (err) {
          console.error('Failed to get live snapshot for check:', err.message);
        }

        const currentUrl = liveSnapshot?.page?.url || '';
        const currentTitle = liveSnapshot?.page?.title || '';
        const expectedUrl = cp.lastVerifiedState?.url || '';
        const expectedDomain = cp.browserContext?.domain || '';

        const urlMatches = expectedUrl && currentUrl && (currentUrl.split('?')[0] === expectedUrl.split('?')[0]);
        const domainMatches = expectedDomain && currentUrl.toLowerCase().includes(expectedDomain.toLowerCase());
        const safeToResume = Boolean(liveSnapshot && (urlMatches || domainMatches || currentUrl !== 'about:blank'));
        const currentStateMatches = Boolean(urlMatches);

        let reason = '';
        if (currentStateMatches) {
          reason = `Browser is currently on the expected page (${currentTitle || currentUrl}). verified state matches.`;
          broadcast({ type: 'checkpoint_validated', runId: cp.runId, safeToResume: true, currentStateMatches: true, reason });
        } else if (safeToResume) {
          reason = `Browser is on '${currentTitle || currentUrl}' (differs from expected '${expectedUrl}'). Agent will re-plan safely from current state.`;
          broadcast({ type: 'checkpoint_stale', runId: cp.runId, safeToResume: true, currentStateMatches: false, reason });
        } else {
          reason = 'Browser is currently blank or unreachable. Starting fresh or re-navigation is required.';
          broadcast({ type: 'checkpoint_stale', runId: cp.runId, safeToResume: false, currentStateMatches: false, reason });
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          safeToResume,
          currentStateMatches,
          reason,
          currentUrl,
          expectedUrl,
          verifiedStepsCount: (cp.verifiedSteps || []).length
        }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/checkpoint/resume') {
    if (activeTask) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Task already running' }));
    }

    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const cp = getCheckpoint(payload.runId) || getLatestCheckpoint();

        if (!cp) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'No checkpoint found to resume' }));
        }

        currentRunId = cp.runId;
        activeTask = cp.task;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'resuming', runId: currentRunId }));

        broadcast({ type: 'checkpoint_resuming', runId: currentRunId, step: cp.currentStep });

        try {
          await runAgent(cp.task, {
            runId: currentRunId,
            resumeCheckpoint: cp,
            onEvent: (event) => broadcast(event),
            askUser: (question) => {
              return new Promise(resolve => {
                pendingAskUserResolve = resolve;
              });
            }
          });
        } catch (e) {
          broadcast({ type: 'error', message: 'Fatal error during resume: ' + e.message });
        } finally {
          activeTask = null;
          pendingAskUserResolve = null;
          broadcast({ type: 'task_completed_internal' });
        }
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
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

  if (req.method === 'POST' && req.url === '/api/stop') {
    if (pendingAskUserResolve) {
      pendingAskUserResolve('quit');
      pendingAskUserResolve = null;
    }
    
    if (currentRunId) {
      const cp = getCheckpoint(currentRunId);
      if (cp) {
        cp.status = 'stopped';
        saveCheckpoint(cp);
        broadcast({ type: 'checkpoint_saved', runId: currentRunId, status: 'stopped' });
      }
    }

    broadcast({ type: 'terminated', result: 'Task stopped by user.' });
    activeTask = null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'stopped' }));
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
