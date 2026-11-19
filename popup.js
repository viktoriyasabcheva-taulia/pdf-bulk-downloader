const statusDiv = document.getElementById('status');
const btn = document.getElementById('downloadBtn');

function setStatus(text, cls) {
  statusDiv.textContent = text;
  statusDiv.className = cls;
}

btn.addEventListener('click', async () => {
  btn.disabled = true;
  setStatus('Reading selection...', 'info');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab || !/^https:\/\/sapcloudconnectportal\.net\//.test(tab.url || '')) {
      setStatus('Open CloudConnect (sapcloudconnectportal.net) first, then try again.', 'error');
      btn.disabled = false;
      return;
    }

    // Reports and Intervention pages expose PDFs differently, so pick the
    // matching collector for whichever page is open.
    const isReports = /\/Reports\b/i.test(tab.url);
    const collector = isReports ? collectReports : collectPdfs;

    // Runs in the PAGE so fetch() carries the CloudConnect session cookies.
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: collector
    });

    console.log(`collector (${isReports ? 'Reports' : 'Intervention'}) result:`, result);

    if (!result) {
      setStatus('No response from the page. Reload CloudConnect and retry.', 'error');
      btn.disabled = false;
      return;
    }
    if (result.fatal) {
      setStatus(result.fatal, 'error');
      btn.disabled = false;
      return;
    }
    if (!result.files.length) {
      const why = result.errors.length ? '\n\n' + result.errors.join('\n') : '';
      setStatus('No PDFs could be collected.' + why, 'error');
      btn.disabled = false;
      return;
    }

    setStatus(`Zipping ${result.files.length} PDF(s)...`, 'info');

    const zipName = isReports ? 'reports.zip' : 'invoices.zip';
    const zip = new JSZip();
    for (const f of result.files) {
      zip.file(f.filename, base64ToUint8(f.base64));
    }
    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);

    await new Promise((resolve, reject) => {
      chrome.downloads.download(
        { url, filename: zipName, saveAs: true },
        (id) => {
          if (chrome.runtime.lastError || id === undefined) {
            reject(new Error(chrome.runtime.lastError?.message || 'download failed'));
          } else {
            resolve(id);
          }
        }
      );
    });

    // Give the download a moment to read the blob URL before revoking.
    setTimeout(() => URL.revokeObjectURL(url), 60000);

    let msg = `Done — ${result.files.length} PDF(s) in ${zipName}.`;
    if (result.errors.length) {
      msg += `\n\nSkipped ${result.errors.length}:\n` + result.errors.join('\n');
    }
    setStatus(msg, result.errors.length ? 'info' : 'success');
  } catch (error) {
    console.error(error);
    setStatus('Error: ' + error.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

function base64ToUint8(b64) {
  const bin = atob(b64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ==== Injected into the CloudConnect page (MAIN world). Must be self-contained. ====
async function collectPdfs() {
  const URL_RE = /downloads\/input/i;
  const files = [];
  const errors = [];
  const usedUrls = new Set();
  const usedNames = new Set();

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const boxes = Array.from(document.querySelectorAll('input[type="checkbox"]:checked'));
  const rows = [];
  for (const box of boxes) {
    const row = box.closest('tr');
    if (row && !rows.includes(row)) rows.push(row);
  }
  if (!rows.length) {
    return { fatal: 'No invoices selected. Tick at least one invoice, then click again.', files, errors };
  }

  const abs = (src) => {
    if (!src) return null;
    try { return new URL(src, window.location.href).href; } catch { return null; }
  };

  const currentIframeUrl = () => {
    const iframes = Array.from(document.querySelectorAll('iframe'));
    for (const f of iframes) {
      const src = abs(f.getAttribute('src') || f.src);
      if (src && URL_RE.test(src)) return src;
    }
    return null;
  };

  const invokeKoSelect = (row) => {
    if (typeof ko === 'undefined') return false;
    let data;
    try { data = ko.dataFor(row); } catch { return false; }
    if (data == null) return false;

    const candidates = [];
    try {
      const g = window.ko_model;
      if (g && g.intervention && g.intervention.ko && typeof g.intervention.ko.select_intervention === 'function') {
        candidates.push([g.intervention.ko, g.intervention.ko.select_intervention]);
      }
    } catch { /* ignore */ }
    try {
      const ctx = ko.contextFor(row);
      const scopes = [];
      if (ctx) { scopes.push(ctx.$data, ctx.$root); if (ctx.$parents) scopes.push.apply(scopes, ctx.$parents); }
      for (const s of scopes) {
        if (!s) continue;
        try { if (typeof s.select_intervention === 'function') candidates.push([s, s.select_intervention]); } catch {}
        try {
          if (s.intervention && s.intervention.ko && typeof s.intervention.ko.select_intervention === 'function') {
            candidates.push([s.intervention.ko, s.intervention.ko.select_intervention]);
          }
        } catch {}
      }
    } catch { /* ignore */ }

    for (const [thisArg, fn] of candidates) {
      try { fn.call(thisArg, data); return true; } catch { /* try next */ }
    }
    return false;
  };

  const clickRow = (row) => {
    const target = row.querySelector('td') || row;
    for (const type of ['mousedown', 'mouseup', 'click']) {
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
  };

  // True when the preview URL's fileName clearly belongs to this row. This is
  // how we know the preview is showing the RIGHT invoice — whether the preview
  // just switched or was already showing it (the "first invoice skipped" bug).
  const normalize = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const urlMatchesRow = (u, row) => {
    let fn = '';
    try { fn = decodeURIComponent(new URL(u).searchParams.get('fileName') || ''); } catch { /* ignore */ }
    if (!fn) return false;
    const rowNorm = normalize(row.textContent);
    if (!rowNorm) return false;
    // Any longish number in the filename that also appears in the row = a match.
    const nums = fn.match(/\d{5,}/g) || [];
    for (const n of nums) if (rowNorm.includes(n)) return true;
    // Otherwise fall back to a shared text chunk.
    const fnNorm = normalize(fn);
    return fnNorm.length >= 10 && (rowNorm.includes(fnNorm.slice(0, 12)) || fnNorm.includes(rowNorm.slice(0, 12)));
  };

  // Wait until the preview shows THIS row's invoice and we haven't collected it.
  const waitForRowUrl = async (row, capMs) => {
    const stepMs = 250;
    let waited = 0;
    while (waited < capMs) {
      const cur = currentIframeUrl();
      if (cur && !usedUrls.has(cur) && urlMatchesRow(cur, row)) return cur;
      await sleep(stepMs);
      waited += stepMs;
    }
    return null;
  };

  const nameFor = (url, rowId) => {
    let name = null;
    try {
      const fn = new URL(url).searchParams.get('fileName');
      if (fn) name = decodeURIComponent(fn);
    } catch { /* ignore */ }
    if (!name) name = 'invoice_' + (rowId || 'unknown');
    name = name.replace(/[\\/:*?"<>|]+/g, '_').trim();
    if (!/\.pdf$/i.test(name)) name += '.pdf';
    let unique = name;
    let n = 2;
    while (usedNames.has(unique)) {
      unique = name.replace(/\.pdf$/i, '') + '_' + n + '.pdf';
      n++;
    }
    usedNames.add(unique);
    return unique;
  };

  const toBase64 = (buf) => {
    const bytes = new Uint8Array(buf);
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowId = row.id || `#${i}`;
    try {
      row.scrollIntoView({ block: 'center' });
      await sleep(150);

      // Trigger CloudConnect's own row selection so the preview loads this
      // invoice, then accept its URL as soon as the preview matches this row.
      // Retry a few times for slow previews / the occasional missed click.
      let url = null;
      let usedKo = false;
      for (let attempt = 0; attempt < 4 && !url; attempt++) {
        usedKo = invokeKoSelect(row);
        if (!usedKo || attempt > 0) clickRow(row);
        url = await waitForRowUrl(row, 6000);
      }

      console.log(
        `[bulk] row ${i} (${rowId}) method=${usedKo ? 'ko' : 'click'} url=${url || '(none)'}`
      );

      if (!url) {
        errors.push(`${rowId}: preview did not load — re-run to retry this one`);
        continue;
      }
      usedUrls.add(url);

      const resp = await fetch(url, { credentials: 'include' });
      if (!resp.ok) {
        errors.push(`${rowId}: server returned ${resp.status}`);
        continue;
      }
      const buf = await resp.arrayBuffer();

      const head = new Uint8Array(buf.slice(0, 5));
      const magic = String.fromCharCode(...head);
      if (!magic.startsWith('%PDF')) {
        errors.push(`${rowId}: not a PDF (session may have expired)`);
        continue;
      }

      files.push({ filename: nameFor(url, row.id), base64: toBase64(buf) });
    } catch (e) {
      errors.push(`${rowId}: ${e && e.message ? e.message : String(e)}`);
    }
  }

  return { files, errors };
}

// ==== Injected into the CloudConnect REPORTS page (MAIN world). Self-contained. ====
// Reports has no preview pane: each file downloads from
//   /Downloads/Pdf?fileName=<File Name Prefix>
// so we build the URL straight from each selected row — no clicking/timing needed.
async function collectReports() {
  const files = [];
  const errors = [];
  const usedNames = new Set();

  const boxes = Array.from(document.querySelectorAll('input[type="checkbox"]:checked'));
  const rows = [];
  for (const box of boxes) {
    const row = box.closest('tr');
    if (row && !rows.includes(row)) rows.push(row);
  }
  if (!rows.length) {
    return { fatal: 'No reports selected. Tick at least one report, then click again.', files, errors };
  }

  // The real file name (with correct brackets/punctuation) lives in the row's
  // data model; fall back to the visible "File Name Prefix" cell text.
  const TS_RE = /\.\d{4}\.\d{2}\.\d{2}\.\d{2}\.\d{2}\.\d{2}\.\d+$/; // ...2026.10.08.03.41.39.375
  const fileNameForRow = (row) => {
    try {
      if (typeof ko !== 'undefined') {
        const d = ko.toJS(ko.dataFor(row));
        if (d && typeof d === 'object') {
          for (const k of Object.keys(d)) {
            if (/file.?name|prefix/i.test(k) && typeof d[k] === 'string' && d[k].length > 8) return d[k].trim();
          }
          let best = '';
          for (const v of Object.values(d)) {
            if (typeof v === 'string' && TS_RE.test(v.trim()) && v.length > best.length) best = v.trim();
          }
          if (best) return best;
        }
      }
    } catch { /* ignore, fall back to cell text */ }
    const tds = Array.from(row.querySelectorAll('td'));
    for (const td of tds) {
      const t = (td.textContent || '').trim();
      if (TS_RE.test(t)) return t;
    }
    return tds.map((td) => (td.textContent || '').trim()).sort((a, b) => b.length - a.length)[0] || '';
  };

  const nameFor = (fileName, i) => {
    let name = (fileName || ('report_' + (i + 1))).replace(/[\\/:*?"<>|]+/g, '_').trim();
    if (!/\.pdf$/i.test(name)) name += '.pdf';
    let unique = name;
    let n = 2;
    while (usedNames.has(unique)) {
      unique = name.replace(/\.pdf$/i, '') + '_' + n + '.pdf';
      n++;
    }
    usedNames.add(unique);
    return unique;
  };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const label = `#${i + 1}`;
    try {
      const fileName = fileNameForRow(row);
      if (!fileName) {
        errors.push(`${label}: could not read file name`);
        continue;
      }
      const url = window.location.origin + '/Downloads/Pdf?fileName=' + encodeURIComponent(fileName);

      console.log(`[bulk-reports] ${label} fileName=${fileName}`);

      const resp = await fetch(url, { credentials: 'include' });
      if (!resp.ok) {
        errors.push(`${fileName}: server returned ${resp.status}`);
        continue;
      }
      const buf = await resp.arrayBuffer();

      const head = new Uint8Array(buf.slice(0, 5));
      if (!String.fromCharCode(...head).startsWith('%PDF')) {
        errors.push(`${fileName}: not a PDF (session may have expired)`);
        continue;
      }

      let bin = '';
      const bytes = new Uint8Array(buf);
      for (let j = 0; j < bytes.length; j += 0x8000) {
        bin += String.fromCharCode.apply(null, bytes.subarray(j, j + 0x8000));
      }
      files.push({ filename: nameFor(fileName, i), base64: btoa(bin) });
    } catch (e) {
      errors.push(`${label}: ${e && e.message ? e.message : String(e)}`);
    }
  }

  return { files, errors };
}
