/**
 * ENCYCLOPÉDIE — Frontend Application
 * Handles chat interactions, RAG queries, and admin functions
 */

const API_BASE = window.location.origin;

// ── DOM Elements ──
const welcomeSection = document.getElementById('welcome-section');
const chatMessages = document.getElementById('chat-messages');
const questionInput = document.getElementById('question-input');
const btnSend = document.getElementById('btn-send');
const btnClearChat = document.getElementById('btn-clear-chat');
const btnStatus = document.getElementById('btn-status');
const btnSettings = document.getElementById('btn-settings');
const modalOverlay = document.getElementById('modal-overlay');
const modalClose = document.getElementById('modal-close');
const statusIndicator = document.getElementById('status-indicator');
const statusText = document.getElementById('status-text');
const btnIngest = document.getElementById('btn-ingest');
const btnReset = document.getElementById('btn-reset');
const uploadZone = document.getElementById('upload-zone');
const fileInput = document.getElementById('file-input');
const toastEl = document.getElementById('toast');
const modelSelect = document.getElementById('model-select');
const topKInput = document.getElementById('top-k-input');
const topKValue = document.getElementById('top-k-value');
const recentQuestions = document.getElementById('recent-questions');
const recentList = document.getElementById('recent-list');

let isLoading = false;
const SETTINGS_KEY = 'encyclopedie-settings';
const RECENT_KEY = 'encyclopedie-recent-questions';

// ── Initialize ──
document.addEventListener('DOMContentLoaded', () => {
    restoreSettings();
    renderRecentQuestions();
    checkStatus();
    setupEventListeners();
    autoResizeTextarea();
});

function setupEventListeners() {
    // Send question
    btnSend.addEventListener('click', sendQuestion);
    questionInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendQuestion();
        }
    });
    questionInput.addEventListener('input', () => {
        autoResizeTextarea();
        btnSend.disabled = !questionInput.value.trim();
    });
    btnClearChat.addEventListener('click', clearChat);
    modelSelect.addEventListener('change', saveSettings);
    topKInput.addEventListener('input', () => {
        topKValue.textContent = topKInput.value;
        saveSettings();
    });

    // Suggestions
    document.querySelectorAll('.suggestion-card').forEach(card => {
        card.addEventListener('click', () => {
            const q = card.dataset.question;
            questionInput.value = q;
            btnSend.disabled = false;
            autoResizeTextarea();
            sendQuestion();
        });
    });

    // Modal
    btnSettings.addEventListener('click', openSettings);
    btnStatus.addEventListener('click', () => { openSettings(); checkStatus(); });
    modalClose.addEventListener('click', closeModal);
    modalOverlay.addEventListener('click', (e) => {
        if (e.target === modalOverlay) closeModal();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeModal();
    });

    // Admin actions
    btnIngest.addEventListener('click', ingestDocuments);
    btnReset.addEventListener('click', resetDatabase);

    // Upload
    uploadZone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', handleFileUpload);
    uploadZone.addEventListener('dragover', (e) => { e.preventDefault(); uploadZone.style.borderColor = 'var(--gold)'; });
    uploadZone.addEventListener('dragleave', () => { uploadZone.style.borderColor = ''; });
    uploadZone.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadZone.style.borderColor = '';
        if (e.dataTransfer.files.length) {
            fileInput.files = e.dataTransfer.files;
            handleFileUpload();
        }
    });

    chatMessages.addEventListener('click', (e) => {
        const copyButton = e.target.closest('[data-copy-answer]');
        if (copyButton) copyAnswer(copyButton);
    });

    recentList.addEventListener('click', (e) => {
        const button = e.target.closest('[data-recent-question]');
        if (!button) return;
        questionInput.value = button.dataset.recentQuestion;
        btnSend.disabled = false;
        autoResizeTextarea();
        sendQuestion();
    });
}

function autoResizeTextarea() {
    questionInput.style.height = 'auto';
    questionInput.style.height = Math.min(questionInput.scrollHeight, 120) + 'px';
}

