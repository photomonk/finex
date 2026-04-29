let currentSymbol = "";
let healthChartInstance = null;
let recentSearches = JSON.parse(localStorage.getItem('finagent_searches')) || [];
let currentUser = localStorage.getItem('fintech_user') || null;




// Initialization
document.addEventListener('DOMContentLoaded', () => {
    // Theme Management
    const themeBtn = document.getElementById('theme-toggle');
    const isDark = localStorage.getItem('finagent_theme') === 'dark';
    if (isDark) {
        document.body.classList.add('dark-mode');
        themeBtn.innerHTML = '<i class="fa-solid fa-sun"></i>';
    }

    themeBtn.addEventListener('click', () => {
        document.body.classList.toggle('dark-mode');
        const isNowDark = document.body.classList.contains('dark-mode');
        themeBtn.innerHTML = isNowDark ? '<i class="fa-solid fa-sun"></i>' : '<i class="fa-solid fa-moon"></i>';
        localStorage.setItem('finagent_theme', isNowDark ? 'dark' : 'light');
        if (healthChartInstance) healthChartInstance.update();
    });

    // Navigation Sub-system
    const navLinks = document.querySelectorAll('.nav-links a, #nav-get-started');
    const views = document.querySelectorAll('.view-section');

    function switchView(targetView) {
        document.querySelectorAll('.nav-links a').forEach(l => l.classList.remove('active'));
        const activeLink = document.querySelector(`.nav-links a[data-view="${targetView}"]`);
        if (activeLink) activeLink.classList.add('active');

        views.forEach(v => {
            if (v.id === targetView) {
                v.classList.remove('hidden');
                v.classList.add('active');
            } else {
                v.classList.add('hidden');
                v.classList.remove('active');
            }
        });
    }

    navLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            switchView(link.getAttribute('data-view'));
        });
    });

    // Auth Init
    updateAuthUI();
    renderRecentSearches();
});

// Expose market search globally for market view onclicks
window.searchFromMarket = function (symbol) {
    document.getElementById('symbol-input').value = symbol;
    document.querySelector('.nav-links a[data-view=analyze-view]').click();
    document.getElementById('search-form').dispatchEvent(new Event('submit'));
};

// Single Analyze
document.getElementById('search-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const symbol = document.getElementById('symbol-input').value.trim().toUpperCase();
    if (!symbol) return;

    currentSymbol = symbol;

    // UI State
    document.getElementById('empty-state').classList.add('hidden');
    document.getElementById('dashboard').classList.add('hidden');
    document.getElementById('loading-spinner').classList.remove('hidden');
    document.getElementById('chat-history').innerHTML = '';
    const errAlert = document.getElementById('analyze-error-alert');
    if (errAlert) errAlert.classList.add('hidden');

    try {
        const res = await fetch('/api/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ symbol })
        });

        if (!res.ok) {
            const errData = await res.json();
            throw new Error(errData.detail || "Failed to analyze stock. Gemini might be overloaded.");
        }

        const data = await res.json();

        // Add to recents
        if (!recentSearches.includes(symbol)) {
            recentSearches.unshift(symbol);
            if (recentSearches.length > 5) recentSearches.pop();
            localStorage.setItem('finagent_searches', JSON.stringify(recentSearches));
            renderRecentSearches();
        }

        renderDashboard(data);

    } catch (err) {
        document.getElementById('loading-spinner').classList.add('hidden');
        const emptyState = document.getElementById('empty-state');
        emptyState.classList.remove('hidden');

        let errDiv = document.getElementById('analyze-error-alert');
        if (!errDiv) {
            errDiv = document.createElement('div');
            errDiv.id = 'analyze-error-alert';
            errDiv.className = 'error-alert mt-4';
            emptyState.parentNode.insertBefore(errDiv, emptyState.nextSibling);
        }
        errDiv.innerText = "Error: " + err.message;
        errDiv.classList.remove('hidden');
    }
});

