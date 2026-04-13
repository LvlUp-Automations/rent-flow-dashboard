const express = require('express');
const router = express.Router();
const Transaction = require('../models/Transaction');

// GET /api/transactions - Get all (with optional filters)
router.get('/', async (req, res) => {
  try {
    const { startDate, endDate, type, product, status, limit = 50, page = 1 } = req.query;
    let filter = {};
    if (startDate && endDate) {
      filter.date = { $gte: new Date(startDate), $lte: new Date(endDate) };
    }
    if (type) filter.type = type;
    if (product) filter.product = product;
    if (status) filter.status = status;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const total = await Transaction.countDocuments(filter);
    const transactions = await Transaction.find(filter)
      .sort({ date: -1 })
      .limit(parseInt(limit))
      .skip(skip);
    res.json({
      success: true,
      data: transactions,
      pagination: {
        total,
        page: parseInt(page),
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
});

// GET /api/transactions/:id - Get single
router.get('/:id', async (req, res) => {
  try {
    const tx = await Transaction.findById(req.params.id);
    if (!tx) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, data: tx });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
});

// POST /api/transactions - Create new (manual or from frontend)
router.post('/', async (req, res) => {
  try {
    if (req.body.amount) {
      req.body.amount = parseFloat(String(req.body.amount).replace(/[$,]/g, ''));
    }
    const tx = new Transaction(req.body);
    await tx.save();
    res.status(201).json({ success: true, data: tx, message: 'Transaction created' });
  } catch (err) {
    res.status(400).json({ success: false, message: 'Validation error', error: err.message });
  }
});

// ─── Helper: Try to fetch invoice from GHL API ───
async function fetchInvoiceFromGHL(invoiceNumber) {
  const GHL_API_KEY = process.env.GHL_API_KEY;
  const LOCATION_ID = process.env.GHL_LOCATION_ID || 'nmnVdM6ftybsBH4LqJKU';

  if (!GHL_API_KEY) return null;

  // Try multiple API versions and URL formats
  const attempts = [
    {
      url: `https://services.leadconnectorhq.com/invoices/?altId=${LOCATION_ID}&altType=location&search=${invoiceNumber}&limit=5&offset=0`,
      version: '2021-04-15'
    },
    {
      url: `https://services.leadconnectorhq.com/invoices/?altId=${LOCATION_ID}&altType=location&search=${invoiceNumber}&limit=5&offset=0`,
      version: '2021-07-28'
    },
    {
      url: `https://services.leadconnectorhq.com/invoices?altId=${LOCATION_ID}&altType=location&search=${invoiceNumber}&limit=5&offset=0`,
      version: '2021-04-15'
    },
    {
      url: `https://services.leadconnectorhq.com/invoices?altId=${LOCATION_ID}&altType=location&limit=20&offset=0`,
      version: '2021-04-15'
    }
  ];

  for (const attempt of attempts) {
    try {
      console.log(`🔍 Trying GHL API: ${attempt.url} (version: ${attempt.version})`);

      const response = await fetch(attempt.url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${GHL_API_KEY}`,
          'Version': attempt.version,
          'Accept': 'application/json'
        }
      });

      if (!response.ok) {
        const errText = await response.text();
        console.log(`⚠️ Attempt failed (${response.status}): ${errText.substring(0, 200)}`);
        continue;
      }

      const data = await response.json();
      const invoices = data.invoices || data.data || [];
      console.log(`📋 Got ${invoices.length} invoices from GHL`);

      if (invoices.length === 0) continue;

      // Find matching invoice
      const match = invoices.find(inv =>
        String(inv.invoiceNumber) === String(invoiceNumber) ||
        String(inv.number) === String(invoiceNumber)
      ) || invoices[0];

      if (match) {
        console.log(`✅ Found invoice via API: ${match._id || match.id}`);
        return match;
      }
    } catch (err) {
      console.log(`⚠️ Attempt error: ${err.message}`);
      continue;
    }
  }

  console.log('❌ All GHL API attempts failed');
  return null;
}

// POST /api/transactions/from-invoice - Auto-create from GHL webhook
// Accepts: { invoiceNumber } (minimal - will try API lookup)
// OR: { invoiceNumber, customer, amount, title, date, status, type } (full data from webhook)
router.post('/from-invoice', async (req, res) => {
  try {
    const { invoiceNumber, customer, amount, title, date, status, type, notes } = req.body;

    if (!invoiceNumber && !amount) {
      return res.status(400).json({ success: false, message: 'Invoice number or amount is required' });
    }

    // Check for duplicates
    if (invoiceNumber) {
      const existing = await Transaction.findOne({
        notes: { $regex: invoiceNumber, $options: 'i' }
      });
      if (existing) {
        return res.status(200).json({
          success: true,
          message: 'Invoice already synced',
          data: existing,
          duplicate: true
        });
      }
    }

    // ─── STRATEGY 1: Try GHL API to get full invoice details ───
    let invoice = null;
    if (invoiceNumber) {
      invoice = await fetchInvoiceFromGHL(invoiceNumber);
    }

    let txData = {};

    if (invoice) {
      // ─── Got invoice from API - extract all data ───
      console.log('📦 Using GHL API data');

      let apiAmount = invoice.total || invoice.amount || invoice.amountPaid || invoice.totalAmount || 0;
      if (apiAmount > 10000) apiAmount = apiAmount / 100;
      apiAmount = parseFloat(String(apiAmount).replace(/[$,]/g, ''));

      const apiCustomer = invoice.contactName
        || invoice.contactDetails?.name
        || invoice.contact?.name
        || (invoice.contact?.firstName ? `${invoice.contact.firstName} ${invoice.contact.lastName || ''}`.trim() : null)
        || (invoice.contactDetails?.firstName ? `${invoice.contactDetails.firstName} ${invoice.contactDetails.lastName || ''}`.trim() : null)
        || invoice.businessDetails?.name
        || 'Unknown Customer';

      const apiProduct = (invoice.items?.[0]?.name || invoice.items?.[0]?.description)
        || invoice.title
        || invoice.name
        || `Invoice #${invoiceNumber}`;

      let apiStatus = 'Pending';
      const invStatus = (invoice.status || '').toLowerCase();
      if (invStatus === 'paid' || invStatus === 'completed') apiStatus = 'Completed';
      else if (invStatus === 'refunded' || invStatus === 'void') apiStatus = 'Refunded';

      let apiType = 'Rental';
      const itemText = (invoice.items || []).map(i => (i.name || i.description || '').toLowerCase()).join(' ');
      if (itemText.includes('deposit')) apiType = 'Deposit';
      else if (itemText.includes('clean')) apiType = 'Cleaning Fee';
      else if (itemText.includes('late')) apiType = 'Late Fee';
      else if (itemText.includes('delivery')) apiType = 'Delivery';

      txData = {
        date: invoice.createdAt || invoice.issueDate || invoice.dueDate || new Date(),
        customer: apiCustomer,
        product: apiProduct,
        type: apiType,
        amount: apiAmount,
        status: apiStatus,
        notes: `Auto-synced from Invoice #${invoiceNumber}`
      };

    } else {
      // ─── STRATEGY 2: Use webhook data directly ───
      console.log('📦 GHL API unavailable, using webhook data');

      let webhookAmount = 0;
      if (amount) {
        webhookAmount = parseFloat(String(amount).replace(/[$,]/g, ''));
      }

      // Determine type from title
      let webhookType = type || 'Rental';
      if (title) {
        const titleLower = title.toLowerCase();
        if (titleLower.includes('deposit')) webhookType = 'Deposit';
        else if (titleLower.includes('clean')) webhookType = 'Cleaning Fee';
        else if (titleLower.includes('late')) webhookType = 'Late Fee';
        else if (titleLower.includes('delivery')) webhookType = 'Delivery';
      }

      txData = {
        date: date ? new Date(date) : new Date(),
        customer: customer || 'Unknown Customer',
        product: title || `Invoice #${invoiceNumber || 'N/A'}`,
        type: webhookType,
        amount: webhookAmount,
        status: status || 'Completed',
        notes: notes || `Auto-synced from Invoice #${invoiceNumber || 'N/A'}`
      };
    }

    // Validate amount
    if (!txData.amount || isNaN(txData.amount) || txData.amount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid or zero amount',
        raw: { amount: txData.amount, source: invoice ? 'API' : 'webhook' }
      });
    }

    // Create and save
    const tx = new Transaction(txData);
    await tx.save();

    console.log(`✅ Transaction saved: $${tx.amount} - ${tx.customer} - ${tx.product} (via ${invoice ? 'API' : 'webhook'})`);

    res.status(201).json({
      success: true,
      data: tx,
      source: invoice ? 'ghl_api' : 'webhook_data',
      message: `Transaction created from Invoice #${invoiceNumber}`
    });

  } catch (err) {
    console.error('❌ Invoice sync error:', err);
    res.status(500).json({ success: false, message: 'Invoice sync failed', error: err.message });
  }
});

// PUT /api/transactions/:id - Update
router.put('/:id', async (req, res) => {
  try {
    const tx = await Transaction.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!tx) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, data: tx, message: 'Transaction updated' });
  } catch (err) {
    res.status(400).json({ success: false, message: 'Validation error', error: err.message });
  }
});

// DELETE /api/transactions/:id - Delete
router.delete('/:id', async (req, res) => {
  try {
    const tx = await Transaction.findByIdAndDelete(req.params.id);
    if (!tx) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, message: 'Transaction deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
});

module.exports = router;
