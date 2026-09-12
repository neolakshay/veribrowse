require('dotenv').config();
const { OpenAI } = require('openai');
const { exec } = require('child_process');
const readline = require('readline');

const SESSION_ID = process.env.WEBCMD_SESSION || 'veribrowse-3h';
const MAX_LOOPS = 12;
const MAX_RETRIES = 3;
const SNAPSHOT_CHAR_LIMIT = 15000;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ---------------------------------------------------------------------------
// WebCMD CLI helpers
// ---------------------------------------------------------------------------

function runWebCmd(command, stdinData = null) {
  return new Promise((resolve, reject) => {
    const fullCmd = `webcmd --session ${SESSION_ID} browser ${command} --format json`;
    const child = exec(fullCmd, { maxBuffer: 1024 * 1024 * 10, timeout: 30000 }, (error, stdout, stderr) => {
      if (stdout) {
        try {
          resolve(JSON.parse(stdout));
          return;
        } catch (e) {
          // Non-JSON stdout — return raw
          resolve({ raw: stdout, stderr });
          return;
        }
      }
      if (error) {
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });

    if (stdinData) {
      child.stdin.write(stdinData);
      child.stdin.end();
    }
  });
}

// Known infrastructure error codes that should NOT reach the planner
const INFRA_ERRORS = new Set([
  'SESSION_BUSY',
  'SESSION_REQUIRED',
  'session_not_found',
  'browser_not_found',
  'fatal',
]);

async function safeRunWebCmd(command, stdinData = null) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const result = await runWebCmd(command, stdinData).catch(e => ({
      error: { code: 'fatal', message: e.message || String(e) },
    }));

    if (result && result.error) {
      const code = result.error.code || 'unknown';
      const msg = result.error.message || JSON.stringify(result.error);

      // SESSION_BUSY — wait and retry
      if (code === 'SESSION_BUSY') {
        console.warn(`  [Infra] Session busy — retrying (${attempt}/${MAX_RETRIES})…`);
        await sleep(2000);
        continue;
      }

      // Session missing — try to bootstrap
      if (code === 'session_not_found' || code === 'SESSION_REQUIRED') {
        console.warn(`  [Infra] Session missing (${code}). Attempting recovery…`);
        try {
          // Wake up the session without destroying the current page
          await runWebCmd('run --stdin', 'return true;');
          console.log('  [Infra] Session recovered. Retrying…');
          continue;
        } catch (e2) {
          throw new Error(`Session recovery failed: ${e2.message}`);
        }
      }

      // Other known infrastructure errors → unrecoverable
      if (INFRA_ERRORS.has(code)) {
        console.error(`\n  [Infra] Unrecoverable: ${code} — ${msg}`);
        if (result.error.hint) console.error(`  Hint: ${result.error.hint}`);
        throw new Error(`Unrecoverable infrastructure error: ${code}`);
      }

      // Anything else (e.g. Playwright timeout, element not found) → return to caller
      return result;
    }

    return result;
  }
  throw new Error('Persistent infrastructure error after retries');
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------

async function getSnapshot() {
  const data = await safeRunWebCmd('snapshot --snapshot-mode act');
  // Warn about truncation so we know
  if (data?.limits?.snapshotTruncated) {
    console.warn('  Snapshot was truncated by WebCMD');
  }
  return data;
}

// Extract the useful snapshot text (the accessibility tree string)
function snapshotToText(snapshotData) {
  if (!snapshotData) return '(empty snapshot)';
  // WebCMD JSON: { ok, tree, page: { id, url, title }, warnings, limits }
  const parts = [];
  if (snapshotData.page) {
    parts.push(`Page URL: ${snapshotData.page.url}`);
    parts.push(`Page Title: ${snapshotData.page.title}`);
  }
  if (snapshotData.tree) {
    parts.push(`\nAccessibility Tree:\n${snapshotData.tree}`);
  }
  if (snapshotData.limits?.snapshotTruncated) {
    parts.push('\n(Note: Snapshot was truncated — some elements may not be visible.)');
  }
  const full = parts.join('\n');
  // Truncate safely — at a newline boundary if possible
  if (full.length > SNAPSHOT_CHAR_LIMIT) {
    const cutPoint = full.lastIndexOf('\n', SNAPSHOT_CHAR_LIMIT);
    return full.substring(0, cutPoint > 0 ? cutPoint : SNAPSHOT_CHAR_LIMIT) + '\n… (truncated)';
  }
  return full;
}

