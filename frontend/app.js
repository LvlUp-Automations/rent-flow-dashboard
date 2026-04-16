// ─── CONFIG ────────────────────────────────────────────────
const API_BASE = 'https://rent-flow-backend.onrender.com/api';

// ─── CHART INSTANCES ───────────────────────────────────────
let productChart = null;
let typeChart = null;

// ─── FORMAT HELPERS ────────────────────────────────────────
function formatCurrency(num) {
  return '$' + parseFloat(num || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ─── FETCH WITH ERROR HANDLING & RETRY ─────────────────────
async function apiFetch(endpoint, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(API_BASE + endpoint);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      console.error(`API Error [${endpoint}] attempt ${i + 1}:`, err.message);
      if (i < retries) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }
  return null;
}

// ─── LOAD DASHBOARD STATS ──────────────────────────────────
async function loadStats(startDate = '', endDate = '') {
  let url = '/stats/overview';
  if (startDate && endDate) url += `?startDate=${startDate}&endDate=${endDate}`;

  const result = await apiFetch(url);
  if (!result || !result.success) return;

  const d = result.data;

  document.getElementById('overallRevenue').textContent = formatCurrency(d.overallRevenue);
  document.getElementById('overallCount').textContent = `across ${d.totalTransactions} transactions`;
  document.getElementById('totalTransactions').textContent = d.totalTransactions;
  document.getElementById('avgPerTransaction').textContent = formatCurrency(d.avgPerTransaction);
  document.getElementById('lastMonth').textContent = formatCurrency(d.lastMonth);
  document.getElementById('thisMonth').textContent = formatCurrency(d.thisMonth);
  document.getElementById('lastQuarter').textContent = formatCurrency(d.lastQuarter);
  document.getElementById('thisQuarter').textContent = formatCurrency(d.thisQuarter);
  document.getElementById('lastYear').textContent = formatCurrency(d.lastYear);
  document.getElementById('thisYear').textContent = formatCurrency(d.thisYear);

  if (d.lastTransactionDate) {
    document.getElementById('lastTransaction').textContent =
      `Last transaction ${formatDate(d.lastTransactionDate)}`;
  }
}

// ─── CHART COLORS (Blue theme matching LevelUp logo) ───────
const CHART_COLORS = [
  '#3B82F6',  // Primary blue
  '#2EAC57',  // Logo green
  '#F5922A',  // Logo orange
  '#8B5CF6',  // Purple
  '#06B6D4',  // Cyan
  '#EC4899',  // Pink
  '#F59E0B',  // Amber
  '#10B981',  // Emerald
  '#6366F1',  // Indigo
  '#EF4444'   // Red
];

// ─── LOAD CHARTS ───────────────────────────────────────────
async function loadProductChart(startDate = '', endDate = '') {
  let url = '/stats/by-product';
  if (startDate && endDate) url += `?startDate=${startDate}&endDate=${endDate}`;

  const result = await apiFetch(url);
  if (!result || !result.success) return;

  const labels = result.data.map(r => r._id || 'Unknown');
  const amounts = result.data.map(r => r.totalAmount);

  if (productChart) productChart.destroy();

  const ctx = document.getElementById('productChart').getContext('2d');
  productChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Revenue ($)',
        data: amounts,
        backgroundColor: CHART_COLORS,
        borderRadius: 2,
        borderSkipped: false
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => ' $' + ctx.raw.toFixed(2)
          }
        }
      },
      scales: {
        x: {
          ticks: { color: '#888', font: { size: 11 } },
          grid: { color: '#1a1a1a' }
        },
        y: {
          ticks: { color: '#888', font: { size: 11 }, callback: v => '$' + v },
          grid: { color: '#1a1a1a' }
        }
      }
    }
  });
}

