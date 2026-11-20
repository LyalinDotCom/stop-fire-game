#!/usr/bin/env node
/**
 * EMBER FRONT — Full Build, Test, Bundle & Headless Chromium Visual QA Suite
 *
 * Runs:
 *   1. npm run net:rules:check
 *   2. npm test (test/sim.test.mjs + test/net.test.mjs)
 *   3. npm run build + gzipped chunk & lazy Firebase code-splitting check
 *   4. Headless /usr/bin/google-chrome (SwiftShader WebGL) via Playwright:
 *      - Solo DEMO FLIGHT: 0 console/page errors, 0 Firebase requests,
 *        640x360 internal WebGL canvas upscaled to 1280x720, < 25 draw calls,
 *        crisp HUD checks, NO @loktar00 / GPT-6.2 Astra text -> 01-demo-flight.png
 *      - Manual takeover + water drop curtain + reticle + RELEASING badge -> 02-manual-drop.png
 *      - South sky check at 188 deg (0 UV seam) -> 03-south-sky-check.png
 *      - [?] Settings / Squadron drawer open + callsign input isolation -> 04-settings-drawer.png
 *      - ?loopback=100 Cascadia Mega-Basin 100 floatplanes, 16 liveries, < 25 draw calls -> 05-loopback-100p.png
 */

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(__dirname, '..', '..');
const DEFAULT_SHOT_DIR =
  process.env.QA_SHOT_DIR ||
  path.join(PROJECT_DIR, 'qa-screenshots');
const PORT = Number(process.env.QA_PORT || 5185);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';

const ENV = {
  ...process.env,
  PATH: `${process.env.HOME}/.local/bin:${process.env.PATH || ''}`,
};

function assert(cond, msg) {
  if (!cond) {
    throw new Error(`QA ASSERTION FAILED: ${msg}`);
  }
}