// ---------------------------------------------------------------------------
// CAPTCHA / human-intervention detection
// ---------------------------------------------------------------------------

function detectBlocker(snapshotData) {
  if (!snapshotData) return null;

  // Build a searchable text from the snapshot
  const searchText = [
    snapshotData.tree || '',
    snapshotData.page?.title || '',
    snapshotData.page?.url || '',
  ].join(' ').toLowerCase();

  // Generic CAPTCHA indicators
  const captchaSignals = [
    'captcha',
    'verify you are human',
    'i am not a robot',
    'i\'m not a robot',
    'are you a robot',
    'human verification',
    'security check',
    'bot detection',
    'recaptcha',
    'hcaptcha',
    'challenge-platform',
    'cloudflare',
    'just a moment',
    'checking your browser',
    'verify you are not a bot',
  ];

  for (const signal of captchaSignals) {
    if (searchText.includes(signal)) {
      return {
        type: 'captcha',
        signal,
        message: `Detected a CAPTCHA or human-verification challenge ("${signal}"). Automated progress is blocked.`,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Action → Playwright script translation (safe, no injection)
// ---------------------------------------------------------------------------

// Escape a string for safe embedding in single-quoted JS string
function escapeJS(str) {
  return String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
}

function actionToPlaywright(action) {
  switch (action.action) {
    case 'navigate': {
      const url = escapeJS(action.url || '');
      return `await page.goto('${url}', { waitUntil: 'domcontentloaded', timeout: 15000 });`;
    }
    case 'click': {
      const target = escapeJS(action.target || '');
      const role = action.role ? escapeJS(action.role) : null;
      const href = action.href ? escapeJS(action.href) : null;
      
      const scriptLines = [
        `async function robustClick(loc) {`,
        `  if (await loc.count() === 0) return false;`,
        `  try { await loc.first().click({ timeout: 3000 }); return true; }`,
        `  catch(e) {`,
        `    try { await loc.first().dispatchEvent('click', { timeout: 2000 }); return true; }`,
        `    catch(e2) { return false; }`,
        `  }`,
        `}`
      ];
      
      if (role && href) {
        const path = href.replace(/^https?:\/\/[^\/]+/, '');
        if (path && path !== '/') {
          scriptLines.push(`let el = page.locator('${role === 'link' ? 'a' : role}[href*="${path}"]');`);
          scriptLines.push(`if (await robustClick(el)) return;`);
        }
      }
      if (role) {
        scriptLines.push(`el = page.getByRole('${role}', { name: '${target}', exact: true });`);
        scriptLines.push(`if (await robustClick(el)) return;`);
        scriptLines.push(`el = page.getByRole('${role}', { name: '${target}' });`);
        scriptLines.push(`if (await robustClick(el)) return;`);
      }
      scriptLines.push(`el = page.getByText('${target}');`);
      scriptLines.push(`if (await robustClick(el)) return;`);
      scriptLines.push(`throw new Error('Element not found or not clickable');`);
      
      return `await (async () => {\n  ${scriptLines.join('\n  ')}\n})();`;
    }
    case 'type': {
      const target = escapeJS(action.target || '');
      const text = escapeJS(action.text || '');
      const role = action.role ? escapeJS(action.role) : null;
      
      const scriptLines = [
        `async function robustFill(loc, text) {`,
        `  if (await loc.count() === 0) return false;`,
        `  try { await loc.first().fill(text, { timeout: 3000 }); return true; }`,
        `  catch(e) {`,
        `    try { await loc.first().dispatchEvent('focus'); await loc.first().fill(text, { force: true, timeout: 2000 }); return true; }`,
        `    catch(e2) { return false; }`,
        `  }`,
        `}`
      ];
      
      if (role) {
        scriptLines.push(`let el = page.getByRole('${role}', { name: '${target}', exact: true });`);
        scriptLines.push(`if (await robustFill(el, '${text}')) return;`);
        scriptLines.push(`el = page.getByRole('${role}', { name: '${target}' });`);
        scriptLines.push(`if (await robustFill(el, '${text}')) return;`);
      }
      scriptLines.push(`el = page.getByPlaceholder('${target}');`);
      scriptLines.push(`if (await robustFill(el, '${text}')) return;`);
      scriptLines.push(`throw new Error('Field not found or not fillable');`);

      return `await (async () => {\n  ${scriptLines.join('\n  ')}\n})();`;
    }
    case 'extract':
      // Use the snapshot read mode instead of raw innerText
      return null; // handled separately
    case 'wait':
      return `await page.waitForTimeout(${Math.min(Number(action.ms) || 2000, 5000)});`;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// LLM: Verifier
// ---------------------------------------------------------------------------

async function verifyAction(task, previousStateText, action, newStateText) {
  const verifierPrompt = `You are VeriBrowse's independent Verification Module.

Your job: judge whether the USER'S ORIGINAL TASK has PROGRESSED or been COMPLETED based on the new browser state.

Rules:
- Do NOT just check if the command ran without error.
- Inspect the new browser state and compare it with the previous state.
- Ask: "Is the user closer to their goal than before?"
- If a CAPTCHA or human-verification challenge appeared, set verified to false and mention it.

Return strict JSON:
{
  "verified": true or false,
  "reason": "one sentence explanation"
}`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: verifierPrompt },
      {
        role: 'user',
        content: `Original Task: ${task}\n\nPrevious State:\n${previousStateText}\n\nAction Attempted: ${JSON.stringify(action)}\n\nNew State:\n${newStateText}\n\nDid this action progress or complete the task?`,
      },
    ],
    response_format: { type: 'json_object' },
  });

  try {
    return JSON.parse(response.choices[0].message.content);
  } catch {
    return { verified: false, reason: 'Failed to parse verifier response.' };
  }
}

// ---------------------------------------------------------------------------
// LLM: Completion Verifier
// ---------------------------------------------------------------------------

async function verifyCompletion(task, currentStateText, plannerResult) {
  const prompt = `You are VeriBrowse's Completion Verification Module.

Your job: judge whether the USER'S ORIGINAL TASK has actually been fully COMPLETED based on the current browser state.

Rules:
- Read the original task.
- Examine the current browser state.
- Does the state provide strong evidence that the task is finished?
- Example: "Find refund policy" is complete when reading the refund policy page. "Find train status" is complete when the actual status is visible on screen, NOT just the search page. "Help me sign up" is NOT complete just by reaching the signup page.
- IMPORTANT: If the user needs to enter private information (passwords, OTP, credit cards, personal info, CAPTCHAs), the task is NOT automatically complete. The agent must use the 'human_needed' action instead of 'finish'.
- If the completion evidence is ambiguous, return complete: false.

Return strict JSON:
{
  "complete": true or false,
  "reason": "one sentence explanation"
}`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: prompt },
      {
        role: 'user',
        content: `Original Task: ${task}\n\nPlanner proposed finish with result: "${plannerResult}"\n\nCurrent Browser State:\n${currentStateText}\n\nIs the original task genuinely complete?`,
      },
    ],
    response_format: { type: 'json_object' },
  });

  try {
    return JSON.parse(response.choices[0].message.content);
  } catch {
    return { complete: false, reason: 'Failed to parse verifier response.' };
  }
}

