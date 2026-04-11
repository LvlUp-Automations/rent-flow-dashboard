const express = require('express');
const router = express.Router();
const Transaction = require('../models/Transaction');

// Helper: get start and end of a period
function getPeriodDates(period) {
  const now = new Date();
  let start, end;
  switch (period) {
    case 'thisMonth':
      start = new Date(now.getFullYear(), now.getMonth(), 1);
      end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
      break;
    case 'lastMonth':
      start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      end = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
      break;
    case 'thisQuarter':
      const q = Math.floor(now.getMonth() / 3);
      start = new Date(now.getFullYear(), q * 3, 1);
      end = new Date(now.getFullYear(), q * 3 + 3, 0, 23, 59, 59);
      break;
    case 'thisYear':
      start = new Date(now.getFullYear(), 0, 1);
      end = new Date(now.getFullYear(), 11, 31, 23, 59, 59);
      break;
    default:
      start = new Date(0);
      end = new Date();
  }
  return { start, end };
}

// GET /dashboard/location - Serve the HTML dashboard for GHL iframe
router.get('/location', async (req, res) => {
  try {
    const locationId = req.query.id || 'unknown';

    // Fetch all stats
    async function getPeriodRevenue(period) {
      const { start, end } = getPeriodDates(period);
      const agg = await Transaction.aggregate([
        { $match: { status: 'Completed', date: { $gte: start, $lte: end } } },
        { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
      ]);
      return agg[0] || { total: 0, count: 0 };
    }

    const [thisMonth, lastMonth, thisQuarter, thisYear] = await Promise.all([
      getPeriodRevenue('thisMonth'),
      getPeriodRevenue('lastMonth'),
      getPeriodRevenue('thisQuarter'),
      getPeriodRevenue('thisYear')
    ]);

    // Overall
    const overallAgg = await Transaction.aggregate([
      { $match: { status: 'Completed' } },
      { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
    ]);
    const overall = overallAgg[0] || { total: 0, count: 0 };

    // By product
    const byProduct = await Transaction.aggregate([
      { $match: { status: 'Completed' } },
      { $group: { _id: '$product', totalAmount: { $sum: '$amount' }, count: { $sum: 1 } } },
      { $sort: { totalAmount: -1 } }
    ]);

    // By type
    const byType = await Transaction.aggregate([
      { $match: { status: 'Completed' } },
      { $group: { _id: '$type', totalAmount: { $sum: '$amount' }, count: { $sum: 1 } } },
      { $sort: { totalAmount: -1 } }
    ]);

    // Recent transactions
    const recentTx = await Transaction.find({ status: 'Completed' })
      .sort({ date: -1 })
      .limit(10);

    // Monthly trend (last 6 months)
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5);
    sixMonthsAgo.setDate(1);
    sixMonthsAgo.setHours(0, 0, 0, 0);

    const monthlyTrend = await Transaction.aggregate([
      { $match: { status: 'Completed', date: { $gte: sixMonthsAgo } } },
      {
        $group: {
          _id: { year: { $year: '$date' }, month: { $month: '$date' } },
          total: { $sum: '$amount' },
          count: { $sum: 1 }
        }
      },
      { $sort: { '_id.year': 1, '_id.month': 1 } }
    ]);

    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    // Calculate month-over-month change
    const momChange = lastMonth.total > 0
      ? (((thisMonth.total - lastMonth.total) / lastMonth.total) * 100).toFixed(1)
      : thisMonth.total > 0 ? 100 : 0;

    const avgPerTx = overall.count > 0 ? (overall.total / overall.count) : 0;

    // Build product colors
    const productColors = ['#6366f1', '#06b6d4', '#f59e0b', '#ef4444', '#10b981', '#8b5cf6', '#ec4899', '#14b8a6'];

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Rent Flow Dashboard</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }

    :root {
      --bg: #0f1117;
      --surface: #1a1d27;
      --surface-hover: #22252f;
      --border: #2a2d3a;
      --text: #e4e4e7;
      --text-muted: #71717a;
      --accent: #6366f1;
      --accent-glow: rgba(99, 102, 241, 0.15);
      --green: #22c55e;
      --green-bg: rgba(34, 197, 94, 0.1);
      --red: #ef4444;
      --red-bg: rgba(239, 68, 68, 0.1);
      --cyan: #06b6d4;
      --amber: #f59e0b;
    }

    body {
      font-family: 'DM Sans', -apple-system, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
      min-height: 100vh;
      overflow-x: hidden;
    }

    .dashboard {
      max-width: 1400px;
      margin: 0 auto;
      padding: 24px;
    }

    /* Header */
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 32px;
      padding-bottom: 24px;
      border-bottom: 1px solid var(--border);
    }

    .header-left h1 {
      font-size: 24px;
      font-weight: 700;
      letter-spacing: -0.5px;
      background: linear-gradient(135deg, #fff 0%, #a5b4fc 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .header-left .subtitle {
      font-size: 13px;
      color: var(--text-muted);
      margin-top: 4px;
    }

    .header-right {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .live-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--green);
      animation: pulse 2s infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.4); }
      50% { opacity: 0.8; box-shadow: 0 0 0 6px rgba(34, 197, 94, 0); }
    }

    .live-text {
      font-size: 12px;
      color: var(--green);
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    /* Stat Cards Grid */
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 16px;
      margin-bottom: 28px;
    }

    .stat-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 22px;
      position: relative;
      overflow: hidden;
      transition: border-color 0.2s, transform 0.2s;
    }

    .stat-card:hover {
      border-color: var(--accent);
      transform: translateY(-2px);
    }

    .stat-card::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 2px;
      background: linear-gradient(90deg, var(--accent), var(--cyan));
      opacity: 0;
      transition: opacity 0.2s;
    }

    .stat-card:hover::before { opacity: 1; }

    .stat-label {
      font-size: 12px;
      font-weight: 500;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.8px;
      margin-bottom: 10px;
    }

    .stat-value {
      font-family: 'JetBrains Mono', monospace;
      font-size: 28px;
      font-weight: 700;
      color: #fff;
      letter-spacing: -1px;
    }

    .stat-change {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 12px;
      font-weight: 600;
      padding: 3px 8px;
      border-radius: 6px;
      margin-top: 10px;
    }

    .stat-change.up { color: var(--green); background: var(--green-bg); }
    .stat-change.down { color: var(--red); background: var(--red-bg); }

    .stat-sub {
      font-size: 12px;
      color: var(--text-muted);
      margin-top: 8px;
    }

    /* Chart Sections */
    .charts-row {
      display: grid;
      grid-template-columns: 2fr 1fr;
      gap: 16px;
      margin-bottom: 28px;
    }

    @media (max-width: 900px) {
      .charts-row { grid-template-columns: 1fr; }
    }

    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 24px;
    }

    .card-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--text);
      margin-bottom: 20px;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .card-title .icon {
      width: 20px;
      height: 20px;
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
    }

    /* Bar Chart */
    .bar-chart {
      display: flex;
      align-items: flex-end;
      gap: 12px;
      height: 200px;
      padding-top: 10px;
    }

    .bar-col {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      height: 100%;
      justify-content: flex-end;
    }

    .bar {
      width: 100%;
      max-width: 48px;
      border-radius: 8px 8px 4px 4px;
      background: linear-gradient(180deg, var(--accent) 0%, #4338ca 100%);
      transition: all 0.6s cubic-bezier(0.34, 1.56, 0.64, 1);
      position: relative;
      min-height: 4px;
    }

    .bar:hover {
      filter: brightness(1.2);
      transform: scaleY(1.03);
      transform-origin: bottom;
    }

    .bar-value {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      color: var(--text-muted);
      margin-bottom: 6px;
      font-weight: 500;
    }

    .bar-label {
      font-size: 11px;
      color: var(--text-muted);
      margin-top: 10px;
      font-weight: 500;
    }

    /* Donut / Breakdown */
    .breakdown-list {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .breakdown-item {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .breakdown-dot {
      width: 10px;
      height: 10px;
      border-radius: 3px;
      flex-shrink: 0;
    }

    .breakdown-info {
      flex: 1;
      min-width: 0;
    }

    .breakdown-name {
      font-size: 13px;
      font-weight: 500;
      color: var(--text);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .breakdown-bar-track {
      width: 100%;
      height: 6px;
      background: var(--bg);
      border-radius: 3px;
      margin-top: 4px;
      overflow: hidden;
    }

    .breakdown-bar-fill {
      height: 100%;
      border-radius: 3px;
      transition: width 0.8s cubic-bezier(0.34, 1.56, 0.64, 1);
    }

    .breakdown-amount {
      font-family: 'JetBrains Mono', monospace;
      font-size: 13px;
      font-weight: 600;
      color: #fff;
      flex-shrink: 0;
    }

    /* Transactions Table */
    .table-wrap {
      overflow-x: auto;
    }

    table {
      width: 100%;
      border-collapse: collapse;
    }

    thead th {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.8px;
      padding: 12px 16px;
      text-align: left;
      border-bottom: 1px solid var(--border);
    }

    tbody td {
      font-size: 13px;
      padding: 14px 16px;
      border-bottom: 1px solid rgba(42, 45, 58, 0.5);
      color: var(--text);
    }

    tbody tr:hover { background: var(--surface-hover); }

    .badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      font-weight: 600;
      padding: 3px 10px;
      border-radius: 6px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .badge.completed { color: var(--green); background: var(--green-bg); }
    .badge.pending { color: var(--amber); background: rgba(245, 158, 11, 0.1); }

    .amount-cell {
      font-family: 'JetBrains Mono', monospace;
      font-weight: 600;
      color: #fff;
    }

    /* Empty state */
    .empty-state {
      text-align: center;
      padding: 60px 20px;
      color: var(--text-muted);
    }

    .empty-state .emoji { font-size: 40px; margin-bottom: 12px; }
    .empty-state p { font-size: 14px; }

    /* Refresh button */
    .refresh-btn {
      background: var(--surface);
      border: 1px solid var(--border);
      color: var(--text-muted);
      padding: 8px 16px;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s;
      font-family: 'DM Sans', sans-serif;
    }

    .refresh-btn:hover {
      border-color: var(--accent);
      color: var(--text);
    }

    /* Animations */
    @keyframes fadeUp {
      from { opacity: 0; transform: translateY(16px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .animate-in {
      animation: fadeUp 0.5s ease-out forwards;
      opacity: 0;
    }

    .delay-1 { animation-delay: 0.05s; }
    .delay-2 { animation-delay: 0.1s; }
    .delay-3 { animation-delay: 0.15s; }
    .delay-4 { animation-delay: 0.2s; }
    .delay-5 { animation-delay: 0.3s; }
    .delay-6 { animation-delay: 0.4s; }
  </style>
</head>
<body>
  <div class="dashboard">
    <!-- Header -->
    <div class="header animate-in">
      <div class="header-left">
        <h1>Restroom Trailer Revenue</h1>
        <div class="subtitle">Rent Flow Dashboard &mdash; Updated ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
      </div>
      <div class="header-right">
        <div class="live-dot"></div>
        <span class="live-text">Live</span>
        <button class="refresh-btn" onclick="location.reload()" style="margin-left: 12px;">&#8635; Refresh</button>
      </div>
    </div>

    ${overall.count === 0 ? `
    <div class="empty-state animate-in delay-1">
      <div class="emoji">📊</div>
      <p>No completed transactions yet.<br>Data will appear here once transactions are recorded.</p>
    </div>
    ` : `

    <!-- KPI Cards -->
    <div class="stats-grid">
      <div class="stat-card animate-in delay-1">
        <div class="stat-label">Total Revenue</div>
        <div class="stat-value">$${overall.total.toLocaleString('en-US', { minimumFractionDigits: 2 })}</div>
        <div class="stat-sub">${overall.count} transactions</div>
      </div>
      <div class="stat-card animate-in delay-2">
        <div class="stat-label">This Month</div>
        <div class="stat-value">$${thisMonth.total.toLocaleString('en-US', { minimumFractionDigits: 2 })}</div>
        <span class="stat-change ${parseFloat(momChange) >= 0 ? 'up' : 'down'}">
          ${parseFloat(momChange) >= 0 ? '&#9650;' : '&#9660;'} ${Math.abs(momChange)}%
        </span>
      </div>
      <div class="stat-card animate-in delay-3">
        <div class="stat-label">This Quarter</div>
        <div class="stat-value">$${thisQuarter.total.toLocaleString('en-US', { minimumFractionDigits: 2 })}</div>
        <div class="stat-sub">${thisQuarter.count} transactions</div>
      </div>
      <div class="stat-card animate-in delay-4">
        <div class="stat-label">Avg / Transaction</div>
        <div class="stat-value">$${avgPerTx.toLocaleString('en-US', { minimumFractionDigits: 2 })}</div>
        <div class="stat-sub">Year total: $${thisYear.total.toLocaleString('en-US', { minimumFractionDigits: 2 })}</div>
      </div>
    </div>

    <!-- Charts Row -->
    <div class="charts-row">
      <!-- Monthly Trend Bar Chart -->
      <div class="card animate-in delay-5">
        <div class="card-title">
          <span class="icon" style="background: var(--accent-glow); color: var(--accent);">&#9656;</span>
          Monthly Revenue Trend
        </div>
        <div class="bar-chart">
          ${monthlyTrend.length > 0 ? (() => {
            const maxVal = Math.max(...monthlyTrend.map(m => m.total), 1);
            return monthlyTrend.map(m => {
              const pct = (m.total / maxVal) * 100;
              return `
              <div class="bar-col">
                <div class="bar-value">$${m.total >= 1000 ? (m.total / 1000).toFixed(1) + 'k' : m.total.toFixed(0)}</div>
                <div class="bar" style="height: ${Math.max(pct, 3)}%;"></div>
                <div class="bar-label">${monthNames[m._id.month - 1]}</div>
              </div>`;
            }).join('');
          })() : '<div style="width:100%;text-align:center;color:var(--text-muted);padding:40px;">No trend data yet</div>'}
        </div>
      </div>

      <!-- Revenue by Product -->
      <div class="card animate-in delay-6">
        <div class="card-title">
          <span class="icon" style="background: rgba(6, 182, 212, 0.1); color: var(--cyan);">&#9632;</span>
          By Product
        </div>
        <div class="breakdown-list">
          ${byProduct.length > 0 ? (() => {
            const maxProduct = Math.max(...byProduct.map(p => p.totalAmount), 1);
            return byProduct.slice(0, 6).map((p, i) => `
              <div class="breakdown-item">
                <div class="breakdown-dot" style="background: ${productColors[i % productColors.length]};"></div>
                <div class="breakdown-info">
                  <div class="breakdown-name">${p._id || 'Unknown'}</div>
                  <div class="breakdown-bar-track">
                    <div class="breakdown-bar-fill" style="width: ${(p.totalAmount / maxProduct) * 100}%; background: ${productColors[i % productColors.length]};"></div>
                  </div>
                </div>
                <div class="breakdown-amount">$${p.totalAmount.toLocaleString('en-US', { minimumFractionDigits: 0 })}</div>
              </div>
            `).join('');
          })() : '<div style="color:var(--text-muted);font-size:13px;">No product data</div>'}
        </div>
      </div>
    </div>

    <!-- Recent Transactions Table -->
    <div class="card animate-in delay-6">
      <div class="card-title">
        <span class="icon" style="background: rgba(245, 158, 11, 0.1); color: var(--amber);">&#9654;</span>
        Recent Transactions
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Product</th>
              <th>Type</th>
              <th>Customer</th>
              <th>Amount</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${recentTx.length > 0 ? recentTx.map(tx => `
              <tr>
                <td>${new Date(tx.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</td>
                <td>${tx.product || '—'}</td>
                <td>${tx.type || '—'}</td>
                <td>${tx.customer || '—'}</td>
                <td class="amount-cell">$${tx.amount.toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
                <td><span class="badge ${(tx.status || '').toLowerCase()}">${tx.status || '—'}</span></td>
              </tr>
            `).join('') : '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:30px;">No transactions found</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
    `}
  </div>
</body>
</html>`);

  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).send(`
      <div style="font-family:sans-serif;padding:40px;text-align:center;color:#ef4444;">
        <h2>Dashboard Error</h2>
        <p>${err.message}</p>
      </div>
    `);
  }
});

module.exports = router;
