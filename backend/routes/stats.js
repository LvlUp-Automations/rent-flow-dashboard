const express = require('express');
const router = express.Router();
const Transaction = require('../models/Transaction');

// Helper: get start and end of a period
function getPeriodDates(period) {
  const now = new Date();
  let start, end;

  switch(period) {
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
    case 'lastQuarter':
      const lq = Math.floor(now.getMonth() / 3) - 1;
      const lqYear = lq < 0 ? now.getFullYear() - 1 : now.getFullYear();
      const lqAdj = lq < 0 ? 3 : lq;
      start = new Date(lqYear, lqAdj * 3, 1);
      end = new Date(lqYear, lqAdj * 3 + 3, 0, 23, 59, 59);
      break;
    case 'thisYear':
      start = new Date(now.getFullYear(), 0, 1);
      end = new Date(now.getFullYear(), 11, 31, 23, 59, 59);
      break;
    case 'lastYear':
      start = new Date(now.getFullYear() - 1, 0, 1);
      end = new Date(now.getFullYear() - 1, 11, 31, 23, 59, 59);
      break;
    default:
      start = new Date(0);
      end = new Date();
  }
  return { start, end };
}

// GET /api/stats/overview
router.get('/overview', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    // Build date filter for overall stats
    let dateFilter = {};
    if (startDate && endDate) {
      dateFilter = {
        date: {
          $gte: new Date(startDate),
          $lte: new Date(endDate)
        }
      };
    }

    // Overall Revenue
    const overallAgg = await Transaction.aggregate([
      { $match: { status: 'Completed', ...dateFilter } },
      { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
    ]);
    const overall = overallAgg[0] || { total: 0, count: 0 };

    // Helper to get revenue for a period
    async function getPeriodRevenue(period) {
      const { start, end } = getPeriodDates(period);
      const agg = await Transaction.aggregate([
        { $match: { status: 'Completed', date: { $gte: start, $lte: end } } },
        { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
      ]);
      return agg[0] || { total: 0, count: 0 };
    }

    const [thisMonth, lastMonth, thisQuarter, lastQuarter, thisYear, lastYear] = await Promise.all([
      getPeriodRevenue('thisMonth'),
      getPeriodRevenue('lastMonth'),
      getPeriodRevenue('thisQuarter'),
      getPeriodRevenue('lastQuarter'),
      getPeriodRevenue('thisYear'),
      getPeriodRevenue('lastYear')
    ]);

    // Last transaction date
    const lastTx = await Transaction.findOne().sort({ date: -1 }).select('date');

    res.json({
      success: true,
      data: {
        overallRevenue: overall.total,
        totalTransactions: overall.count,
        avgPerTransaction: overall.count > 0 ? (overall.total / overall.count) : 0,
        thisMonth: thisMonth.total,
        lastMonth: lastMonth.total,
        thisQuarter: thisQuarter.total,
        lastQuarter: lastQuarter.total,
        thisYear: thisYear.total,
        lastYear: lastYear.total,
        lastTransactionDate: lastTx ? lastTx.date : null
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
});

// GET /api/stats/by-product
router.get('/by-product', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    let dateFilter = {};
    if (startDate && endDate) {
      dateFilter = { date: { $gte: new Date(startDate), $lte: new Date(endDate) } };
    }

    const data = await Transaction.aggregate([
      { $match: { status: 'Completed', ...dateFilter } },
      { $group: {
        _id: '$product',
        totalAmount: { $sum: '$amount' },
        count: { $sum: 1 }
      }},
      { $sort: { totalAmount: -1 } }
    ]);

    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
});

// GET /api/stats/by-type
router.get('/by-type', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    let dateFilter = {};
    if (startDate && endDate) {
      dateFilter = { date: { $gte: new Date(startDate), $lte: new Date(endDate) } };
    }

    const data = await Transaction.aggregate([
      { $match: { status: 'Completed', ...dateFilter } },
      { $group: {
        _id: '$type',
        totalAmount: { $sum: '$amount' },
        count: { $sum: 1 }
      }},
      { $sort: { totalAmount: -1 } }
    ]);

    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
});

module.exports = router;