function renderRecentSearches() {
    const cont = document.getElementById('recent-searches');
    cont.innerHTML = '<span>Recent: </span>';
    if (recentSearches.length === 0) {
        cont.innerHTML += ' <span style="font-size: 0.8rem">None</span>';
        return;
    }

    recentSearches.forEach(sym => {
        const pill = document.createElement('span');
        pill.className = 'recent-pill';
        pill.innerText = sym;
        pill.onclick = () => {
            document.getElementById('symbol-input').value = sym;
            document.getElementById('search-form').dispatchEvent(new Event('submit'));
        };
        cont.appendChild(pill);
    });
}

function renderDashboard(data) {
    document.getElementById('loading-spinner').classList.add('hidden');
    document.getElementById('dashboard').classList.remove('hidden');

    document.getElementById('stock-title').innerText = `${data.symbol} Analysis`;

    const score = data.score;
    document.getElementById('overall-score-val').innerText = score.overall_score;
    document.getElementById('overall-grade').innerText = score.grade;
    document.getElementById('overall-descriptor').innerText = score.descriptor || "";

    // Flags
    const flagsList = document.getElementById('flags-list');
    flagsList.innerHTML = '';
    if (score.flags && score.flags.length > 0) {
        score.flags.forEach(f => {
            const li = document.createElement('li');
            li.innerHTML = `<span>${f}</span>`;
            flagsList.appendChild(li);
        });
    } else {
        flagsList.innerHTML = '<li class="no-flags">No significant risk flags detected.</li>';
    }

    // Chart Update
    updateChart(score.categories);

    // Metrics UI
    const metricsCont = document.getElementById('metrics-container');
    metricsCont.innerHTML = '';
    const orderedKeys = ["Profitability", "Growth", "Safety"];

    orderedKeys.forEach(catKey => {
        const catKeyLower = catKey.toLowerCase();
        const catData = score.categories[catKeyLower];
        if (catData) {
            const sect = document.createElement('div');
            sect.className = 'metric-group';
            sect.innerHTML = `<h3><span>${catKey}</span> <span class="badge" style="background:transparent;border:0;padding:0;">${catData.grade} (${catData.score}/100)</span></h3>`;

            catData.metrics.forEach(m => {
                sect.innerHTML += `
                    <div class="metric-row">
                        <span>${m.label}</span>
                        <strong>${m.formatted}</strong>
                    </div>
                `;
            });
            metricsCont.appendChild(sect);
        }
    });

    // AI Section
    document.getElementById('ai-verdict').innerText = data.ai.verdict;

    const rec = data.ai.recommendation || {};
    const actionBadge = document.getElementById('rec-action');
    actionBadge.innerText = (rec.action || "UNKNOWN").toUpperCase();
    actionBadge.className = 'badge ' + (rec.action ? rec.action.toLowerCase() : '');

    document.getElementById('rec-conviction').innerText = rec.conviction || "--";
    document.getElementById('rec-reasoning').innerText = rec.reasoning || "";

    if (data.raw_data) {
        renderStatements(data.raw_data);
    }
}

function updateChart(categories) {
    const ctx = document.getElementById('healthChart').getContext('2d');

    const prof = categories['profitability'] ? categories['profitability'].score : 0;
    const grow = categories['growth'] ? categories['growth'].score : 0;
    const safe = categories['safety'] ? categories['safety'].score : 0;

    const dataArr = [prof, grow, safe];

    if (healthChartInstance) {
        healthChartInstance.destroy();
    }

    const isDark = document.body.classList.contains('dark-mode');
    const color = isDark ? 'rgba(230, 237, 243, 0.7)' : 'rgba(31, 41, 55, 0.7)';
    const gridColor = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)';

    healthChartInstance = new Chart(ctx, {
        type: 'radar',
        data: {
            labels: ['Profitability', 'Growth', 'Safety'],
            datasets: [{
                label: 'Score / 100',
                data: dataArr,
                backgroundColor: 'rgba(16, 185, 129, 0.3)',
                borderColor: 'rgba(16, 185, 129, 1)',
                borderWidth: 2,
                pointBackgroundColor: 'rgba(16, 185, 129, 1)',
            }]
        },
        options: {
            responsive: true,
            scales: {
                r: {
                    angleLines: { color: gridColor },
                    grid: { color: gridColor },
                    pointLabels: { color: color, font: { family: 'Inter', size: 14 } },
                    ticks: { display: false, min: 0, max: 100, stepSize: 20 }
                }
            },
            plugins: { legend: { display: false } }
        }
    });
}

