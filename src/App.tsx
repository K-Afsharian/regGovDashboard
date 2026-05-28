// App.tsx — The entire application lives in this one file.
// It handles searching EPA dockets, browsing their documents, viewing public comments,
// and batch-downloading PDFs directly through the browser.

import React, { useState, useEffect, useCallback } from 'react';
import './App.css';

// ---------------------------------------------------------------------------
// TypeScript interfaces — these describe the shape of data we get back from
// the Regulations.gov API so TypeScript can catch typos and type mismatches.
// ---------------------------------------------------------------------------

// A single regulatory document (e.g. a Notice, Rule, or supporting PDF)
interface Document {
  id: string;
  attributes: {
    title: string;
    documentType: string;   // e.g. "Notice", "Rule", "Proposed Rule"
    postedDate: string;
    openForComment: boolean;
    commentEndDate: string;
  };
}

// A docket is a folder that groups related documents together (one per rulemaking)
interface Docket {
  id: string;
  attributes: {
    title: string;
    docketType: string;
    lastModifiedDate: string;
  };
}

// Pagination info returned alongside list responses
interface Meta {
  totalElements: number;
  totalPages: number;
}

// A public comment submitted by a member of the public on a document
interface Comment {
  id: string;
  attributes: {
    title: string;
    postedDate: string;
    submitterType: string;  // e.g. "Individual", "Organization"
  };
}

// Base URL for all API requests — every fetch call starts with this
const API_BASE = "https://api.regulations.gov/v4";

// ---------------------------------------------------------------------------
// apiUrl — Builds a regulations.gov URL with properly percent-encoded query
// params. The /documents and /comments endpoints reject raw "[" / "]" in the
// query string with an HTTP 400, so JSON:API keys like "filter[docketId]" must
// be encoded (URLSearchParams turns them into "filter%5BdocketId%5D"). The
// /dockets endpoint tolerates raw brackets, but encoding everywhere is safe.
// Params with empty-string/undefined values are skipped.
// ---------------------------------------------------------------------------
const apiUrl = (path: string, params: Record<string, string | number | undefined>) => {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') qs.append(key, String(value));
  }
  return `${API_BASE}${path}?${qs.toString()}`;
};