// ---------------------------------------------------------------------------
// Planner prompt
// ---------------------------------------------------------------------------

const PLANNER_SYSTEM_PROMPT = `You are VeriBrowse, a careful browser automation agent.

You receive the user's task and the current browser accessibility snapshot.
You must return ONE structured JSON action to progress toward the goal.

CRITICAL RULES:
1. Every action MUST be grounded in elements visible in the current snapshot.
2. Do NOT invent URLs. Use "navigate" ONLY if the user explicitly gave a URL AND you are not there yet.
3. Prefer "click" on links/buttons already in the snapshot for navigation.
4. Use "type" to fill input fields, search boxes, or text areas visible in the snapshot.
5. Use "extract" only when you need to read the page content to answer the user's question.
6. Use "wait" if a page is loading or you just submitted a form.
7. If a CAPTCHA, "verify you are human", or similar challenge is visible, return:
   {"action": "human_needed", "reason": "CAPTCHA or verification challenge detected."}
8. If the current page has NO plausible path toward the goal, return:
   {"action": "finish", "result": "I could not find a verified path to complete the task from the current page."}
9. When the task is complete and you can answer the user, return:
   {"action": "finish", "result": "your answer here"}

FAILURE HANDLING:
- ACTION_EXECUTION_FAILURE means the Playwright command crashed (element not found, timeout, etc.). 
  → Try a DIFFERENT selector or approach. Do NOT retry the exact same action.
- VERIFICATION_FAILURE means the action ran but did NOT make progress toward the task.
  → Reassess deeply. If no logical next step exists, return "finish".
- Never repeat a failed action more than once with the same target.

AVAILABLE ACTIONS (return exactly one as JSON):

Click an element (COPY the ref, role, and name EXACTLY from the snapshot):
{"action": "click", "ref": "l3", "target": "exact text from snapshot", "role": "link|button|tab|menuitem", "href": "/path (for links, if shown in snapshot)"}
IMPORTANT: Copy the element text EXACTLY as it appears in the snapshot, including capitalization. Do not paraphrase or reconstruct it. Include href for links when the snapshot shows it.

Type into a field (COPY the ref, role, and name EXACTLY from the snapshot):
{"action": "type", "ref": "l14", "target": "exact text from snapshot", "text": "what to type", "role": "textbox|combobox|searchbox (optional)"}

Navigate (RESTRICTED — only for explicit user-provided URLs):
{"action": "navigate", "url": "https://…"}

Read/extract page content:
{"action": "extract", "what": "description of what to extract"}

Wait for page to load:
{"action": "wait", "ms": 2000}

Request human help (for CAPTCHAs or login walls):
{"action": "human_needed", "reason": "why automation cannot proceed"}

Finish:
{"action": "finish", "result": "final answer or explanation"}

Return ONLY valid JSON. No markdown, no explanation outside the JSON.`;

