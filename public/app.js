const taskInput = document.getElementById('taskInput');
const runBtn = document.getElementById('runBtn');
const stopTaskBtn = document.getElementById('stopTaskBtn');
const demoBtn = document.getElementById('demoBtn');

const currentStepIndicator = document.getElementById('currentStepIndicator');
const stepUnderstand = document.getElementById('step-understand');
const stepPlan = document.getElementById('step-plan');
const stepAct = document.getElementById('step-act');
const stepVerify = document.getElementById('step-verify');
const stepComplete = document.getElementById('step-complete');

const activitySection = document.getElementById('activitySection');
const toggleDevDetailsBtn = document.getElementById('toggleDevDetailsBtn');
const pulseIndicator = document.getElementById('pulseIndicator');
const timerBadge = document.getElementById('timerBadge');
const statusBadge = document.getElementById('statusBadge');
const emptyFeed = document.getElementById('emptyFeed');
const logArea = document.getElementById('logArea');

const interventionSection = document.getElementById('interventionSection');
const interventionReason = document.getElementById('interventionReason');
const continueBtn = document.getElementById('continueBtn');
const stopBtn = document.getElementById('stopBtn');

const resultSection = document.getElementById('resultSection');
const resultText = document.getElementById('resultText');

let eventSource = null;
let timerInterval = null;
let startTime = null;
let showDevDetails = false;

// Preset Demo Task Prompt
const DEMO_TASK_TEXT = "Find everything I need for my hackathon submission and open the submission page.";

demoBtn.addEventListener('click', () => {
  taskInput.value = DEMO_TASK_TEXT;
  taskInput.focus();
});

// Dev Details Toggle Handler
toggleDevDetailsBtn.addEventListener('click', () => {
  showDevDetails = !showDevDetails;
  activitySection.classList.toggle('show-dev-details', showDevDetails);
  toggleDevDetailsBtn.classList.toggle('active', showDevDetails);
  const label = toggleDevDetailsBtn.querySelector('span');
  if (label) {
    label.textContent = showDevDetails ? 'Hide technical details' : 'Show technical details';
  }
});

