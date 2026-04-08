#!/usr/bin/env node

/**
 * greenhouse-apply.mjs — Auto-fill Greenhouse job application forms via Playwright
 *
 * Usage:
 *   node greenhouse-apply.mjs <url> <pdf-path> [--report=NNN] [--mode=semi|full] [--score=X.X]
 *
 * Mode:
 *   semi (default) — fills form, opens visible browser, you review and click Submit
 *   full           — fills and submits automatically (score must be >= min_score in profile.yml)
 *
 * Example:
 *   node greenhouse-apply.mjs \
 *     "https://job-boards.greenhouse.io/embed/job_app?for=sofi&token=7692745003" \
 *     ./output/cv-pramod-sofi-2026-04-07.pdf --report=002 --score=4.7
 */

import { chromium } from 'playwright';
import { resolve, join, dirname, basename } from 'path';
import { readFile, writeFile, readdir, access } from 'fs/promises';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── CLI ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let url, pdfPath;
let reportNum = null;
let mode = 'semi';
let scoreArg = null;

for (const arg of args) {
  if (arg.startsWith('--report=')) reportNum = arg.split('=')[1].padStart(3, '0');
  else if (arg.startsWith('--mode=')) mode = arg.split('=')[1].toLowerCase();
  else if (arg.startsWith('--score=')) scoreArg = parseFloat(arg.split('=')[1]);
  else if (!url) url = arg;
  else if (!pdfPath) pdfPath = arg;
}

if (!url || !pdfPath) {
  console.error('Usage: node greenhouse-apply.mjs <url> <pdf-path> [--report=NNN] [--mode=semi|full] [--score=X.X]');
  process.exit(1);
}
pdfPath = resolve(pdfPath);

// ─── Profile parser ───────────────────────────────────────────────────────────

/**
 * Minimal YAML section reader — no external dependency.
 * Reads all indented key: value lines under a top-level section.
 */