// ---------------------------------------------------------------------------
// Agent loop
// ---------------------------------------------------------------------------

async function runAgent(task, rl) {
  console.log(`\nStarting task: "${task}"\n`);

  const messages = [{ role: 'system', content: PLANNER_SYSTEM_PROMPT }];
  let currentState, currentStateText;
  let consecutiveFailures = 0;
  const MAX_CONSECUTIVE_FAILURES = 3;
  const failedActions = [];

  // --- Initial snapshot ---
  console.log('Taking initial browser snapshot…');
  try {
    currentState = await getSnapshot();
  } catch (err) {
    console.error('Cannot start: infrastructure error getting initial snapshot.');
    console.error(`   ${err.message}`);
    return;
  }

  // --- Startup navigation if on about:blank ---
  if (currentState?.page?.url === 'about:blank' || currentState?.page?.url === 'chrome://newtab/') {
    const urlMatch = task.match(/https?:\/\/[^\s]+/);
    const startUrl = urlMatch ? urlMatch[0] : 'https://www.google.com';
    console.log(`Initializing empty browser to starting URL: ${startUrl}`);
    try {
      await safeRunWebCmd('run --stdin --timeout 15', `await page.goto('${escapeJS(startUrl)}', { waitUntil: 'domcontentloaded', timeout: 15000 });`);
      currentState = await getSnapshot();
    } catch (err) {
      console.error(`Failed to initialize starting URL: ${err.message}`);
      return;
    }
  }

  // Check for blocker on the very first page
  const initialBlocker = detectBlocker(currentState);
  if (initialBlocker) {
    console.log(`\n${initialBlocker.message}`);
    console.log('The current page has a challenge that requires human intervention.');
    console.log('Please complete the challenge in the browser, then re-run VeriBrowse.');
    return;
  }

  currentStateText = snapshotToText(currentState);
  messages.push({
    role: 'user',
    content: `Task: ${task}\n\nCurrent Browser State:\n${currentStateText}\n\nWhat is your next action?`,
  });

  // --- Main loop ---
  for (let step = 1; step <= MAX_LOOPS; step++) {
    console.log(`\n━━━ Step ${step}/${MAX_LOOPS} ━━━`);

    // 1. Ask planner
    console.log('Asking planner…');
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      response_format: { type: 'json_object' },
    });

    let action;
    try {
      action = JSON.parse(response.choices[0].message.content);
    } catch {
      console.error('Planner returned invalid JSON. Stopping.');
      break;
    }

    console.log(`Action: ${JSON.stringify(action)}`);
    messages.push({ role: 'assistant', content: JSON.stringify(action) });

    // Prevent repeating a failed action on the same page
    if (action.action !== 'finish' && action.action !== 'human_needed' && action.action !== 'extract') {
      const isRepeat = failedActions.some(fa => {
        if (fa.pageUrl !== currentState.page?.url || fa.action.action !== action.action) return false;
        if (action.action === 'type' && fa.action.text !== action.text) return false;
        return (
          (fa.action.ref && fa.action.ref === action.ref) || 
          (fa.action.target && fa.action.target === action.target)
        );
      });

      if (isRepeat) {
        console.log(`⚠️  Planner repeated a failed action. Intercepting.`);
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.log('Too many consecutive failures. Stopping.');
          return;
        }
        messages.push({
          role: 'user',
          content: `You repeated an action that ALREADY FAILED on this page: ${JSON.stringify(action)}.\n\nDo NOT repeat it. Choose a DIFFERENT grounded action, or return:\n{"action": "finish", "result": "I could not find a verified path to complete the task from the current page."}`
        });
        continue;
      }
    }

    // 2. Handle terminal actions
    if (action.action === 'finish') {
      if (action.result?.toLowerCase().includes('could not')) {
        console.log(`\nTask terminated!`);
        console.log(`Result: ${action.result}`);
        return;
      }
      
      console.log('🔎 Verifying task completion…');
      const completion = await verifyCompletion(task, currentStateText, action.result);
      if (completion.complete) {
        console.log(`\n✅ Task completed!`);
        console.log(`Result: ${action.result}`);
        return;
      } else {
        console.log(`❌ COMPLETION REJECTED: ${completion.reason}`);
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.log('Too many consecutive failures without progress. Stopping.');
          return;
        }
        messages.push({
          role: 'user',
          content: `COMPLETION REJECTED.\nYou attempted to finish, but the user's task is not yet complete.\nReason: ${completion.reason}\n\nContinue browsing to complete the task, or return {"action": "human_needed", "reason": "..."} if sensitive user input or human action is required.`
        });
        continue;
      }
    }

    if (action.action === 'human_needed') {
      console.log(`\nHUMAN INTERVENTION REQUIRED`);
      console.log(`   Reason: ${action.reason}`);
      console.log('');

      // Offer to wait for the human to resolve
      const answer = await askUser(rl, 'Complete the challenge in the browser, then type "done" to continue (or "quit" to stop): ');
      if (answer.trim().toLowerCase() === 'quit') {
        console.log('Agent stopped by user.');
        return;
      }
      // Human says done — get fresh snapshot and continue
      console.log('Taking fresh snapshot after human intervention…');
      try {
        currentState = await getSnapshot();
        currentStateText = snapshotToText(currentState);
      } catch (err) {
        console.error(`Infrastructure error after human intervention: ${err.message}`);
        return;
      }

      // Check if blocker is gone
      const stillBlocked = detectBlocker(currentState);
      if (stillBlocked) {
        console.log(`Challenge still detected: ${stillBlocked.message}`);
        console.log('Please try again in the browser.');
        step--; // Don't count this as a step
        continue;
      }

      consecutiveFailures = 0;
      messages.push({
        role: 'user',
        content: `Human completed the challenge. The page has changed.\n\nNew Browser State:\n${currentStateText}\n\nContinue with the task: ${task}\n\nWhat is your next action?`,
      });
      continue;
    }

    // 3. Handle extract action (use read-mode snapshot, no Playwright execution)
    if (action.action === 'extract') {
      console.log('Extracting page content via read-mode snapshot…');
      let readData;
      try {
        readData = await safeRunWebCmd('snapshot --snapshot-mode read');
      } catch (err) {
        console.error(`Infrastructure error: ${err.message}`);
        return;
      }

      const readText = readData?.tree || readData?.raw || JSON.stringify(readData);
      const extractedContent = String(readText).substring(0, 8000);
      console.log(`   Extracted ${extractedContent.length} chars of content`);

      messages.push({
        role: 'user',
        content: `Extraction result (read-mode snapshot):\n${extractedContent}\n\nDoes this contain the answer to the task? If yes, return "finish" with the result. If not, choose the next action.\n\nTask reminder: ${task}`,
      });
      consecutiveFailures = 0;
      continue;
    }

    // 4. Translate action to Playwright
    // 4.5 HARD SAFETY BOUNDARY: Prevent automated input of sensitive/fabricated information
    if (action.action === 'type') {
      const sensitiveKeywords = [
        'email', 'e-mail', 'password', 'passcode', 'username', 'phone', 'mobile',
        'otp', 'verification', 'code', 'captcha', 'address', 'date of birth', 'dob',
        'card', 'credit', 'debit', 'cvv', 'cvc', 'bank', 'account', 'security answer',
        'first name', 'last name', 'full name'
      ];
      const targetStr = (action.target || '').toLowerCase();
      
      const isSensitive = sensitiveKeywords.some(kw => targetStr.includes(kw));
      
      if (isSensitive) {
        console.log(`\n==================================================`);
        console.log(`HUMAN INTERVENTION REQUIRED`);
        console.log(`==================================================\n`);
        console.log(`VeriBrowse reached a sensitive input field.`);
        console.log(`Field requires human interaction: "${action.target}"\n`);
        console.log(`I will not invent or enter personal information.`);
        console.log(`Please enter the required information in the browser.`);
        console.log(`VeriBrowse has paused.\n`);
        return;
      }
    } else if (action.action === 'click') {
      const destructiveKeywords = [
        'purchase', 'pay now', 'checkout', 'submit payment', 'confirm order', 'place order'
      ];
      const targetStr = (action.target || '').toLowerCase();
      
      const isDestructive = destructiveKeywords.some(kw => targetStr.includes(kw));
      
      if (isDestructive) {
        console.log(`\n==================================================`);
        console.log(`HUMAN INTERVENTION REQUIRED`);
        console.log(`==================================================\n`);
        console.log(`VeriBrowse reached a sensitive or irreversible action.`);
        console.log(`Action requires human confirmation: "${action.target}"\n`);
        console.log(`I will not make purchases or irreversible actions automatically.`);
        console.log(`Please complete this step in the browser.`);
        console.log(`VeriBrowse has paused.\n`);
        return;
      }
    }

    const script = actionToPlaywright(action);
    if (!script) {
      console.log('Unknown action type — skipping.');
      messages.push({
        role: 'user',
        content: `Unknown action "${action.action}". Available actions: click, type, navigate, extract, wait, human_needed, finish. Try again.`,
      });
      continue;
    }

    // 5. Execute via WebCMD
    console.log(`Executing: ${script}`);
    let execError = null;
    try {
      const runResult = await safeRunWebCmd('run --stdin --timeout 15', script);
      if (runResult?.error) {
        execError = runResult.error.message || JSON.stringify(runResult.error);
      }
    } catch (err) {
      // Infrastructure failure — stop agent
      console.error(`Infrastructure failure: ${err.message}`);
      return;
    }

    if (execError) {
      consecutiveFailures++;
      console.log(`ACTION EXECUTION FAILED: ${execError}`);

      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.log('Too many consecutive failures. Stopping.');
        return;
      }

      messages.push({
        role: 'user',
        content: `ACTION EXECUTION FAILED.\nFailed action was: ${JSON.stringify(action)}\nError: ${execError}\n\nDo NOT repeat this exact action. The target text may not match what is actually in the DOM. Try a different element, shorter name match, or a different approach entirely.\nConsecutive failures: ${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}.\n\nCurrent Browser State:\n${currentStateText}\n\nWhat is your next action?`,
      });
      failedActions.push({
        pageUrl: currentState.page?.url,
        action: action,
        reason: 'Execution failed: ' + execError
      });
      continue;
    }

    // 6. Post-action snapshot
    console.log('Taking post-action snapshot…');
    let newState;
    try {
      newState = await getSnapshot();
    } catch (err) {
      console.error(`Infrastructure error getting post-action snapshot: ${err.message}`);
      return;
    }

    const newStateText = snapshotToText(newState);

    // 7. Check for CAPTCHA after action
    const blocker = detectBlocker(newState);
    if (blocker) {
      console.log(`\n${blocker.message}`);
      messages.push({
        role: 'user',
        content: `After executing the action, a ${blocker.type} challenge was detected: "${blocker.signal}". Return {"action": "human_needed", "reason": "..."} so the user can resolve it.`,
      });
      currentState = newState;
      currentStateText = newStateText;
      continue;
    }

    // 8. Verify
    console.log('Verifying action result…');
    const verification = await verifyAction(task, currentStateText, action, newStateText);
    const icon = verification.verified ? '✅' : '❌';
    console.log(`${icon} Verification: ${verification.verified ? 'SUCCESS' : 'FAILED'} — ${verification.reason}`);

    if (verification.verified) {
      consecutiveFailures = 0;
      messages.push({
        role: 'user',
        content: `Action verified as SUCCESSFUL. Reason: ${verification.reason}\n\nNew Browser State:\n${newStateText}\n\nTask reminder: ${task}\n\nWhat is your next action?`,
      });
    } else {
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.log('Too many consecutive failures without progress. Stopping.');
        return;
      }
      messages.push({
        role: 'user',
        content: `VERIFICATION FAILED — the action did NOT make progress toward the task.\nFailed action was: ${JSON.stringify(action)}\nReason: ${verification.reason}\n\nDo NOT repeat this exact action (same ref/target). Do NOT click random links. Reassess the current state.\nIf the task is impossible from this page, return "finish".\nConsecutive failures: ${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}.\n\nNew Browser State:\n${newStateText}\n\nTask reminder: ${task}\n\nWhat is your next action?`,
      });
      failedActions.push({
        pageUrl: currentState.page?.url,
        action: action,
        reason: 'Verification failed: ' + verification.reason
      });
    }

    currentState = newState;
    currentStateText = newStateText;
  }

  console.log(`\nReached step limit (${MAX_LOOPS}). Stopping.`);
}

// ---------------------------------------------------------------------------
// CLI helpers
// ---------------------------------------------------------------------------

function askUser(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log('');
  console.log('╔══════════════════════════════════════╗');
  console.log('║           VeriBrowse                 ║');
  console.log('║   Verified Browser Automation Agent  ║');
  console.log('╚══════════════════════════════════════╝');
  console.log('');

  const task = await askUser(rl, 'What do you want me to do?\n> ');
  if (!task.trim()) {
    rl.close();
    return;
  }

  try {
    await runAgent(task.trim(), rl);
  } catch (err) {
    console.error('\nFatal error:', err.message || err);
  }

  rl.close();
}

main();