// Timer formatting helper
function startTimer() {
  stopTimer();
  startTime = Date.now();
  timerBadge.textContent = '00:00';
  timerInterval = setInterval(() => {
    const elapsedMs = Date.now() - startTime;
    const totalSecs = Math.floor(elapsedMs / 1000);
    const mins = String(Math.floor(totalSecs / 60)).padStart(2, '0');
    const secs = String(totalSecs % 60).padStart(2, '0');
    timerBadge.textContent = `${mins}:${secs}`;
  }, 1000);
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

// Status badge helper
function setStatus(text, type = 'ready') {
  statusBadge.textContent = text;
  statusBadge.className = `status-badge ${type}`;
  if (type === 'active') {
    pulseIndicator.className = 'pulse-indicator active';
  } else {
    pulseIndicator.className = 'pulse-indicator';
  }
}

// Pipeline stage controller
function updatePipeline(activeStage, completedStages = [], failedStages = []) {
  const steps = [
    { id: 'understand', el: stepUnderstand },
    { id: 'plan', el: stepPlan },
    { id: 'act', el: stepAct },
    { id: 'verify', el: stepVerify },
    { id: 'complete', el: stepComplete }
  ];

  steps.forEach(step => {
    step.el.classList.remove('active', 'completed', 'failed');
    if (completedStages.includes(step.id)) {
      step.el.classList.add('completed');
    } else if (failedStages.includes(step.id)) {
      step.el.classList.add('failed');
    } else if (step.id === activeStage) {
      step.el.classList.add('active');
    }
  });

  if (activeStage) {
    currentStepIndicator.textContent = activeStage.toUpperCase();
  }
}

// Timeline Card Creator with Human-Readable Focus & Collapsible Technical Details
function addTimelineCard({ tag, tagClass = 'step', iconSvg, title, details, rawEventObj, customCardHtml }) {
  emptyFeed.style.display = 'none';
  logArea.style.display = 'flex';

  const item = document.createElement('div');
  item.className = 'timeline-item';
  const timeStr = new Date().toLocaleTimeString([], { hour12: false });

  if (customCardHtml) {
    item.innerHTML = customCardHtml;
  } else {
    item.innerHTML = `
      <div class="timeline-icon-box ${tagClass}">
        ${iconSvg || defaultIcon(tagClass)}
      </div>
      <div class="timeline-content">
        <div class="timeline-meta">
          <span class="timeline-tag ${tagClass}">${escapeHtml(tag)}</span>
          <span class="timeline-time">${timeStr}</span>
        </div>
        <div class="timeline-title">${escapeHtml(title)}</div>
        ${details ? `<div class="timeline-details">${escapeHtml(details)}</div>` : ''}
        ${rawEventObj ? `
          <div class="dev-details-panel">
            <div class="dev-details-label">Developer Event Payload</div>
            <pre class="dev-details-code">${escapeHtml(JSON.stringify(rawEventObj, null, 2))}</pre>
          </div>
        ` : ''}
      </div>
    `;
  }

  logArea.appendChild(item);
  logArea.scrollTop = logArea.scrollHeight;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function defaultIcon(type) {
  switch (type) {
    case 'planning':
      return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>`;
    case 'action':
      return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`;
    case 'executing':
      return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`;
    case 'verifying':
      return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`;
    case 'verified-success':
      return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`;
    case 'verified-failure':
    case 'error':
      return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`;
    default:
      return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`;
  }
}

function resetUI() {
  logArea.innerHTML = '';
  emptyFeed.style.display = 'block';
  logArea.style.display = 'none';
  interventionSection.style.display = 'none';
  resultSection.style.display = 'none';
  
  updatePipeline('understand', []);
  setStatus('STARTING...', 'active');
  
  runBtn.style.display = 'none';
  stopTaskBtn.style.display = 'inline-flex';
  startTimer();
}

function restoreIdleButtons() {
  runBtn.style.display = 'inline-flex';
  runBtn.disabled = false;
  runBtn.querySelector('span').textContent = 'Run Agent';
  stopTaskBtn.style.display = 'none';
  stopTimer();
}

// Event Source Listener Initialization
function initEventSource() {
  if (!eventSource) {
    eventSource = new EventSource('/api/events');
    eventSource.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        handleEvent(data);
      } catch (err) {
        console.error('Failed to parse event data', err);
      }
    };
  }
}

// Run Agent Button Handler
runBtn.addEventListener('click', async () => {
  const task = taskInput.value.trim();
  if (!task) return;

  resetUI();
  initEventSource();

  try {
    const res = await fetch('/api/task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task })
    });
    const data = await res.json();
    if (data.error) {
      addTimelineCard({
        tag: 'NOTICE',
        tagClass: 'error',
        title: 'Task could not start',
        details: 'Another task is currently running or request was invalid.',
        rawEventObj: data
      });
      setStatus('ERROR', 'error');
      restoreIdleButtons();
    }
  } catch (err) {
    addTimelineCard({
      tag: 'NOTICE',
      tagClass: 'error',
      title: 'Connection interrupted',
      details: 'Unable to reach VeriBrowse server. Please try again.',
      rawEventObj: { error: err.message }
    });
    setStatus('ERROR', 'error');
    restoreIdleButtons();
  }
});

// Stop Agent Button Handler (Stop Task execution)
async function requestStopTask() {
  try {
    await fetch('/api/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    console.error('Stop request failed', err);
  }
  
  interventionSection.style.display = 'none';
  setStatus('STOPPED', 'error');
  addTimelineCard({
    tag: 'STOPPED',
    tagClass: 'error',
    title: 'Task stopped',
    details: 'Task execution was stopped by user request.',
    rawEventObj: { action: 'user_stopped' }
  });
  restoreIdleButtons();
}

stopTaskBtn.addEventListener('click', requestStopTask);

async function sendContinue(answer) {
  interventionSection.style.display = 'none';
  if (answer === 'quit') {
    return requestStopTask();
  }

  addTimelineCard({
    tag: 'USER CHOICE',
    tagClass: 'step',
    title: 'Continuing task',
    details: 'User confirmed action in browser. Resuming agent...'
  });
  setStatus('RESUMING...', 'active');
  
  await fetch('/api/continue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answer })
  });
}

continueBtn.addEventListener('click', () => sendContinue('done'));
stopBtn.addEventListener('click', () => sendContinue('quit'));

// User-Facing Event Translator Helper
function translateActionToUserLanguage(actObj = {}) {
  const actName = (actObj.action || '').toLowerCase();
  let title = 'Searching for the requested information';
  let details = 'Browsing site content...';

  if (actName === 'click') {
    title = 'Looking for the right page';
    details = actObj.target || actObj.text ? `Selecting page link or button` : 'Clicking relevant element';
  } else if (actName === 'navigate' || actName === 'goto') {
    title = 'Opening the relevant page';
    let domainStr = '';
    if (actObj.href || actObj.target) {
      try {
        const url = new URL(actObj.href || actObj.target);
        domainStr = ` on ${url.hostname}`;
      } catch (e) {
        domainStr = '';
      }
    }
    details = `Opening site content${domainStr}`;
  } else if (actName === 'type' || actName === 'fill') {
    title = 'Searching website';
    details = 'Entering search query into form field';
  } else if (actName === 'scroll') {
    title = 'Browsing page';
    details = 'Scrolling down to check more page options';
  } else if (actName === 'wait') {
    title = 'Waiting for the website';
    details = 'Waiting for website page to complete loading...';
  }

  return { title, details };
}

// SSE Event Dispatcher with Plain User Language
function handleEvent(event) {
  const timeStr = new Date().toLocaleTimeString([], { hour12: false });

  switch (event.type) {
    case 'task_started':
      updatePipeline('understand', []);
      setStatus('UNDERSTANDING', 'active');
      addTimelineCard({
        tag: 'STARTING',
        tagClass: 'step',
        title: 'Starting your request',
        details: `Goal: "${event.task}"`,
        rawEventObj: event
      });
      break;

    case 'workspace_retrieved':
      {
        const el = document.getElementById('retrievedSourcesCount');
        if (el) el.textContent = `${event.count} Sources (${(event.sources || []).map(s => s.split('/').pop()).join(', ')})`;
      }
      addTimelineCard({
        tag: 'SOURCES',
        tagClass: 'step',
        title: 'Searched local workspace knowledge',
        details: `Retrieved ${event.count} sources: ${(event.sources || []).join(', ')}`,
        rawEventObj: event
      });
      break;

    case 'understanding':
      updatePipeline('understand', []);
      setStatus('UNDERSTANDING', 'active');
      {
        const u = event.understanding || {};
        const reqs = (u.requirements || []).map(r => `<li>${escapeHtml(r)}</li>`).join('');
        const deadlines = (u.deadlines || []).map(d => `<span class="deadline-chip">⏰ ${escapeHtml(d)}</span>`).join(' ');
        const sources = (u.sources || []).map(s => `<span class="source-chip">📄 ${escapeHtml(s)}</span>`).join(' ');
        
        const cardHtml = `
          <div class="timeline-icon-box planning">
            ${defaultIcon('planning')}
          </div>
          <div class="timeline-content">
            <div class="timeline-meta">
              <span class="timeline-tag planning">UNDERSTANDING</span>
              <span class="timeline-time">${timeStr}</span>
            </div>
            <div class="timeline-title">Goal & Workspace Intelligence</div>
            <div class="understanding-box" style="margin-top: 0.5rem; background: rgba(99, 102, 241, 0.08); border: 1px solid rgba(99, 102, 241, 0.2); border-radius: 8px; padding: 0.85rem;">
              <div style="font-weight: 600; color: #a5b4fc; margin-bottom: 0.3rem;">Intent: ${escapeHtml(u.intent || '')}</div>
              ${deadlines ? `<div style="margin-bottom: 0.5rem;">${deadlines}</div>` : ''}
              ${reqs ? `<div style="font-size: 0.85rem; color: #cbd5e1; margin-bottom: 0.4rem;"><strong>Requirements:</strong><ul style="padding-left: 1.2rem; margin-top: 0.2rem;">${reqs}</ul></div>` : ''}
              ${sources ? `<div style="font-size: 0.775rem; color: #94a3b8; margin-top: 0.4rem;"><strong>Sources:</strong> ${sources}</div>` : ''}
            </div>
            <div class="dev-details-panel">
              <div class="dev-details-label">Developer Event Payload</div>
              <pre class="dev-details-code">${escapeHtml(JSON.stringify(event, null, 2))}</pre>
            </div>
          </div>
        `;
        addTimelineCard({ customCardHtml: cardHtml });
      }
      break;

    case 'plan_generated':
      updatePipeline('plan', ['understand']);
      setStatus('PLAN GENERATED', 'active');
      {
        const steps = (event.plan || []).map(s => `<li>${escapeHtml(s)}</li>`).join('');
        const cardHtml = `
          <div class="timeline-icon-box action">
            ${defaultIcon('planning')}
          </div>
          <div class="timeline-content">
            <div class="timeline-meta">
              <span class="timeline-tag action">PLAN</span>
              <span class="timeline-time">${timeStr}</span>
            </div>
            <div class="timeline-title">Actionable Plan Generated</div>
            <div style="margin-top: 0.5rem; background: rgba(59, 130, 246, 0.08); border: 1px solid rgba(59, 130, 246, 0.2); border-radius: 8px; padding: 0.85rem;">
              <ol style="padding-left: 1.2rem; font-size: 0.875rem; color: #93c5fd; line-height: 1.6;">
                ${steps}
              </ol>
            </div>
            <div class="dev-details-panel">
              <div class="dev-details-label">Developer Event Payload</div>
              <pre class="dev-details-code">${escapeHtml(JSON.stringify(event, null, 2))}</pre>
            </div>
          </div>
        `;
        addTimelineCard({ customCardHtml: cardHtml });
      }
      break;

    case 'domain_constraint':
      addTimelineCard({
        tag: 'SAFETY',
        tagClass: 'step',
        title: 'Restricting search scope',
        details: `Restricting navigation scope to domain: ${event.domain}`,
        rawEventObj: event
      });
      break;

    case 'step':
      updatePipeline('plan', ['understand']);
      addTimelineCard({
        tag: `STEP ${event.step}`,
        tagClass: 'step',
        title: 'Working through request',
        details: `Working through step ${event.step} of ${event.total}`,
        rawEventObj: event
      });
      break;

    case 'planning':
      updatePipeline('plan', ['understand']);
      setStatus('PLANNING', 'active');
      addTimelineCard({
        tag: 'PLANNING',
        tagClass: 'planning',
        title: 'Understanding your request',
        details: 'Analyzing current web page and deciding next action...',
        rawEventObj: event
      });
      break;

    case 'action':
      updatePipeline('act', ['understand', 'plan']);
      setStatus('EXECUTING', 'active');
      {
        const userLang = translateActionToUserLanguage(event.action || {});
        addTimelineCard({
          tag: 'ACTION',
          tagClass: 'action',
          title: userLang.title,
          details: userLang.details,
          rawEventObj: event
        });
      }
      break;

    case 'executing':
      updatePipeline('act', ['understand', 'plan']);
      setStatus('EXECUTING', 'active');
      addTimelineCard({
        tag: 'EXECUTING',
        tagClass: 'executing',
        title: 'Browsing the site',
        details: 'Waiting for website to load...',
        rawEventObj: event
      });
      break;

    case 'action_failed':
      addTimelineCard({
        tag: 'RETRYING',
        tagClass: 'error',
        title: "That path didn't work, so I'm trying another one",
        details: 'Reassessing current page and trying another route.',
        rawEventObj: event
      });
      break;

    case 'verifying':
      updatePipeline('verify', ['understand', 'plan', 'act']);
      setStatus('VERIFYING', 'active');
      addTimelineCard({
        tag: 'VERIFYING',
        tagClass: 'verifying',
        title: 'Checking that the result matches your request',
        details: 'Evaluating page state against success criteria...',
        rawEventObj: event
      });
      break;

    case 'verified':
      if (event.success) {
        updatePipeline('verify', ['understand', 'plan', 'act', 'verify']);
        const cardHtml = `
          <div class="timeline-icon-box verified-success">
            ${defaultIcon('verified-success')}
          </div>
          <div class="timeline-content">
            <div class="verification-card success">
              <div class="verification-header">
                <span class="verification-badge">✓ VERIFIED</span>
                <span class="timeline-time">${timeStr}</span>
              </div>
              <div class="verification-reason">${escapeHtml(event.reason || 'Task goal verified.')}</div>
            </div>
            <div class="dev-details-panel">
              <div class="dev-details-label">Developer Event Payload</div>
              <pre class="dev-details-code">${escapeHtml(JSON.stringify(event, null, 2))}</pre>
            </div>
          </div>
        `;
        addTimelineCard({ customCardHtml: cardHtml });
      } else {
        updatePipeline('plan', ['understand'], ['verify']);
        const cardHtml = `
          <div class="timeline-icon-box verified-failure">
            ${defaultIcon('verified-failure')}
          </div>
          <div class="timeline-content">
            <div class="verification-card failure">
              <div class="verification-header">
                <span class="verification-badge">✗ NOT VERIFIED</span>
                <span class="timeline-time">${timeStr}</span>
              </div>
              <div class="verification-reason">${escapeHtml(event.reason || "Result wasn't sufficient.")}</div>
              <div class="verification-subtext">That result wasn't sufficient. Reassessing...</div>
            </div>
            <div class="dev-details-panel">
              <div class="dev-details-label">Developer Event Payload</div>
              <pre class="dev-details-code">${escapeHtml(JSON.stringify(event, null, 2))}</pre>
            </div>
          </div>
        `;
        addTimelineCard({ customCardHtml: cardHtml });
      }
      break;

    case 'human_intervention':
      updatePipeline('act', ['understand', 'plan']);
      setStatus('INTERVENTION', 'warning');
      {
        let reasonMsg = 'VeriBrowse requires your confirmation before proceeding with sensitive actions or inputs.';
        interventionReason.textContent = reasonMsg;
        interventionSection.style.display = 'block';

        addTimelineCard({
          tag: 'HELP NEEDED',
          tagClass: 'warning',
          title: 'I need your help to continue',
          details: reasonMsg,
          rawEventObj: event
        });
      }
      break;

    case 'verifying_completion':
      updatePipeline('verify', ['understand', 'plan', 'act']);
      setStatus('VERIFYING COMPLETION', 'active');
      addTimelineCard({
        tag: 'VERIFYING',
        tagClass: 'verifying',
        title: 'Checking final result',
        details: 'Checking if final result matches your request...',
        rawEventObj: event
      });
      break;

    case 'completion_rejected':
      updatePipeline('plan', ['understand', 'act'], ['verify']);
      addTimelineCard({
        tag: 'CONTINUING',
        tagClass: 'error',
        title: 'Result not complete yet',
        details: 'Continuing browsing to find complete result...',
        rawEventObj: event
      });
      break;

    case 'success':
      updatePipeline('complete', ['understand', 'plan', 'act', 'verify', 'complete']);
      setStatus('VERIFIED', 'success');
      resultText.textContent = event.result || 'Task verified successfully.';
      resultSection.style.display = 'block';
      restoreIdleButtons();

      addTimelineCard({
        tag: 'SUCCESS',
        tagClass: 'verified-success',
        title: 'Task verified successfully',
        details: event.result,
        rawEventObj: event
      });
      break;

    case 'terminated':
      setStatus('TERMINATED', 'error');
      restoreIdleButtons();
      addTimelineCard({
        tag: 'STOPPED',
        tagClass: 'error',
        title: 'Task stopped',
        details: event.result || 'Task execution stopped by user.',
        rawEventObj: event
      });
      break;

    case 'error':
      setStatus('ERROR', 'error');
      restoreIdleButtons();
      addTimelineCard({
        tag: 'STOPPED',
        tagClass: 'error',
        title: 'Encountered an issue',
        details: 'VeriBrowse encountered a site loading issue and stopped safely.',
        rawEventObj: event
      });
      break;

    case 'task_completed_internal':
      restoreIdleButtons();
      break;
  }
}
