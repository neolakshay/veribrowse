const taskInput = document.getElementById('taskInput');
const runBtn = document.getElementById('runBtn');
const statusSection = document.getElementById('statusSection');
const currentStatusLabel = document.getElementById('currentStatusLabel');
const logArea = document.getElementById('logArea');
const interventionSection = document.getElementById('interventionSection');
const interventionReason = document.getElementById('interventionReason');
const continueBtn = document.getElementById('continueBtn');
const stopBtn = document.getElementById('stopBtn');
const resultSection = document.getElementById('resultSection');
const resultText = document.getElementById('resultText');

let eventSource = null;

function appendLog(text, className = '') {
  const div = document.createElement('div');
  div.className = `log-item ${className}`;
  const time = new Date().toLocaleTimeString([], { hour12: false });
  div.innerHTML = `<span class="log-time">[${time}]</span> ${text}`;
  logArea.appendChild(div);
  logArea.scrollTop = logArea.scrollHeight;
}

function setBadge(text, type = 'active') {
  currentStatusLabel.textContent = text;
  currentStatusLabel.className = `status-badge ${type}`;
}

function resetUI() {
  logArea.innerHTML = '';
  statusSection.style.display = 'block';
  interventionSection.style.display = 'none';
  resultSection.style.display = 'none';
  setBadge('Starting...', 'active');
  runBtn.disabled = true;
}

runBtn.addEventListener('click', async () => {
  const task = taskInput.value.trim();
  if (!task) return;

  resetUI();

  if (!eventSource) {
    eventSource = new EventSource('/api/events');
    eventSource.onmessage = (e) => handleEvent(JSON.parse(e.data));
  }

  try {
    const res = await fetch('/api/task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task })
    });
    const data = await res.json();
    if (data.error) {
      appendLog(`Error: ${data.error}`, 'log-error');
      setBadge('Error', 'error');
      runBtn.disabled = false;
    }
  } catch (err) {
    appendLog(`Network error: ${err.message}`, 'log-error');
    runBtn.disabled = false;
  }
});

async function sendContinue(answer) {
  interventionSection.style.display = 'none';
  appendLog(`User selected: ${answer}`);
  setBadge('Resuming...', 'active');
  
  await fetch('/api/continue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answer })
  });
}

continueBtn.addEventListener('click', () => sendContinue('done'));
stopBtn.addEventListener('click', () => sendContinue('quit'));

function handleEvent(event) {
  switch (event.type) {
    case 'task_started':
      appendLog(`Task started: ${event.task}`);
      break;
    case 'domain_constraint':
      appendLog(`Target constraint enforced: ${event.domain}`);
      break;
    case 'step':
      appendLog(`--- Step ${event.step}/${event.total} ---`);
      break;
    case 'planning':
      setBadge('PLANNING', 'active');
      appendLog('Agent is planning next step...', 'log-planning');
      break;
    case 'action':
      appendLog(`Selected Action: ${event.action.action} on ${event.action.target || event.action.href || ''}`, 'log-planning');
      break;
    case 'executing':
      setBadge('EXECUTING', 'warning');
      appendLog('Executing action in browser...', 'log-executing');
      break;
    case 'action_failed':
      appendLog(`Execution failed: ${event.error}`, 'log-error');
      break;
    case 'verifying':
      setBadge('VERIFYING', 'active');
      appendLog('Verifying action result...', 'log-verifying');
      break;
    case 'verified':
      if (event.success) {
        appendLog(`✓ Verification Successful: ${event.reason}`, 'log-verified');
      } else {
        appendLog(`✗ Verification Failed: ${event.reason}`, 'log-error');
      }
      break;
    case 'human_intervention':
      setBadge('HUMAN INTERVENTION', 'warning');
      interventionReason.textContent = event.message || event.reason;
      if (event.field) interventionReason.textContent += ` (Field: ${event.field})`;
      if (event.action) interventionReason.textContent += ` (Action: ${event.action})`;
      interventionSection.style.display = 'block';
      break;
    case 'verifying_completion':
      setBadge('VERIFYING COMPLETION', 'active');
      appendLog('Verifying final task completion...');
      break;
    case 'completion_rejected':
      appendLog(`Completion rejected: ${event.reason}`, 'log-error');
      break;
    case 'success':
      setBadge('VERIFIED', 'success');
      appendLog('Task completed successfully!', 'log-verified');
      resultText.textContent = event.result;
      resultSection.style.display = 'block';
      break;
    case 'terminated':
      setBadge('TERMINATED', 'error');
      appendLog(`Task terminated: ${event.result}`, 'log-error');
      break;
    case 'error':
      setBadge('ERROR', 'error');
      appendLog(`Error: ${event.message}`, 'log-error');
      break;
    case 'task_completed_internal':
      runBtn.disabled = false;
      break;
  }
}
