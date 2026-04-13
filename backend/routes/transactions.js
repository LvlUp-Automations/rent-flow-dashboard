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
    // Clean the amount - remove $ and commas, convert to number
    if (req.body.amount) {
      req.body.amount = parseFloat(
        String(req.body.amount).replace(/[$,]/g, '')
      );
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

    // Hardcoded location ID for Restroom Trailer Snapshot
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

    // Fetch invoice from GHL API
    console.log(`🔍 Searching GHL for invoice: ${invoiceNumber}`);

    const searchUrl = `https://services.leadconnectorhq.com/invoices?altId=${LOCATION_ID}&altType=location&search=${invoiceNumber}&limit=5`;

    const response = await fetch(searchUrl, {
      headers: {
        'Authorization': `Bearer ${GHL_API_KEY}`,
        'Version': '2021-07-28',
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`❌ GHL API error: ${response.status} - ${errText}`);
      return res.status(502).json({
        success: false,
        message: `GHL API returned ${response.status}`,
        error: errText
      });
    }

    const data = await response.json();
    console.log(`📦 GHL returned ${data.invoices?.length || 0} invoices`);

    // Find the matching invoice
    let invoice = null;
    if (data.invoices && data.invoices.length > 0) {
      // Try exact match first
      invoice = data.invoices.find(inv =>
        inv.invoiceNumber === invoiceNumber ||
        inv.number === invoiceNumber ||
        String(inv.invoiceNumber) === String(invoiceNumber)
      );
      // If no exact match, take the first result
      if (!invoice) {
        invoice = data.invoices[0];
      }
    }

    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: `Invoice #${invoiceNumber} not found in GHL`,
        searchUrl: searchUrl.replace(GHL_API_KEY, '***')
      });
    }

    console.log(`✅ Found invoice:`, JSON.stringify(invoice, null, 2).substring(0, 500));

    // Extract amount - GHL may return in cents or dollars
    let amount = invoice.total || invoice.amount || invoice.amountPaid || 0;
    if (amount > 10000) {
      amount = amount / 100; // Convert cents to dollars
    }

    // Clean amount
    amount = parseFloat(String(amount).replace(/[$,]/g, ''));

    if (!amount || isNaN(amount) || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Invoice has no valid amount',
        invoiceData: { total: invoice.total, amount: invoice.amount, amountPaid: invoice.amountPaid }
      });
    }

    // Extract customer name
    const customerName = invoice.contactName
      || invoice.contactDetails?.name
      || invoice.contact?.name
      || (invoice.contact?.firstName ? `${invoice.contact.firstName} ${invoice.contact.lastName || ''}`.trim() : null)
      || (invoice.contactDetails?.firstName ? `${invoice.contactDetails.firstName} ${invoice.contactDetails.lastName || ''}`.trim() : null)
      || invoice.businessDetails?.name
      || 'Unknown Customer';

    // Extract product name
    const productName = invoice.title
      || invoice.name
      || (invoice.items && invoice.items.length > 0 ? invoice.items[0].name || invoice.items[0].description : null)
      || `Invoice #${invoiceNumber}`;

    // Determine status
    let txStatus = 'Pending';
    const invStatus = (invoice.status || '').toLowerCase();
    if (invStatus === 'paid' || invStatus === 'completed') {
      txStatus = 'Completed';
    } else if (invStatus === 'refunded' || invStatus === 'void') {
      txStatus = 'Refunded';
    }

    // Determine type from items
    let txType = 'Rental';
    const allItemNames = (invoice.items || [])
      .map(i => (i.name || i.description || '').toLowerCase())
      .join(' ');
    if (allItemNames.includes('deposit')) txType = 'Deposit';
    else if (allItemNames.includes('clean')) txType = 'Cleaning Fee';
    else if (allItemNames.includes('late')) txType = 'Late Fee';
    else if (allItemNames.includes('delivery')) txType = 'Delivery';

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
