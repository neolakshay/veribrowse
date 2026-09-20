require('dotenv').config();
const { OpenAI } = require('openai');
const { exec } = require('child_process');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

const SESSION_ID = process.env.WEBCMD_SESSION || 'veribrowse-3h';
const MAX_LOOPS = 12;
const MAX_RETRIES = 3;
const SNAPSHOT_CHAR_LIMIT = 15000;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function extractTargetDomain(task) {
  const prompt = `You are a domain extraction tool.
Given the user's task, identify if there is an explicitly intended target website, service, or domain.
If the task mentions a specific service (like "reddit", "minecraft.net", "twitter"), extract its primary domain (e.g., "reddit.com", "minecraft.net", "twitter.com").
If the task is generic (e.g., "find a recipe for cake", "what is the news"), return null.

Return strict JSON:
{
  "domain": "reddit.com" | null
}`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: `Task: ${task}` }
    ],
    response_format: { type: 'json_object' }
  });
  
  try {
    return JSON.parse(response.choices[0].message.content).domain;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Workspace Knowledge Retrieval (Local RAG)
// ---------------------------------------------------------------------------

function getWorkspaceFiles(dirPath = path.join(__dirname, 'workspace')) {
  let results = [];
  if (!fs.existsSync(dirPath)) return results;
  
  const list = fs.readdirSync(dirPath);
  list.forEach(file => {
    const fullPath = path.join(dirPath, file);
    const stat = fs.statSync(fullPath);
    if (stat && stat.isDirectory()) {
      results = results.concat(getWorkspaceFiles(fullPath));
    } else {
      if (file.endsWith('.txt') || file.endsWith('.json') || file.endsWith('.md')) {
        const relPath = path.relative(__dirname, fullPath);
        const content = fs.readFileSync(fullPath, 'utf8');
        results.push({ source: relPath, content });
      }
    }
  });
  return results;
}

function retrieveWorkspaceInfo(query) {
  const allFiles = getWorkspaceFiles();
  if (allFiles.length === 0) return [];

  const q = (query || '').toLowerCase();
  const queryWords = q.split(/\W+/).filter(w => w.length > 2);

  const scored = allFiles.map(file => {
    const lowerContent = file.content.toLowerCase();
    let score = 0;
    
    queryWords.forEach(word => {
      if (['check', 'email', 'find', 'open', 'show', 'what', 'view', 'with', 'from', 'this', 'that'].includes(word)) return;
      if (lowerContent.includes(word)) score += 2;
    });

    // Special category intent boosts:
    if (file.source.includes('profile') && (q.includes('parker') || q.includes('who') || q.includes('role') || q.includes('company') || q.includes('hugging face') || q.includes('background') || q.includes('interest'))) {
      score += 5;
    }
    if (file.source.includes('bookmarks') && (q.includes('bookmark') || q.includes('github') || q.includes('transformers') || q.includes('follow') || q.includes('url') || q.includes('wikipedia') || q.includes('blog') || q.includes('resource') || q.includes('huggingface'))) {
      score += 5;
    }
    if ((file.source.includes('tasks') || file.source.includes('weekly-review')) && (q.includes('task') || q.includes('urgent') || q.includes('priority') || q.includes('priorities') || q.includes('todo') || q.includes('deadline') || q.includes('blocked') || q.includes('finish') || q.includes('ready'))) {
      score += 5;
    }
    if (file.source.includes('projects') && (q.includes('project') || q.includes('review') || q.includes('milestone') || q.includes('summary') || q.includes('engineering review') || q.includes('inference') || q.includes('dashboard'))) {
      score += 4;
    }

    return { ...file, score };
  });

  const matches = scored.filter(f => f.score > 0).sort((a, b) => b.score - a.score);
  return matches.slice(0, 5);
}

// ---------------------------------------------------------------------------
// LLM Understanding & Plan Generation Step
// ---------------------------------------------------------------------------

async function understandGoal(task, retrievedInfo) {
  const contextText = (retrievedInfo || []).map(item => `--- SOURCE: ${item.source} ---\n${item.content}`).join('\n\n');

  const prompt = `You are VeriBrowse's Goal Understanding & Workspace Intelligence Module.
Your job is to analyze the user's goal along with the retrieved workspace information.

EXTRACT AND STRUCTURE:
1. Intent: What is the main objective of the user?
2. Tasks: What specific tasks/steps are required to achieve this goal?
3. Deadlines: What are the explicit deadlines mentioned in the workspace?
4. Requirements: What deliverables/submission criteria are required?
5. Known Information: What facts are explicitly confirmed in the workspace?
6. Missing Information: What required details are not found in the workspace?
7. Completed Items: Which required tasks are already marked completed?
8. Uncertainties: Any ambiguities or potential blockers?
9. Sources: Exact source filenames referenced.

CRITICAL RULES:
- Reason ONLY from the retrieved workspace information and user prompt.
- Do NOT fabricate or invent information.
- For email or web inspection tasks (e.g., checking Gmail for a login alert), focus on the user's intent to inspect their email. Do NOT invent unrelated missing information (such as company rules or credentials) unless relevant workspace files were actually retrieved.
- If something is missing, explicitly list it under missing_information.

Return strict JSON matching this schema:
{
  "intent": "string",
  "tasks": ["string"],
  "deadlines": ["string"],
  "requirements": ["string"],
  "known_information": ["string"],
  "missing_information": ["string"],
  "completed_items": ["string"],
  "uncertainties": ["string"],
  "sources": ["string"]
}`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: `User Goal: ${task}\n\nRetrieved Workspace Context:\n${contextText || '(No workspace files found)'}` }
    ],
    response_format: { type: 'json_object' }
  });

  try {
    const parsed = JSON.parse(response.choices[0].message.content);
    return {
      intent: parsed.intent || task,
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [task],
      deadlines: Array.isArray(parsed.deadlines) ? parsed.deadlines : [],
      requirements: Array.isArray(parsed.requirements) ? parsed.requirements : [],
      known_information: Array.isArray(parsed.known_information) ? parsed.known_information : [],
      missing_information: Array.isArray(parsed.missing_information) ? parsed.missing_information : [],
      completed_items: Array.isArray(parsed.completed_items) ? parsed.completed_items : [],
      uncertainties: Array.isArray(parsed.uncertainties) ? parsed.uncertainties : [],
      sources: Array.isArray(parsed.sources) ? parsed.sources : retrievedInfo.map(r => r.source)
    };
  } catch (e) {
    return {
      intent: task,
      tasks: [task],
      deadlines: [],
      requirements: [],
      known_information: [],
      missing_information: [],
      completed_items: [],
      uncertainties: [],
      sources: (retrievedInfo || []).map(r => r.source)
    };
  }
}

