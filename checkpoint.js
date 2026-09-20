const fs = require('fs');
const path = require('path');

const CHECKPOINTS_DIR = path.join(__dirname, 'checkpoints');

function ensureDir() {
  if (!fs.existsSync(CHECKPOINTS_DIR)) {
    fs.mkdirSync(CHECKPOINTS_DIR, { recursive: true });
  }
}

function sanitizeData(data) {
  if (!data) return data;
  const str = JSON.stringify(data);
  // Redact potential secret keys / passwords
  const redactedStr = str.replace(/"(password|pass|secret|otp|token|auth)":\s*"[^"]*"/gi, '"$1":"[REDACTED]"');
  return JSON.parse(redactedStr);
}

function saveCheckpoint(data) {
  ensureDir();
  const runId = data.runId || `run-${Date.now()}`;
  const now = new Date().toISOString();
  
  const checkpoint = sanitizeData({
    runId,
    createdAt: data.createdAt || now,
    updatedAt: now,
    task: data.task || '',
    status: data.status || 'active',
    currentStep: data.currentStep || 0,
    totalSteps: data.totalSteps || 12,
    goal: data.goal || data.task || '',
    understanding: data.understanding || {},
    plan: data.plan || [],
    completedSteps: data.completedSteps || [],
    verifiedSteps: data.verifiedSteps || [],
    failedSteps: data.failedSteps || [],
    currentAction: data.currentAction || null,
    lastVerifiedState: data.lastVerifiedState || null,
    browserContext: data.browserContext || { domain: '', pageDescription: '' },
    sources: data.sources || [],
    error: data.error || null
  });

  const filePath = path.join(CHECKPOINTS_DIR, `${runId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(checkpoint, null, 2), 'utf8');
  return checkpoint;
}

function getCheckpoint(runId) {
  ensureDir();
  if (!runId) {
    // Return latest if not specified
    const files = fs.readdirSync(CHECKPOINTS_DIR).filter(f => f.endsWith('.json'));
    if (files.length === 0) return null;
    const sorted = files.map(f => {
      const p = path.join(CHECKPOINTS_DIR, f);
      const stat = fs.statSync(p);
      return { file: p, mtime: stat.mtimeMs };
    }).sort((a, b) => b.mtime - a.mtime);
    return JSON.parse(fs.readFileSync(sorted[0].file, 'utf8'));
  }

  const filePath = path.join(CHECKPOINTS_DIR, `${runId}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return null;
  }
}

function getLatestCheckpoint() {
  return getCheckpoint(null);
}

module.exports = {
  saveCheckpoint,
  getCheckpoint,
  getLatestCheckpoint,
  CHECKPOINTS_DIR
};