// Compare functionality - SEQUENTIAL EXECUTION to avoid 503
document.getElementById('compare-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const sym1 = document.getElementById('comp-sym-1').value.trim().toUpperCase();
    const sym2 = document.getElementById('comp-sym-2').value.trim().toUpperCase();
    if (!sym1 || !sym2) return;

    document.getElementById('compare-results').classList.add('hidden');
    document.getElementById('compare-error-alert').classList.add('hidden');
    document.getElementById('compare-loading').classList.remove('hidden');

    // Clear previous
    document.getElementById('comp-res-1').innerHTML = '';
    document.getElementById('comp-res-2').innerHTML = '';

    try {
        // Fetch Symbol 1
        document.getElementById('compare-status-text').innerText = `Fetching data for ${sym1}...`;
        const res1 = await fetch('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol: sym1 }) });
        if (!res1.ok) {
            const err = await res1.json();
            throw new Error(`Failed on ${sym1}: ${err.detail || 'High Gemini Demand (503). Try again.'}`);
        }
        const dat1 = await res1.json();
        renderCompareCard('comp-res-1', dat1);

        // Minor delay to let Gemini API breathe
        await new Promise(r => setTimeout(r, 1000));

        // Fetch Symbol 2
        document.getElementById('compare-status-text').innerText = `Fetching data for ${sym2}...`;
        const res2 = await fetch('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol: sym2 }) });
        if (!res2.ok) {
            const err = await res2.json();
            throw new Error(`Failed on ${sym2}: ${err.detail || 'High Gemini Demand (503). Try again.'}`);
        }
        const dat2 = await res2.json();
        renderCompareCard('comp-res-2', dat2);

        document.getElementById('compare-loading').classList.add('hidden');
        document.getElementById('compare-results').classList.remove('hidden');
        document.getElementById('compare-status-text').innerText = `Running dual analysis...`;
    } catch (err) {
        document.getElementById('compare-error-alert').innerText = "Compare Error: " + err.message;
        document.getElementById('compare-error-alert').classList.remove('hidden');
        document.getElementById('compare-loading').classList.add('hidden');
        document.getElementById('compare-status-text').innerText = `Running dual analysis...`;
    }
});

function renderCompareCard(elementId, data) {
    const el = document.getElementById(elementId);
    if (!data) return;
    el.innerHTML = `
        <h3 style="text-align:center; margin-bottom: 0.5rem; color: var(--accent); font-size: 1.5rem;">${data.symbol}</h3>
        <div style="text-align:center; margin-bottom: 1rem;">
            <h2>${data.score.overall_score} / 100</h2>
            <span class="badge" style="margin-top:0.5rem">${data.score.grade}</span>
        </div>
        <p style="font-size:0.9rem; color: var(--text-muted); margin-bottom: 1rem;">${data.ai.verdict}</p>
        <div class="metrics-grid" style="margin-top:0">
            <div class="metric-row"><span>Profitability</span><strong>${data.score.categories.profitability.score}</strong></div>
            <div class="metric-row"><span>Growth</span><strong>${data.score.categories.growth.score}</strong></div>
            <div class="metric-row"><span>Safety</span><strong>${data.score.categories.safety.score}</strong></div>
        </div>
        <div style="margin-top: 1rem; border-top: 1px solid var(--border-color); padding-top: 1rem;">
            <strong>AI Recommendation: </strong> <span class="badge ${data.ai.recommendation.action.toLowerCase()}">${data.ai.recommendation.action}</span>
        </div>
    `;
}

// Chat Functionality
document.getElementById('chat-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentSymbol) return;

    const inputEl = document.getElementById('chat-input');
    const question = inputEl.value.trim();
    if (!question) return;

    inputEl.value = '';
    addChatMessage(question, 'user');

    try {
        const res = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ symbol: currentSymbol, question })
        });

        if (!res.ok) throw new Error("Chat limit reached or unavailable.");
        const data = await res.json();
        addChatMessage(data.response, 'ai');
    } catch (err) {
        addChatMessage("Error: " + err.message, 'ai');
    }
});

