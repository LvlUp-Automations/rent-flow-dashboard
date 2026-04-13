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

// POST /api/transactions/from-invoice - Auto-create from GHL invoice number via API
router.post('/from-invoice', async (req, res) => {
  try {
    const { invoiceNumber } = req.body;

    if (!invoiceNumber) {
      return res.status(400).json({ success: false, message: 'Invoice number is required' });
    }

    const GHL_API_KEY = process.env.GHL_API_KEY;
    if (!GHL_API_KEY) {
      return res.status(500).json({ success: false, message: 'GHL API key not configured on server' });
    }

    const LOCATION_ID = process.env.GHL_LOCATION_ID || 'nmnVdM6ftybsBH4LqJKU';

    // Check for duplicates first
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

    // Declare invoice variable before use
    let invoice = null;

    // ─── Fetch invoice list from GHL API V2 ───
    console.log(`🔍 Searching GHL for invoice: ${invoiceNumber}`);

    const searchUrl = `https://services.leadconnectorhq.com/invoices/?altId=${LOCATION_ID}&altType=location&search=${invoiceNumber}&limit=5&offset=0`;

    const response = await fetch(searchUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${GHL_API_KEY}`,
        'Version': '2021-07-28',
        'Accept': 'application/json'
      }
    });

    const responseText = await response.text();
    console.log(`📡 GHL API Status: ${response.status}`);
    console.log(`📦 GHL API Response: ${responseText.substring(0, 500)}`);

    if (!response.ok) {
      // If search endpoint fails, try fetching all invoices without search
      console.log('⚠️ Search failed, trying without search param...');

      const fallbackUrl = `https://services.leadconnectorhq.com/invoices/?altId=${LOCATION_ID}&altType=location&limit=50&offset=0`;
      const fallbackResponse = await fetch(fallbackUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${GHL_API_KEY}`,
          'Version': '2021-07-28',
          'Accept': 'application/json'
        }
      });

      if (!fallbackResponse.ok) {
        const fallbackErr = await fallbackResponse.text();
        console.error(`❌ Fallback also failed: ${fallbackResponse.status} - ${fallbackErr}`);
        return res.status(502).json({
          success: false,
          message: `GHL API returned ${fallbackResponse.status}`,
          error: fallbackErr
        });
      }

      const fallbackData = await fallbackResponse.json();
      const allInvoices = fallbackData.invoices || fallbackData.data || [];
      console.log(`📋 Fallback found ${allInvoices.length} invoices, searching manually...`);

      // Search manually
      invoice = allInvoices.find(inv =>
        String(inv.invoiceNumber) === String(invoiceNumber) ||
        String(inv.number) === String(invoiceNumber) ||
        String(inv.invoiceNumber).includes(invoiceNumber)
      );

      if (!invoice) {
        return res.status(404).json({
          success: false,
          message: `Invoice #${invoiceNumber} not found. ${allInvoices.length} invoices checked.`
        });
      }
    }

    // Parse the successful search response if we don't have an invoice yet
    if (!invoice) {
      let data;
      try {
        data = JSON.parse(responseText);
      } catch (e) {
        return res.status(502).json({
          success: false,
          message: 'Invalid JSON from GHL API',
          raw: responseText.substring(0, 200)
        });
      }

      const invoices = data.invoices || data.data || [];
      console.log(`📋 Found ${invoices.length} invoices in search results`);

      if (invoices.length === 0) {
        return res.status(404).json({
          success: false,
          message: `Invoice #${invoiceNumber} not found in GHL`
        });
      }

      // Find exact match or take first
      invoice = invoices.find(inv =>
        String(inv.invoiceNumber) === String(invoiceNumber) ||
        String(inv.number) === String(invoiceNumber)
      ) || invoices[0];
    }

    console.log(`✅ Found invoice: ${invoice._id || invoice.id} - ${invoice.name || invoice.title}`);

    // ─── Extract data from invoice ───
    let amount = invoice.total || invoice.amount || invoice.amountPaid || invoice.totalAmount || 0;
    // GHL sometimes returns cents
    if (amount > 10000) amount = amount / 100;
    amount = parseFloat(String(amount).replace(/[$,]/g, ''));

    if (!amount || isNaN(amount) || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Invoice has no valid amount',
        raw: { total: invoice.total, amount: invoice.amount, amountPaid: invoice.amountPaid }
      });
    }

    // Customer name
    const customerName = invoice.contactName
      || invoice.contactDetails?.name
      || invoice.contact?.name
      || (invoice.contact?.firstName ? `${invoice.contact.firstName} ${invoice.contact.lastName || ''}`.trim() : null)
      || (invoice.contactDetails?.firstName ? `${invoice.contactDetails.firstName} ${invoice.contactDetails.lastName || ''}`.trim() : null)
      || invoice.businessDetails?.name
      || 'Unknown Customer';

    // Product
    const productName = invoice.title
      || invoice.name
      || (invoice.items?.[0]?.name || invoice.items?.[0]?.description)
      || `Invoice #${invoiceNumber}`;

    // Status
    let txStatus = 'Pending';
    const invStatus = (invoice.status || '').toLowerCase();
    if (invStatus === 'paid' || invStatus === 'completed') txStatus = 'Completed';
    else if (invStatus === 'refunded' || invStatus === 'void') txStatus = 'Refunded';

    // Type from items
    let txType = 'Rental';
    const itemText = (invoice.items || []).map(i => (i.name || i.description || '').toLowerCase()).join(' ');
    if (itemText.includes('deposit')) txType = 'Deposit';
    else if (itemText.includes('clean')) txType = 'Cleaning Fee';
    else if (itemText.includes('late')) txType = 'Late Fee';
    else if (itemText.includes('delivery')) txType = 'Delivery';

    // Create transaction
    const tx = new Transaction({
      date: invoice.createdAt || invoice.issueDate || invoice.dueDate || new Date(),
      customer: customerName,
      product: productName,
      type: txType,
      amount: amount,
      status: txStatus,
      notes: `Auto-synced from Invoice #${invoiceNumber}`
    });

    await tx.save();
    console.log(`✅ Transaction saved: $${tx.amount} - ${tx.customer} - ${tx.product}`);

    res.status(201).json({
      success: true,
      data: tx,
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