// ── API Helper ──
async function apiRequest(url, options = {}) {
    const res = await fetch(url, options);
    const contentType = res.headers.get("content-type") || "";
    let data;
    
    if (contentType.includes("application/json")) {
        data = await res.json();
    } else {
        const text = await res.text();
        data = { detail: text || `Erreur serveur (${res.status})` };
    }
    
    if (!res.ok) {
        throw new Error(data.detail || data.message || `Erreur serveur (${res.status})`);
    }
    return data;
}

// ── API Calls ──

async function checkStatus() {
    try {
        const data = await apiRequest(`${API_BASE}/api/status`);

        if (data.ollama_connected) {
            statusIndicator.className = 'status-dot status-ok';
            statusText.textContent = `Connecté — ${data.documents_indexed} passages indexés`;
        } else {
            statusIndicator.className = 'status-dot status-error';
            statusText.textContent = 'Ollama non connecté — lancez : ollama serve';
        }
        populateModelSelect(data.models_available);

        // Update modal details
        document.getElementById('detail-ollama').textContent = data.ollama_connected ? '✓ Connecté' : '✗ Déconnecté';
        document.getElementById('detail-ollama').style.color = data.ollama_connected ? 'var(--emerald)' : 'var(--burgundy)';
        document.getElementById('detail-models').textContent = data.models_available.join(', ') || 'Aucun';
        document.getElementById('detail-docs').textContent = `${data.documents_indexed} passages`;

        // Load documents list
        loadDocumentsList();
    } catch (e) {
        statusIndicator.className = 'status-dot status-error';
        statusText.textContent = 'Backend non disponible — lancez le serveur';
    }
}

async function sendQuestion() {
    const question = questionInput.value.trim();
    if (!question || isLoading) return;

    isLoading = true;
    btnSend.disabled = true;
    const selectedModel = modelSelect.value || null;
    const topK = Number(topKInput.value) || 5;
    questionInput.value = '';
    autoResizeTextarea();

    // Hide welcome, show chat
    welcomeSection.classList.add('hidden');
    chatMessages.classList.remove('hidden');

    // Add user message
    appendMessage('user', question);

    // Show typing indicator
    const typingEl = appendTyping();

    try {
        const response = await fetch(`${API_BASE}/api/ask`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ question, top_k: topK, model: selectedModel })
        });

        if (!response.ok) {
            let errorMsg = `Erreur serveur (${response.status})`;
            try { const errData = await response.json(); errorMsg = errData.detail || errorMsg; } catch(e){}
            throw new Error(errorMsg);
        }

        typingEl.remove();
        
        // Prepare UI for the assistant's streaming answer
        const messageDiv = document.createElement('div');
        messageDiv.className = 'message assistant-message';
        messageDiv.innerHTML = `
            <div class="message-content">
                <div class="message-text"></div>
                <div class="sources-container" style="margin-top: 15px;"></div>
                <div class="message-meta" style="margin-top: 10px;"></div>
            </div>
        `;
        chatMessages.appendChild(messageDiv);
        const textContainer = messageDiv.querySelector('.message-text');
        const sourcesContainer = messageDiv.querySelector('.sources-container');
        const metaContainer = messageDiv.querySelector('.message-meta');
        
        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let fullText = "";
        let sourcesData = [];

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split('\n\n');
            
            for (const line of lines) {
                if (line.startsWith("data: ")) {
                    try {
                        const data = JSON.parse(line.slice(6));
                        
                        if (data.type === 'sources') {
                            sourcesData = data.sources;
                        } else if (data.type === 'token') {
                            fullText += data.token;
                            textContainer.innerHTML = formatMarkdown(fullText);
                            scrollToBottom();
                        } else if (data.type === 'done') {
                            // Render sources
                            if (sourcesData && sourcesData.length > 0) {
                                sourcesData.forEach((src, idx) => {
                                    const sourceEl = document.createElement('div');
                                    sourceEl.className = 'source-card';
                                    sourceEl.innerHTML = `
                                        <div class="source-header">
                                            <span class="source-title">Source ${idx + 1}: ${escapeHtml(src.source)}</span>
                                            <span class="source-score">Sim: ${src.score}</span>
                                        </div>
                                        <div class="source-text">${escapeHtml(src.content)}...</div>
                                    `;
                                    sourcesContainer.appendChild(sourceEl);
                                });
                            }
                            // Render meta
                            metaContainer.innerHTML = `<span class="meta-model">${data.model}</span><span class="meta-time">${data.elapsed_seconds}s</span>`;
                            saveRecentQuestion(question);
                            scrollToBottom();
                        } else if (data.type === 'error') {
                            fullText += `\n\n**⚠️ Erreur :** ${data.message}`;
                            textContainer.innerHTML = formatMarkdown(fullText);
                            scrollToBottom();
                        }
                    } catch (e) {
                        console.error("Error parsing stream chunk", e);
                    }
                }
            }
        }

    } catch (e) {
        if (typingEl && typingEl.parentNode) typingEl.remove();
        appendMessage('assistant', `⚠️ Erreur : ${e.message}`, [], '', 0);
    }

    isLoading = false;
    scrollToBottom();
}