function readSection(yaml, section) {
  const re = new RegExp(`^${section}:\\s*$`, 'm');
  const m = re.exec(yaml);
  if (!m) return {};
  const after = yaml.slice(m.index + m[0].length);
  const end = after.match(/^\S/m);
  const block = end ? after.slice(0, end.index) : after;
  const out = {};
  for (const line of block.split('\n')) {
    const kv = line.match(/^\s{2,}(\w+):\s*["']?([^"'\n#]+?)["']?\s*(?:#.*)?$/);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}

function readNested(yaml, section, subsection) {
  // Get the section block, then re-parse it as if it's top-level
  const re = new RegExp(`^${section}:\\s*$`, 'm');
  const m = re.exec(yaml);
  if (!m) return {};
  const after = yaml.slice(m.index + m[0].length);
  const end = after.match(/^\S/m);
  const block = end ? after.slice(0, end.index) : after;
  // Re-call readSection on the block with 2-space dedent
  const dedented = block.replace(/^  /gm, '');
  return readSection(dedented, subsection);
}

// ─── Report parser ────────────────────────────────────────────────────────────

function parseSectionF(content) {
  const answers = {};
  const fBlock = content.match(/## F\).*?(?=\n## [A-Z]\)|\n---\n# |$)/s);
  if (!fBlock) return answers;
  const section = fBlock[0];

  // **"Question"** + STAR bullets
  for (const b of section.matchAll(/\*\*[""](.+?)[""]?\*\*\s*\n((?:[-*] \*\*[STAR]\*\*:.*\n?)+)/g)) {
    const q = b[1].trim().toLowerCase();
    const text = b[2].replace(/^[-*] \*\*[STAR]\*\*:\s*/gm, '').replace(/\n+/g, ' ').trim();
    answers[q] = text;
  }
  // **"Question"** + blockquote > "answer"
  for (const b of section.matchAll(/\*\*[""](.+?)[""]?\*\*\s*\n+>\s*[""]?(.+?)[""]?\s*\n/gs)) {
    answers[b[1].trim().toLowerCase()] = b[2].trim();
  }
  return answers;
}

async function loadReport(reportNumPadded, url) {
  const dir = join(__dirname, 'reports');
  let file = null;

  if (reportNumPadded) {
    const files = await readdir(dir);
    file = files.find(f => f.startsWith(reportNumPadded + '-'));
  } else {
    // Auto-detect from ?for=company in URL
    const m = url.match(/[?&]for=([^&]+)/);
    if (m) {
      const slug = m[1].toLowerCase();
      const files = await readdir(dir);
      file = files.filter(f => f.endsWith('.md')).find(f => f.toLowerCase().includes(slug));
    }
  }

  if (!file) return {};
  const content = await readFile(join(dir, file), 'utf-8');
  const answers = parseSectionF(content);
  console.log(`📋 Report: ${file} (${Object.keys(answers).length} STAR answers)`);
  return answers;
}

// ─── Safe fill/select helpers ─────────────────────────────────────────────────

/** Fill a single input field — silently skips if selector not found. */
async function fill(page, selector, value, label) {
  if (!value && value !== 0) return false;
  try {
    const loc = page.locator(selector).first();
    if (await loc.count() === 0) return false;
    await loc.fill(String(value));
    console.log(`   ✓ ${label || selector}`);
    return true;
  } catch (e) {
    console.log(`   ✗ ${label || selector}: ${e.message.split('\n')[0]}`);
    return false;
  }
}

/** Select a dropdown option by label text — silently skips if not found/matched. */
async function select(page, selector, value, label) {
  if (!value) return false;
  try {
    const loc = page.locator(selector).first();
    if (await loc.count() === 0) return false;
    // Try by label text first, then by value
    try {
      await loc.selectOption({ label: value });
    } catch {
      await loc.selectOption(value);
    }
    console.log(`   ✓ ${label || selector}: ${value}`);
    return true;
  } catch (e) {
    console.log(`   ✗ ${label || selector}: ${e.message.split('\n')[0]}`);
    return false;
  }
}

/** Check a checkbox or radio — silently skips if not found. */
async function check(page, selector, label) {
  try {
    const loc = page.locator(selector).first();
    if (await loc.count() === 0) return false;
    await loc.check();
    console.log(`   ✓ ${label || selector}`);
    return true;
  } catch {
    return false;
  }
}

/** Upload a file to a file input — tries multiple selectors. */
async function upload(page, selectors, filePath, label) {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.count() === 0) continue;
      await loc.setInputFiles(filePath);
      await page.waitForTimeout(1500);  // let form JS register the file
      console.log(`   ✓ ${label}: ${basename(filePath)}`);
      return true;
    } catch { /* try next */ }
  }
  console.log(`   ✗ ${label}: no matching input found`);
  return false;
}

// ─── Cover letter generator ───────────────────────────────────────────────────

function generateCoverLetter(candidate, companySlug, sectionFAnswers) {
  const company = companySlug.charAt(0).toUpperCase() + companySlug.slice(1);

  // Use "Why company?" answer from Section F if available
  const whyKey = Object.keys(sectionFAnswers).find(k => k.includes('why') && k.includes(companySlug.toLowerCase()));
  const whyAnswer = whyKey ? sectionFAnswers[whyKey] : null;

  const why = whyAnswer
    ? whyAnswer
    : `I've spent the past 4 years building high-throughput Java/Spring Boot microservices in fintech — including a payment platform processing 500K+ daily transactions where I delivered a 60% p95 latency reduction and 40% throughput improvement. ${company}'s Java/Spring Boot/Kubernetes stack and fintech domain are a direct match to where I have the most depth and the most impact.`;

  return `I am writing to express my interest in the Software Engineer role at ${company}.

${why}

My background maps directly to this role: Java/Spring Boot microservices (3 roles, 4+ years), AWS cloud infrastructure, Kafka-based event streaming, Kubernetes deployments, and data architecture. I hold an AWS Certified Developer certification and a Master's in Information Technology from the University of Cincinnati.

I would welcome the opportunity to discuss how my experience with high-throughput financial systems can contribute to ${company}'s engineering goals.

Best regards,
${candidate.full_name}
${candidate.email}`;
}

// ─── Tracker update ───────────────────────────────────────────────────────────

async function updateTracker(url, newStatus) {
  try {
    const path = join(__dirname, 'data/applications.md');
    const content = await readFile(path, 'utf-8');
    const m = url.match(/[?&]for=([^&]+)/);
    if (!m) return;
    const company = m[1].charAt(0).toUpperCase() + m[1].slice(1);
    const updated = content.replace(
      new RegExp(`(\\| *${company}[^|]*\\|[^|]*\\|) *Evaluated *(\\|)`, 'i'),
      `$1 ${newStatus} $2`
    );
    if (updated !== content) {
      await writeFile(path, updated);
      console.log(`📊 Tracker: ${company} → ${newStatus}`);
    }
  } catch { /* non-critical */ }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Load profile
  let yaml;
  try {
    yaml = await readFile(join(__dirname, 'config/profile.yml'), 'utf-8');
  } catch {
    console.error('❌ config/profile.yml not found');
    process.exit(1);
  }

  const C = readSection(yaml, 'candidate');
  const addr = readSection(yaml, 'address');
  const edu = readSection(yaml, 'education');
  const da = readNested(yaml, 'auto_apply', 'default_answers');

  // Salary: read from default_answers or compute from compensation section
  const comp = readSection(yaml, 'compensation');
  const salary = da.salary_expectation || (() => {
    const m = (comp.minimum || comp.target_range || '').match(/([\d,]+)/);
    return m ? m[1].replace(',', '') : '95000';
  })();

  // Score gate
  const minScoreMatch = yaml.match(/^\s+min_score:\s*([\d.]+)/m);
  const minScore = minScoreMatch ? parseFloat(minScoreMatch[1]) : 4.0;
  if (mode === 'full' && scoreArg !== null && scoreArg < minScore) {
    console.log(`⚠️  Score ${scoreArg} < min_score ${minScore} — switching to semi`);
    mode = 'semi';
  }

  // Validate PDF
  try { await access(pdfPath); } catch {
    console.error(`❌ PDF not found: ${pdfPath}`);
    process.exit(1);
  }

  // Load report answers
  const sectionF = await loadReport(reportNum, url);

  // Parse candidate
  const [firstName, ...lastParts] = (C.full_name || '').split(' ');
  const lastName = lastParts.join(' ');
  const linkedin = (C.linkedin || '').startsWith('http') ? C.linkedin : `https://${C.linkedin}`;

  // Cover letter text
  const companySlug = (url.match(/[?&]for=([^&]+)/) || [])[1] || 'company';
  const coverLetterText = generateCoverLetter(C, companySlug, sectionF);

  // Resume plain text (for resume_text textarea) — read cv.md
  let resumePlainText = '';
  try {
    resumePlainText = await readFile(join(__dirname, 'cv.md'), 'utf-8');
    // Strip markdown formatting for plain text field
    resumePlainText = resumePlainText
      .replace(/^#{1,6}\s+/gm, '')          // Remove headings
      .replace(/\*\*(.*?)\*\*/g, '$1')       // Remove bold
      .replace(/\*(.*?)\*/g, '$1')           // Remove italic
      .replace(/^[-*]\s+/gm, '• ')           // Normalize bullets
      .replace(/\|[^|\n]+/g, '')             // Remove table pipes
      .replace(/\n{3,}/g, '\n\n')            // Collapse multiple blanks
      .trim();
  } catch { /* cv.md not found — leave blank */ }

  // Today's date in MM/DD/YY format
  const today = new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit' });

  console.log(`\n🤖 Greenhouse Auto-Apply`);
  console.log(`   Mode:      ${mode.toUpperCase()}`);
  console.log(`   URL:       ${url}`);
  console.log(`   PDF:       ${basename(pdfPath)}`);
  console.log(`   Candidate: ${C.full_name}\n`);

  const browser = await chromium.launch({ headless: mode === 'full', slowMo: 30 });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Wait for the form to render
    await page.waitForSelector('[name="first_name"], [name="email"]', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);

    // ── 1. Standard personal fields ─────────────────────────────────────────
    console.log('── Personal fields');
    await fill(page, '[name="first_name"]', firstName,   'First Name');
    await fill(page, '[name="last_name"]',  lastName,    'Last Name');
    await fill(page, '[name="email"]',      C.email,     'Email');
    await fill(page, '[name="phone"]',      C.phone,     'Phone');
    await fill(page, '[name="candidate_location"]', C.location || `${addr.city}, ${addr.state}`, 'Location');

    // ── 2. Resume file upload ────────────────────────────────────────────────
    console.log('── Resume');
    await upload(page,
      ['[name="resume"]', 'input[type="file"][id*="resume"]', 'input[type="file"]:first-of-type'],
      pdfPath, 'Resume file'
    );

    // Resume plain text (textarea fallback — Greenhouse shows this if file upload not supported)
    if (resumePlainText) {
      await fill(page, '[name="resume_text"], textarea[id*="resume_text"]', resumePlainText, 'Resume text');
    }

    // ── 3. Cover letter ──────────────────────────────────────────────────────
    console.log('── Cover Letter');
    // File: upload same PDF (common practice; user can swap in browser)
    await upload(page,
      ['[name="cover_letter"]', 'input[type="file"][id*="cover_letter"]', 'input[type="file"]:nth-of-type(2)'],
      pdfPath, 'Cover letter file'
    );
    // Text
    await fill(page, '[name="cover_letter_text"]', coverLetterText, 'Cover letter text');

    // ── 4. Custom questions — by exact [name] attribute ──────────────────────
    // These are fetched directly by the known field names from the form schema.
    // No label guessing needed — [name="question_XXXXXXX"] is reliable.
    console.log('── Custom questions');

    await fill(page,   '[name="question_30347598003"]', linkedin, 'LinkedIn');

    await select(page, '[name="question_30347599003"]', 'Yes', 'Work authorized');
    await select(page, '[name="question_30347600003"]', 'No',  'Sponsorship required');
    await select(page, '[name="question_30347601003"]', 'No',  'Prior SoFi employment');
    await select(page, '[name="question_30347602003"]', edu.degree || "Master's", 'Degree type');
    await fill(page,   '[name="question_30347603003"]', edu.field || 'Information Technology', 'Field of study');
    await select(page, '[name="question_30347604003"]', '5+ Years', 'Years of experience');

    // SMS consent — required, single option (Yes = agree to receive texts)
    // Try as select first, then as checkbox
    const smsSelected = await select(page, '[name="question_30347605003"]', 'Yes', 'SMS consent');
    if (!smsSelected) {
      await check(page, '[name="question_30347605003"]', 'SMS consent (checkbox)');
    }

    await select(page, '[name="question_30347606003"]', 'No',  'Deloitte employment');
    await select(page, '[name="question_30347607003"]', 'No',  'Current SoFi employee');
    await fill(page,   '[name="question_30347608003"]', today, 'Application date');
    await select(page, '[name="question_30347609003"]', 'No',  'FINRA intent');

    // FINRA licenses multi-select — select N/A
    try {
      const finra = page.locator('[name="question_30347610003[]"]').first();
      if (await finra.count() > 0) {
        await finra.selectOption({ label: 'N/A' });
        console.log('   ✓ FINRA licenses: N/A');
      }
    } catch (e) {
      console.log(`   ✗ FINRA licenses: ${e.message.split('\n')[0]}`);
    }

    // Location/commute question — Yes = willing to work in the role's location (remote OK)
    await select(page, '[name="question_30347611003"]', 'Yes', 'Location/commute');

    // ── 5. Address fields ────────────────────────────────────────────────────
    console.log('── Address');
    await fill(page, '[name="question_30347612003"]', addr.line1 || '', 'Address Line 1');
    await fill(page, '[name="question_30347613003"]', addr.line2 || '', 'Address Line 2');
    await fill(page, '[name="question_30347614003"]', addr.city  || 'Dallas', 'City');
    await fill(page, '[name="question_30347615003"]', addr.state || 'TX',     'State');
    await fill(page, '[name="question_30347616003"]', addr.zip   || '', 'Zip');
    await select(page, '[name="question_30347617003"]', 'United States of America', 'Country');

    // ── 6. Education fields (Greenhouse standard) ────────────────────────────
    // These use a different name pattern — try label-based as fallback
    console.log('── Education');
    // Degree select inside the education section
    await select(page, 'select[name*="education"][name*="degree"], [id*="education"][id*="degree"]',
      edu.degree || "Master's", 'Education degree');
    // School — try to type University of Cincinnati
    const schoolInput = page.locator('input[name*="school"], input[id*="school"], input[placeholder*="school" i]').first();
    if (await schoolInput.count() > 0) {
      await schoolInput.fill(edu.school || 'University of Cincinnati');
      await page.waitForTimeout(800);
      // If it's a typeahead, press first option
      const firstOption = page.locator('[role="option"], .select2-result, li.ui-menu-item').first();
      if (await firstOption.count() > 0) await firstOption.click().catch(() => {});
      console.log('   ✓ School: University of Cincinnati');
    }

    // ── 7. Screenshot ────────────────────────────────────────────────────────
    await page.waitForTimeout(500);
    const shot = '/tmp/greenhouse-form-filled.png';
    await page.screenshot({ path: shot, fullPage: true });
    console.log(`\n📸 Screenshot: ${shot}`);

    // ── Semi-auto handoff ─────────────────────────────────────────────────────
    if (mode === 'semi') {
      console.log('\n' + '─'.repeat(60));
      console.log('🔵  SEMI-AUTO: Form is filled. Browser is open.');
      if (!addr.line1) console.log('⚠️   Fill in Address Line 1 and Zip before submitting.');
      console.log('    Review everything, fix any fields, then click Submit.');
      console.log('─'.repeat(60) + '\n');
      await page.waitForEvent('close', { timeout: 0 }).catch(() => {});
      await browser.close().catch(() => {});
      return;
    }

    // ── Full-auto submit ──────────────────────────────────────────────────────
    if (!addr.line1 || !addr.zip) {
      console.error('❌ Cannot auto-submit: address.line1 and address.zip are empty in config/profile.yml');
      console.log('   Fill them in, then rerun with --mode=full');
      await page.waitForEvent('close', { timeout: 0 }).catch(() => {});
      await browser.close().catch(() => {});
      return;
    }

    console.log('\n🚀 FULL-AUTO: submitting...');
    const btn = page.locator('button[type="submit"], input[type="submit"], button:has-text("Submit")').first();
    if (await btn.count() === 0) {
      console.error('❌ Submit button not found');
      await page.waitForEvent('close', { timeout: 0 }).catch(() => {});
      await browser.close().catch(() => {});
      return;
    }

    await btn.click();
    await page.waitForTimeout(4000);
    await page.screenshot({ path: '/tmp/greenhouse-submit-confirm.png' });
    console.log('✅ Submitted! Screenshot: /tmp/greenhouse-submit-confirm.png');
    await updateTracker(url, 'Applied');
    await browser.close();

  } catch (err) {
    await page.screenshot({ path: '/tmp/greenhouse-error.png' }).catch(() => {});
    console.error(`\n❌ Error: ${err.message}`);
    console.error('   Screenshot: /tmp/greenhouse-error.png');
    await browser.close().catch(() => {});
    process.exit(1);
  }
}

main().catch(err => {
  console.error(`\n❌ Fatal: ${err.message}`);
  process.exit(1);
});