function addChatMessage(text, sender) {
    const history = document.getElementById('chat-history');
    const msg = document.createElement('div');
    msg.className = `chat-msg chat-${sender}`;
    msg.innerText = text;
    history.appendChild(msg);
    history.scrollTop = history.scrollHeight;
}


// --- AUTH LOGIC (MOCK LAYER) ---

const tabLogin = document.getElementById('tab-login');
const tabRegister = document.getElementById('tab-register');
const formLogin = document.getElementById('login-form');
const formRegister = document.getElementById('register-form');

tabLogin.addEventListener('click', () => {
    tabLogin.classList.add('active'); tabRegister.classList.remove('active');
    formLogin.classList.remove('hidden'); formRegister.classList.add('hidden');
});
tabRegister.addEventListener('click', () => {
    tabRegister.classList.add('active'); tabLogin.classList.remove('active');
    formRegister.classList.remove('hidden'); formLogin.classList.add('hidden');
});

function updateAuthUI() {
    const container = document.getElementById('auth-nav-container');
    if (currentUser) {
        container.innerHTML = `
            <div class="user-menu">
                <i class="fa-solid fa-user-circle"></i> ${currentUser} 
                <button btn="logout" title="Logout" style="margin-left:8px; border:none; background:transparent; color:var(--red); cursor:pointer;"><i class="fa-solid fa-right-from-bracket"></i></button>
            </div>
        `;
        container.querySelector('button[btn="logout"]').addEventListener('click', () => {
            localStorage.removeItem('fintech_user');
            currentUser = null;
            updateAuthUI();
        });
    } else {
        container.innerHTML = `<button class="primary-btn" id="nav-get-started" data-view="auth-view">Get Started</button>`;
        document.getElementById('nav-get-started').addEventListener('click', (e) => {
            document.querySelectorAll('.nav-links a').forEach(l => l.classList.remove('active'));
            document.querySelectorAll('.view-section').forEach(v => {
                if (v.id === 'auth-view') {
                    v.classList.remove('hidden'); v.classList.add('active');
                } else {
                    v.classList.add('hidden'); v.classList.remove('active');
                }
            });
        });
    }
}

formRegister.addEventListener('submit', (e) => {
    e.preventDefault();
    const u = document.getElementById('reg-user').value.trim();
    const p = document.getElementById('reg-pass').value.trim();
    if (!u || !p) return;

    // Store in a simple users mock DB in local storage
    const users = JSON.parse(localStorage.getItem('fintech_users_db') || '{}');
    users[u] = p;
    localStorage.setItem('fintech_users_db', JSON.stringify(users));

    document.getElementById('reg-success').classList.remove('hidden');
    setTimeout(() => { tabLogin.click(); }, 1500);
});

formLogin.addEventListener('submit', (e) => {
    e.preventDefault();
    const u = document.getElementById('login-user').value.trim();
    const p = document.getElementById('login-pass').value.trim();

    const users = JSON.parse(localStorage.getItem('fintech_users_db') || '{}');
    if (users[u] === p) {
        document.getElementById('login-error').classList.add('hidden');
        currentUser = u;
        localStorage.setItem('fintech_user', u);
        updateAuthUI();
        // Route to analyze
        document.querySelector('.nav-links a[data-view=analyze-view]').click();
    } else {
        document.getElementById('login-error').classList.remove('hidden');
    }
});

