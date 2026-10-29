// ==UserScript==
// @name         Auto Typer voor Google Docs
// @namespace    https://github.com/Wander2026projects/Auto-typer
// @version      1.1.0
// @description  Typt geplakte tekst letter voor letter in Google Docs, met instelbare snelheid (woorden per minuut), menselijke variatie, pauzes en tikfouten. Met Verbeter-typer: past alleen de veranderde woorden aan.
// @author       Wander2026projects
// @match        https://docs.google.com/document/*
// @run-at       document-idle
// @inject-into  content
// @noframes
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  if (window.__autoTyperLoaded) return;
  window.__autoTyperLoaded = true;

  // ---------------------------------------------------------------------------
  // Instellingen (worden onthouden in Safari)
  // ---------------------------------------------------------------------------

  const SETTINGS_KEY = 'autoTyper.settings.v1';
  const TEXT_KEY = 'autoTyper.text.v1';
  const OLD_TEXT_KEY = 'autoTyper.oldText.v1';
  const NEW_TEXT_KEY = 'autoTyper.newText.v1';

  const DEFAULTS = {
    wpm: 45,              // woorden per minuut (1 woord = 5 tekens)
    variation: 50,        // menselijke variatie in %
    sentencePause: 0.6,   // seconden extra na . ! ?
    paragraphPause: 1.5,  // seconden extra na een nieuwe alinea
    typoRate: 2,          // tikfouten per 100 woorden
    readPause: 2,         // seconden "lezen" tussen twee wijzigingen (Verbeter-typer)
    countdown: 3,         // seconden aftellen voor het typen begint
    method: 'auto',       // 'auto' | 'keys' | 'input'
    tab: 'type',          // 'type' = Auto typer, 'improve' = Verbeter-typer
    settingsOpen: false,
    minimized: false,
    left: null,
    top: null,
  };

  const settings = loadSettings();

  function loadSettings() {
    try {
      return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'));
    } catch (e) {
      return Object.assign({}, DEFAULTS);
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (e) { /* opslag geblokkeerd: dan onthouden we het gewoon niet */ }
  }

  function loadText(key) {
    try {
      return localStorage.getItem(key) || '';
    } catch (e) {
      return '';
    }
  }

  function saveText(key, text) {
    try {
      localStorage.setItem(key, text);
    } catch (e) { /* tekst te groot of opslag geblokkeerd */ }
  }

  // ---------------------------------------------------------------------------
  // Google Docs: waar de toetsaanslagen heen moeten
  // ---------------------------------------------------------------------------

  // Google Docs vangt alle toetsaanslagen op in een onzichtbaar iframe.
  function getInputFrame() {
    return document.querySelector('iframe.docs-texteventtarget-iframe');
  }

  function getInputDocument() {
    const frame = getInputFrame();
    if (frame) {
      try {
        return frame.contentDocument;
      } catch (e) {
        return null;
      }
    }
    const el = document.querySelector('.docs-texteventtarget-iframe');
    return el ? el.ownerDocument : null;
  }

  // Het element dat de toetsaanslagen ontvangt (zoals bij een echt toetsenbord).
  function getInputElement() {
    const frame = getInputFrame();
    if (!frame) return document.querySelector('.docs-texteventtarget-iframe');
    const doc = getInputDocument();
    if (!doc) return null;
    return doc.querySelector('[contenteditable="true"]') || doc.body || doc.documentElement;
  }

  function focusDocument() {
    const frame = getInputFrame();
    const el = getInputElement();
    try {
      if (frame && frame.contentWindow) frame.contentWindow.focus();
      if (el && el.focus) el.focus({ preventScroll: true });
    } catch (e) { /* niet erg: toetsaanslagen werken ook zonder focus */ }
  }

  function codeFor(ch) {
    if (/^[a-z]$/i.test(ch)) return 'Key' + ch.toUpperCase();
    if (/^[0-9]$/.test(ch)) return 'Digit' + ch;
    if (ch === ' ') return 'Space';
    return '';
  }

  // Google Docs leest nog de oude keyCode/charCode-velden, dus die vullen we ook in.
  function keyEvent(type, key, code, keyCode, modifiers) {
    return new KeyboardEvent(type, Object.assign({
      key: key,
      code: code,
      keyCode: keyCode,
      charCode: keyCode,
      which: keyCode,
      bubbles: true,
      cancelable: true,
      composed: true,
    }, modifiers));
  }

  // Enter, Backspace, Tab en de pijltjes verwerkt Google Docs bij 'keydown'.
  function pressSpecialKey(key, keyCode, modifiers) {
    const el = getInputElement();
    if (!el) throw new Error(MSG_NO_DOCS);
    el.dispatchEvent(keyEvent('keydown', key, key, keyCode, modifiers));
  }

  // Gewone tekens: 'keys' = toetsaanslag (keypress), 'input' = tekstinvoer (zoals het schermtoetsenbord).
  function insertChar(ch, method) {
    const el = getInputElement();
    if (!el) throw new Error(MSG_NO_DOCS);
    if (IS_IOS || method === 'input') {
      const doc = el.ownerDocument;
      if (el.focus) el.focus({ preventScroll: true });
      if (IS_IOS) {
        try {
          el.dispatchEvent(new InputEvent('beforeinput', {
            inputType: 'insertText', data: ch, bubbles: true, cancelable: true
          }));
        } catch (_) {}
      }
      doc.execCommand('insertText', false, ch);
    } else {
      el.dispatchEvent(keyEvent('keypress', ch, codeFor(ch), ch.codePointAt(0)));
    }
  }

  // Positie van de cursor in het document; verandert als er echt iets getypt is.
  function caretSignature() {
    const root = document.getElementById('docs-editor') || document.body;
    const cursors = root.querySelectorAll('.kix-cursor');
    if (!cursors.length) return null;
    return Array.from(cursors, (c) => {
      const caret = c.querySelector('.kix-cursor-caret') || c;
      const r = caret.getBoundingClientRect();
      return [Math.round(r.left), Math.round(r.top), Math.round(r.height)].join(',');
    }).join('|');
  }

  async function caretMoved(before, timeout) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      await sleep(50);
      if (caretSignature() !== before) return true;
    }
    return false;
  }

  const METHOD_NAMES = { keys: 'toetsaanslagen', input: 'tekstinvoer' };
  const MSG_NO_DOCS = 'Ik kan het Google Docs-document niet vinden. Wacht tot het document helemaal geladen is, of herlaad de pagina.';
  const MSG_NOT_TYPING = 'Er verschijnt geen tekst in je document. Tik eerst in je document waar de tekst moet komen. ' +
    'Werkt het dan nog niet? Kies bij Instellingen → Methode een andere methode en druk op Test.';

  // Typt het eerste teken en kijkt welke methode werkt (alleen bij Methode: Automatisch).
  async function detectMethod(ch) {
    if (IS_IOS) return 'input';
    const before = caretSignature();
    insertChar(ch, 'keys');
    if (before === null) return 'keys'; // geen cursor gevonden: dan gaan we uit van toetsaanslagen
    if (await caretMoved(before, 700)) return 'keys';

    const before2 = caretSignature();
    insertChar(ch, 'input');
    if (await caretMoved(before2, 700)) return 'input';

    throw new Error(MSG_NOT_TYPING);
  }

  async function typeChar(ch) {
    if (IS_IOS && ch !== '\n' && ch !== '\t') {
      const el = getInputElement();
      if (!el) throw new Error(MSG_NO_DOCS);
      if (el.focus) el.focus({ preventScroll: true });
      await wait(50);
      insertChar(ch, 'input');
      return;
    }
    if (ch === '\n') return pressSpecialKey('Enter', 13);
    if (ch === '\t') return pressSpecialKey('Tab', 9);
    if (!run.method) {
      run.method = await detectMethod(ch);
      return;
    }
    insertChar(ch, run.method);
  }

  // Wacht tot de cursor een tijdje stil staat; geeft de laatste positie terug.
  async function settledCaret() {
    let last = caretSignature();
    for (let k = 0; k < 10; k++) {
      await wait(80);
      const now = caretSignature();
      if (now === last) return now;
      last = now;
    }
    return last;
  }

  // Zet de cursor helemaal aan het begin van het document.
  async function goToDocumentStart() {
    pressSpecialKey('ArrowUp', 38, { metaKey: true }); // Mac/iPad: Cmd + pijltje omhoog
    pressSpecialKey('Home', 36, { ctrlKey: true });    // Windows/Chromebook: Ctrl + Home
    const atStart = await settledCaret();
    if (atStart === null) return; // cursor niet te zien: we vertrouwen op de sneltoetsen

    // Controle: aan het begin doet pijltje-links niets.
    pressSpecialKey('ArrowLeft', 37);
    if (await settledCaret() === atStart) return;

    // Sneltoetsen werkten niet: dan met de pijltjes naar boven en naar links tot het niet verder kan.
    for (const [key, keyCode] of [['ArrowUp', 38], ['ArrowLeft', 37]]) {
      let before = caretSignature();
      for (let round = 0; round < 2000; round++) {
        for (let k = 0; k < 20; k++) pressSpecialKey(key, keyCode);
        const now = await settledCaret();
        if (now === before) break;
        before = now;
      }
    }
  }

  // Cursor een aantal tekens naar rechts, in kleine stapjes.
  async function moveRight(count, onStep) {
    if (IS_IOS) throw new Error('Verbeter-typer werkt niet betrouwbaar op iPad. Gebruik de Auto-typer om de volledige tekst opnieuw te typen.');
    let left = count;
    while (left > 0) {
      const batch = Math.min(left, ARROWS_PER_STEP);
      for (let k = 0; k < batch; k++) pressSpecialKey('ArrowRight', 39);
      left -= batch;
      if (onStep) onStep(count - left);
      await wait(ARROW_STEP_MS);
    }
  }

  const ARROWS_PER_STEP = 6;
  const ARROW_STEP_MS = 20;

  // ---------------------------------------------------------------------------
  // Snelheid, pauzes en tikfouten
  // ---------------------------------------------------------------------------

  const SENTENCE_END = new Set(['.', '!', '?', '…']);
  const CLAUSE_END = new Set([',', ';', ':']);
  const CLAUSE_PAUSE_FACTOR = 0.35;
  const THINK_CHANCE = 0.03; // kans op een korte denkpauze voor een woord (bij 100% variatie)

  // Toetsen die naast elkaar liggen op een QWERTY-toetsenbord.
  const NEIGHBORS = {
    q: 'wa', w: 'qeas', e: 'wrsd', r: 'etdf', t: 'ryfg', y: 'tugh', u: 'yihj', i: 'uojk', o: 'ipkl', p: 'ol',
    a: 'qwsz', s: 'awedxz', d: 'serfcx', f: 'drtgvc', g: 'ftyhbv', h: 'gyujnb', j: 'huikmn', k: 'jiolm', l: 'kop',
    z: 'asx', x: 'zsdc', c: 'xdfv', v: 'cfgb', b: 'vghn', n: 'bhjm', m: 'njk',
  };

  function charDelay() {
    return 12000 / settings.wpm; // 60.000 ms / (wpm × 5 tekens)
  }

  function gaussian() {
    let u = 0;
    let v = 0;
    while (!u) u = Math.random();
    while (!v) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  // Willekeurige factor rond 1: bij 0% variatie altijd precies 1 (robot).
  function jitter() {
    const sigma = 0.55 * (settings.variation / 100);
    if (sigma <= 0) return 1;
    const f = Math.exp(gaussian() * sigma - (sigma * sigma) / 2);
    return Math.min(4, Math.max(0.25, f));
  }

  function spread(ms) {
    const v = settings.variation / 100;
    return ms * (1 + (Math.random() * 2 - 1) * 0.5 * v);
  }

  function pauseBefore(chars, i) {
    const prev = chars[i - 1];
    if (prev === '\n') return chars[i] === '\n' ? 0 : settings.paragraphPause * 1000;
    if (prev === ' ' || prev === '\t') {
      if (SENTENCE_END.has(chars[i - 2])) return settings.sentencePause * 1000;
      if (CLAUSE_END.has(chars[i - 2])) return settings.sentencePause * 1000 * CLAUSE_PAUSE_FACTOR;
    }
    return 0;
  }

  function isWordStart(chars, i) {
    return chars[i - 1] === ' ' && chars[i] !== ' ';
  }

  function delayBefore(chars, i) {
    if (i === 0) return 0;
    let ms = charDelay() * jitter();
    const pause = pauseBefore(chars, i);
    if (pause) ms += spread(pause);
    if (isWordStart(chars, i) && Math.random() < THINK_CHANCE * (settings.variation / 100)) {
      ms += 400 + Math.random() * 1600;
    }
    return ms;
  }

  function canTypo(ch) {
    return !!ch && Object.prototype.hasOwnProperty.call(NEIGHBORS, ch.toLowerCase());
  }

  // 100 woorden ≈ 500 tekens ≈ 400 letters.
  function typoChance() {
    return settings.typoRate / 400;
  }

  function wrongCharFor(ch) {
    const options = NEIGHBORS[ch.toLowerCase()];
    const wrong = options[Math.floor(Math.random() * options.length)];
    return ch === ch.toUpperCase() ? wrong.toUpperCase() : wrong;
  }

  // Verkeerde letter typen, soms nog 1-2 letters doortypen, dan terug wissen.
  async function makeTypo(chars, i) {
    await typeChar(wrongCharFor(chars[i]));
    const keepGoing = Math.floor(Math.random() * 3);
    let extra = 0;
    while (extra < keepGoing && canTypo(chars[i + 1 + extra])) {
      await wait(charDelay() * jitter());
      await typeChar(chars[i + 1 + extra]);
      extra++;
    }
    await wait(350 + Math.random() * 550);
    for (let k = 0; k <= extra; k++) {
      pressSpecialKey('Backspace', 8);
      await wait(charDelay() * 0.6 * jitter());
    }
    await wait(150 + Math.random() * 250);
  }

  // Typt een reeks tekens met het ingestelde tempo, pauzes en tikfouten.
  async function typeSequence(chars, onProgress) {
    for (let i = 0; i < chars.length; i++) {
      await wait(delayBefore(chars, i));
      if (IS_IOS) await wait(10 + Math.random() * 30);
      if (IS_IOS && i > 0 && i % 15 === 0) await wait(120);
      if (i > 0 && canTypo(chars[i]) && Math.random() < typoChance()) {
        await makeTypo(chars, i);
      }
      await typeChar(chars[i]);
      if (onProgress) onProgress(i + 1);
    }
  }

  async function deleteChars(count) {
    for (let k = 0; k < count; k++) {
      await wait(charDelay() * 0.6 * jitter());
      pressSpecialKey('Backspace', 8);
    }
  }

  // Verwachte tijd per teken, voor de schatting "nog ongeveer ...".
  function expectedCost(chars, i) {
    const base = charDelay();
    let ms = i === 0 ? 0 : base + pauseBefore(chars, i);
    if (isWordStart(chars, i)) ms += THINK_CHANCE * (settings.variation / 100) * 1200;
    if (canTypo(chars[i])) ms += typoChance() * (base * 3.6 + 1000);
    return ms;
  }

  function buildEstimate(chars) {
    const remaining = new Float64Array(chars.length + 1);
    for (let j = chars.length - 1; j >= 0; j--) {
      remaining[j] = remaining[j + 1] + expectedCost(chars, j);
    }
    return remaining;
  }

  function toChars(text) {
    return Array.from(text.replace(/\r\n?/g, '\n'));
  }

  // ---------------------------------------------------------------------------
  // Verbeter-typer: verschillen tussen oude en nieuwe tekst
  // ---------------------------------------------------------------------------

  // Woorden, spaties, losse leestekens en nieuwe regels.
  const TOKEN_RE = /\n|[^\S\n]+|[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu;
  const MAX_DIFF_CELLS = 4000000;

  function tokenize(text) {
    return text.match(TOKEN_RE) || [];
  }

  // Lijst a omzetten naar lijst b: [{t: 'eq' | 'del' | 'ins', s: item}, ...]
  function alignLists(a, b) {
    let p = 0;
    while (p < a.length && p < b.length && a[p] === b[p]) p++;
    let q = 0;
    while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;

    const ops = [];
    for (let k = 0; k < p; k++) ops.push({ t: 'eq', s: a[k] });

    const am = a.slice(p, a.length - q);
    const bm = b.slice(p, b.length - q);
    const n = am.length;
    const m = bm.length;
    if ((n + 1) * (m + 1) > MAX_DIFF_CELLS) {
      am.forEach((s) => ops.push({ t: 'del', s }));
      bm.forEach((s) => ops.push({ t: 'ins', s }));
    } else {
      // Langste gemeenschappelijke reeks (LCS).
      const w = m + 1;
      const table = new Uint32Array((n + 1) * w);
      for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
          table[i * w + j] = am[i] === bm[j]
            ? table[(i + 1) * w + j + 1] + 1
            : Math.max(table[(i + 1) * w + j], table[i * w + j + 1]);
        }
      }
      let i = 0;
      let j = 0;
      while (i < n && j < m) {
        if (am[i] === bm[j]) {
          ops.push({ t: 'eq', s: am[i] });
          i++;
          j++;
        } else if (table[(i + 1) * w + j] >= table[i * w + j + 1]) {
          ops.push({ t: 'del', s: am[i++] });
        } else {
          ops.push({ t: 'ins', s: bm[j++] });
        }
      }
      while (i < n) ops.push({ t: 'del', s: am[i++] });
      while (j < m) ops.push({ t: 'ins', s: bm[j++] });
    }

    for (let k = a.length - q; k < a.length; k++) ops.push({ t: 'eq', s: a[k] });
    return ops;
  }

  // Eerst per alinea vergelijken, daarna per woord binnen de veranderde alinea's.
  function diffTexts(oldText, newText) {
    const lines = (text) => text.match(/[^\n]*\n|[^\n]+$/g) || [];
    const ops = [];
    let oldPart = '';
    let newPart = '';
    const flush = () => {
      if (oldPart || newPart) ops.push(...alignLists(tokenize(oldPart), tokenize(newPart)));
      oldPart = '';
      newPart = '';
    };
    alignLists(lines(oldText), lines(newText)).forEach((op) => {
      if (op.t === 'eq') {
        flush();
        ops.push(op);
      } else if (op.t === 'del') {
        oldPart += op.s;
      } else {
        newPart += op.s;
      }
    });
    flush();
    return ops;
  }

  function charLength(s) {
    return Array.from(s).length;
  }

  // Wijzigingen als {start, del, ins} met posities in de oude tekst (in tekens).
  function buildEdits(ops) {
    const edits = [];
    let pos = 0;
    let current = null;
    ops.forEach((op, k) => {
      const len = charLength(op.s);
      if (op.t === 'eq') {
        // Een losse spatie tussen twee wijzigingen hoort bij de wijziging (dan vervangt hij een stukje zin in één keer).
        const next = ops[k + 1];
        if (current && /^[^\S\n]+$/.test(op.s) && next && next.t !== 'eq') {
          current.del += op.s;
          current.ins += op.s;
        } else if (current) {
          edits.push(current);
          current = null;
        }
        pos += len;
        return;
      }
      if (!current) current = { start: pos, del: '', ins: '' };
      if (op.t === 'del') {
        current.del += op.s;
        pos += len;
      } else {
        current.ins += op.s;
      }
    });
    if (current) edits.push(current);

    // Eén woord dat op één woord lijkt: alleen het stukje dat anders is (werkt → werkte: alleen "e" erbij).
    return edits.map((e) => {
      if (/\s/.test(e.del) || /\s/.test(e.ins)) return e;
      const del = Array.from(e.del);
      const ins = Array.from(e.ins);
      let p = 0;
      while (p < del.length && p < ins.length && del[p] === ins[p]) p++;
      let q = 0;
      while (q < del.length - p && q < ins.length - p && del[del.length - 1 - q] === ins[ins.length - 1 - q]) q++;
      return {
        start: e.start + p,
        del: del.slice(p, del.length - q).join(''),
        ins: ins.slice(p, ins.length - q).join(''),
      };
    }).filter((e) => e.del || e.ins);
  }

  function normalizeForCompare(text) {
    return text.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  }

  // Alles wat de Verbeter-typer nodig heeft: wijzigingen, cursorstappen en tijdschatting.
  function planImprovement(oldRaw, newRaw) {
    const oldText = normalizeForCompare(oldRaw);
    let newText = normalizeForCompare(newRaw);
    let note = '';
    // Plak je tekst van ergens anders met lege regels tussen alinea's, terwijl je document die niet heeft?
    if (!/\n\s*\n/.test(oldText) && /\n\s*\n/.test(newText)) {
      newText = newText.replace(/\n(\s*\n)+/g, '\n');
      note = 'Lege regels tussen alinea\'s in de nieuwe tekst worden genegeerd, want je document heeft die niet.';
    }

    const edits = buildEdits(diffTexts(oldText, newText));
    let caret = 0;
    let offset = 0;
    edits.forEach((e) => {
      e.delLen = charLength(e.del);
      e.insChars = Array.from(e.ins);
      const target = e.start + offset + e.delLen;
      e.move = target - caret;
      caret = target - e.delLen + e.insChars.length;
      offset += e.insChars.length - e.delLen;
    });
    return { oldText, newText, edits, note };
  }

  function editCost(e, k) {
    let ms = Math.ceil(e.move / ARROWS_PER_STEP) * ARROW_STEP_MS;
    if (k > 0) ms += settings.readPause * 1000;
    ms += e.delLen * charDelay() * 0.6;
    if (e.insChars.length) ms += charDelay() + buildEstimate(e.insChars)[0];
    return ms;
  }

  function buildEditEstimate(edits) {
    const remaining = new Float64Array(edits.length + 1);
    for (let k = edits.length - 1; k >= 0; k--) remaining[k] = remaining[k + 1] + editCost(edits[k], k);
    return remaining;
  }

  // ---------------------------------------------------------------------------
  // Typen: starten, pauzeren, stoppen
  // ---------------------------------------------------------------------------

  const STOP = new Error('gestopt');

  const run = {
    active: false,
    mode: 'type',       // 'type' | 'improve' | 'test'
    paused: false,
    stopRequested: false,
    method: null,
    chars: [],          // Auto typer: de tekst
    edits: [],          // Verbeter-typer: de wijzigingen
    done: 0,
    total: 0,
    estimate: null,     // verwachte resterende tijd per stap
    startedAt: 0,
    pausedAt: 0,
    pausedTotal: 0,
    waiters: [],
    countingDown: false,
  };

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Wachten dat rekening houdt met Pauze en Stop.
  async function wait(ms) {
    let left = ms;
    for (;;) {
      if (run.stopRequested) throw STOP;
      if (run.paused) {
        await new Promise((resolve) => run.waiters.push(resolve));
        continue;
      }
      if (left <= 0) return;
      const step = Math.min(left, 100);
      await sleep(step);
      left -= step;
    }
  }

  function wakeWaiters() {
    const waiters = run.waiters;
    run.waiters = [];
    waiters.forEach((resolve) => resolve());
  }

  let wakeLock = null;

  async function keepScreenOn(on) {
    try {
      if (on && !wakeLock && 'wakeLock' in navigator) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      } else if (!on && wakeLock) {
        await wakeLock.release();
        wakeLock = null;
      }
    } catch (e) { /* niet ondersteund: zet dan zelf automatische vergrendeling uit */ }
  }

  function beginRun(mode, fields) {
    Object.assign(run, {
      active: true,
      mode: mode,
      paused: false,
      stopRequested: false,
      method: settings.method === 'auto' ? null : settings.method,
      chars: [],
      edits: [],
      done: 0,
      total: 0,
      estimate: null,
      startedAt: 0,
      pausedAt: 0,
      pausedTotal: 0,
      waiters: [],
      countingDown: settings.countdown > 0,
    }, fields);

    const focused = ui.host.shadowRoot.activeElement;
    if (focused) focused.blur();
    focusDocument();
    watchEscape();
    keepScreenOn(true);
    updateControls();
    updateProgress();
  }

  async function countdown(message) {
    for (let s = settings.countdown; s > 0; s--) {
      setStatus('Begint over ' + s + '… ' + message);
      await wait(1000);
    }
    run.countingDown = false;
    focusDocument();
    await wait(150);
    run.startedAt = Date.now();
    updateControls();
  }

  function endRun() {
    run.active = false;
    run.paused = false;
    run.countingDown = false;
    keepScreenOn(false);
    updateControls();
    updateProgress();
  }

  function showError(e, stoppedMessage) {
    if (e === STOP) {
      setStatus(stoppedMessage);
    } else {
      setStatus(e.message || String(e), 'error');
    }
  }

  async function startTyping() {
    if (run.active) return;
    const text = ui.textarea.value;
    if (!text.trim()) {
      setStatus('Plak eerst je tekst in het vak hierboven.', 'warn');
      return;
    }

    const chars = toChars(text);
    beginRun('type', { chars: chars, total: chars.length, estimate: buildEstimate(chars) });

    try {
      await countdown('Tik nu in je document waar de tekst moet komen.');
      setStatus('Bezig met typen…');
      await typeSequence(chars, (done) => {
        run.done = done;
        updateProgress();
      });
      const words = countWords(text);
      setStatus('Klaar! ✓ ' + words + ' ' + (words === 1 ? 'woord' : 'woorden') +
        ' getypt in ' + formatDuration(activeTime()) + '.', 'ok');
    } catch (e) {
      showError(e, 'Gestopt na ' + run.done.toLocaleString('nl-NL') + ' tekens.');
    } finally {
      endRun();
    }
  }

  async function startImproving() {
    if (run.active) return;
    if (IS_IOS) {
      setStatus('De Verbeter-typer gebruikt cursorverplaatsingen die op iPad niet betrouwbaar werken. Gebruik Auto-typer met de volledige tekst.', 'warn');
      return;
    }
    if (!ui.oldTextarea.value.trim() || !ui.newTextarea.value.trim()) {
      setStatus('Plak allebei de teksten: de tekst die nu in je document staat, en je nieuwe tekst.', 'warn');
      return;
    }
    const plan = planImprovement(ui.oldTextarea.value, ui.newTextarea.value);
    if (!plan.edits.length) {
      setStatus('Er zijn geen verschillen tussen de twee teksten.', 'warn');
      return;
    }

    beginRun('improve', { edits: plan.edits, total: plan.edits.length, estimate: buildEditEstimate(plan.edits) });

    try {
      await countdown('Tik niet in je document: hij zoekt zelf het begin op.');
      setStatus('Begin van je document opzoeken…');
      await goToDocumentStart();

      for (let k = 0; k < plan.edits.length; k++) {
        const e = plan.edits[k];
        if (k > 0) await wait(spread(settings.readPause * 1000));
        setStatus('Wijziging ' + (k + 1) + ' van ' + plan.edits.length + '…');
        await moveRight(e.move);
        if (e.delLen) {
          await wait(200 + Math.random() * 300);
          await deleteChars(e.delLen);
        }
        if (e.insChars.length) {
          await wait(charDelay() * jitter());
          await typeSequence(e.insChars);
        }
        run.done = k + 1;
        updateProgress();
      }
      setStatus('Klaar! ✓ ' + plan.edits.length + ' ' + (plan.edits.length === 1 ? 'wijziging' : 'wijzigingen') +
        ' gedaan in ' + formatDuration(activeTime()) + '. Controleer even of alles goed staat.', 'ok');
    } catch (e) {
      showError(e, 'Gestopt na ' + run.done + ' van de ' + run.total + ' wijzigingen. ' +
        'Let op: plak de tekst uit je document opnieuw in "Tekst nu in je document" voordat je opnieuw begint.');
    } finally {
      endRun();
    }
  }

  function pauseTyping() {
    if (!run.active || run.paused || run.mode === 'test') return;
    run.paused = true;
    run.pausedAt = Date.now();
    setStatus(run.mode === 'improve'
      ? 'Gepauzeerd. Tik niet in je document, anders klopt de plek van de volgende wijziging niet. Druk op Verder om door te gaan.'
      : 'Gepauzeerd. Druk op Verder om door te gaan.');
    keepScreenOn(false);
    updateControls();
  }

  function resumeTyping() {
    if (!run.active || !run.paused) return;
    if (run.startedAt) run.pausedTotal += Date.now() - run.pausedAt;
    run.paused = false;
    focusDocument();
    keepScreenOn(true);
    setStatus(run.countingDown ? 'Aftellen…' : 'Bezig…');
    updateControls();
    wakeWaiters();
  }

  function stopTyping() {
    if (!run.active) return;
    run.stopRequested = true;
    run.paused = false;
    wakeWaiters();
  }

  function activeTime() {
    if (!run.startedAt) return 0;
    const end = run.paused ? run.pausedAt : Date.now();
    return end - run.startedAt - run.pausedTotal;
  }

  // Esc op je toetsenbord = pauze.
  const watchedDocs = new WeakSet();

  function onKeyDown(e) {
    if (e.key === 'Escape' && e.isTrusted && run.active && !run.paused) pauseTyping();
  }

  function watchEscape() {
    [document, getInputDocument()].forEach((doc) => {
      if (doc && !watchedDocs.has(doc)) {
        doc.addEventListener('keydown', onKeyDown, true);
        watchedDocs.add(doc);
      }
    });
  }

  // Test: typt "Test", controleert of het verschijnt en wist het weer.
  async function runTest() {
    if (run.active) return;
    run.active = true;
    run.mode = 'test';
    run.stopRequested = false;
    run.paused = false;
    run.method = settings.method === 'auto' ? null : settings.method;
    updateControls();
    try {
      focusDocument();
      await sleep(250);
      if (!getInputElement()) throw new Error(MSG_NO_DOCS);

      setStatus('Test bezig…');
      const before = caretSignature();
      for (const ch of 'Test') {
        await typeChar(ch);
        await sleep(120);
      }
      await sleep(300);
      const typed = before === null ? null : caretSignature() !== before;

      const beforeDelete = caretSignature();
      for (let k = 0; k < 4; k++) {
        pressSpecialKey('Backspace', 8);
        await sleep(120);
      }
      await sleep(300);
      const deleted = beforeDelete === null ? null : caretSignature() !== beforeDelete;

      const method = METHOD_NAMES[run.method] || run.method;
      if (typed === null) {
        setStatus('Test klaar (methode: ' + method + '). Kijk zelf: verscheen "Test" even in je document en werd het weer gewist?');
      } else if (typed && deleted) {
        setStatus('Test gelukt ✓ Typen en wissen werken (methode: ' + method + ').', 'ok');
      } else if (typed) {
        setStatus('Typen werkt ✓, maar wissen lukte misschien niet. Haal "Test" zo nodig zelf weg.', 'warn');
      } else {
        setStatus(MSG_NOT_TYPING, 'error');
      }
    } catch (e) {
      setStatus(e.message || String(e), 'error');
    } finally {
      run.active = false;
      run.method = null;
      updateControls();
    }
  }

  // ---------------------------------------------------------------------------
  // Paneel
  // ---------------------------------------------------------------------------

  const PANEL_WIDTH = 320;
  const BUBBLE_SIZE = 52;

  const CSS = `
    :host {
      all: initial;
      --accent: #4f46e5; --accent-dark: #4338ca; --text: #1f2330; --muted: #646a7a; --line: #e3e5ec; --soft: #f4f5f9;
    }
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
    [hidden] { display: none !important; }
    .panel {
      position: fixed; z-index: 2147483000; width: ${PANEL_WIDTH}px; max-height: calc(100vh - 24px);
      display: flex; flex-direction: column; background: #fff; color: var(--text);
      border: 2px solid #1685ff; border-radius: 16px; box-shadow: 0 12px 36px rgba(20, 22, 40, .22);
      font-size: 14px; line-height: 1.4; overflow: hidden;
    }
    .header {
      display: flex; align-items: center; gap: 8px; padding: 10px 10px 10px 14px; background: var(--accent); color: #fff;
      cursor: grab; touch-action: none; user-select: none; -webkit-user-select: none; flex: none;
    }
    .header:active { cursor: grabbing; }
    .title { font-weight: 650; font-size: 15px; flex: 1; }
    .icon-btn {
      width: 34px; height: 34px; border-radius: 10px; border: 0; background: rgba(255,255,255,.18); color: #fff;
      font-size: 20px; line-height: 1; cursor: pointer; display: grid; place-items: center;
    }
    .body { padding: 12px 14px 14px; overflow-y: auto; -webkit-overflow-scrolling: touch; }
    .tabs { display: flex; gap: 4px; padding: 4px; margin-bottom: 10px; border-radius: 12px; background: var(--soft); }
    .tab {
      flex: 1; height: 36px; border: 0; border-radius: 9px; background: transparent; color: var(--muted);
      font-size: 14px; font-weight: 600; cursor: pointer;
    }
    .tab.active { background: #fff; color: var(--text); box-shadow: 0 1px 3px rgba(20, 22, 40, .14); }
    .tab:disabled { cursor: default; }
    .field-label { display: block; font-size: 12.5px; font-weight: 600; margin: 8px 2px 4px; }
    .field-label:first-child { margin-top: 0; }
    textarea {
      width: 100%; min-height: 120px; max-height: 40vh; resize: vertical; padding: 10px; border-radius: 10px;
      border: 1px solid var(--line); background: var(--soft); color: var(--text); font-size: 14px; line-height: 1.45;
    }
    textarea.small { min-height: 84px; }
    textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; background: #fff; }
    textarea[readonly] { opacity: .7; }
    .meta { color: var(--muted); font-size: 12.5px; margin: 6px 2px 10px; }
    .preview {
      margin-top: 8px; max-height: 190px; overflow-y: auto; padding: 8px 10px; border: 1px solid var(--line);
      border-radius: 10px; font-size: 13px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere;
    }
    .preview .del { background: #fde2e2; color: #a1231f; text-decoration: line-through; border-radius: 3px; }
    .preview .ins { background: #dcf5e3; color: #17602f; border-radius: 3px; }
    .preview .del + .ins { margin-left: 3px; }
    .preview .gap { color: var(--muted); }
    .note { color: #7a5200; font-size: 12px; margin-top: 4px; }
    .buttons { display: grid; grid-template-columns: 1.3fr 1fr 1fr; gap: 8px; }
    button.btn {
      height: 42px; border-radius: 10px; border: 1px solid var(--line); background: #fff; color: var(--text);
      font-size: 14.5px; font-weight: 600; cursor: pointer;
    }
    button.btn:disabled { opacity: .45; cursor: default; }
    button.start { background: var(--accent); border-color: var(--accent); color: #fff; }
    button.start:not(:disabled):active { background: var(--accent-dark); }
    button.stop { color: #c62828; }
    .progress { height: 8px; border-radius: 99px; background: var(--soft); margin: 12px 0 6px; overflow: hidden; border: 1px solid var(--line); }
    .bar { height: 100%; width: 0; background: var(--accent); border-radius: 99px; transition: width .15s linear; }
    .stats { color: var(--muted); font-size: 12.5px; min-height: 17px; }
    .status { margin-top: 6px; font-size: 13px; padding: 8px 10px; border-radius: 10px; background: var(--soft); }
    .status.ok { background: #e7f6ec; color: #17602f; }
    .status.warn { background: #fff5dc; color: #7a5200; }
    .status.error { background: #fdeaea; color: #a1231f; }
    details { margin-top: 12px; border-top: 1px solid var(--line); padding-top: 8px; }
    summary { cursor: pointer; font-weight: 600; padding: 6px 0; list-style: none; user-select: none; -webkit-user-select: none; }
    summary::-webkit-details-marker { display: none; }
    summary::before { content: "▸ "; color: var(--muted); }
    details[open] summary::before { content: "▾ "; }
    .row { margin: 10px 0 4px; }
    .row-top { display: flex; justify-content: space-between; gap: 8px; font-size: 13px; }
    .row-top label { font-weight: 600; }
    .val { color: var(--accent); font-weight: 600; white-space: nowrap; }
    .hint { color: var(--muted); font-size: 12px; }
    input[type=range] { width: 100%; height: 30px; margin: 2px 0 0; accent-color: var(--accent); }
    .method { display: flex; gap: 8px; align-items: center; margin-top: 4px; }
    select {
      flex: 1; height: 38px; border-radius: 10px; border: 1px solid var(--line); background: #fff; color: var(--text);
      font-size: 14px; padding: 0 8px;
    }
    .method button.btn { height: 38px; padding: 0 14px; }
    .tip { color: var(--muted); font-size: 12px; margin-top: 12px; }
    .bubble {
      position: fixed; z-index: 2147483000; width: ${BUBBLE_SIZE}px; height: ${BUBBLE_SIZE}px; border-radius: 50%;
      border: 0; background: var(--accent); color: #fff; font-size: 13px; font-weight: 700; cursor: pointer;
      box-shadow: 0 8px 24px rgba(20, 22, 40, .3); display: grid; place-items: center;
    }
  `;

  const ui = {};

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function formatNumber(n) {
    return n.toLocaleString('nl-NL', { maximumFractionDigits: 1 });
  }

  function formatDuration(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
  }

  function countWords(text) {
    const words = text.trim().split(/\s+/).filter(Boolean);
    return words.length;
  }

  function plural(n, one, many) {
    return n.toLocaleString('nl-NL') + ' ' + (n === 1 ? one : many);
  }

  function sliderRow(label, key, min, max, step, format, hint) {
    const row = el('div', 'row');
    const top = el('div', 'row-top');
    const id = 'at-' + key;
    const lab = el('label', null, label);
    lab.htmlFor = id;
    const val = el('span', 'val');
    top.append(lab, val);

    const input = el('input');
    input.type = 'range';
    input.id = id;
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(settings[key]);

    const show = () => { val.textContent = format(Number(input.value)); };
    input.addEventListener('input', () => {
      settings[key] = Number(input.value);
      show();
      onSettingsChanged();
    });
    show();

    row.append(top, input);
    if (hint) row.append(el('div', 'hint', hint));
    return row;
  }

  function textField(label, key, placeholder, small) {
    const lab = el('label', 'field-label', label);
    lab.htmlFor = 'at-field-' + key;
    const textarea = el('textarea', small ? 'small' : null);
    textarea.id = 'at-field-' + key;
    textarea.placeholder = placeholder;
    textarea.value = loadText(key);
    textarea.spellcheck = false;
    let saveTimer = 0;
    textarea.addEventListener('input', () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => saveText(key, textarea.value), 400);
      updateMeta();
    });
    return [lab, textarea];
  }

  function buildUI() {
    const host = document.createElement('div');
    host.id = 'auto-typer-host';
    const shadow = host.attachShadow({ mode: 'open' });

    shadow.append(el('style', null, CSS));

    // Klikken en toetsen in het paneel niet doorgeven aan Google Docs.
    ['keydown', 'keypress', 'keyup', 'paste', 'copy', 'cut', 'beforeinput', 'input',
      'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend',
      'click', 'dblclick', 'contextmenu', 'wheel'].forEach((type) => {
      host.addEventListener(type, (e) => e.stopPropagation());
    });

    const panel = el('div', 'panel');

    // Kop
    const header = el('div', 'header');
    header.append(el('span', 'title', '⌨️ Auto Typer'));
    const minBtn = el('button', 'icon-btn', '–');
    minBtn.type = 'button';
    minBtn.title = 'Klein maken';
    minBtn.setAttribute('aria-label', 'Klein maken');
    header.append(minBtn);

    // Inhoud
    const body = el('div', 'body');

    // Tabbladen
    const tabs = el('div', 'tabs');
    const typeTab = el('button', 'tab', 'Auto typer');
    const improveTab = el('button', 'tab', 'Verbeter-typer');
    [typeTab, improveTab].forEach((b) => { b.type = 'button'; });
    tabs.append(typeTab, improveTab);

    // Auto typer
    const typeSection = el('div');
    const [, textarea] = textField('Tekst', TEXT_KEY, 'Plak hier de tekst die getypt moet worden…');
    const typeMeta = el('div', 'meta');
    typeSection.append(textarea, typeMeta);

    // Verbeter-typer
    const improveSection = el('div');
    const [oldLabel, oldTextarea] = textField('1. Tekst nu in je document', OLD_TEXT_KEY,
      'In Google Docs: Bewerken → Alles selecteren, kopiëren, en hier plakken…', true);
    const [newLabel, newTextarea] = textField('2. Nieuwe tekst', NEW_TEXT_KEY,
      'Plak hier je verbeterde tekst…', true);
    const previewLabel = el('div', 'field-label', 'Wat er verandert');
    const preview = el('div', 'preview');
    const improveNote = el('div', 'note');
    const improveMeta = el('div', 'meta');
    improveSection.append(oldLabel, oldTextarea, newLabel, newTextarea, previewLabel, preview, improveNote, improveMeta);

    const buttons = el('div', 'buttons');
    const startBtn = el('button', 'btn start', '▶ Start');
    const pauseBtn = el('button', 'btn pause', '⏸ Pauze');
    const stopBtn = el('button', 'btn stop', '■ Stop');
    [startBtn, pauseBtn, stopBtn].forEach((b) => { b.type = 'button'; });
    buttons.append(startBtn, pauseBtn, stopBtn);

    const progress = el('div', 'progress');
    const bar = el('div', 'bar');
    progress.append(bar);
    const stats = el('div', 'stats');
    const status = el('div', 'status');

    // Instellingen
    const details = el('details');
    details.open = !!settings.settingsOpen;
    details.addEventListener('toggle', () => {
      settings.settingsOpen = details.open;
      saveSettings();
    });
    details.append(el('summary', null, 'Instellingen'));

    details.append(
      sliderRow('Snelheid', 'wpm', 10, 300, 1, (v) => v + ' woorden per minuut',
        'Gemiddeld typt iemand 35–45 woorden per minuut.'),
      sliderRow('Menselijke variatie', 'variation', 0, 100, 5, (v) => (v === 0 ? 'uit (robot)' : v + '%'),
        'Hoe meer variatie, hoe ongelijker de tijd tussen de letters.'),
      sliderRow('Pauze na een zin', 'sentencePause', 0, 5, 0.1, (v) => formatNumber(v) + ' s',
        'Extra wachten na . ! ? (na een komma ongeveer een derde hiervan).'),
      sliderRow('Pauze na een alinea', 'paragraphPause', 0, 10, 0.5, (v) => formatNumber(v) + ' s',
        'Extra wachten na een nieuwe regel.'),
      sliderRow('Tikfouten', 'typoRate', 0, 10, 0.5, (v) => (v === 0 ? 'uit' : formatNumber(v) + ' per 100 woorden'),
        'Typt soms een verkeerde letter en verbetert die meteen.'),
      sliderRow('Leespauze tussen wijzigingen', 'readPause', 0, 10, 0.5, (v) => formatNumber(v) + ' s',
        'Alleen voor de Verbeter-typer: even "lezen" voor de volgende wijziging.'),
      sliderRow('Aftellen voor start', 'countdown', 0, 10, 1, (v) => (v === 0 ? 'meteen' : v + ' s'),
        'Tijd om in je document te tikken nadat je op Start hebt gedrukt.')
    );

    const methodRow = el('div', 'row');
    const methodTop = el('div', 'row-top');
    const methodLabel = el('label', null, 'Methode');
    methodLabel.htmlFor = 'at-method';
    methodTop.append(methodLabel);
    const method = el('div', 'method');
    const select = el('select');
    select.id = 'at-method';
    [['auto', 'Automatisch (aanbevolen)'], ['keys', 'Toetsaanslagen'], ['input', 'Tekstinvoer']].forEach(([value, label]) => {
      select.append(new Option(label, value));
    });
    select.value = settings.method;
    select.addEventListener('change', () => {
      settings.method = select.value;
      if (run.active && settings.method !== 'auto') run.method = settings.method;
      saveSettings();
    });
    const testBtn = el('button', 'btn', 'Test');
    testBtn.type = 'button';
    method.append(select, testBtn);
    methodRow.append(methodTop, method,
      el('div', 'hint', 'Test typt "Test" in je document en wist het meteen weer. Lukt het niet? Kies een andere methode.'));
    details.append(methodRow);

    const tip = el('div', 'tip', 'Tip: houd Safari open en je scherm aan tijdens het typen. Druk op Esc om te pauzeren.');

    body.append(tabs, typeSection, improveSection, buttons, progress, stats, status, details, tip);
    panel.append(header, body);

    // Klein gemaakt: alleen een rond knopje
    const bubble = el('button', 'bubble', '⌨️');
    bubble.type = 'button';
    bubble.title = 'Auto Typer openen';
    bubble.setAttribute('aria-label', 'Auto Typer openen');

    shadow.append(panel, bubble);
    document.documentElement.append(host);

    Object.assign(ui, {
      host, panel, header, typeTab, improveTab, typeSection, improveSection, textarea, typeMeta,
      oldTextarea, newTextarea, preview, improveNote, improveMeta,
      startBtn, pauseBtn, stopBtn, testBtn, select, bar, stats, status, bubble,
    });

    typeTab.addEventListener('click', () => setTab('type'));
    improveTab.addEventListener('click', () => setTab('improve'));
    startBtn.addEventListener('click', () => (settings.tab === 'improve' ? startImproving() : startTyping()));
    pauseBtn.addEventListener('click', () => (run.paused ? resumeTyping() : pauseTyping()));
    stopBtn.addEventListener('click', stopTyping);
    testBtn.addEventListener('click', runTest);
    minBtn.addEventListener('click', () => setMinimized(true));
    bubble.addEventListener('click', () => setMinimized(false));

    enableDragging(header);
    window.addEventListener('resize', () => placePanel());
    setMinimized(!!settings.minimized);
    setTab(settings.tab === 'improve' ? 'improve' : 'type');
    placePanel();
    updateControls();
  }

  // ---------------------------------------------------------------------------
  // Paneel bijwerken
  // ---------------------------------------------------------------------------

  function setStatus(text, kind) {
    ui.status.textContent = text;
    ui.status.className = 'status' + (kind ? ' ' + kind : '');
  }

  function setTab(tab) {
    if (run.active) return;
    settings.tab = tab;
    saveSettings();
    const improve = tab === 'improve';
    ui.typeTab.classList.toggle('active', !improve);
    ui.improveTab.classList.toggle('active', improve);
    ui.typeSection.hidden = improve;
    ui.improveSection.hidden = !improve;
    run.done = 0;
    run.total = 0;
    updateProgress();
    setStatus(improve
      ? 'Plak de tekst uit je document en je nieuwe tekst, bekijk de wijzigingen en druk op Start.'
      : 'Tik in je document waar de tekst moet komen en druk op Start.');
    updateMeta();
  }

  let metaTimer = 0;

  function onSettingsChanged() {
    saveSettings();
    if (run.active && run.mode === 'type') {
      run.estimate = buildEstimate(run.chars);
      updateProgress();
    } else if (run.active && run.mode === 'improve') {
      run.estimate = buildEditEstimate(run.edits);
      updateProgress();
    }
    updateMeta();
  }

  function updateMeta() {
    clearTimeout(metaTimer);
    metaTimer = setTimeout(() => {
      if (settings.tab === 'improve') {
        updateImproveMeta();
        return;
      }
      const text = ui.textarea.value;
      if (!text.trim()) {
        ui.typeMeta.textContent = 'Nog geen tekst.';
        return;
      }
      const chars = toChars(text);
      const estimate = buildEstimate(chars)[0];
      ui.typeMeta.textContent = plural(countWords(text), 'woord', 'woorden') + ' · ' +
        plural(chars.length, 'teken', 'tekens') + ' · duurt ongeveer ' + formatDuration(estimate);
    }, 150);
  }

  // Kleurenoverzicht: rood doorgestreept = weg, groen = erbij.
  function updateImproveMeta() {
    const preview = ui.preview;
    preview.replaceChildren();
    ui.improveNote.textContent = '';
    if (!ui.oldTextarea.value.trim() || !ui.newTextarea.value.trim()) {
      preview.append(el('span', 'gap', 'Hier zie je de wijzigingen zodra je allebei de teksten hebt geplakt.'));
      ui.improveMeta.textContent = '';
      return;
    }

    const plan = planImprovement(ui.oldTextarea.value, ui.newTextarea.value);
    ui.improveNote.textContent = plan.note;
    if (!plan.edits.length) {
      preview.append(el('span', 'gap', 'Geen verschillen gevonden: de teksten zijn hetzelfde.'));
      ui.improveMeta.textContent = '';
      return;
    }

    const oldChars = Array.from(plan.oldText);
    const showNewlines = (s) => s.replace(/\n/g, '↵\n');
    const unchanged = (from, to, first, last) => {
      const text = oldChars.slice(from, to).join('');
      const chars = Array.from(text);
      const keep = 60;
      if (chars.length <= keep * 2 + 10) return preview.append(text);
      if (!first) preview.append(chars.slice(0, keep).join(''));
      preview.append(el('span', 'gap', first ? '… ' : ' … '));
      if (!last) preview.append(chars.slice(chars.length - keep).join(''));
    };

    let pos = 0;
    let removed = 0;
    let added = 0;
    plan.edits.forEach((e, k) => {
      unchanged(pos, e.start, k === 0, false);
      if (e.del) preview.append(el('span', 'del', showNewlines(e.del)));
      if (e.ins) preview.append(el('span', 'ins', showNewlines(e.ins)));
      pos = e.start + e.delLen;
      removed += countWords(e.del);
      added += countWords(e.ins);
    });
    unchanged(pos, oldChars.length, false, true);

    const time = buildEditEstimate(plan.edits)[0];
    ui.improveMeta.textContent = plural(plan.edits.length, 'wijziging', 'wijzigingen') + ' · ' +
      removed + ' weg · ' + added + ' erbij · duurt ongeveer ' + formatDuration(time);
  }

  function updateProgress() {
    const total = run.total;
    const pct = total ? Math.floor((run.done / total) * 100) : 0;
    ui.bar.style.width = (total ? (run.done / total) * 100 : 0) + '%';

    if (!total) {
      ui.stats.textContent = '';
    } else {
      const unit = run.mode === 'improve' ? 'wijzigingen' : 'tekens';
      const parts = [pct + '%', run.done.toLocaleString('nl-NL') + ' / ' + total.toLocaleString('nl-NL') + ' ' + unit];
      if (run.active && run.estimate) parts.push('nog ± ' + formatDuration(run.estimate[run.done]));
      const minutes = activeTime() / 60000;
      if (run.active && run.mode === 'type' && minutes > 0.05) parts.push(Math.round(run.done / 5 / minutes) + ' wpm');
      ui.stats.textContent = parts.join(' · ');
    }
    ui.bubble.textContent = run.active && total ? pct + '%' : '⌨️';
  }

  function updateControls() {
    ui.startBtn.disabled = run.active;
    ui.testBtn.disabled = run.active;
    ui.typeTab.disabled = run.active;
    ui.improveTab.disabled = run.active;
    ui.pauseBtn.disabled = !run.active || run.mode === 'test' || (!run.startedAt && !run.countingDown);
    ui.stopBtn.disabled = !run.active || run.mode === 'test';
    ui.pauseBtn.textContent = run.paused ? '▶ Verder' : '⏸ Pauze';
    [ui.textarea, ui.oldTextarea, ui.newTextarea].forEach((t) => { t.readOnly = run.active; });
  }

  function setMinimized(min) {
    settings.minimized = min;
    saveSettings();
    ui.panel.hidden = min;
    ui.bubble.hidden = !min;
    placePanel();
  }

  // ---------------------------------------------------------------------------
  // Verslepen en plaatsen
  // ---------------------------------------------------------------------------

  function placePanel() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = settings.left == null ? vw - PANEL_WIDTH - 16 : settings.left;
    let top = settings.top == null ? 72 : settings.top;
    left = Math.min(Math.max(8, left), Math.max(8, vw - PANEL_WIDTH - 8));
    top = Math.min(Math.max(8, top), Math.max(8, vh - 60));
    ui.panel.style.left = left + 'px';
    ui.panel.style.top = top + 'px';
    ui.panel.style.maxHeight = (vh - top - 12) + 'px';
    ui.bubble.style.left = (left + PANEL_WIDTH - BUBBLE_SIZE) + 'px';
    ui.bubble.style.top = top + 'px';
  }

  function enableDragging(handle) {
    let start = null;
    handle.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      const rect = ui.panel.getBoundingClientRect();
      start = { x: e.clientX, y: e.clientY, left: rect.left, top: rect.top };
      handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    handle.addEventListener('pointermove', (e) => {
      if (!start) return;
      settings.left = start.left + e.clientX - start.x;
      settings.top = start.top + e.clientY - start.y;
      placePanel();
    });
    const end = () => {
      if (!start) return;
      start = null;
      saveSettings();
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && run.active && !run.paused) keepScreenOn(true);
  });

  buildUI();
})();