function runSync(cmd, args, label) {
  console.log(`\n=== ${label}: ${cmd} ${args.join(' ')} ===`);
  const out = execFileSync(cmd, args, {
    cwd: PROJECT_DIR,
    env: ENV,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  process.stdout.write(out);
  return out;
}

async function loadPlaywright() {
  const candidates = [
    path.join(PROJECT_DIR, 'node_modules/playwright-core/index.mjs'),
    path.join(PROJECT_DIR, 'node_modules/playwright/index.mjs'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const mod = await import(pathToFileURL(p).href);
      return mod.chromium ? mod : mod.default || mod;
    }
  }
  const mod = await import('playwright-core');
  return mod.chromium ? mod : mod.default || mod;
}

function analyzeDistBundle() {
  const assetsDir = path.join(PROJECT_DIR, 'dist', 'assets');
  assert(fs.existsSync(assetsDir), `Missing ${assetsDir}; run vite build first`);
  const files = fs.readdirSync(assetsDir).sort();
  const chunks = [];
  let totalRaw = 0;
  let totalGzip = 0;
  let firebaseChunk = null;

  for (const name of files) {
    const full = path.join(assetsDir, name);
    const stat = fs.statSync(full);
    if (!stat.isFile()) continue;
    const buf = fs.readFileSync(full);
    const gz = zlib.gzipSync(buf, { level: 9 }).length;
    totalRaw += buf.length;
    totalGzip += gz;
    const info = { name, rawBytes: buf.length, gzipBytes: gz };
    chunks.push(info);
    if (/firebase/i.test(name)) firebaseChunk = info;
  }

  const indexHtml = fs.readFileSync(path.join(PROJECT_DIR, 'dist', 'index.html'), 'utf8');
  // Verify firebase chunk is NOT statically preloaded or imported by index.html
  if (firebaseChunk) {
    assert(
      !indexHtml.includes(firebaseChunk.name),
      `Firebase chunk ${firebaseChunk.name} must NOT be statically referenced in dist/index.html`
    );
  }
  // Verify zero inline scripts in index.html (strict CSP)
  const inlineScriptMatches = [...indexHtml.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
  assert(inlineScriptMatches.length === 0, 'dist/index.html must contain zero inline <script> tags');

  return { chunks, totalRaw, totalGzip, firebaseChunk };
}

async function waitForServer(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Preview server did not become ready at ${url} within ${timeoutMs} ms`);
}

function startPreviewServer() {
  const child = spawn(
    'npx',
    ['vite', 'preview', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'],
    {
      cwd: PROJECT_DIR,
      env: ENV,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  child.stdout.on('data', (d) => process.stdout.write(`[vite-preview] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[vite-preview] ${d}`));
  return child;
}

async function waitFrames(page, count = 6) {
  await page.evaluate(
    (n) =>
      new Promise((resolve) => {
        let i = 0;
        function step() {
          if (++i >= n) resolve();
          else requestAnimationFrame(step);
        }
        requestAnimationFrame(step);
      }),
    count
  );
}

async function main() {
  fs.mkdirSync(DEFAULT_SHOT_DIR, { recursive: true });

  // 1. Rules check, Unit tests, Production build
  runSync('npm', ['run', 'net:rules:check'], 'RTDB Rules Drift Check');
  runSync('npm', ['test'], 'Unit Test Suite (sim + net)');
  runSync('npm', ['run', 'build'], 'Production Build');

  const bundle = analyzeDistBundle();
  console.log('\n=== Bundle Summary ===');
  for (const c of bundle.chunks) {
    console.log(
      `  ${c.name.padEnd(40)} raw=${(c.rawBytes / 1024).toFixed(1).padStart(7)} KB  gzip=${(
        c.gzipBytes / 1024
      )
        .toFixed(1)
        .padStart(6)} KB`
    );
  }
  console.log(
    `  TOTAL${' '.repeat(35)} raw=${(bundle.totalRaw / 1024).toFixed(1).padStart(7)} KB  gzip=${(
      bundle.totalGzip / 1024
    )
      .toFixed(1)
      .padStart(6)} KB`
  );

  // 2. Start preview server + launch headless Chrome
  const server = startPreviewServer();
  let browser = null;
  const report = {
    bundle,
    solo: null,
    manualDrop: null,
    southSky: null,
    drawer: null,
    loopback: null,
    screenshots: {},
  };

  try {
    await waitForServer(BASE_URL);
    const pw = await loadPlaywright();
    browser = await pw.chromium.launch({
      executablePath: CHROME_PATH,
      headless: true,
      args: [
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-webgl',
        '--ignore-gpu-blocklist',
        '--no-sandbox',
        '--disable-dev-shm-usage',
      ],
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();

    const consoleErrors = [];
    const pageErrors = [];
    const requests = [];
    const failedResponses = [];

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });
    page.on('pageerror', (err) => {
      pageErrors.push(err.message || String(err));
    });
    page.on('request', (req) => {
      requests.push(req.url());
    });
    page.on('response', (res) => {
      if (res.status() >= 400) {
        failedResponses.push(`${res.status()} ${res.url()}`);
      }
    });

    // =========================================================================
    // Scenario 1: Solo DEMO FLIGHT on Operation 01 / 05: Cinderpine Basin
    // =========================================================================
    console.log('\n=== Scenario 1: Solo DEMO FLIGHT ===');
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => Boolean(window.__EMBER_FRONT__), { timeout: 15000 });
    await waitFrames(page, 25);
    await page.waitForTimeout(1200);

    const soloReqs = [...requests];
    const firebaseReqs = soloReqs.filter((u) =>
      /firebase|identitytoolkit|securetoken/i.test(u)
    );
    assert(
      firebaseReqs.length === 0,
      `Solo mode must make 0 Firebase requests/chunk downloads, found: ${firebaseReqs.join(', ')}`
    );

    const soloCheck = await page.evaluate(() => {
      const state = window.__EMBER_FRONT__.getState();
      const canvas = document.getElementById('game-canvas');
      const rect = canvas.getBoundingClientRect();
      const style = window.getComputedStyle(canvas);
      const bodyText = document.body.innerText || '';
      const minimap = document.querySelector('#hud-root canvas');
      const tankSegs = document.querySelectorAll('.ef-tank-seg, [data-tank-segment], .tank-seg, .tank-segment').length;
      return {
        state,
        canvasW: canvas.width,
        canvasH: canvas.height,
        cssW: Math.round(rect.width),
        cssH: Math.round(rect.height),
        imageRendering: style.imageRendering,
        hasMinimap: Boolean(minimap),
        tankSegs,
        bodyText,
      };
    });

    assert(soloCheck.canvasW === 640 && soloCheck.canvasH === 360, `Expected 640x360 canvas, got ${soloCheck.canvasW}x${soloCheck.canvasH}`);
    assert(soloCheck.cssW === 1280 && soloCheck.cssH === 720, `Expected 1280x720 viewport upscale, got ${soloCheck.cssW}x${soloCheck.cssH}`);
    assert(
      /pixelated|crisp-edges/i.test(soloCheck.imageRendering),
      `Expected pixelated image-rendering, got ${soloCheck.imageRendering}`
    );
    assert(
      soloCheck.state.drawCalls > 0 && soloCheck.state.drawCalls < 25,
      `Expected 1..24 draw calls in Solo, got ${soloCheck.state.drawCalls}`
    );
    assert(soloCheck.hasMinimap, 'Expected Tactical Map 2D canvas inside #hud-root');
    assert(soloCheck.tankSegs === 20, `Expected 20 water tank segments, got ${soloCheck.tankSegs}`);

    // HUD text checks
    const txt = soloCheck.bodyText;
    for (const needle of [
      'EMBER',
      'FRONT',
      'OPERATION 01 / 05',
      'CINDERPINE BASIN',
      'WIND VECTOR',
      'FLIGHT TELEMETRY',
      'WATER TANK',
      'MISSION SCORE',
      'DEMO FLIGHT',
    ]) {
      assert(txt.toUpperCase().includes(needle), `Missing HUD text: ${needle}`);
    }
    assert(!txt.includes('@loktar00'), 'Forbidden @loktar00 text found in DOM!');
    assert(!/GPT-6\.2\s*Astra/i.test(txt), 'Forbidden GPT-6.2 Astra text found in DOM!');

    const shot1 = path.join(DEFAULT_SHOT_DIR, '01-demo-flight.png');
    await page.screenshot({ path: shot1, fullPage: false });
    report.screenshots.demoFlight = shot1;
    report.solo = {
      drawCalls: soloCheck.state.drawCalls,
      renderWidth: soloCheck.canvasW,
      renderHeight: soloCheck.canvasH,
      firebaseRequests: firebaseReqs.length,
      tankSegs: soloCheck.tankSegs,
      fireSummary: soloCheck.state.fireSummary,
    };
    console.log('  Solo OK:', JSON.stringify(report.solo));

    // =========================================================================
    // Scenario 2: Manual Control Takeover + Water Drop Curtain + RELEASING
    // =========================================================================
    console.log('\n=== Scenario 2: Manual Drop ===');
    await page.keyboard.down('KeyW');
    await waitFrames(page, 3);
    await page.keyboard.up('KeyW');
    await waitFrames(page, 2);

    // Hold SPACE to release water curtain and capture while actively releasing (mid-dump)
    await page.keyboard.down('Space');
    await page.waitForFunction(
      () => {
        const s = window.__EMBER_FRONT__.getState();
        return !s.aircraft.autopilot && s.aircraft.releasing && s.aircraft.tankPct < 90;
      },
      { timeout: 8000 }
    );
    await waitFrames(page, 4);

    const dropState = await page.evaluate(() => ({
      state: window.__EMBER_FRONT__.getState(),
      bodyText: document.body.innerText || '',
    }));
    assert(!dropState.state.aircraft.autopilot, 'Expected manual mode after pressing W');
    assert(dropState.state.aircraft.releasing, 'Expected aircraft.releasing === true while holding SPACE');
    assert(
      dropState.bodyText.toUpperCase().includes('RELEASING'),
      'Expected RELEASING badge in Flight Telemetry while dropping water'
    );

    const shot2 = path.join(DEFAULT_SHOT_DIR, '02-manual-drop.png');
    await page.screenshot({ path: shot2, fullPage: false });
    await page.keyboard.up('Space');
    report.screenshots.manualDrop = shot2;
    report.manualDrop = {
      releasing: dropState.state.aircraft.releasing,
      tankPct: dropState.state.aircraft.tankPct,
      drawCalls: dropState.state.drawCalls,
    };
    console.log('  Manual Drop OK:', JSON.stringify(report.manualDrop));

    // =========================================================================
    // Scenario 3: Due South (188 deg) Skybox UV Seam Check
    // =========================================================================
    console.log('\n=== Scenario 3: South Sky Seam Check (188 deg) ===');
    await page.evaluate(() => {
      window.__EMBER_FRONT__.setCameraYaw(188, 12);
    });
    await waitFrames(page, 10);

    const southState = await page.evaluate(() => window.__EMBER_FRONT__.getState());
    assert(
      Math.abs(southState.aircraft.yawDeg - 188) < 5,
      `Expected heading ~188 deg, got ${southState.aircraft.yawDeg}`
    );

    const shot3 = path.join(DEFAULT_SHOT_DIR, '03-south-sky-check.png');
    await page.screenshot({ path: shot3, fullPage: false });
    report.screenshots.southSky = shot3;
    report.southSky = {
      yawDeg: southState.aircraft.yawDeg,
      pitchDeg: southState.aircraft.pitchDeg,
      drawCalls: southState.drawCalls,
    };
    console.log('  South Sky OK:', JSON.stringify(report.southSky));

    // =========================================================================
    // Scenario 4: [?] Settings / Mode / Squadron Drawer Open
    // =========================================================================
    console.log('\n=== Scenario 4: Settings Drawer ===');
    await page.keyboard.press('KeyH');
    await waitFrames(page, 8);

    const drawerCheck = await page.evaluate(() => {
      const state = window.__EMBER_FRONT__.getState();
      const input = document.querySelector('#hud-root input[type="text"], #hud-root input:not([type="checkbox"])');
      return { drawerOpen: state.drawerOpen, hasCallsignInput: Boolean(input) };
    });
    assert(drawerCheck.drawerOpen, 'Expected [?] drawer to open on H keypress');

    // Verify typing inside callsign input does not close drawer or leak hotkeys
    if (drawerCheck.hasCallsignInput) {
      const inputLoc = page.locator('#hud-root input[type="text"], #hud-root input:not([type="checkbox"])').first();
      await inputLoc.click();
      await inputLoc.fill('HAWK-07');
      await page.keyboard.type('HM'); // would toggle drawer/mute if input guard failed!
      const stillOpen = await page.evaluate(() => window.__EMBER_FRONT__.getState().drawerOpen);
      assert(stillOpen, 'Typing H inside callsign input must NOT close drawer');
      await inputLoc.fill('EF-07');
    }

    const shot4 = path.join(DEFAULT_SHOT_DIR, '04-settings-drawer.png');
    await page.screenshot({ path: shot4, fullPage: false });
    report.screenshots.settingsDrawer = shot4;
    report.drawer = drawerCheck;
    console.log('  Settings Drawer OK:', JSON.stringify(report.drawer));

    // Log any Solo console/page errors now, and assert at the end after Scenario 5 also runs
    if (failedResponses.length > 0) {
      console.warn('  Failed HTTP responses during Solo:', failedResponses);
    }

    // =========================================================================
    // Scenario 5: ?loopback=100 Cascadia Mega-Basin (100 Active Floatplanes)
    // =========================================================================
    console.log('\n=== Scenario 5: ?loopback=100 Cascadia Mega-Basin ===');
    const preLoopbackReqIdx = requests.length;
    await page.goto(`${BASE_URL}/?loopback=100`, { waitUntil: 'networkidle' });
    await page.waitForFunction(
      () => {
        if (!window.__EMBER_FRONT__) return false;
        const s = window.__EMBER_FRONT__.getState();
        return s.mode === 'loopback' && s.remoteCount >= 95;
      },
      { timeout: 30000 }
    );
    await waitFrames(page, 10);

    const loopbackReqs = requests.slice(preLoopbackReqIdx);
    const loopbackFbReqs = loopbackReqs.filter((u) =>
      /\/firebase-[^/]+\.js|firebaseio|firebasedatabase|identitytoolkit|securetoken/i.test(u)
    );
    assert(
      loopbackFbReqs.length === 0,
      `Loopback 100-bot mode must make 0 Firebase SDK/network requests, found: ${loopbackFbReqs.join(', ')}`
    );

    const lbState = await page.evaluate(() => ({
      state: window.__EMBER_FRONT__.getState(),
      bodyText: document.body.innerText || '',
    }));

    assert(
      lbState.state.remoteCount >= 95,
      `Expected >= 95 active remote instanced floatplanes in ?loopback=100, got ${lbState.state.remoteCount}`
    );
    assert(
      lbState.state.drawCalls > 0 && lbState.state.drawCalls < 25,
      `Expected < 25 draw calls in 100-plane Mega-Basin, got ${lbState.state.drawCalls}`
    );
    assert(
      lbState.bodyText.toUpperCase().includes('MEGA-BASIN') ||
        lbState.bodyText.toUpperCase().includes('CASCADIA'),
      'Expected Mega-Basin / Cascadia HUD briefing in ?loopback=100'
    );

    const shot5 = path.join(DEFAULT_SHOT_DIR, '05-loopback-100p.png');
    await page.screenshot({ path: shot5, fullPage: false });
    report.screenshots.loopback100 = shot5;
    report.loopback = {
      remoteCount: lbState.state.remoteCount,
      pilotsCount: lbState.state.netState.pilotsCount,
      drawCalls: lbState.state.drawCalls,
      triangles: lbState.state.triangles,
      fps: lbState.state.fps,
      fireSummary: lbState.state.fireSummary,
    };
    console.log('  Loopback 100P OK:', JSON.stringify(report.loopback));

    assert(
      consoleErrors.length === 0,
      `Console errors total: ${consoleErrors.join(' | ')} (failed responses: ${failedResponses.join(', ')})`
    );
    assert(pageErrors.length === 0, `Page errors total: ${pageErrors.join(' | ')}`);

    console.log('\n=== ALL QA CHECKS PASSED ===');
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
  }
}

main().catch((err) => {
  console.error('\nQA VERIFICATION FAILED:', err);
  process.exit(1);
});