// --- DOCUMENT EXTRACTOR LOGIC ---
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');

dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.style.borderColor = 'var(--accent)'; });
dropZone.addEventListener('dragleave', () => dropZone.style.borderColor = 'var(--accent)');
dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.style.borderColor = 'var(--accent)';
    if (e.dataTransfer.files.length > 0) { fileInput.files = e.dataTransfer.files; handleFileUpload(fileInput.files[0]); }
});
fileInput.addEventListener('change', () => {
    if (fileInput.files.length > 0) handleFileUpload(fileInput.files[0]);
});

async function handleFileUpload(file) {
    if (!file) return;

    document.getElementById('drop-zone').classList.add('hidden');
    document.getElementById('doc-results').classList.add('hidden');
    document.getElementById('doc-spinner').classList.remove('hidden');

    const formData = new FormData();
    formData.append('file', file);

    try {
        const res = await fetch('/api/extract_document', {
            method: 'POST', body: formData
        });
        
        if (!res.ok) {
            const errData = await res.json();
            throw new Error(errData.detail || "Document analysis failed.");
        }
        
        const data = await res.json();

        document.getElementById('doc-filename').innerText = data.filename;
        const cat = data.extracted.category || 'Unknown';
        document.getElementById('doc-category').innerText = cat;
        document.getElementById('doc-summary').innerText = data.extracted.summary || 'No summary generated.';

        const grid = document.getElementById('doc-extracted-grid');
        grid.innerHTML = '';

        const pd = data.extracted.extracted_data || {};
        const entries = [
            { k: 'Key Entities', v: pd.key_entities },
            { k: 'Important Dates', v: pd.important_dates },
            { k: 'Monetary Amounts', v: pd.monetary_amounts }
        ];

        entries.forEach(e => {
            if (e.v && Array.isArray(e.v) && e.v.length > 0) {
                grid.innerHTML += `<div class="metric-row" style="flex-direction:column; align-items:start; border-bottom:1px solid var(--border-color); padding-bottom: 0.8rem; margin-bottom:0.8rem;">
                    <span style="font-weight:600; color:var(--text-main); margin-bottom:0.4rem;">${e.k}</span>
                    <ul style="list-style-type:circle; margin-left:1.5rem; color:var(--text-muted); font-size:0.9rem;">
                        ${e.v.map(item => `<li>${item}</li>`).join('')}
                    </ul>
                </div>`;
            }
        });

    } catch (err) {
        alert("Extraction Error: " + err.message);
    } finally {
        document.getElementById('doc-spinner').classList.add('hidden');
        document.getElementById('doc-results').classList.remove('hidden');
        document.getElementById('drop-zone').classList.remove('hidden');
    }
}

// --- GLOBAL CHAT WIDGET LOGIC ---
const fabChat = document.getElementById('fab-chat');
const gchatWindow = document.getElementById('global-chat-window');
const gchatClose = document.getElementById('gchat-close');
const gchatForm = document.getElementById('gchat-form');
const gchatHistoryUi = document.getElementById('gchat-history');

let globalChatHistory = [];

fabChat.addEventListener('click', () => {
    gchatWindow.classList.toggle('hidden');
    if (!gchatWindow.classList.contains('hidden')) {
        document.getElementById('gchat-input').focus();
    }
});
gchatClose.addEventListener('click', () => gchatWindow.classList.add('hidden'));

gchatForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const inp = document.getElementById('gchat-input');
    const q = inp.value.trim();
    if (!q) return;

    inp.value = '';

    // Add user msg
    globalChatHistory.push({ sender: 'user', text: q });
    const uDiv = document.createElement('div');
    uDiv.className = 'chat-msg chat-user'; uDiv.innerText = q;
    gchatHistoryUi.appendChild(uDiv);
    gchatHistoryUi.scrollTop = gchatHistoryUi.scrollHeight;

    // Setup AI loading bubble
    const aiDiv = document.createElement('div');
    aiDiv.className = 'chat-msg chat-ai'; aiDiv.innerText = 'typing...';
    gchatHistoryUi.appendChild(aiDiv);
    gchatHistoryUi.scrollTop = gchatHistoryUi.scrollHeight;


    function renderMarkdown(text) {
        return text
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.*?)\*/g, '<li>$1</li>')
            .replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>')
            .replace(/^\d+\.\s(.*)$/gm, '<li>$1</li>')
            .replace(/\n\n/g, '<br/><br/>')
            .replace(/\n/g, '<br/>')
    }

    try {
        const res = await fetch('/api/global_chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                question: q,
                history: globalChatHistory.slice(0, -1) // send previous history
            })
        });

        if (!res.ok) throw new Error("Chat unavailable.");
        const data = await res.json();

        aiDiv.innerHTML = renderMarkdown(data.response);   // ← was innerText
        globalChatHistory.push({ sender: 'ai', text: data.response });
    } catch (err) {
        aiDiv.innerText = "Error: " + err.message;
        aiDiv.style.color = "var(--red)";
    }
    gchatHistoryUi.scrollTop = gchatHistoryUi.scrollHeight;
});

// --- FINANCIAL STATEMENTS LOGIC ---
document.querySelectorAll('.stmt-tab').forEach(tab => {
    tab.addEventListener('click', (e) => {
        document.querySelectorAll('.stmt-tab').forEach(t => t.classList.remove('active'));
        e.target.classList.add('active');
        document.querySelectorAll('.stmt-view').forEach(v => v.classList.add('hidden'));
        document.getElementById(e.target.dataset.target).classList.remove('hidden');
    });
});

function formatCurrencyNum(val) {
    if (!val || isNaN(val)) return '-';
    let n = parseFloat(val);
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
    if (Math.abs(n) >= 1000) return '$' + (n / 1000).toFixed(2) + 'k';
    return '$' + n.toFixed(2);
}

function renderStatements(raw) {
    const incDiv = document.getElementById('inc-stmt-table');
    const balDiv = document.getElementById('bal-stmt-table');
    const cshDiv = document.getElementById('csh-stmt-table');

    if (incDiv) incDiv.innerHTML = generateTableHtml(raw.income, ['fiscal_date', 'revenue', 'gross_profit', 'operating_income', 'net_income', 'ebitda'], ['Fiscal Date', 'Revenue', 'Gross Profit', 'Operating Inc', 'Net Income', 'EBITDA']);
    if (balDiv) balDiv.innerHTML = generateTableHtml(raw.balance, ['fiscal_date', 'total_assets', 'total_liabilities', 'total_equity', 'current_assets', 'current_liabilities', 'long_term_debt'], ['Fiscal Date', 'Total Assets', 'Total Liab', 'Total Equity', 'Curr Assets', 'Curr Liab', 'Long Term Debt']);
    if (cshDiv) cshDiv.innerHTML = generateTableHtml(raw.cashflow, ['fiscal_date', 'operating_cash_flow', 'capital_expenditure', 'free_cash_flow'], ['Fiscal Date', 'Operating Cash', 'CapEx', 'Free Cash Flow']);
}

function generateTableHtml(dataArray, keys, headers) {
    if (!dataArray || dataArray.length === 0) return '<p class="text-muted">No statement data available.</p>';

    let html = '<table class="fin-table"><thead><tr>';
    headers.forEach(h => html += `<th>${h}</th>`);
    html += '</tr></thead><tbody>';

    dataArray.forEach(row => {
        html += '<tr>';
        keys.forEach(k => {
            let val = row[k];
            if (k !== 'fiscal_date') val = formatCurrencyNum(val);
            html += `<td>${val}</td>`;
        });
        html += '</tr>';
    });

    html += '</tbody></table>';
    return html;
}