async function ingestDocuments() {
    btnIngest.disabled = true;
    btnIngest.textContent = 'Indexation en cours…';

    try {
        const data = await apiRequest(`${API_BASE}/api/ingest`, { method: 'POST' });
        showToast(data.message, 'success');
        checkStatus();
    } catch (e) {
        showToast(`Erreur : ${e.message}`, 'error');
    }

    btnIngest.disabled = false;
    btnIngest.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
        <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
        <polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
    </svg> Indexer les documents`;
}

async function resetDatabase() {
    if (!confirm('Réinitialiser la base vectorielle ? Tous les index seront supprimés.')) return;

    try {
        const data = await apiRequest(`${API_BASE}/api/reset`, { method: 'DELETE' });
        showToast(data.message, 'success');
        checkStatus();
    } catch (e) {
        showToast(`Erreur : ${e.message}`, 'error');
    }
}

async function loadDocumentsList() {
    try {
        const data = await apiRequest(`${API_BASE}/api/documents`);
        const listEl = document.getElementById('documents-list');

        if (data.documents.length === 0) {
            listEl.innerHTML = '<p class="text-muted" style="font-size:0.83rem">Aucun document dans data/raw/</p>';
            return;
        }

        listEl.innerHTML = data.documents.map(d => `
            <div class="doc-item">
                <span>📄 ${escapeHtml(d.name)}</span>
                <span class="doc-size">${d.size_kb} Ko</span>
            </div>
        `).join('');
    } catch (e) {
        // Silently fail
    }
}

async function handleFileUpload() {
    const file = fileInput.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);

    try {
        const data = await apiRequest(`${API_BASE}/api/upload`, { method: 'POST', body: formData });
        showToast(data.message, 'success');
        loadDocumentsList();
    } catch (e) {
        showToast(`Erreur : ${e.message}`, 'error');
    }

    fileInput.value = '';
}

// ── DOM Helpers ──

function appendMessage(role, content, sources = [], model = '', elapsed = 0) {
    const msgDiv = document.createElement('div');
    msgDiv.className = `message message-${role}`;

    if (role === 'user') {
        msgDiv.innerHTML = `<div class="message-bubble">${escapeHtml(content)}</div>`;
    } else {
        const formattedContent = formatMarkdown(content);
        let sourcesHtml = '';

        if (sources && sources.length > 0) {
            const sourceItems = sources.map((s, index) =>
                `<details class="source-card">
                    <summary>
                        <span class="source-rank">${index + 1}</span>
                        <span class="source-name">${escapeHtml(s.source)}</span>
                        <span class="source-score">${Math.max(0, s.score * 100).toFixed(0)}%</span>
                    </summary>
                    <p>${escapeHtml(s.content)}</p>
                </details>`
            ).join('');

            sourcesHtml = `
                <div class="sources-panel">
                    <div class="sources-title">Sources consultées</div>
                    <div class="sources-list">${sourceItems}</div>
                </div>`;
        }

        const metaHtml = model ? `
            <div class="message-meta">
                <span>Modèle : ${escapeHtml(model)}</span>
                <span aria-hidden="true">•</span>
                <span>${elapsed}s</span>
                <button class="btn-copy" data-copy-answer title="Copier la réponse" aria-label="Copier la réponse">Copier</button>
            </div>` : '';

        msgDiv.innerHTML = `
            <div class="message-bubble" data-answer="${escapeAttr(content)}">${formattedContent}${sourcesHtml}</div>
            ${metaHtml}`;
    }

    chatMessages.appendChild(msgDiv);
    scrollToBottom();
    return msgDiv;
}

function appendTyping() {
    const div = document.createElement('div');
    div.className = 'message message-assistant';
    div.innerHTML = `<div class="typing-indicator">
        <div class="typing-dot"></div>
        <div class="typing-dot"></div>
        <div class="typing-dot"></div>
    </div>`;
    chatMessages.appendChild(div);
    scrollToBottom();
    return div;
}

function scrollToBottom() {
    const main = document.getElementById('app-main');
    setTimeout(() => { main.scrollTop = main.scrollHeight; }, 50);
}

function formatMarkdown(text) {
    // Basic markdown formatting
    let html = escapeHtml(text);
    
    // Bold
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    // Italic
    html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
    // Line breaks to paragraphs
    html = html.split('\n\n').map(p => `<p>${p.trim()}</p>`).join('');
    // Single line breaks
    html = html.replace(/\n/g, '<br>');
    // Lists (— or - at start of line)
    html = html.replace(/<br>[\s]*[—\-]\s/g, '</p><p>• ');
    
    return html;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function escapeAttr(text) {
    return escapeHtml(text).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function populateModelSelect(models = []) {
    const current = modelSelect.value;
    const options = ['<option value="">Par défaut</option>'];

    models.forEach(model => {
        const selected = model === current ? ' selected' : '';
        options.push(`<option value="${escapeAttr(model)}"${selected}>${escapeHtml(model)}</option>`);
    });

    modelSelect.innerHTML = options.join('');
    if (current && models.includes(current)) {
        modelSelect.value = current;
    }
}

function saveSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
        model: modelSelect.value,
        topK: topKInput.value
    }));
}

function restoreSettings() {
    try {
        const settings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
        if (settings.topK) {
            topKInput.value = settings.topK;
            topKValue.textContent = settings.topK;
        }
        if (settings.model) {
            modelSelect.innerHTML = `<option value="">Par défaut</option><option value="${escapeAttr(settings.model)}" selected>${escapeHtml(settings.model)}</option>`;
        }
    } catch (e) {
        localStorage.removeItem(SETTINGS_KEY);
    }
}

function saveRecentQuestion(question) {
    const recent = getRecentQuestions().filter(item => item !== question);
    recent.unshift(question);
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent.slice(0, 5)));
    renderRecentQuestions();
}

function getRecentQuestions() {
    try {
        return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    } catch (e) {
        return [];
    }
}

function renderRecentQuestions() {
    const recent = getRecentQuestions();
    recentQuestions.classList.toggle('hidden', recent.length === 0);
    recentList.innerHTML = recent.map(question => `
        <button class="recent-question" data-recent-question="${escapeAttr(question)}">${escapeHtml(question)}</button>
    `).join('');
}

function clearChat() {
    chatMessages.innerHTML = '';
    chatMessages.classList.add('hidden');
    welcomeSection.classList.remove('hidden');
    questionInput.focus();
}

async function copyAnswer(button) {
    const message = button.closest('.message-assistant');
    const bubble = message?.querySelector('[data-answer]');
    if (!bubble) return;

    try {
        await navigator.clipboard.writeText(bubble.dataset.answer);
        showToast('Réponse copiée', 'success');
    } catch (e) {
        showToast('Impossible de copier la réponse', 'error');
    }
}

// ── Modal ──

function openSettings() {
    modalOverlay.classList.remove('hidden');
    checkStatus();
    loadDocumentsList();
}

function closeModal() {
    modalOverlay.classList.add('hidden');
}

// ── Toast ──

function showToast(message, type = 'info') {
    toastEl.textContent = message;
    toastEl.className = `toast toast-${type}`;
    setTimeout(() => { toastEl.classList.add('hidden'); }, 4000);
}
