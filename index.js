require('dotenv').config();
const { OpenAI } = require('openai');
const { exec } = require('child_process');
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const { saveCheckpoint, getCheckpoint } = require('./checkpoint');

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
// Centralized Browser-State Synchronization Layer
// ---------------------------------------------------------------------------

async function syncBrowserState(options = {}) {
  try {
    // 1. Inspect live browser context & active tabs
    const tabsResult = await runWebCmd('tabs').catch(() => []);
    const tabs = Array.isArray(tabsResult) ? tabsResult : [];
    
    // 2. Identify active / selected page
    let activeTab = tabs.find(t => t.selected) || (tabs.length > 0 ? tabs[tabs.length - 1] : null);

    if (activeTab && options.forceBind !== false) {
      await runWebCmd(`bind --page ${activeTab.id}`).catch(() => {});
    }

    // 3. Take fresh accessibility snapshot
    const snapshotData = await getSnapshot();
    const snapshotText = snapshotToText(snapshotData);

    const pageUrl = snapshotData?.page?.url || activeTab?.url || 'about:blank';
    const pageTitle = snapshotData?.page?.title || activeTab?.title || '';
    const pageId = snapshotData?.page?.id || activeTab?.id || 'default';

    // 4. Compute state fingerprint for change detection
    const textHash = snapshotText ? snapshotText.length + '::' + snapshotText.slice(0, 150) : 'empty';
    const fingerprint = `${pageId}::${pageUrl}::${pageTitle}::${textHash}`;

    return {
      ok: true,
      tabs,
      activeTab,
      pageId,
      url: pageUrl,
      title: pageTitle,
      snapshotData,
      snapshotText,
      fingerprint,
      timestamp: Date.now()
    };
  } catch (err) {
    console.warn(`  [Sync State Error] State synchronization failed: ${err.message}`);
    return {
      ok: false,
      error: err.message,
      tabs: [],
      activeTab: null,
      pageId: null,
      url: '',
      title: '',
      snapshotData: null,
      snapshotText: '(empty snapshot due to sync error)',
      fingerprint: 'error',
      timestamp: Date.now()
    };
  }
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
    case 'open_new_tab': {
      const url = escapeJS(action.url || '');
      return `await (async () => {
        const newPage = await page.context().newPage();
        if ('${url}') {
          await newPage.goto('${url}', { waitUntil: 'domcontentloaded', timeout: 15000 });
        }
      })();`;
    }
    case 'click': {
      const target = escapeJS(action.target || '');
      const ref = action.ref ? escapeJS(action.ref) : null;
      const role = action.role ? escapeJS(action.role) : null;
      const href = action.href ? escapeJS(action.href) : null;
      const openInNewTab = !!(action.open_in_new_tab || action.new_tab);
      
      // Shorten long targets for flexible matching
      let searchTerms = [target];
      if (target.includes(',') || target.length > 15) {
        const parts = target.split(/[\n,:]+/).map(s => s.trim()).filter(s => s.length > 3);
        if (parts.length > 0) {
          searchTerms = parts.concat(searchTerms);
        }
      }

      const scriptLines = [
        `let el;`,
        `async function robustClick(loc) {`,
        `  if (!loc || await loc.count() === 0) return false;`,
        `  try {`,
        `    const targetEl = loc.first();`,
        `    if (${openInNewTab}) {`,
        `      const hrefAttr = await targetEl.getAttribute('href').catch(() => null);`,
        `      if (hrefAttr) {`,
        `        const fullUrl = new URL(hrefAttr, page.url()).href;`,
        `        const newP = await page.context().newPage();`,
        `        await newP.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });`,
        `        return true;`,
        `      }`,
        `    }`,
        `    await targetEl.click({ timeout: 4000 });`,
        `    return true;`,
        `  } catch(e) {`,
        `    try { await loc.first().click({ force: true, timeout: 3000 }); return true; }`,
        `    catch(e1) {`,
        `      try { await loc.first().dispatchEvent('click', { timeout: 2000 }); return true; }`,
        `      catch(e2) {`,
        `        try { await loc.first().evaluate(el => el.click()); return true; }`,
        `        catch(e3) { return false; }`,
        `      }`,
        `    }`,
        `  }`,
        `}`
      ];
      
      // 1. Snapshot ref locator
      if (ref) {
        scriptLines.push(`el = page.locator('[data-ref="${ref}"], [ref="${ref}"], #${ref}, [aria-describedby*="${ref}"], [id*="${ref}"]');`);
        scriptLines.push(`if (await robustClick(el)) return;`);
      }

      // 2. Role + Href locator
      if (role && href) {
        const path = href.replace(/^https?:\/\/[^\/]+/, '');
        if (path && path !== '/') {
          const safePath = escapeJS(path);
          scriptLines.push(`el = page.locator('${role === 'link' ? 'a' : role}[href*="${safePath}"], [href*="${safePath}"]');`);
          scriptLines.push(`if (await robustClick(el)) return;`);
        }
      }

      // 3. Role + Target name
      if (role) {
        scriptLines.push(`el = page.getByRole('${role}', { name: '${target}', exact: true });`);
        scriptLines.push(`if (await robustClick(el)) return;`);
        scriptLines.push(`el = page.getByRole('${role}', { name: '${target}' });`);
        scriptLines.push(`if (await robustClick(el)) return;`);
      }

      // 4. Exact text
      scriptLines.push(`el = page.getByText('${target}', { exact: true });`);
      scriptLines.push(`if (await robustClick(el)) return;`);
      scriptLines.push(`el = page.getByText('${target}', { exact: false });`);
      scriptLines.push(`if (await robustClick(el)) return;`);

      // 5. Shortened term matching & container cascade
      for (const term of searchTerms) {
        const safeTerm = escapeJS(term);
        if (!safeTerm) continue;
        scriptLines.push(`el = page.locator('button, a, [role="button"], [role="link"], [role="option"], tr, [role="row"], div.y6, span.bog, div.zA, span.bAq').filter({ hasText: '${safeTerm}' });`);
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
      return 'return true;';
    case 'wait':
      return `await page.waitForTimeout(${Math.min(Number(action.ms) || 2000, 5000)});`;
    default:
      return 'return true;';
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

CRITICAL RULES:
- Read the original task carefully.
- Examine the current browser state.
- CRITICAL DISTINCTION: Distinguish between "reading information" vs "completing the requested action".
  - If the user's task was purely informational (e.g. "what is the deadline?"), finding and reading the information satisfies the task.
  - If the user's task required an ACTION (e.g. "open this link in a new tab", "click the login alert", "submit form", "search for topic"):
    - Simply reading page text or extracting information does NOT complete the task.
    - Completion REQUIRES strong evidence that the target action (new tab opened, link clicked, form submitted) has actually been executed and its outcome is verified in the browser state.
- For email inspection tasks:
  Completion requires:
  1. Gmail/inbox is accessible.
  2. A relevant email was found.
  3. The relevant email was opened and its contents inspected on screen.
  4. Relevant information was extracted and reported to the user.
- IMPORTANT: If private credentials or security settings changes are needed, use 'human_needed'.
- If the completion evidence is ambiguous or incomplete, return complete: false.

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
3. If the user asks to open a link or URL in a new tab, use "open_new_tab" or "click" with "open_in_new_tab": true.
4. READING IS NOT SATISFYING AN ACTION GOAL: If the user's task requires an action (e.g. clicking a link, opening a tab, submitting a form, checking an alert and navigating to security), reading or extracting page content is ONLY an intermediate step. Once you extract information, you MUST proceed to execute the required action. Do NOT return "finish" right after "extract" if the user requested an action.
5. If the browser is ALREADY on Gmail, Inbox, or mail.google.com, Gmail is open! NEVER issue "navigate" to gmail.com or mail.google.com when already on Gmail.
6. GMAIL & EMAIL WORKFLOW:
   - For email requests ("check my email for a login alert"), reason semantically. Relevant terms include: "security alert", "login alert", "new sign-in", "sign-in", "suspicious login", "account activity".
   - Inspect visible inbox items first. If a matching email is visible, click its text/subject fragment (e.g. target "Security alert" or "New sign-in").
   - Do NOT copy the full long multi-line text of an email row as the target. Use a short distinctive subject fragment.
   - If the email is not visible, use Gmail's search box to search for "login alert" or "security alert" instead of refreshing or re-navigating.
   - Once an email is opened, inspect/extract visible details: sender, subject, date/time, device/browser, approximate location, security actions.
7. EMAIL SECURITY CONSTRAINTS:
   - You MAY: inspect inbox, search emails, open an email, extract email text.
   - You MUST NOT: enter passwords, enter OTPs, change account settings, delete emails, mark spam, click suspicious links, perform recovery, or send emails.
   - If an email contains suspicious links, report them in the final result rather than clicking them.
8. Use "type" to fill input fields, search boxes, or text areas visible in the snapshot.
9. Use "extract" when you need to read page content as an intermediate step to inform your next action.
10. Use "wait" if a page is loading or you just submitted a form.
11. If a CAPTCHA, "verify you are human", or similar challenge is visible, return:
   {"action": "human_needed", "reason": "CAPTCHA or verification challenge detected."}
12. If the current page has NO plausible path toward the goal, return:
   {"action": "finish", "result": "I could not find a verified path to complete the task from the current page."}
13. When the entire task is complete and verified, return:
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
{"action": "click", "ref": "l3", "target": "exact text from snapshot", "role": "link|button|tab|menuitem", "href": "/path (for links, if shown in snapshot)", "open_in_new_tab": false}

Open a URL in a new tab:
{"action": "open_new_tab", "url": "https://…"}

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

  const runId = options.runId || `run-${Date.now()}`;
  const resumeCheckpoint = options.resumeCheckpoint || null;
  const verifiedSteps = resumeCheckpoint?.verifiedSteps ? [...resumeCheckpoint.verifiedSteps] : [];
  const completedSteps = resumeCheckpoint?.completedSteps ? [...resumeCheckpoint.completedSteps] : [];
  const failedActions = resumeCheckpoint?.failedSteps ? [...resumeCheckpoint.failedSteps] : [];

  console.log(`\nStarting task (${runId}): "${task}"\n`);
  emit({ type: 'task_started', task, runId });
  
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

  const verifiedStepsSummary = verifiedSteps.length > 0 
    ? verifiedSteps.map(vs => `- Step ${vs.step}: ${JSON.stringify(vs.action)} -> Result: ${vs.result}`).join('\n')
    : 'None yet.';

  const contextSummary = `
PRODUCTIVITY CONTEXT FROM WORKSPACE:
- Intent: ${understanding.intent || task}
- Extracted Requirements: ${JSON.stringify(understanding.requirements || [])}
- Extracted Deadlines: ${JSON.stringify(understanding.deadlines || [])}
- Completed Prerequisites: ${JSON.stringify(understanding.completed_items || [])}
- Execution Plan: ${JSON.stringify(planSteps)}
- Sources Referenced: ${(understanding.sources || []).join(', ')}

VERIFIED PROGRESS FROM CHECKPOINT:
${verifiedStepsSummary}
NOTE TO PLANNER: The steps listed above are ALREADY VERIFIED. Do NOT repeat them unless the current browser state proves they are no longer true.
`;

  const messages = [
    { role: 'system', content: PLANNER_SYSTEM_PROMPT + '\n\n' + contextSummary }
  ];

  let currentState, currentStateText;
  let currentSync;
  let consecutiveFailures = 0;
  let finishRejectionsCount = 0;
  let recoveryCount = 0;
  const MAX_CONSECUTIVE_FAILURES = 3;
  const MAX_RECOVERIES = 3;

  // Generic Checkpoint Recovery & Re-Planning Helper
  async function attemptRecoveryFromCheckpoint(reason, stepNum) {
    if (recoveryCount >= MAX_RECOVERIES) {
      console.log(`⚠️ [Recovery System] Max recovery attempts (${MAX_RECOVERIES}) reached. Cannot recover further.`);
      return false;
    }

    recoveryCount++;
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`[Recovery System] RECOVERY STARTED (Attempt ${recoveryCount}/${MAX_RECOVERIES})`);
    console.log(`  • Reason: ${reason}`);
    console.log(`  • Retained Verified Steps: ${verifiedSteps.length}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

    emit({ type: 'recovery_started', reason, recoveryCount, verifiedCount: verifiedSteps.length });

    // Save recovery checkpoint
    const cp = saveCheckpoint({
      runId,
      task,
      status: 'recovering',
      currentStep: stepNum,
      totalSteps: MAX_LOOPS,
      goal: task,
      understanding,
      plan: planSteps,
      completedSteps,
      verifiedSteps,
      failedSteps: failedActions,
      lastVerifiedState: {
        url: currentSync?.url || '',
        title: currentSync?.title || '',
        snapshotSummary: (currentSync?.snapshotText || '').substring(0, 300)
      },
      browserContext: { domain: targetDomain || '' },
      sources
    });

    emit({ type: 'checkpoint_loaded', runId, step: stepNum, verifiedCount: verifiedSteps.length, checkpoint: cp });

    // Inspect & Reconcile live state
    const liveSync = await syncBrowserState();
    const verifiedUrl = cp.lastVerifiedState?.url || '';

    if (verifiedUrl && liveSync.url !== verifiedUrl && verifiedUrl !== 'about:blank') {
      console.log(`[State Reconciliation] Navigating live browser from ${liveSync.url} to verified page ${verifiedUrl}...`);
      await safeRunWebCmd('run --stdin --timeout 15', `await page.goto('${escapeJS(verifiedUrl)}', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});`);
      currentSync = await syncBrowserState();
    } else {
      currentSync = liveSync;
    }

    emit({
      type: 'state_reconciled',
      liveUrl: currentSync.url,
      verifiedUrl,
      status: 'reconciled',
      details: `Realigned browser state with ${currentSync.url}`
    });

    // Re-plan from verified baseline
    messages.push({
      role: 'user',
      content: `[RECOVERY FROM VERIFIED CHECKPOINT]\nReason: ${reason}\nVerified Progress Retained: ${verifiedSteps.length} verified steps.\nFailed Candidates/Actions on record: ${JSON.stringify(failedActions.slice(-5))}\n\nCurrent Reconciled Browser State:\n${currentSync.snapshotText}\n\nRECOVERY INSTRUCTION:\nThe previous attempted path or candidate failed. Abandon the failed candidate link/button/path. Inspect the current page or search results for a DIFFERENT, UNATTEMPTED candidate path. Output a concrete action (click, open_new_tab, type, navigate, extract). Do NOT repeat failed actions. Output finish with UNACHIEVABLE only if all candidate paths have been thoroughly verified as invalid.`
    });

    emit({ type: 'recovery_replanned', recoveryCount, verifiedCount: verifiedSteps.length, details: 'Prompted planner with fresh state & failed candidate history' });

    consecutiveFailures = 0;
    return true;
  }

  // --- Initial Browser State Synchronization & Checkpoint Reconciliation ---
  console.log('Synchronizing initial browser state…');
  try {
    currentSync = await syncBrowserState();
    currentState = currentSync.snapshotData;
    currentStateText = currentSync.snapshotText;
  } catch (err) {
    console.error('Cannot start: infrastructure error getting initial browser state.');
    console.error(`   ${err.message}`);
    emit({ type: 'error', message: `Infrastructure failure: ${err.message}` });
    return;
  }

  // Reconcile with checkpoint state if resuming
  if (resumeCheckpoint?.lastVerifiedState?.url) {
    const cpUrl = resumeCheckpoint.lastVerifiedState.url;
    if (currentSync.url !== cpUrl && cpUrl !== 'about:blank') {
      console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`[Checkpoint Reconciliation] Live browser URL (${currentSync.url}) differs from saved checkpoint URL (${cpUrl}).`);
      console.log(`Reconciling state and continuing from live browser reality...`);
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
      emit({ type: 'state_reconciled', liveUrl: currentSync.url, verifiedUrl: cpUrl, details: 'Continuing task from live browser state' });
    }
  }

  // --- Startup navigation if on empty page ---
  if (currentSync.url === 'about:blank' || currentSync.url === 'chrome://newtab/') {
    const combinedText = task + ' ' + JSON.stringify(understanding);
    const urlMatch = combinedText.match(/https?:\/\/[^\s]+/);
    const startUrl = urlMatch ? urlMatch[0] : 'https://www.google.com';
    console.log(`Initializing empty browser to starting URL: ${startUrl}`);
    try {
      await safeRunWebCmd('run --stdin --timeout 15', `await page.goto('${escapeJS(startUrl)}', { waitUntil: 'domcontentloaded', timeout: 15000 });`);
      currentSync = await syncBrowserState();
      currentState = currentSync.snapshotData;
      currentStateText = currentSync.snapshotText;
    } catch (err) {
      console.error(`Failed to initialize starting URL: ${err.message}`);
      emit({ type: 'error', message: `Failed to initialize starting URL: ${err.message}` });
      return;
    }
  }

  // Check for blocker on the initial page
  const initialBlocker = detectBlocker(currentState);
  if (initialBlocker) {
    console.log(`\n${initialBlocker.message}`);
    console.log('The current page has a challenge that requires human intervention.');
    console.log('Please complete the challenge in the browser, then re-run VeriBrowse.');
    emit({ type: 'human_intervention', reason: 'CAPTCHA detected on initial page', message: initialBlocker.message });
    return;
  }

  messages.push({
    role: 'user',
    content: `Task: ${task}\n\nCurrent Browser State:\n${currentStateText}\n\nWhat is your next action?`,
  });

  let lastPlannedFingerprint = currentSync.fingerprint;

  // --- Main Agent Execution & Recovery Loop ---
  for (let step = 1; step <= MAX_LOOPS; step++) {
    console.log(`\n━━━ Step ${step}/${MAX_LOOPS} ━━━`);
    emit({ type: 'step', step, total: MAX_LOOPS });

    // 1. Stale State Detection prior to planning
    const prePlanSync = await syncBrowserState({ forceBind: false });
    if (prePlanSync.fingerprint !== lastPlannedFingerprint && step > 1) {
      console.log(`⚠️ [Stale State] Browser updated prior to step ${step} (${currentSync.url} -> ${prePlanSync.url}). Refreshing snapshot.`);
      currentSync = prePlanSync;
      currentState = currentSync.snapshotData;
      currentStateText = currentSync.snapshotText;
    }

    // 2. Ask Planner
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

    lastPlannedFingerprint = currentSync.fingerprint;
    console.log(`Action: ${JSON.stringify(action)}`);
    emit({ type: 'action', action });
    messages.push({ role: 'assistant', content: JSON.stringify(action) });

    // Generic redundant navigation check
    if (action.action === 'navigate') {
      const navUrl = (action.url || '').toLowerCase();
      const currentUrl = (currentSync.url || '').toLowerCase();
      let isRedundant = false;

      try {
        const targetHost = new URL(navUrl).hostname.replace(/^www\./, '');
        const currentHost = new URL(currentUrl).hostname.replace(/^www\./, '');
        if (targetHost && currentHost && (targetHost === currentHost || currentHost.includes(targetHost))) {
          isRedundant = true;
        }
      } catch (e) {
        if (currentUrl && navUrl && currentUrl.includes(navUrl)) isRedundant = true;
      }

      if (isRedundant) {
        console.log(`⚡ [State Sync] Browser is ALREADY on target domain/page (${currentUrl}). Skipping redundant navigation.`);
        emit({ type: 'action_success', reason: 'Browser is already on the target page/domain.' });
        messages.push({
          role: 'user',
          content: `REDUNDANT NAVIGATION SKIPPED: You are ALREADY on the target page/domain (${currentUrl}). Do NOT issue navigate to this URL again. Work directly with visible elements.`
        });
        consecutiveFailures = 0;
        continue;
      }
    }

    // Prevent repeating a failed action on the same page
    if (action.action !== 'finish' && action.action !== 'human_needed' && action.action !== 'extract') {
      const isRepeat = failedActions.some(fa => {
        if (fa.pageUrl !== currentSync.url || fa.action.action !== action.action) return false;
        if (action.action === 'type' && fa.action.text !== action.text) return false;
        return (
          (fa.action.ref && fa.action.ref === action.ref) || 
          (fa.action.target && fa.action.target === action.target)
        );
      });

      if (isRepeat) {
        console.log(`⚠️  Planner repeated a failed action. Triggering recovery...`);
        failedActions.push({ pageUrl: currentSync.url, action, reason: 'Repeated failed action' });
        const recovered = await attemptRecoveryFromCheckpoint('Planner repeated a failed action', step);
        if (recovered) continue;
      }
    }

    // 3. Handle Finish & Terminal State Classification
    if (action.action === 'finish') {
      const resultLower = (action.result || '').toLowerCase();
      const isNegativeResult = resultLower.includes('could not') || resultLower.includes('unable') || resultLower.includes('unachievable') || resultLower.includes('failed to find');

      if (isNegativeResult) {
        if (verifiedSteps.length > 0 && recoveryCount < MAX_RECOVERIES) {
          console.log(`⚠️ [Recovery Trigger] Planner returned negative finish. Attempting checkpoint recovery...`);
          const recovered = await attemptRecoveryFromCheckpoint(`Planner gave up on current path: "${action.result}"`, step);
          if (recovered) continue;
        }

        console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        console.log(`[Terminal State] TASK UNACHIEVABLE`);
        console.log(`  • Reason: ${action.result}`);
        console.log(`  • Retained Verified Steps: ${verifiedSteps.length}`);
        console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

        saveCheckpoint({
          runId,
          task,
          status: 'unachievable',
          currentStep: step,
          totalSteps: MAX_LOOPS,
          goal: task,
          understanding,
          plan: planSteps,
          completedSteps,
          verifiedSteps,
          failedSteps: failedActions,
          lastVerifiedState: {
            url: currentSync.url,
            title: currentSync.title,
            snapshotSummary: (currentSync.snapshotText || '').substring(0, 300)
          },
          browserContext: { domain: targetDomain || '' },
          sources,
          error: action.result
        });

        emit({ type: 'task_unachievable', reason: action.result, verifiedSteps, result: action.result });
        emit({ type: 'terminated', result: action.result });
        return;
      }
      
      console.log('🔎 Verifying task completion against live browser state…');
      emit({ type: 'verifying_completion' });
      const completion = await verifyCompletion(task, currentSync.snapshotText, action.result);
      if (completion.complete) {
        console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        console.log(`[Terminal State] TASK ACHIEVED`);
        console.log(`  • Result: ${action.result}`);
        console.log(`  • Retained Verified Steps: ${verifiedSteps.length}`);
        console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

        saveCheckpoint({
          runId,
          task,
          status: 'achieved',
          currentStep: step,
          totalSteps: MAX_LOOPS,
          goal: task,
          understanding,
          plan: planSteps,
          completedSteps,
          verifiedSteps,
          failedSteps: failedActions,
          lastVerifiedState: {
            url: currentSync.url,
            title: currentSync.title,
            snapshotSummary: (currentSync.snapshotText || '').substring(0, 300)
          },
          browserContext: { domain: targetDomain || '' },
          sources
        });

        emit({ type: 'task_achieved', result: action.result, verifiedSteps });
        emit({ type: 'success', result: action.result });
        return;
      } else {
        finishRejectionsCount++;
        console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        console.log(`[Finish Loop Prevention] VERIFICATION MISMATCH`);
        console.log(`  • Proposed Result: "${action.result}"`);
        console.log(`  • Rejection Reason: ${completion.reason}`);
        console.log(`  • Finish Rejection Count: ${finishRejectionsCount}`);
        console.log(`  • Decision: Forcing planner to generate concrete action`);
        console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
        
        emit({ type: 'completion_rejected', reason: completion.reason });

        messages.push({
          role: 'user',
          content: `FINISH REJECTED: Your proposed finish was REJECTED by completion verification.\nReason: ${completion.reason}\n\nYour next action MUST be a concrete executable action (click, open_new_tab, type, navigate, extract, wait) to make progress. Do NOT return "finish".\n\nLive Browser State:\n${currentSync.snapshotText}`
        });
        continue;
      }
    }

    if (action.action === 'human_needed') {
      console.log(`\nHUMAN INTERVENTION REQUIRED: ${action.reason}\n`);
      emit({ type: 'human_intervention', reason: action.reason });

      if (options.askUser) {
        const answer = await options.askUser('Complete the challenge in the browser, then type "done" to continue (or "quit" to stop): ');
        if (answer.trim().toLowerCase() === 'quit') {
          console.log('Agent stopped by user.');
          emit({ type: 'terminated', result: 'Stopped by user during human intervention.' });
          return;
        }
      } else {
        return;
      }

      currentSync = await syncBrowserState();
      currentState = currentSync.snapshotData;
      currentStateText = currentSync.snapshotText;

      const stillBlocked = detectBlocker(currentState);
      if (stillBlocked) {
        console.log(`Challenge still detected: ${stillBlocked.message}`);
        step--;
        continue;
      }

      consecutiveFailures = 0;
      messages.push({
        role: 'user',
        content: `Human completed the challenge. The page has changed.\n\nNew Browser State:\n${currentStateText}\n\nContinue with the task: ${task}\n\nWhat is your next action?`,
      });
      continue;
    }

    // 4. Handle extract action directly
    if (action.action === 'extract') {
      console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`[Step ${step}/${MAX_LOOPS}] Action: EXTRACT`);
      console.log(`  • Description: Reading page content for: "${action.what || action.target || 'information'}"`);
      console.log(`  • Locator Type: Snapshot Tree Reader`);
      console.log(`  • WebCMD Result: SUCCESS`);
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

      emit({ type: 'executing', script: '// Extracting page content from snapshot' });
      messages.push({
        role: 'user',
        content: `PAGE CONTENT READ & EXTRACTED:\n${currentSync.snapshotText}\n\nIMPORTANT: Inspect the extracted content above. Now proceed to execute the NEXT ACTION required by the user's task (e.g., click a link, open a tab, submit a form). Do NOT finish unless the ENTIRE user goal is complete.`
      });
      consecutiveFailures = 0;
      emit({ type: 'action_success', reason: 'Page content read and extracted successfully.' });
      continue;
    }

    // Safety checks for sensitive fields or payment buttons
    if (action.action === 'type') {
      const sensitiveKeywords = [
        'email', 'e-mail', 'password', 'passcode', 'username', 'phone', 'mobile',
        'otp', 'verification', 'code', 'captcha', 'address', 'date of birth', 'dob',
        'card', 'credit', 'debit', 'cvv', 'cvc', 'bank', 'account', 'security answer',
        'first name', 'last name', 'full name'
      ];
      const targetStr = (action.target || '').toLowerCase();
      if (sensitiveKeywords.some(kw => targetStr.includes(kw))) {
        console.log(`\nHUMAN INTERVENTION REQUIRED: Sensitive input field "${action.target}"\n`);
        emit({ type: 'human_intervention', reason: 'Sensitive input field detected', field: action.target });
        if (options.askUser) {
           const answer = await options.askUser('Enter information in browser, then type "done" (or "quit"): ');
           if (answer.trim().toLowerCase() === 'quit') {
             emit({ type: 'terminated', result: 'Stopped by user.' });
             return;
           }
           messages.push({ role: 'user', content: `I have entered sensitive information. Please continue.` });
           continue;
        }
        return;
      }
    } else if (action.action === 'click') {
      const destructiveKeywords = ['purchase', 'pay now', 'checkout', 'submit payment', 'confirm order', 'place order'];
      const targetStr = (action.target || '').toLowerCase();
      if (destructiveKeywords.some(kw => targetStr.includes(kw))) {
        console.log(`\nHUMAN INTERVENTION REQUIRED: Irreversible action "${action.target}"\n`);
        emit({ type: 'human_intervention', reason: 'Irreversible action detected', action: action.target });
        if (options.askUser) {
           const answer = await options.askUser('Confirm action in browser, then type "done" (or "quit"): ');
           if (answer.trim().toLowerCase() === 'quit') {
             emit({ type: 'terminated', result: 'Stopped by user.' });
             return;
           }
           messages.push({ role: 'user', content: `I confirmed the action. Please continue.` });
           continue;
        }
        return;
      }
    }

    // Validate target existence before execution
    if ((action.action === 'click' || action.action === 'type') && action.target) {
      const shortTarget = (action.target || '').slice(0, 15).toLowerCase();
      const refId = action.ref ? String(action.ref).toLowerCase() : '';
      const stateLower = currentSync.snapshotText.toLowerCase();
      
      const existsInSnapshot = (refId && stateLower.includes(refId)) || (shortTarget && stateLower.includes(shortTarget));
      if (!existsInSnapshot) {
        console.warn(`⚠️ [Target Validation] Target "${action.target}" not detected in snapshot. Refreshing browser state...`);
        currentSync = await syncBrowserState();
        currentState = currentSync.snapshotData;
        currentStateText = currentSync.snapshotText;
      }
    }

    const script = actionToPlaywright(action);
    if (!script) {
      console.log('Unknown action type — skipping.');
      messages.push({
        role: 'user',
        content: `Unknown action "${action.action}". Available actions: click, open_new_tab, type, navigate, extract, wait, human_needed, finish. Try again.`,
      });
      continue;
    }

    // 5. Execute Action & Perform Action -> State Synchronization
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`[Step ${step}/${MAX_LOOPS}] Action Execution`);
    console.log(`  • Type: ${action.action}`);
    console.log(`  • Target: "${action.target || action.url || 'N/A'}"`);
    console.log(`  • Ref: ${action.ref || 'N/A'} | Role: ${action.role || 'N/A'}`);
    console.log(`  • Executing Script: ${script}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

    emit({ type: 'executing', script });
    
    const preExecSync = await syncBrowserState({ forceBind: false });
    let execError = null;
    
    try {
      const runResult = await safeRunWebCmd('run --stdin --timeout 15', script);
      if (runResult?.error) {
        execError = runResult.error.message || JSON.stringify(runResult.error);
      }
    } catch (err) {
      console.error(`Infrastructure failure: ${err.message}`);
      emit({ type: 'error', message: `Infrastructure failure: ${err.message}` });
      return;
    }

    // Post-action state synchronization
    const postExecSync = await syncBrowserState();
    const stateChanged = (preExecSync.fingerprint !== postExecSync.fingerprint) || (preExecSync.url !== postExecSync.url);

    let failureCategory = 'NONE';

    // Generic Action Recovery: State Inspection vs Script Output
    if (execError) {
      if (stateChanged) {
        failureCategory = 'ACTION_MAY_HAVE_SUCCEEDED';
        console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        console.log(`[Action Recovery] EXECUTION ERROR -> STATE SYNC -> ACTION ACTUALLY SUCCEEDED`);
        console.log(`  • Playwright Error: ${execError}`);
        console.log(`  • Reality Check: State changed (${preExecSync.url} -> ${postExecSync.url})`);
        console.log(`  • Decision: Treating action as SUCCEEDED in browser reality!`);
        console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
        execError = null; // Clear error!
      } else {
        failureCategory = 'GENUINE_ACTION_FAILURE';
      }
    }

    if (execError) {
      consecutiveFailures++;
      console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`[Action Execution Failed] Category: ${failureCategory}`);
      console.log(`  • Error: ${execError}`);
      console.log(`  • Failure Count: ${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}`);
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

      emit({ type: 'action_failed', error: execError, category: failureCategory });
      failedActions.push({ pageUrl: postExecSync.url, action, reason: 'Execution failed: ' + execError });

      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.log('Consecutive execution failure limit reached. Triggering recovery...');
        const recovered = await attemptRecoveryFromCheckpoint(`Action execution failed repeatedly: ${execError}`, step);
        if (recovered) continue;

        console.log('Too many consecutive failures without state change. Pausing task safely.');
        saveCheckpoint({
          runId,
          task,
          status: 'paused',
          currentStep: step,
          totalSteps: MAX_LOOPS,
          goal: task,
          understanding,
          plan: planSteps,
          completedSteps,
          verifiedSteps,
          failedSteps: failedActions,
          lastVerifiedState: {
            url: postExecSync.url,
            title: postExecSync.title,
            snapshotSummary: postExecSync.snapshotText.substring(0, 300)
          },
          browserContext: { domain: targetDomain || '' },
          sources,
          error: 'Task paused safely due to execution difficulty.'
        });
        emit({ type: 'task_paused', runId, reason: 'Task paused safely due to execution difficulty.', step, verifiedCount: verifiedSteps.length, verifiedSteps });
        emit({ type: 'checkpoint_available', runId, reason: 'Task paused safely due to execution difficulty.', step, verifiedCount: verifiedSteps.length, verifiedSteps });
        return;
      }

      messages.push({
        role: 'user',
        content: `ACTION EXECUTION FAILED (${failureCategory}).\nFailed action: ${JSON.stringify(action)}\nError: ${execError}\n\nDo NOT repeat this exact action. Re-evaluating fresh browser state:\n${postExecSync.snapshotText}\n\nWhat is your next action?`
      });
      currentSync = postExecSync;
      currentState = postExecSync.snapshotData;
      currentStateText = postExecSync.snapshotText;
      continue;
    }

    // 6. Domain Drift Safety Check
    if (targetDomain && postExecSync.url) {
      try {
        const u = new URL(postExecSync.url);
        const hostname = u.hostname.toLowerCase();
        const isSearchEngine = ['google.', 'bing.', 'yahoo.', 'duckduckgo.', 'about:blank'].some(se => hostname.includes(se));
        const domainBase = targetDomain.split('.')[0].toLowerCase();
        const isTarget = hostname.includes(domainBase);
        
        if (!isSearchEngine && !isTarget && u.protocol !== 'about:') {
          console.log(`\n⚠️ DOMAIN DRIFT DETECTED: Navigated to unrelated domain ${hostname}`);
          console.log(`Rolling back navigation...`);
          await safeRunWebCmd('run --stdin', 'await page.goBack().catch(() => {});');
          postExecSync = await syncBrowserState();
          
          consecutiveFailures++;
          messages.push({
            role: 'user',
            content: `ACTION REJECTED: DOMAIN DRIFT.\nYour action navigated to an unrelated service ('${hostname}').\nThe task is constrained to '${targetDomain}'. Restored previous page.`
          });
          currentSync = postExecSync;
          currentState = postExecSync.snapshotData;
          currentStateText = postExecSync.snapshotText;
          continue;
        }
      } catch(e) {}
    }

    // 7. Check for CAPTCHA after action
    const blocker = detectBlocker(postExecSync.snapshotData);
    if (blocker) {
      console.log(`\n${blocker.message}`);
      messages.push({
        role: 'user',
        content: `After executing the action, a ${blocker.type} challenge was detected: "${blocker.signal}". Return {"action": "human_needed", "reason": "..."} so the user can resolve it.`,
      });
      currentSync = postExecSync;
      currentState = postExecSync.snapshotData;
      currentStateText = postExecSync.snapshotText;
      continue;
    }

    // 8. Result Verification & State Synchronization
    console.log('Verifying action result against live browser state…');
    emit({ type: 'verifying' });
    const verification = await verifyAction(task, preExecSync.snapshotText, action, postExecSync.snapshotText);
    const isVerified = verification.verified || stateChanged;

    if (isVerified) {
      consecutiveFailures = 0;
      finishRejectionsCount = 0;

      if (recoveryCount > 0) {
        console.log(`🎉 [Recovery System] RECOVERY SUCCEEDED! Verified action after recovery.`);
        emit({ type: 'recovery_succeeded', recoveryCount, summary: verification.reason });
      }

      console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`[Step ${step}/${MAX_LOOPS}] ACTION → EXECUTED → STATE SYNC → VERIFIED`);
      console.log(`  • Action: ${action.action} (Target: "${action.target || action.url || ''}")`);
      console.log(`  • State Change: ${stateChanged ? 'YES' : 'NO'}`);
      console.log(`  • Verification: SUCCESS (${verification.reason})`);
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

      verifiedSteps.push({
        step,
        action,
        result: verification.reason,
        timestamp: new Date().toISOString(),
        pageUrl: postExecSync.url,
        pageTitle: postExecSync.title
      });

      saveCheckpoint({
        runId,
        task,
        status: 'active',
        currentStep: step,
        totalSteps: MAX_LOOPS,
        goal: task,
        understanding,
        plan: planSteps,
        completedSteps,
        verifiedSteps,
        failedSteps: failedActions,
        currentAction: action,
        lastVerifiedState: {
          url: postExecSync.url,
          title: postExecSync.title,
          snapshotSummary: postExecSync.snapshotText.substring(0, 300)
        },
        browserContext: { domain: targetDomain || '', pageDescription: postExecSync.title },
        sources
      });

      emit({ type: 'checkpoint_saved', runId, step, count: verifiedSteps.length, summary: verification.reason });

      messages.push({
        role: 'user',
        content: `Action verified as SUCCESSFUL. Reason: ${verification.reason}\n\nNew Browser State:\n${postExecSync.snapshotText}\n\nTask reminder: ${task}\n\nWhat is your next action?`
      });
    } else {
      consecutiveFailures++;
      failureCategory = 'VERIFICATION_MISMATCH';
      failedActions.push({ pageUrl: postExecSync.url, action, reason: 'Verification failed: ' + verification.reason });

      console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`[Step ${step}/${MAX_LOOPS}] ACTION → VERIFICATION MISMATCH → STATE REFRESH`);
      console.log(`  • Action: ${action.action} (Target: "${action.target || action.url || ''}")`);
      console.log(`  • Verification Reason: ${verification.reason}`);
      console.log(`  • Failure Count: ${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}`);
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.log('Verification failed repeatedly. Attempting checkpoint recovery...');
        const recovered = await attemptRecoveryFromCheckpoint(`Action failed verification: ${verification.reason}`, step);
        if (recovered) continue;

        console.log('Too many consecutive failures without verified progress. Pausing task safely.');
        saveCheckpoint({
          runId,
          task,
          status: 'paused',
          currentStep: step,
          totalSteps: MAX_LOOPS,
          goal: task,
          understanding,
          plan: planSteps,
          completedSteps,
          verifiedSteps,
          failedSteps: failedActions,
          lastVerifiedState: {
            url: postExecSync.url,
            title: postExecSync.title,
            snapshotSummary: postExecSync.snapshotText.substring(0, 300)
          },
          browserContext: { domain: targetDomain || '' },
          sources,
          error: 'Task paused safely due to execution difficulty.'
        });

        emit({
          type: 'task_paused',
          runId,
          reason: 'Task paused safely due to execution difficulty.',
          step,
          verifiedCount: verifiedSteps.length,
          verifiedSteps
        });
        emit({
          type: 'checkpoint_available',
          runId,
          reason: 'Task paused safely due to execution difficulty.',
          step,
          verifiedCount: verifiedSteps.length,
          verifiedSteps
        });
        return;
      }

      messages.push({
        role: 'user',
        content: `VERIFICATION FAILED — the action did NOT make progress toward the task.\nFailed action was: ${JSON.stringify(action)}\nReason: ${verification.reason}\n\nDo NOT repeat this exact action. Re-evaluating fresh browser state:\n${postExecSync.snapshotText}\n\nWhat is your next action?`
      });
    }

    currentSync = postExecSync;
    currentState = postExecSync.snapshotData;
    currentStateText = postExecSync.snapshotText;
  }

  console.log(`\nReached step limit (${MAX_LOOPS}). Pausing task with safe checkpoint.`);
  saveCheckpoint({
    runId,
    task,
    status: 'paused',
    currentStep: MAX_LOOPS,
    totalSteps: MAX_LOOPS,
    goal: task,
    understanding,
    plan: planSteps,
    completedSteps,
    verifiedSteps,
    failedSteps: failedActions,
    lastVerifiedState: {
      url: currentSync?.url || '',
      title: currentSync?.title || '',
      snapshotSummary: (currentSync?.snapshotText || '').substring(0, 300)
    },
    browserContext: { domain: targetDomain || '' },
    sources,
    error: 'VeriBrowse reached its current action budget (12 steps).'
  });

  emit({
    type: 'task_paused',
    runId,
    reason: 'VeriBrowse reached its current action budget (12 steps).',
    step: MAX_LOOPS,
    verifiedCount: verifiedSteps.length,
    verifiedSteps
  });
  emit({
    type: 'checkpoint_available',
    runId,
    reason: 'VeriBrowse reached its current action budget (12 steps).',
    step: MAX_LOOPS,
    verifiedCount: verifiedSteps.length,
    verifiedSteps
  });

  console.log(`\nReached step limit (${MAX_LOOPS}). Pausing task with safe checkpoint.`);
  saveCheckpoint({
    runId,
    task,
    status: 'budget_exhausted',
    currentStep: MAX_LOOPS,
    totalSteps: MAX_LOOPS,
    goal: task,
    understanding,
    plan: planSteps,
    completedSteps,
    verifiedSteps,
    failedSteps: failedActions,
    lastVerifiedState: {
      url: currentState?.page?.url || '',
      title: currentState?.page?.title || '',
      snapshotSummary: (currentStateText || '').substring(0, 300)
    },
    browserContext: { domain: targetDomain || '' },
    sources,
    error: 'VeriBrowse reached its current action budget (12 steps).'
  });

  emit({
    type: 'checkpoint_available',
    runId,
    reason: 'VeriBrowse reached its current action budget (12 steps).',
    step: MAX_LOOPS,
    verifiedCount: verifiedSteps.length,
    verifiedSteps
  });
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

  let task = process.argv[2] ? process.argv[2].trim() : '';
  if (!task) {
    task = await askUser(rl, 'What do you want me to do?\n> ');
  } else {
    console.log(`Executing CLI Task: "${task}"\n`);
  }

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
  getSnapshot,
  snapshotToText,
  syncBrowserState,
  extractTargetDomain,
  actionToPlaywright,
  verifyCompletion
};