async function generatePlan(task, understanding) {
  const prompt = `You are VeriBrowse's Strategic Planner.
Based on the user goal and the structured understanding, generate a concise, actionable 4 to 6 step plan.

Rules:
- The plan must be specific to the extracted requirements and deadlines.
- Clearly state the sequence: review requirements -> verify completed items -> launch/open required URL -> perform required browser action -> verify completion.

Return strict JSON:
{
  "steps": ["Step 1: ...", "Step 2: ...", "Step 3: ...", "Step 4: ..."]
}`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: `User Goal: ${task}\n\nStructured Understanding:\n${JSON.stringify(understanding, null, 2)}` }
    ],
    response_format: { type: 'json_object' }
  });

  try {
    const parsed = JSON.parse(response.choices[0].message.content);
    return Array.isArray(parsed.steps) ? parsed.steps : [];
  } catch (e) {
    return [
      "1. Review extracted workspace details and submission requirements.",
      "2. Check completed prerequisite tasks.",
      "3. Open the target web page in browser.",
      "4. Verify page state and report result."
    ];
  }
}


// ---------------------------------------------------------------------------
// WebCMD CLI helpers
// ---------------------------------------------------------------------------

function runWebCmd(command, stdinData = null) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    if (process.env.BROWSER === 'chrome') {
      const port = process.env.CHROME_DEBUG_PORT || '9222';
      env.WEBCMD_CDP_ENDPOINT = `http://127.0.0.1:${port}`;
    }
    const fullCmd = `webcmd --session ${SESSION_ID} browser ${command} --format json`;
    const child = exec(fullCmd, { env, maxBuffer: 1024 * 1024 * 10, timeout: 30000 }, (error, stdout, stderr) => {
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
          // 1. Try to list existing tabs for this session
          const tabsResult = await runWebCmd('tabs');
          let bindSuccess = false;
          
          if (Array.isArray(tabsResult) && tabsResult.length > 0) {
            // Prefer the currently selected/active tab, otherwise fallback to the first
            const targetTab = tabsResult.find(t => t.selected) || tabsResult[0];
            await runWebCmd(`bind --page ${targetTab.id}`);
            console.log(`  [Infra] Bound to existing page: ${targetTab.url}`);
            bindSuccess = true;
          }

          if (!bindSuccess) {
            // 2. If no usable tabs exist, initialize a new browser session gently
            await runWebCmd('run --stdin', 'return true;');
            console.log('  [Infra] Session initialized. Retrying…');
          }
          
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
      const ref = action.ref ? escapeJS(action.ref) : null;
      const role = action.role ? escapeJS(action.role) : null;
      const href = action.href ? escapeJS(action.href) : null;
      
      // Extract key terms for partial matching if target is long/comma-separated
      let searchTerms = [target];
      if (target.includes(',') || target.length > 20) {
        const parts = target.split(',').map(s => s.trim()).filter(s => s.length > 3);
        if (parts.length > 0) {
          searchTerms = parts.concat(searchTerms);
        }
      }

      const scriptLines = [
        `let el;`,
        `async function robustClick(loc) {`,
        `  if (!loc || await loc.count() === 0) return false;`,
        `  try { await loc.first().click({ timeout: 4000 }); return true; }`,
        `  catch(e) {`,
        `    try { await loc.first().click({ force: true, timeout: 3000 }); return true; }`,
        `    catch(e1) {`,
        `      try { await loc.first().dispatchEvent('click', { timeout: 2000 }); return true; }`,
        `      catch(e2) { return false; }`,
        `    }`,
        `  }`,
        `}`
      ];
      
      if (ref) {
        scriptLines.push(`el = page.locator('[data-ref="${ref}"], [ref="${ref}"], #${ref}');`);
        scriptLines.push(`if (await robustClick(el)) return;`);
      }

      if (role && href) {
        const path = href.replace(/^https?:\/\/[^\/]+/, '');
        if (path && path !== '/') {
          scriptLines.push(`el = page.locator('${role === 'link' ? 'a' : role}[href*="${path}"], [href*="${path}"]');`);
          scriptLines.push(`if (await robustClick(el)) return;`);
        }
      }
      if (role) {
        scriptLines.push(`el = page.getByRole('${role}', { name: '${target}', exact: true });`);
        scriptLines.push(`if (await robustClick(el)) return;`);
        scriptLines.push(`el = page.getByRole('${role}', { name: '${target}' });`);
        scriptLines.push(`if (await robustClick(el)) return;`);
      }

      scriptLines.push(`el = page.getByText('${target}', { exact: true });`);
      scriptLines.push(`if (await robustClick(el)) return;`);
      scriptLines.push(`el = page.getByText('${target}', { exact: false });`);
      scriptLines.push(`if (await robustClick(el)) return;`);

      // Partial term & Gmail/row element cascade
      for (const term of searchTerms) {
        const safeTerm = escapeJS(term);
        if (!safeTerm) continue;
        scriptLines.push(`el = page.locator('tr, [role="row"], [role="link"], [role="option"], [role="button"], div.y6, span.bog, div.zA, span.bAq').filter({ hasText: '${safeTerm}' });`);
        scriptLines.push(`if (await robustClick(el)) return;`);
        scriptLines.push(`el = page.getByText('${safeTerm}', { exact: false });`);
        scriptLines.push(`if (await robustClick(el)) return;`);
      }

      scriptLines.push(`throw new Error('Element not found or not clickable');`);
      return `await (async () => {\n  ${scriptLines.join('\n  ')}\n})();`;
    }
    case 'type': {
      const target = escapeJS(action.target || '');
      const text = escapeJS(action.text || '');
      const ref = action.ref ? escapeJS(action.ref) : null;
      const role = action.role ? escapeJS(action.role) : null;
      
      const scriptLines = [
        `let el;`,
        `async function robustFill(loc, text) {`,
        `  if (!loc || await loc.count() === 0) return false;`,
        `  try {`,
        `    await loc.first().fill(text, { timeout: 3000 });`,
        `    await loc.first().press('Enter').catch(() => {});`,
        `    return true;`,
        `  } catch(e) {`,
        `    try {`,
        `      await loc.first().dispatchEvent('focus');`,
        `      await loc.first().fill(text, { force: true, timeout: 2000 });`,
        `      await loc.first().press('Enter').catch(() => {});`,
        `      return true;`,
        `    } catch(e2) { return false; }`,
        `  }`,
        `}`
      ];
      
      if (ref) {
        scriptLines.push(`el = page.locator('[data-ref="${ref}"], [ref="${ref}"], #${ref}');`);
        scriptLines.push(`if (await robustFill(el, '${text}')) return;`);
      }
      if (role) {
        scriptLines.push(`el = page.getByRole('${role}', { name: '${target}', exact: true });`);
        scriptLines.push(`if (await robustFill(el, '${text}')) return;`);
        scriptLines.push(`el = page.getByRole('${role}', { name: '${target}' });`);
        scriptLines.push(`if (await robustFill(el, '${text}')) return;`);
      }
      scriptLines.push(`el = page.getByPlaceholder('${target}');`);
      scriptLines.push(`if (await robustFill(el, '${text}')) return;`);
      scriptLines.push(`el = page.getByLabel('${target}', { exact: false });`);
      scriptLines.push(`if (await robustFill(el, '${text}')) return;`);
      scriptLines.push(`el = page.locator('input[aria-label*="Search"], input[name="q"], input[type="text"], [contenteditable="true"]');`);
      scriptLines.push(`if (await robustFill(el, '${text}')) return;`);
      scriptLines.push(`throw new Error('Field not found or not fillable');`);

      return `await (async () => {\n  ${scriptLines.join('\n  ')}\n})();`;
    }
    case 'extract':
      return null;
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
- IMPORTANT: If the action was 'navigate' to a URL (e.g. Gmail) and the page is ALREADY on that site/inbox, treat this as VERIFIED SUCCESS with reason "page already satisfies navigation requirement".
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
- For email inspection tasks (e.g. "check my email for a login alert"):
  Completion requires:
  1. Gmail/inbox is accessible.
  2. A relevant email was found.
  3. The relevant email was opened and its contents inspected on screen.
  4. Relevant information (sender, subject, time, alert details) was extracted and reported to the user.
  - Simply navigating to Gmail or displaying an inbox is NOT complete.
  - If no matching email exists after searching, report that clearly as the result.
- IMPORTANT: If private credentials or security settings changes are needed, use 'human_needed'.
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
3. If the browser is ALREADY on Gmail, Inbox, or mail.google.com, Gmail is open! NEVER issue "navigate" to gmail.com or mail.google.com when already on Gmail.
4. GMAIL & EMAIL WORKFLOW:
   - For email requests ("check my email for a login alert"), reason semantically. Relevant terms include: "security alert", "login alert", "new sign-in", "sign-in", "suspicious login", "account activity".
   - Inspect visible inbox items first. If a matching email is visible, click its text/subject fragment (e.g. target "Security alert" or "New sign-in").
   - Do NOT copy the full long multi-line text of an email row as the target. Use a short distinctive subject fragment.
   - If the email is not visible, use Gmail's search box to search for "login alert" or "security alert" instead of refreshing or re-navigating.
   - Once an email is opened, inspect/extract visible details: sender, subject, date/time, device/browser, approximate location, security actions.
5. EMAIL SECURITY CONSTRAINTS:
   - You MAY: inspect inbox, search emails, open an email, extract email text.
   - You MUST NOT: enter passwords, enter OTPs, change account settings, delete emails, mark spam, click suspicious links, perform recovery, or send emails.
   - If an email contains suspicious links, report them in the final result rather than clicking them.
6. Use "type" to fill input fields, search boxes, or text areas visible in the snapshot.
7. Use "extract" only when you need to read the page content to answer the user's task.
8. Use "wait" if a page is loading or you just submitted a form.
9. If a CAPTCHA, "verify you are human", or similar challenge is visible, return:
   {"action": "human_needed", "reason": "CAPTCHA or verification challenge detected."}
10. If the current page has NO plausible path toward the goal, return:
   {"action": "finish", "result": "I could not find a verified path to complete the task from the current page."}
11. When the task is complete and you can answer the user, return:
   {"action": "finish", "result": "your answer here"}

FAILURE HANDLING:
- ACTION_EXECUTION_FAILURE means the Playwright command crashed (element not found, timeout, etc.). 
  → Try a DIFFERENT selector or approach. Do NOT retry the exact same action.
- VERIFICATION_FAILURE means the action ran but the ultimate goal is not reached yet.
  → If the page changed meaningfully (e.g., reaching a homepage), this is PROGRESS. Not every verification failure means the previous action was wrong. Reassess the current snapshot and continue toward the explicit destination.
  → If the state did NOT change, reassess deeply. Do not repeatedly perform the same failed action.
  → Only choose finish when the goal is actually achieved or no verified path remains.

AVAILABLE ACTIONS (return exactly one as JSON):

Click an element (COPY the ref, role, and name EXACTLY from the snapshot):
{"action": "click", "ref": "l3", "target": "exact text from snapshot", "role": "link|button|tab|menuitem", "href": "/path (for links, if shown in snapshot)"}
IMPORTANT: Copy the element text EXACTLY as it appears in the snapshot, including capitalization. Do not paraphrase or reconstruct it. Include href for links when the snapshot shows it.

Type into a field (COPY the ref, role, and name EXACTLY from the snapshot):
{"action": "type", "ref": "l14", "target": "exact text from snapshot", "text": "what to type", "role": "textbox|combobox|searchbox (optional)"}

Navigate (RESTRICTED — only for explicit user-provided URLs):
{"action": "navigate", "url": "https://…"}

Read/extract page content:
{"action": "extract", "what": "EXPLICIT description of the exact fields/information you need to extract based on the user's task."}

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

async function runAgent(task, options = {}) {
  const emit = (event) => { if (options.onEvent) options.onEvent(event); };

  console.log(`\nStarting task: "${task}"\n`);
  emit({ type: 'task_started', task });
  
  // 1. Search local workspace knowledge
  console.log('Searching local workspace knowledge…');
  const retrievedInfo = retrieveWorkspaceInfo(task);
  const sources = retrievedInfo.map(r => r.source);
  if (retrievedInfo.length > 0) {
    console.log(`  Found ${retrievedInfo.length} workspace sources: ${sources.join(', ')}`);
    emit({ type: 'workspace_retrieved', sources, count: retrievedInfo.length });
  }

  // 2. LLM Understanding Step
  console.log('Extracting tasks, deadlines, and requirements via LLM understanding…');
  emit({ type: 'understanding_started' });
  const understanding = await understandGoal(task, retrievedInfo);
  console.log(`  Intent: ${understanding.intent}`);
  console.log(`  Requirements: ${understanding.requirements.join(', ')}`);
  console.log(`  Deadlines: ${understanding.deadlines.join(', ')}`);
  emit({ type: 'understanding', understanding });

  // 3. Plan Generation Step
  console.log('Generating actionable plan…');
  const planSteps = await generatePlan(task, understanding);
  console.log(`  Plan (${planSteps.length} steps):\n   ${planSteps.join('\n   ')}`);
  emit({ type: 'plan_generated', plan: planSteps, understanding });

  // 4. Extract domain constraints
  console.log('Extracting target domain constraints…');
  let targetDomain = await extractTargetDomain(task);
  if (!targetDomain && understanding) {
    const combinedStr = (understanding.known_information || []).concat(understanding.requirements || []).concat(understanding.tasks || []).join(' ');
    const urlMatch = combinedStr.match(/https?:\/\/[^\s]+/);
    if (urlMatch) {
      try {
        targetDomain = new URL(urlMatch[0]).hostname;
      } catch (e) {}
    }
  }

  if (targetDomain) {
    console.log(`  Target constraint: ${targetDomain}`);
    emit({ type: 'domain_constraint', domain: targetDomain });
  }

  const contextSummary = `
PRODUCTIVITY CONTEXT FROM WORKSPACE:
- Intent: ${understanding.intent || task}
- Extracted Requirements: ${JSON.stringify(understanding.requirements || [])}
- Extracted Deadlines: ${JSON.stringify(understanding.deadlines || [])}
- Completed Prerequisites: ${JSON.stringify(understanding.completed_items || [])}
- Execution Plan: ${JSON.stringify(planSteps)}
- Sources Referenced: ${(understanding.sources || []).join(', ')}
`;

  const messages = [
    { role: 'system', content: PLANNER_SYSTEM_PROMPT + '\n\n' + contextSummary }
  ];

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
    const combinedText = task + ' ' + JSON.stringify(understanding);
    const urlMatch = combinedText.match(/https?:\/\/[^\s]+/);
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
    emit({ type: 'human_intervention', reason: 'CAPTCHA detected on initial page', message: initialBlocker.message });
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
    emit({ type: 'step', step, total: MAX_LOOPS });

    // 1. Ask planner
    console.log('Asking planner…');
    emit({ type: 'planning' });
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
      emit({ type: 'error', message: 'Planner returned invalid JSON' });
      break;
    }

    console.log(`Action: ${JSON.stringify(action)}`);
    emit({ type: 'action', action });
    messages.push({ role: 'assistant', content: JSON.stringify(action) });

    // Intercept redundant navigation to Gmail if already on Gmail
    if (action.action === 'navigate') {
      const navUrl = (action.url || '').toLowerCase();
      const currentUrl = (currentState?.page?.url || '').toLowerCase();
      const isGmailNav = navUrl.includes('gmail.com') || navUrl.includes('mail.google.com');
      const isAlreadyOnGmail = currentUrl.includes('gmail.com') || currentUrl.includes('mail.google.com') || currentStateText.includes('Inbox') || currentStateText.includes('Gmail');
      
      if (isGmailNav && isAlreadyOnGmail) {
        console.log('⚡ Browser is ALREADY on Gmail inbox. Skipping redundant navigation.');
        emit({ type: 'action_success', reason: 'Page already satisfies navigation requirement' });
        messages.push({
          role: 'user',
          content: `NAVIGATION SATISFIED: You are ALREADY on Gmail/Inbox (${currentState?.page?.url}). Do NOT navigate to gmail.com again. Inspect visible inbox emails directly or use the search box.`
        });
        consecutiveFailures = 0;
        continue;
      }
    }

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
        emit({ type: 'terminated', result: action.result });
        return;
      }
      
      console.log('🔎 Verifying task completion…');
      emit({ type: 'verifying_completion' });
      const completion = await verifyCompletion(task, currentStateText, action.result);
      if (completion.complete) {
        console.log(`\n✅ Task completed!`);
        console.log(`Result: ${action.result}`);
        emit({ type: 'success', result: action.result });
        return;
      } else {
        console.log(`❌ COMPLETION REJECTED: ${completion.reason}`);
        emit({ type: 'completion_rejected', reason: completion.reason });
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.log('Too many consecutive failures without progress. Stopping.');
          emit({ type: 'error', message: 'Too many consecutive failures' });
          return;
        }
        messages.push({
          role: 'user',
          content: `COMPLETION REJECTED.\nYou attempted to finish, but the user's task is not yet complete.\nReason: ${completion.reason}\n\nIf the information is missing from the current page but a clear next step exists (like a 'Get Status' button), take that action. If the required information is definitively unavailable and there is no logical path forward, return {"action": "finish", "result": "The requested data could not be verified on this page."} rather than wandering to unrelated links.`
        });
        continue;
      }
    }

    if (action.action === 'human_needed') {
      console.log(`\nHUMAN INTERVENTION REQUIRED`);
      console.log(`   Reason: ${action.reason}`);
      console.log('');
      emit({ type: 'human_intervention', reason: action.reason });

      // Offer to wait for the human to resolve
      if (options.askUser) {
        const answer = await options.askUser('Complete the challenge in the browser, then type "done" to continue (or "quit" to stop): ');
        if (answer.trim().toLowerCase() === 'quit') {
          console.log('Agent stopped by user.');
          emit({ type: 'terminated', result: 'Stopped by user during human intervention.' });
          return;
        }
        console.log('Continuing...');
      } else {
        return; // stop if no askUser provided
      }

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
        content: `Extraction result (read-mode snapshot) for your query "${action.what}":\n${extractedContent}\n\nAnalyze this content carefully against the task requirements. \n- If ALL requested information is explicitly present, return "finish" with the verified result.\n- If fields are MISSING or STALE, do NOT fabricate them. If there is a clear next step on this page to get the live data, take it. \n- If the required data is simply unavailable, return "finish" stating exactly which fields could not be found.\n\nTask reminder: ${task}`,
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
        emit({ type: 'human_intervention', reason: 'Sensitive input field detected', field: action.target });
        
        if (options.askUser) {
           const answer = await options.askUser('Enter information in the browser, then type "done" to continue (or "quit" to stop): ');
           if (answer.trim().toLowerCase() === 'quit') {
             emit({ type: 'terminated', result: 'Stopped by user during sensitive input.' });
             return;
           }
           messages.push({ role: 'user', content: `I have entered the sensitive information. Please continue.` });
           continue;
        }
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
        emit({ type: 'human_intervention', reason: 'Irreversible action detected', action: action.target });

        if (options.askUser) {
           const answer = await options.askUser('Confirm the action in the browser, then type "done" to continue (or "quit" to stop): ');
           if (answer.trim().toLowerCase() === 'quit') {
             emit({ type: 'terminated', result: 'Stopped by user.' });
             return;
           }
           messages.push({ role: 'user', content: `I have completed the irreversible action. Please continue.` });
           continue;
        }
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
    emit({ type: 'executing', script });
    let execError = null;
    let newTabOpened = false;
    let activeTabBefore = null;
    
    try {
      const beforeTabs = await runWebCmd('tabs').catch(() => []);
      const beforeTabIds = new Set(Array.isArray(beforeTabs) ? beforeTabs.map(t => t.id) : []);
      activeTabBefore = Array.isArray(beforeTabs) ? beforeTabs.find(t => t.selected)?.id : null;

      const runResult = await safeRunWebCmd('run --stdin --timeout 15', script);
      
      const afterTabs = await runWebCmd('tabs').catch(() => []);
      if (Array.isArray(afterTabs)) {
        const newTab = afterTabs.find(t => !beforeTabIds.has(t.id));
        if (newTab) {
          console.log(`Detected new tab opened: ${newTab.url}. Binding to it...`);
          await runWebCmd(`bind --page ${newTab.id}`);
          newTabOpened = true;
        }
      }

      if (runResult?.error) {
        execError = runResult.error.message || JSON.stringify(runResult.error);
      }
    } catch (err) {
      // Infrastructure failure — stop agent
      console.error(`Infrastructure failure: ${err.message}`);
      emit({ type: 'error', message: `Infrastructure failure: ${err.message}` });
      return;
    }

    if (execError) {
      consecutiveFailures++;
      console.log(`ACTION EXECUTION FAILED: ${execError}`);
      emit({ type: 'action_failed', error: execError });

      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.log('Too many consecutive failures. Stopping.');
        emit({ type: 'error', message: 'Too many consecutive failures' });
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

    // 6.5 Domain Drift Check
    if (targetDomain && newState?.page?.url) {
      try {
        const u = new URL(newState.page.url);
        const hostname = u.hostname.toLowerCase();
        // Allow search engines and blank pages as intermediaries
        const isSearchEngine = ['google.', 'bing.', 'yahoo.', 'duckduckgo.', 'about:blank'].some(se => hostname.includes(se));
        const domainBase = targetDomain.split('.')[0].toLowerCase();
        const isTarget = hostname.includes(domainBase);
        
        if (!isSearchEngine && !isTarget && u.protocol !== 'about:') {
          console.log(`\n⚠️ DOMAIN DRIFT DETECTED: Navigated to unrelated domain ${hostname}`);
          console.log(`Rolling back navigation...`);
          
          if (newTabOpened && activeTabBefore) {
            await runWebCmd(`bind --page ${activeTabBefore}`);
          } else {
            await safeRunWebCmd('run --stdin', 'await page.goBack().catch(() => {});');
          }
          newState = await getSnapshot();
          
          consecutiveFailures++;
          messages.push({
            role: 'user',
            content: `ACTION REJECTED: DOMAIN DRIFT.\nYour action navigated to an unrelated service ('${hostname}').\nThe task is constrained to '${targetDomain}' (and search engines).\nI have restored the previous page.\nChoose a different path.`
          });
          currentState = newState;
          currentStateText = snapshotToText(newState);
          continue;
        }
      } catch(e) {}
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
    emit({ type: 'verifying' });
    const verification = await verifyAction(task, currentStateText, action, newStateText);
    const icon = verification.verified ? '✅' : '❌';
    console.log(`${icon} Verification: ${verification.verified ? 'SUCCESS' : 'FAILED'} — ${verification.reason}`);
    emit({ type: 'verified', success: verification.verified, reason: verification.reason });

    if (verification.verified) {
      consecutiveFailures = 0;
      messages.push({
        role: 'user',
        content: `Action verified as SUCCESSFUL. Reason: ${verification.reason}\n\nNew Browser State:\n${newStateText}\n\nTask reminder: ${task}\n\nWhat is your next action?`,
      });
    } else {
      // Meaningful state change check (e.g., URL or title change)
      const pageChanged = (currentState?.page?.url !== newState?.page?.url) || (currentState?.page?.title !== newState?.page?.title);
      
      if (pageChanged) {
        consecutiveFailures = 0;
        messages.push({
          role: 'user',
          content: `Action executed successfully, but the requested destination/goal has not been reached yet.\nReason: ${verification.reason}\n\nThe browser state has changed meaningfully. This is an intermediate step. Reassess the current page and continue toward the goal.\n\nNew Browser State:\n${newStateText}\n\nTask reminder: ${task}\n\nWhat is your next action?`
        });
      } else {
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.log('Too many consecutive failures without progress. Stopping.');
          emit({ type: 'error', message: 'Too many consecutive failures without progress.' });
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
    }

    currentState = newState;
    currentStateText = newStateText;
  }

  console.log(`\nReached step limit (${MAX_LOOPS}). Stopping.`);
  emit({ type: 'error', message: `Reached step limit (${MAX_LOOPS})` });
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
    await runAgent(task.trim(), { askUser: (q) => askUser(rl, q) });
  } catch (err) {
    console.error('\nFatal error:', err.message || err);
  }

  rl.close();
}

if (require.main === module) {
  main();
}

module.exports = {
  runAgent,
  extractTargetDomain
};