// ---------------------------------------------------------------------------
// Main App component — React components are just functions that return HTML-like JSX
// ---------------------------------------------------------------------------
function App() {
  // --- Authentication ---
  // Load the API key from localStorage on startup so users don't re-enter it every visit
  const [apiKey, setApiKey] = useState(localStorage.getItem('reg_gov_api_key') || '');
  const [searchTerm, setSearchTerm] = useState('');

  // --- Data returned from the API ---
  const [dockets, setDockets] = useState<Docket[]>([]);           // Search results list
  const [activeDocket, setActiveDocket] = useState<Docket | null>(null); // Currently selected docket
  const [documents, setDocuments] = useState<Document[]>([]);     // Documents in the active docket
  const [docMeta, setDocMeta] = useState<Meta | null>(null);      // Pagination info for the document table

  // --- Table controls (all filters/sort are applied server-side by the API) ---
  const [page, setPage] = useState(1);
  const pageSize = 50;  // How many documents to fetch per page
  const [typeFilter, setTypeFilter] = useState('');
  const [dateFilter, setDateFilter] = useState('');   // Number of days to look back (e.g. "30", "90")
  const [onlyOpenForComment, setOnlyOpenForComment] = useState(false);
  // sortConfig tracks which column to sort by and in which direction
  const [sortConfig, setSortConfig] = useState<{ key: string, direction: 'asc' | 'desc' }>({ key: 'postedDate', direction: 'desc' });

  // --- UI interaction states ---
  const [selectedDocIds, setSelectedDocIds] = useState<Set<string>>(new Set()); // Checkboxes
  const [isSearching, setIsSearching] = useState(false);
  const [isFetchingDocs, setIsFetchingDocs] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  // useRef stores a value that persists across renders but doesn't trigger a re-render when changed.
  // We use it here as a flag that the download loop can check to know when to stop.
  const stopDownloadRef = React.useRef(false);

  // --- Public comments ---
  const [expandedDocId, setExpandedDocId] = useState<string | null>(null); // Which row has comments open
  const [docComments, setDocComments] = useState<Comment[]>([]);
  const [isFetchingComments, setIsFetchingComments] = useState(false);

  // --- Download progress ---
  const [isDownloading, setIsDownloading] = useState(false);
  const [progress, setProgress] = useState(0);           // 0–100 for the progress bar
  const [progressStatus, setProgressStatus] = useState('');
  const [logs, setLogs] = useState<string[]>([]);        // Timestamped log lines shown in the console panel

  // --- Bulk download (AI list + keyword list) ---
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkAis, setBulkAis] = useState('');
  const [bulkKeywords, setBulkKeywords] = useState('');
  const [bulkExcludeKeywords, setBulkExcludeKeywords] = useState('');
  const [bulkDocketsPerAi, setBulkDocketsPerAi] = useState(1); // How many top dockets to process per AI
  const [bulkDownloadIntervalMs, setBulkDownloadIntervalMs] = useState(1500); // Delay between firing each browser download

  // Producer/consumer queue: discovery pushes URLs in, the drainer pulls them
  // out and triggers a browser download every `bulkDownloadIntervalMs` ms.
  const downloadQueueRef = React.useRef<string[]>([]);
  const discoveryDoneRef = React.useRef(false);

  // Helper to append a new timestamped line to the log panel
  const addLog = (msg: string) => setLogs(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);

  // Whenever apiKey changes, save it to localStorage so it persists on refresh
  useEffect(() => {
    localStorage.setItem('reg_gov_api_key', apiKey);
  }, [apiKey]);

  // ---------------------------------------------------------------------------
  // fetchDocuments — Loads the document list for the selected docket.
  // All filtering and sorting happens on the API side (we just pass query params).
  // useCallback prevents this function from being recreated on every render,
  // which matters because it's listed as a dependency of the useEffect below.
  // ---------------------------------------------------------------------------
  const fetchDocuments = useCallback(async (
    docketId: string,
    pageNum: number,
    sort: typeof sortConfig,
    filterType: string,
    filterDate: string,
    isOpen: boolean
  ) => {
    if (!apiKey) return;
    setIsFetchingDocs(true);
    setErrorMsg('');
    try {
      // The API sorts descending with a "-" prefix on the field name
      const sortStr = sort.direction === 'desc' ? `-${sort.key}` : sort.key;

      let dateStr = '';
      if (filterDate) {
        // Calculate a cutoff date by subtracting the selected number of days from today
        const date = new Date();
        date.setDate(date.getDate() - parseInt(filterDate));
        dateStr = date.toISOString().split('T')[0]; // Format as YYYY-MM-DD
        addLog(`[i] Applying date filter: Since ${dateStr}`);
      }

      const url = apiUrl('/documents', {
        'filter[docketId]': docketId,
        'page[size]': pageSize,
        'page[number]': pageNum,
        'sort': sortStr,
        'filter[documentType]': filterType || undefined,
        'filter[withinCommentPeriod]': isOpen ? 'true' : undefined,
        'filter[postedDate][ge]': dateStr || undefined,
      });

      const resp = await fetch(url, { headers: { 'X-Api-Key': apiKey } });
      if (!resp.ok) {
        // Surface the API's error detail when present — a bare status code is hard to debug
        const detail = await resp.text().catch(() => '');
        throw new Error(`HTTP ${resp.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
      }

      const data = await resp.json();
      setDocuments(data.data || []);
      setDocMeta(data.meta || null);
    } catch (e: any) {
      setErrorMsg(`Failed to fetch documents: ${e.message}`);
    } finally {
      // finally always runs — ensures the loading spinner turns off even on error
      setIsFetchingDocs(false);
    }
  }, [apiKey, sortConfig]);

  // Re-fetch documents whenever any filter, sort, or page changes
  useEffect(() => {
    if (activeDocket) {
      fetchDocuments(activeDocket.id, page, sortConfig, typeFilter, dateFilter, onlyOpenForComment);
    }
  }, [page, sortConfig, typeFilter, dateFilter, onlyOpenForComment, activeDocket, fetchDocuments]);

  // ---------------------------------------------------------------------------
  // searchDockets — Searches for EPA dockets by name or direct ID.
  // If the search term looks like a docket ID (starts with "EPA-" or "OPP-"),
  // we fetch it directly instead of doing a keyword search.
  // ---------------------------------------------------------------------------
  const searchDockets = async () => {
    if (!apiKey) return setErrorMsg("Please enter an API Key first.");
    setIsSearching(true);
    setErrorMsg('');
    // Clear previous results before starting a new search
    setDockets([]);
    setActiveDocket(null);
    setDocuments([]);
    setDocMeta(null);
    setSelectedDocIds(new Set());

    try {
      const isId = searchTerm.toUpperCase().startsWith("EPA-") || searchTerm.toUpperCase().startsWith("OPP-");
      let url = apiUrl('/dockets', { 'filter[agencyId]': 'EPA', 'filter[searchTerm]': searchTerm, 'page[size]': 20, 'sort': '-lastModifiedDate' });
      if (isId) url = `${API_BASE}/dockets/${encodeURIComponent(searchTerm)}`; // Direct ID lookup — faster and exact

      const resp = await fetch(url, { headers: { 'X-Api-Key': apiKey } });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);

      const data = await resp.json();
      // Direct ID lookup returns a single object; keyword search returns an array
      const results = isId ? [data.data] : (data.data || []);
      setDockets(results);
      if (results.length === 0) setErrorMsg("No dockets found matching that search.");
    } catch (e: any) {
      setErrorMsg(`Search failed: ${e.message}`);
    } finally {
      setIsSearching(false);
    }
  };

  // ---------------------------------------------------------------------------
  // fetchComments — Loads public comments for a document row.
  // Clicking the button a second time collapses the comments panel.
  // ---------------------------------------------------------------------------
  const fetchComments = async (docId: string) => {
    // Toggle: if this doc's comments are already open, close them
    if (expandedDocId === docId) {
      setExpandedDocId(null);
      return;
    }
    setExpandedDocId(docId);
    setDocComments([]);
    setIsFetchingComments(true);
    try {
      const resp = await fetch(apiUrl('/comments', { 'filter[commentOnId]': docId, 'sort': '-postedDate' }), {
        headers: { 'X-Api-Key': apiKey }
      });
      if (!resp.ok) throw new Error("Failed to fetch comments");
      const data = await resp.json();
      setDocComments(data.data || []);
    } catch (e) {
      console.error(e);
    } finally {
      setIsFetchingComments(false);
    }
  };

  // Toggle sort direction when clicking a column header.
  // If clicking the same column again, flip direction; otherwise default to ascending.
  const requestSort = (key: string) => {
    setSortConfig(prev => ({
      key,
      direction: prev.key === key && prev.direction === 'asc' ? 'desc' : 'asc'
    }));
    setPage(1); // Reset to first page whenever sort changes
  };

  // Set the stop flag — the download loop checks this on each iteration
  const stopDownload = () => {
    stopDownloadRef.current = true;
    addLog("[!] Stop request received. Terminating queue...");
  };

  // ---------------------------------------------------------------------------
  // triggerDirectDownload — Creates a temporary invisible link and clicks it,
  // which tells the browser to download the file at that URL.
  // This avoids having to proxy the file through our own server.
  // ---------------------------------------------------------------------------
  const triggerDirectDownload = (url: string) => {
    const link = document.createElement('a');
    link.href = url;
    // `download` hints to the browser to save instead of navigate. Cross-origin
    // servers can ignore it, but regulations.gov serves PDFs with
    // Content-Disposition: attachment, so the browser will save them.
    link.download = '';
    link.rel = 'noopener noreferrer';
    document.body.appendChild(link);
    link.click();
    setTimeout(() => { if (document.body.contains(link)) document.body.removeChild(link); }, 1000);
  };

  // ---------------------------------------------------------------------------
  // startDownload — Loops through every selected document ID, fetches its
  // attachment metadata, then triggers a browser download for each PDF found.
  // A 1.2s delay between downloads prevents the browser from blocking them.
  // ---------------------------------------------------------------------------
  const startDownload = async () => {
    stopDownloadRef.current = false; // Clear any previous stop signal
    setIsDownloading(true);
    setProgress(0);
    setLogs([]);
    const totalDocs = selectedDocIds.size;
    addLog(`Starting download queue for ${totalDocs} documents...`);
    addLog(`[!] Note: Ensure browser popups are allowed for this site.`);

    const ids = Array.from(selectedDocIds);
    let ok = 0, fail = 0;

    for (let i = 0; i < ids.length; i++) {
      // Check the stop flag before processing each document
      if (stopDownloadRef.current) {
        addLog("[!] Download process stopped by user.");
        break;
      }
      const id = ids[i];
      setProgressStatus(`Processing ${i + 1}/${ids.length}: ${id}`);
      addLog(`Fetching details for ${id}...`);

      try {
        // Fetch full document details including any file attachments
        const resp = await fetch(`${API_BASE}/documents/${id}?include=attachments`, {
          headers: { 'X-Api-Key': apiKey }
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();

        // Collect all PDF URLs from both the main document and its attachments
        const files: {url: string, label: string}[] = [];
        const extract = (attrs: any, prefix: string) => {
          (attrs.fileFormats || []).forEach((ff: any) => {
            if (ff.format?.toLowerCase() === 'pdf') {
              files.push({ url: ff.fileUrl, label: prefix });
            }
          });
        };

        extract(data.data.attributes, id);
        // "included" contains the attachment objects when ?include=attachments is used
        (data.included || []).forEach((inc: any, idx: number) => {
          extract(inc.attributes, `${id}__att${idx + 1}`);
        });

        if (files.length > 0) {
          addLog(`  → Found ${files.length} PDF(s). Triggering browser downloads...`);
          for (const f of files) {
            triggerDirectDownload(f.url);
            addLog(`    [✓] Requested: ${f.label}.pdf`);
            ok++;
            // Delay between downloads — without this, browsers silently drop rapid-fire downloads
            await new Promise(r => setTimeout(r, 1200));
          }
        } else {
          addLog(`  → No PDF files found for this document.`);
        }
      } catch (e: any) {
        addLog(`  [!] ERROR fetching ${id}: ${e.message}`);
        fail++;
      }
      // Update the progress bar as a percentage of total documents processed
      setProgress(((i + 1) / ids.length) * 100);
    }

    setIsDownloading(false);
    setProgressStatus('Finished');
    addLog("==================================================");
    addLog(`  Done.  Files Requested: ${ok}  |  Errors: ${fail}`);
    addLog("==================================================");
  };

  // ---------------------------------------------------------------------------
  // runBulkDownload — Automated pipeline:
  //   For each AI name → search dockets → take the top N most-recent → fetch
  //   every document page → keep docs whose title matches any keyword →
  //   download every PDF attachment.
  // ---------------------------------------------------------------------------
  const runBulkDownload = async () => {
    if (!apiKey) return setErrorMsg("Please enter an API Key first.");

    const ais = bulkAis.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const keywords = bulkKeywords.split(/\r?\n|,/).map(s => s.trim().toLowerCase()).filter(Boolean);
    const excludeKeywords = bulkExcludeKeywords.split(/\r?\n|,/).map(s => s.trim().toLowerCase()).filter(Boolean);

    if (ais.length === 0) return setErrorMsg("Add at least one active ingredient.");
    if (keywords.length === 0) return setErrorMsg("Add at least one keyword.");

    setErrorMsg('');
    stopDownloadRef.current = false;
    discoveryDoneRef.current = false;
    downloadQueueRef.current = [];
    setIsDownloading(true);
    setLogs([]);
    setProgress(0);
    addLog(`Bulk run: ${ais.length} AI(s) × ${keywords.length} keyword(s). Top ${bulkDocketsPerAi} docket(s) per AI.`);
    addLog(`[!] Note: Ensure browser popups + automatic downloads are allowed for this site.`);
    addLog(`Download pacing: 1 file every ${bulkDownloadIntervalMs}ms.`);

    // Start the drainer: pulls URLs out of the queue and fires one download
    // every `bulkDownloadIntervalMs` ms. Runs concurrently with discovery.
    const drainer = (async () => {
      while (true) {
        if (stopDownloadRef.current) { downloadQueueRef.current = []; return; }
        const url = downloadQueueRef.current.shift();
        if (url) {
          triggerDirectDownload(url);
          await new Promise(r => setTimeout(r, bulkDownloadIntervalMs));
        } else {
          if (discoveryDoneRef.current) return;
          await new Promise(r => setTimeout(r, 200));
        }
      }
    })();

    let okFiles = 0, failed = 0, matchedDocs = 0;

    // Throttled fetch: paces API calls and retries on HTTP 429 using
    // Retry-After when the server provides one. The regulations.gov API
    // limits to ~1000 requests/hour; without this we burn through the
    // budget in seconds on a multi-AI run.
    const API_REQUEST_DELAY_MS = 250;
    const apiFetch = async (url: string): Promise<Response> => {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (stopDownloadRef.current) throw new Error('stopped');
        await new Promise(r => setTimeout(r, API_REQUEST_DELAY_MS));
        const resp = await fetch(url, { headers: { 'X-Api-Key': apiKey } });
        if (resp.status !== 429) return resp;
        const retryAfter = parseInt(resp.headers.get('Retry-After') || '') || 60;
        const waitMs = Math.min(retryAfter, 120) * 1000;
        addLog(`  [!] Rate-limited (HTTP 429). Waiting ${Math.round(waitMs / 1000)}s before retry...`);
        const startWait = Date.now();
        while (Date.now() - startWait < waitMs) {
          if (stopDownloadRef.current) throw new Error('stopped');
          await new Promise(r => setTimeout(r, 500));
        }
      }
      throw new Error('HTTP 429 after retries');
    };

    aiLoop: for (let a = 0; a < ais.length; a++) {
      if (stopDownloadRef.current) { addLog("[!] Stopped by user."); break; }
      const ai = ais[a];
      setProgressStatus(`AI ${a + 1}/${ais.length}: ${ai}`);
      addLog(`\n=== ${ai} ===`);

      // Search dockets for this AI
      let dockets: Docket[] = [];
      try {
        const isId = ai.toUpperCase().startsWith("EPA-") || ai.toUpperCase().startsWith("OPP-");
        const url = isId
          ? `${API_BASE}/dockets/${encodeURIComponent(ai)}`
          : apiUrl('/dockets', { 'filter[agencyId]': 'EPA', 'filter[searchTerm]': ai, 'page[size]': 20, 'sort': '-lastModifiedDate' });
        const resp = await apiFetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        dockets = isId ? [data.data] : (data.data || []);
      } catch (e: any) {
        addLog(`  [!] Docket search failed: ${e.message}`);
        failed++;
        continue;
      }

      if (dockets.length === 0) { addLog(`  → No dockets found.`); continue; }

      const picked = dockets.slice(0, bulkDocketsPerAi);
      addLog(`  Found ${dockets.length} docket(s); processing top ${picked.length}.`);

      for (const docket of picked) {
        if (stopDownloadRef.current) break aiLoop;
        addLog(`  • Docket ${docket.id} — ${docket.attributes.title}`);

        // Fetch every page of documents in this docket
        const allDocs: Document[] = [];
        try {
          let pageNum = 1;
          while (true) {
            if (stopDownloadRef.current) break aiLoop;
            const url = apiUrl('/documents', { 'filter[docketId]': docket.id, 'page[size]': 250, 'page[number]': pageNum, 'sort': '-postedDate' });
            const resp = await apiFetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            const batch: Document[] = data.data || [];
            allDocs.push(...batch);
            const totalPages: number = data.meta?.totalPages || 1;
            if (pageNum >= totalPages || batch.length === 0) break;
            pageNum++;
          }
        } catch (e: any) {
          addLog(`    [!] Document list failed: ${e.message}`);
          failed++;
          continue;
        }

        // Filter: title must contain at least one include keyword AND none of the exclude keywords
        const matches = allDocs.filter(d => {
          const t = (d.attributes.title || '').toLowerCase();
          if (!keywords.some(k => t.includes(k))) return false;
          if (excludeKeywords.some(k => t.includes(k))) return false;
          return true;
        });
        addLog(`    ${allDocs.length} docs scanned → ${matches.length} keyword match(es).`);
        matchedDocs += matches.length;

        // Download PDFs for each matched doc
        for (let i = 0; i < matches.length; i++) {
          if (stopDownloadRef.current) break aiLoop;
          const doc = matches[i];
          try {
            const resp = await apiFetch(`${API_BASE}/documents/${doc.id}?include=attachments`);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();

            const files: { url: string, label: string }[] = [];
            const extract = (attrs: any, prefix: string) => {
              (attrs.fileFormats || []).forEach((ff: any) => {
                if (ff.format?.toLowerCase() === 'pdf') files.push({ url: ff.fileUrl, label: prefix });
              });
            };
            extract(data.data.attributes, doc.id);
            (data.included || []).forEach((inc: any, idx: number) => {
              extract(inc.attributes, `${doc.id}__att${idx + 1}`);
            });

            if (files.length === 0) {
              addLog(`      → ${doc.id}: no PDF.`);
              continue;
            }
            addLog(`      → ${doc.id}: queued ${files.length} PDF(s) — "${doc.attributes.title.slice(0, 80)}"`);
            for (const f of files) {
              if (stopDownloadRef.current) break aiLoop;
              downloadQueueRef.current.push(f.url);
              okFiles++;
            }
          } catch (e: any) {
            addLog(`      [!] ${doc.id} failed: ${e.message}`);
            failed++;
          }
        }
      }

      setProgress(((a + 1) / ais.length) * 100);
    }

    discoveryDoneRef.current = true;
    addLog(`Discovery finished. Draining ${downloadQueueRef.current.length} queued download(s)...`);
    setProgressStatus('Draining download queue...');
    await drainer;

    setIsDownloading(false);
    setProgressStatus('Finished');
    addLog("==================================================");
    addLog(`  Bulk done.  Matched docs: ${matchedDocs}  |  Files: ${okFiles}  |  Errors: ${failed}`);
    addLog("==================================================");
  };

  // ---------------------------------------------------------------------------
  // JSX — This is what actually renders to the screen.
  // It looks like HTML but it's JavaScript under the hood.
  // ---------------------------------------------------------------------------
  return (
    <div className="admin-panel">
      {/* API key input — stored in localStorage so it survives page refreshes */}
      <div className="api-key-banner">
        <div>
          <strong>API Authentication</strong>
          <input type="password" placeholder="Enter X-Api-Key" value={apiKey} onChange={e => setApiKey(e.target.value)} />
        </div>
        <div>Local Browser Storage</div>
      </div>

      <div className="panel-hdr">
        <div className="panel-title">EPA Docket Downloader</div>
        <div className="panel-desc">Direct download tool for EPA dockets.</div>
      </div>

      {/* Bulk download — paste an AI list and a keyword list, run once. */}
      <div style={{ border: '1px solid var(--border, #ccc)', borderRadius: 6, padding: '0.75rem 1rem', margin: '0.75rem 0' }}>
        <div
          style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
          onClick={() => setBulkOpen(o => !o)}
        >
          <strong>Bulk Download (AI list × Keyword list)</strong>
          <span>{bulkOpen ? '▾' : '▸'}</span>
        </div>

        {bulkOpen && (
          <div style={{ marginTop: '0.75rem', display: 'grid', gap: '0.75rem' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.75rem' }}>
              <div>
                <div className="admin-section-label">Active Ingredients (one per line)</div>
                <textarea
                  value={bulkAis}
                  onChange={e => setBulkAis(e.target.value)}
                  placeholder={"glyphosate\natrazine\n2,4-D"}
                  rows={6}
                  style={{ width: '100%', fontFamily: 'monospace', fontSize: '0.85rem' }}
                />
              </div>
              <div>
                <div className="admin-section-label">Include Keywords (title must contain at least one)</div>
                <textarea
                  value={bulkKeywords}
                  onChange={e => setBulkKeywords(e.target.value)}
                  placeholder={"human health risk assessment\nHHRA"}
                  rows={6}
                  style={{ width: '100%', fontFamily: 'monospace', fontSize: '0.85rem' }}
                />
              </div>
              <div>
                <div className="admin-section-label">Exclude Keywords (title must contain none)</div>
                <textarea
                  value={bulkExcludeKeywords}
                  onChange={e => setBulkExcludeKeywords(e.target.value)}
                  placeholder={"scoping\ndraft"}
                  rows={6}
                  style={{ width: '100%', fontFamily: 'monospace', fontSize: '0.85rem' }}
                />
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
              <label style={{ fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                Top dockets per AI:
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={bulkDocketsPerAi}
                  onChange={e => setBulkDocketsPerAi(Math.max(1, parseInt(e.target.value) || 1))}
                  style={{ width: 60 }}
                />
              </label>
              <label style={{ fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                Download interval (ms):
                <input
                  type="number"
                  min={100}
                  max={10000}
                  step={100}
                  value={bulkDownloadIntervalMs}
                  onChange={e => setBulkDownloadIntervalMs(Math.max(100, parseInt(e.target.value) || 1500))}
                  style={{ width: 80 }}
                />
              </label>
              {isDownloading ? (
                <button className="btn-primary" style={{ background: 'var(--danger)' }} onClick={stopDownload}>
                  Stop
                </button>
              ) : (
                <button className="btn-primary" onClick={runBulkDownload}>
                  Run Bulk Download
                </button>
              )}
              <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                Keywords match as case-insensitive substrings of the document title. Include = at least one must match; Exclude = none may match.
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Progress console — only shown once a download has started or completed */}
      {(isDownloading || logs.length > 0) && (
        <div id="epa-progress-wrap">
          <div className="admin-section-label">Console Output</div>
          <div id="epa-progress-bar-track"><div id="epa-progress-bar" style={{ width: `${progress}%` }}></div></div>
          <div style={{fontSize: '0.8rem', fontWeight: 600, color: 'var(--primary)'}}>{progressStatus}</div>
          <div id="epa-progress-log">
            {logs.map((log, i) => <div key={i} className="log-entry">{log}</div>)}
          </div>
        </div>
      )}

      {/* Error banner — shown whenever an API call fails */}
      {errorMsg && <div className="alert-error">{errorMsg}</div>}

      {/* Search bar — pressing Enter or clicking the button triggers searchDockets() */}
      <div className="epa-search-row">
        <input id="epa-search-input" type="text" placeholder="Pesticide Name or Docket ID" value={searchTerm} onChange={e => setSearchTerm(e.target.value)} onKeyDown={e => e.key === 'Enter' && searchDockets()} />
        <button className="btn-primary" onClick={searchDockets} disabled={isSearching}>{isSearching ? 'Searching...' : 'Search Dockets'}</button>
      </div>

      {/* Docket list — rendered only after a search returns results */}
      {dockets.length > 0 && (
        <div id="epa-docket-list">
          <div className="admin-section-label">Matching Dockets (Recent First)</div>
          {dockets.map(d => (
            // Clicking a docket sets it as active and resets to page 1
            <div key={d.id} className={`docket-item ${activeDocket?.id === d.id ? 'active' : ''}`} onClick={() => {setActiveDocket(d); setPage(1);}}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
                <strong>{d.id}</strong>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 600 }}>
                  Updated: {new Date(d.attributes.lastModifiedDate).toLocaleDateString()}
                </span>
              </div>
              <div className="docket-title">{d.attributes.title}</div>
            </div>
          ))}
        </div>
      )}

      {/* Document table — only shown after a docket is selected */}
      {activeDocket && (
        <div>
          <div className="admin-section-label">
            Documents in <strong>{activeDocket.id}</strong>
            {docMeta && <span className="label-aside">{docMeta.totalElements} total</span>}
          </div>

          {/* Toolbar: select-all checkbox, filters, and the download/stop button */}
          <div className="epa-doc-toolbar">
            <div className="toolbar-group">
              <label style={{display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', fontSize: '0.85rem'}}>
                <input type="checkbox" onChange={e => setSelectedDocIds(e.target.checked ? new Set(documents.map(d => d.id)) : new Set())} checked={documents.length > 0 && documents.every(d => selectedDocIds.has(d.id))} />
                Select All
              </label>

              <select value={typeFilter} onChange={e => { setPage(1); setTypeFilter(e.target.value); }}>
                <option value="">All Types</option>
                <option value="Supporting & Related Material">Supporting & Related Material</option>
                <option value="Notice">Notice</option>
                <option value="Rule">Rule</option>
                <option value="Proposed Rule">Proposed Rule</option>
              </select>

              <select value={dateFilter} onChange={e => { setPage(1); setDateFilter(e.target.value); }}>
                <option value="">All Time</option>
                <option value="30">Last 30 Days</option>
                <option value="90">Last 90 Days</option>
                <option value="365">Last 1 Year</option>
              </select>

              <label style={{display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', fontSize: '0.85rem', color: 'var(--success)', fontWeight: 600}}>
                <input type="checkbox" checked={onlyOpenForComment} onChange={e => { setPage(1); setOnlyOpenForComment(e.target.checked); }} />
                Open For Comment
              </label>
            </div>

            {/* While downloading: show Stop button. Otherwise: show Download button. */}
            {isDownloading ? (
              <button className="btn-primary" style={{ background: 'var(--danger)' }} onClick={stopDownload}>
                Stop Download
              </button>
            ) : (
              <button className="btn-primary" disabled={selectedDocIds.size === 0} onClick={startDownload}>
                Download Selection ({selectedDocIds.size})
              </button>
            )}
          </div>

          <div id="epa-doc-table-wrap">
            <table id="epa-doc-table">
              <thead>
                <tr>
                  <th style={{ width: '40px' }}></th>
                  {/* Clickable column headers trigger requestSort() */}
                  <th style={{ width: '180px', cursor: 'pointer' }} onClick={() => requestSort('documentId')}>
                    Document ID {sortConfig.key === 'documentId' ? (sortConfig.direction === 'asc' ? '↑' : '↓') : '↕'}
                  </th>
                  <th style={{ width: '120px' }}>Type</th>
                  <th style={{ cursor: 'pointer' }} onClick={() => requestSort('title')}>
                    Title {sortConfig.key === 'title' ? (sortConfig.direction === 'asc' ? '↑' : '↓') : '↕'}
                  </th>
                  <th style={{ width: '100px', cursor: 'pointer' }} onClick={() => requestSort('postedDate')}>
                    Posted {sortConfig.key === 'postedDate' ? (sortConfig.direction === 'asc' ? '↑' : '↓') : '↕'}
                  </th>
                  <th style={{ width: '120px' }}>Actions</th>
                </tr>
              </thead>
              <tbody id="epa-doc-tbody">
                {isFetchingDocs ? (
                  <tr><td colSpan={6} style={{textAlign: 'center', padding: '3rem'}}>Loading...</td></tr>
                ) : (
                  // React.Fragment lets us render two <tr> rows per document (the row + comments row)
                  // without adding an extra wrapper element to the DOM
                  documents.map(doc => (
                    <React.Fragment key={doc.id}>
                      <tr>
                        <td><input type="checkbox" checked={selectedDocIds.has(doc.id)} onChange={() => {const next = new Set(selectedDocIds); if (next.has(doc.id)) next.delete(doc.id); else next.add(doc.id); setSelectedDocIds(next);}} /></td>
                        <td style={{fontWeight: 600}}>{doc.id}</td>
                        <td><span className={`badge badge-${doc.attributes.documentType.replace(/\s+/g, '')}`}>{doc.attributes.documentType}</span></td>
                        <td>
                          {doc.attributes.title}
                          {/* Pulsing badge only appears if the comment period is currently open */}
                          {doc.attributes.openForComment && (
                            <div className="pulsing-badge">
                              ● Open for Comment until {new Date(doc.attributes.commentEndDate).toLocaleDateString()}
                            </div>
                          )}
                        </td>
                        <td>{new Date(doc.attributes.postedDate).toLocaleDateString()}</td>
                        <td>
                          <button className="btn-secondary" onClick={() => fetchComments(doc.id)}>
                            {expandedDocId === doc.id ? 'Hide Comments' : 'View Comments'}
                          </button>
                        </td>
                      </tr>
                      {/* Comments expansion row — only rendered for the currently expanded document */}
                      {expandedDocId === doc.id && (
                        <tr className="comments-row">
                          <td colSpan={6}>
                            <div className="comments-container">
                              <div className="admin-section-label">Public Comments for {doc.id}</div>
                              {isFetchingComments ? (
                                <div style={{textAlign: 'center', color: 'var(--text-muted)'}}>Fetching comments...</div>
                              ) : docComments.length === 0 ? (
                                <div style={{textAlign: 'center', color: 'var(--text-muted)'}}>No public comments found.</div>
                              ) : (
                                docComments.map(c => (
                                  <div key={c.id} className="comment-card">
                                    <div>
                                      <div className="comment-title">{c.attributes.title || "Untitled Comment"}</div>
                                      <div className="comment-meta">Posted: {new Date(c.attributes.postedDate).toLocaleDateString()} | Type: {c.attributes.submitterType || "Unknown"}</div>
                                    </div>
                                    <div className="comment-meta">ID: {c.id}</div>
                                  </div>
                                ))
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination — only shown if there's more than one page of results */}
          {docMeta && docMeta.totalPages > 1 && (
            <div className="pagination-controls">
              <span>Page {page} of {docMeta.totalPages}</span>
              <div>
                <button className="btn-page" disabled={page === 1} onClick={() => setPage(p => p - 1)}>&larr; Prev</button>
                <button className="btn-page" disabled={page === docMeta.totalPages} onClick={() => setPage(p => p + 1)}>Next &rarr;</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default App;
