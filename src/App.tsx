import React, { useState, useEffect, useCallback } from 'react';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import './App.css';

// Updated interfaces based on OpenAPI spec
interface Document {
  id: string;
  attributes: {
    title: string;
    documentType: string;
    postedDate: string;
    openForComment: boolean;
    commentEndDate: string;
  };
}

interface Docket {
  id: string;
  attributes: {
    title: string;
    docketType: string;
  };
}

interface Meta {
  totalElements: number;
  totalPages: number;
}

interface Comment {
  id: string;
  attributes: {
    title: string;
    postedDate: string;
    submitterType: string;
  };
}

const API_BASE = "https://api.regulations.gov/v4";

function App() {
  const [apiKey, setApiKey] = useState(localStorage.getItem('reg_gov_api_key') || '');
  const [searchTerm, setSearchTerm] = useState('');
  
  // Data States
  const [dockets, setDockets] = useState<Docket[]>([]);
  const [activeDocket, setActiveDocket] = useState<Docket | null>(null);
  const [documents, setDocuments] = useState<Document[]>([]);
  const [docMeta, setDocMeta] = useState<Meta | null>(null);
  
  // Table Controls (Server-side)
  const [page, setPage] = useState(1);
  const pageSize = 50; 
  const [typeFilter, setTypeFilter] = useState('');
  const [dateFilter, setDateFilter] = useState(''); 
  const [onlyOpenForComment, setOnlyOpenForComment] = useState(false);
  const [sortConfig, setSortConfig] = useState<{ key: string, direction: 'asc' | 'desc' }>({ key: 'postedDate', direction: 'desc' });
  
  // Interaction States
  const [selectedDocIds, setSelectedDocIds] = useState<Set<string>>(new Set());
  const [isSearching, setIsSearching] = useState(false);
  const [isFetchingDocs, setIsFetchingDocs] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  
  // Comments Feature States
  const [expandedDocId, setExpandedDocId] = useState<string | null>(null);
  const [docComments, setDocComments] = useState<Comment[]>([]);
  const [isFetchingComments, setIsFetchingComments] = useState(false);

  // Download States
  const [isDownloading, setIsDownloading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressStatus, setProgressStatus] = useState('');
  const [logs, setLogs] = useState<string[]>([]);

  const addLog = (msg: string) => setLogs(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);

  // Save API key
  useEffect(() => {
    localStorage.setItem('reg_gov_api_key', apiKey);
  }, [apiKey]);

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
      const sortStr = sort.direction === 'desc' ? `-${sort.key}` : sort.key;
      let url = `${API_BASE}/documents?filter[docketId]=${docketId}&page[size]=${pageSize}&page[number]=${pageNum}&sort=${sortStr}`;
      
      if (filterType) url += `&filter[documentType]=${encodeURIComponent(filterType)}`;
      if (isOpen) url += `&filter[withinCommentPeriod]=true`;
      
      if (filterDate) {
        const date = new Date();
        date.setDate(date.getDate() - parseInt(filterDate));
        const dateStr = date.toISOString().split('T')[0];
        url += `&filter[postedDate]=ge${dateStr}`;
      }

      const resp = await fetch(url, { headers: { 'X-Api-Key': apiKey } });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
      
      const data = await resp.json();
      setDocuments(data.data || []);
      setDocMeta(data.meta || null);
    } catch (e: any) {
      setErrorMsg(`Failed to fetch documents: ${e.message}`);
    } finally {
      setIsFetchingDocs(false);
    }
  }, [apiKey, sortConfig]);

  useEffect(() => {
    if (activeDocket) {
      fetchDocuments(activeDocket.id, page, sortConfig, typeFilter, dateFilter, onlyOpenForComment);
    }
  }, [page, sortConfig, typeFilter, dateFilter, onlyOpenForComment, activeDocket, fetchDocuments]);

  const searchDockets = async () => {
    if (!apiKey) return setErrorMsg("Please enter an API Key first.");
    setIsSearching(true);
    setErrorMsg('');
    setDockets([]);
    setActiveDocket(null);
    setDocuments([]);
    setDocMeta(null);
    setSelectedDocIds(new Set());
    
    try {
      const isId = searchTerm.toUpperCase().startsWith("EPA-") || searchTerm.toUpperCase().startsWith("OPP-");
      let url = `${API_BASE}/dockets?filter[agencyId]=EPA&filter[searchTerm]=${searchTerm}&page[size]=20&sort=-lastModifiedDate`;
      if (isId) url = `${API_BASE}/dockets/${searchTerm}`;

      const resp = await fetch(url, { headers: { 'X-Api-Key': apiKey } });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
      
      const data = await resp.json();
      const results = isId ? [data.data] : (data.data || []);
      setDockets(results);
      if (results.length === 0) setErrorMsg("No dockets found matching that search.");
    } catch (e: any) {
      setErrorMsg(`Search failed: ${e.message}`);
    } finally {
      setIsSearching(false);
    }
  };

  const fetchComments = async (docId: string) => {
    if (expandedDocId === docId) {
      setExpandedDocId(null);
      return;
    }
    setExpandedDocId(docId);
    setDocComments([]);
    setIsFetchingComments(true);
    try {
      const resp = await fetch(`${API_BASE}/comments?filter[commentOnId]=${docId}&sort=-postedDate`, {
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

  const requestSort = (key: string) => {
    setSortConfig(prev => ({
      key,
      direction: prev.key === key && prev.direction === 'asc' ? 'desc' : 'asc'
    }));
    setPage(1);
  };

  const triggerDirectDownload = (url: string) => {
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    document.body.appendChild(link);
    link.click();
    setTimeout(() => { if (document.body.contains(link)) document.body.removeChild(link); }, 1000);
  };

  const startDownload = async () => {
    setIsDownloading(true);
    setProgress(0);
    setLogs([]);
    const totalDocs = selectedDocIds.size;
    addLog(`Starting download of ${totalDocs} selected documents...`);
    addLog(`[!] NOTE: If triggered, please click 'Allow' to permit multiple file downloads.`);

    const ids = Array.from(selectedDocIds);
    let ok = 0, fail = 0;
    const zip = totalDocs > 1 ? new JSZip() : null;

    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      setProgressStatus(`Processing ${i + 1}/${ids.length}: ${id}`);
      addLog(`Fetching details for ${id}...`);

      try {
        const resp = await fetch(`${API_BASE}/documents/${id}?include=attachments`, {
          headers: { 'X-Api-Key': apiKey }
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        
        const files: {url: string, label: string}[] = [];
        const extract = (attrs: any, prefix: string) => {
          (attrs.fileFormats || []).forEach((ff: any) => {
            if (ff.format?.toLowerCase() === 'pdf') {
              files.push({ url: ff.fileUrl, label: prefix });
            }
          });
        };

        extract(data.data.attributes, id);
        (data.included || []).forEach((inc: any, idx: number) => {
          extract(inc.attributes, `${id}__att${idx + 1}`);
        });

        if (files.length > 0) {
          addLog(`  → Found ${files.length} PDF(s).`);
          for (const f of files) {
            if (zip) {
              try {
                addLog(`    [+] Fetching ${f.label}.pdf via proxy...`);
                const proxyUrl = `https://corsproxy.io/?url=${encodeURIComponent(f.url)}`;
                
                const fileResp = await fetch(proxyUrl);
                if (!fileResp.ok) throw new Error(`HTTP ${fileResp.status}`);
                
                const blob = await fileResp.blob();
                zip.file(`${f.label}.pdf`, blob);
                addLog(`    [✓] Added to ZIP bundle`);
                ok++;
              } catch (err: any) {
                addLog(`    [!] Proxy fetch failed (${err.message}). Using direct fallback...`);
                triggerDirectDownload(f.url);
                addLog(`    [✓] Fallback request sent to browser`);
                ok++;
                await new Promise(r => setTimeout(r, 1500)); 
              }
            } else {
              addLog(`    [+] Triggering direct download for ${f.label}.pdf`);
              triggerDirectDownload(f.url);
              ok++;
              await new Promise(r => setTimeout(r, 1000));
            }
          }
        }
      } catch (e: any) {
        addLog(`  [!] ERROR: ${e.message}`);
        fail++;
      }
      setProgress(((i + 1) / ids.length) * 100);
      await new Promise(r => setTimeout(r, 800)); 
    }

    if (zip && ok > 0) {
      addLog("[+] Generating final ZIP file package...");
      const content = await zip.generateAsync({ type: "blob" });
      saveAs(content, "EPA_Documents.zip");
      addLog("[✓] ZIP file download triggered");
    }

    setIsDownloading(false);
    setProgressStatus('Finished');
    addLog("==================================================");
    addLog(`  Done.  Processed: ${ok}  |  Failed: ${fail}`);
    addLog("==================================================");
  };

  return (
    <div className="admin-panel">
      <div className="api-key-banner">
        <div>
          <strong>API Authentication</strong>
          <input type="password" placeholder="Enter X-Api-Key" value={apiKey} onChange={e => setApiKey(e.target.value)} />
        </div>
        <div>Local Browser Storage</div>
      </div>

      <div className="panel-hdr">
        <div className="panel-title">EPA Docket Downloader</div>
        <div className="panel-desc">Advanced Regulations.gov Interface with server-side filtering and comment tracking.</div>
      </div>

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

      {errorMsg && <div className="alert-error">{errorMsg}</div>}

      <div className="epa-search-row">
        <input id="epa-search-input" type="text" placeholder="Pesticide Name or Docket ID" value={searchTerm} onChange={e => setSearchTerm(e.target.value)} onKeyDown={e => e.key === 'Enter' && searchDockets()} />
        <button className="btn-primary" onClick={searchDockets} disabled={isSearching}>{isSearching ? 'Searching...' : 'Search Dockets'}</button>
      </div>

      {dockets.length > 0 && (
        <div id="epa-docket-list">
          <div className="admin-section-label">Matching Dockets</div>
          {dockets.map(d => (
            <div key={d.id} className={`docket-item ${activeDocket?.id === d.id ? 'active' : ''}`} onClick={() => {setActiveDocket(d); setPage(1);}}>
              <strong>{d.id}</strong>
              <div className="docket-title">{d.attributes.title}</div>
            </div>
          ))}
        </div>
      )}

      {activeDocket && (
        <div>
          <div className="admin-section-label">
            Documents in <strong>{activeDocket.id}</strong>
            {docMeta && <span className="label-aside">{docMeta.totalElements} total</span>}
          </div>

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

            <button className="btn-primary" disabled={selectedDocIds.size === 0 || isDownloading} onClick={startDownload}>
              Download ({selectedDocIds.size})
            </button>
          </div>

          <div id="epa-doc-table-wrap">
            <table id="epa-doc-table">
              <thead>
                <tr>
                  <th style={{ width: '40px' }}></th>
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
                  documents.map(doc => (
                    <React.Fragment key={doc.id}>
                      <tr>
                        <td><input type="checkbox" checked={selectedDocIds.has(doc.id)} onChange={() => {const next = new Set(selectedDocIds); if (next.has(doc.id)) next.delete(doc.id); else next.add(doc.id); setSelectedDocIds(next);}} /></td>
                        <td style={{fontWeight: 600}}>{doc.id}</td>
                        <td><span className={`badge badge-${doc.attributes.documentType.replace(/\s+/g, '')}`}>{doc.attributes.documentType}</span></td>
                        <td>
                          {doc.attributes.title}
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