async function loadTypeChart(startDate = '', endDate = '') {
  let url = '/stats/by-type';
  if (startDate && endDate) url += `?startDate=${startDate}&endDate=${endDate}`;

  const result = await apiFetch(url);
  if (!result || !result.success) return;

  const labels = result.data.map(r => r._id || 'Unknown');
  const amounts = result.data.map(r => r.totalAmount);

  if (typeChart) typeChart.destroy();

  const ctx = document.getElementById('typeChart').getContext('2d');
  typeChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data: amounts,
        backgroundColor: CHART_COLORS,
        borderWidth: 0,
        hoverOffset: 8
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'right',
          labels: {
            color: '#888',
            font: { size: 11 },
            padding: 16
          }
        },
        tooltip: {
          callbacks: {
            label: ctx => ` $${ctx.raw.toFixed(2)}`
          }
        }
      }
    }
  });
}

// ─── LOAD TRANSACTIONS TABLE ───────────────────────────────
async function loadTransactions(startDate = '', endDate = '') {
  let url = '/transactions?limit=20';
  if (startDate && endDate) url += `&startDate=${startDate}&endDate=${endDate}`;

  const result = await apiFetch(url);
  const tbody = document.getElementById('txTableBody');

  if (!result || !result.success || result.data.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-row">No transactions found</td></tr>';
    return;
  }

  tbody.innerHTML = result.data.map(tx => `
    <tr>
      <td>${formatDate(tx.date)}</td>
      <td>${tx.customer || '—'}</td>
      <td>${tx.product || '—'}</td>
      <td>${tx.type || '—'}</td>
      <td style="color: #3B82F6; font-weight: 600;">${formatCurrency(tx.amount)}</td>
      <td><span class="badge badge-${(tx.status || 'pending').toLowerCase()}">${tx.status || '—'}</span></td>
      <td>
        <button class="btn-delete" onclick="deleteTransaction('${tx._id}')">Delete</button>
      </td>
    </tr>
  `).join('');
}

// ─── APPLY / CLEAR FILTER ──────────────────────────────────
function applyFilter() {
  const start = document.getElementById('startDate').value;
  const end = document.getElementById('endDate').value;
  if (!start || !end) { alert('Please select both start and end dates'); return; }
  loadAll(start, end);
}

function clearFilter() {
  document.getElementById('startDate').value = '';
  document.getElementById('endDate').value = '';
  loadAll();
}

async function loadAll(start = '', end = '') {
  await loadStats(start, end);
  await loadProductChart(start, end);
  await loadTypeChart(start, end);
  await loadTransactions(start, end);
}

// ─── ADD TRANSACTION MODAL ─────────────────────────────────
function openModal() {
  document.getElementById('modalOverlay').classList.add('active');
  document.getElementById('txDate').value = new Date().toISOString().split('T')[0];
}

function closeModal(e) {
  if (!e || e.target === document.getElementById('modalOverlay')) {
    document.getElementById('modalOverlay').classList.remove('active');
  }
}

async function submitTransaction() {
  const payload = {
    date: document.getElementById('txDate').value,
    customer: document.getElementById('txCustomer').value.trim(),
    product: document.getElementById('txProduct').value.trim(),
    type: document.getElementById('txType').value,
    amount: parseFloat(document.getElementById('txAmount').value),
    status: document.getElementById('txStatus').value,
    notes: document.getElementById('txNotes').value.trim()
  };

  if (!payload.date || !payload.customer || !payload.product || !payload.amount) {
    alert('Please fill in all required fields (Date, Customer, Product, Amount)');
    return;
  }
  if (isNaN(payload.amount) || payload.amount <= 0) {
    alert('Please enter a valid amount');
    return;
  }

  try {
    const res = await fetch(API_BASE + '/transactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.success) {
      closeModal();
      ['txDate','txCustomer','txProduct','txAmount','txNotes'].forEach(id => {
        document.getElementById(id).value = '';
      });
      loadAll();
      alert('Transaction saved successfully!');
    } else {
      alert('Error: ' + (data.message || 'Could not save transaction'));
    }
  } catch (err) {
    alert('Network error. Please try again.');
    console.error(err);
  }
}

// ─── DELETE TRANSACTION ────────────────────────────────────
async function deleteTransaction(id) {
  if (!confirm('Are you sure you want to delete this transaction?')) return;

  try {
    const res = await fetch(API_BASE + '/transactions/' + id, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      loadAll();
    } else {
      alert('Could not delete transaction');
    }
  } catch (err) {
    alert('Network error');
  }
}

// ─── INITIALIZE ────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadAll();
});
