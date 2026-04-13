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

// POST /api/transactions - Create new (manual or from GHL webhook)
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

// POST /api/transactions/from-invoice - Auto-create transaction from GHL invoice number
router.post('/from-invoice', async (req, res) => {
  try {
    const { invoiceNumber, invoiceId, locationId } = req.body;

    if (!invoiceNumber && !invoiceId) {
      return res.status(400).json({ success: false, message: 'Invoice number or ID required' });
    }

    const GHL_API_KEY = process.env.GHL_API_KEY;
    if (!GHL_API_KEY) {
      return res.status(500).json({ success: false, message: 'GHL API key not configured' });
    }

    let invoice = null;

    // Method 1: If we have the invoice ID, fetch directly
    if (invoiceId) {
      const response = await fetch(
        `https://services.leadconnectorhq.com/invoices/${invoiceId}`,
        {
          headers: {
            'Authorization': `Bearer ${GHL_API_KEY}`,
            'Version': '2021-07-28',
            'Content-Type': 'application/json'
          }
        }
      );
      const data = await response.json();
      invoice = data.invoice || data;
    }

    // Method 2: Search by invoice number
    if (!invoice && invoiceNumber && locationId) {
      const response = await fetch(
        `https://services.leadconnectorhq.com/invoices?altId=${locationId}&altType=location&search=${invoiceNumber}&limit=1`,
        {
          headers: {
            'Authorization': `Bearer ${GHL_API_KEY}`,
            'Version': '2021-07-28',
            'Content-Type': 'application/json'
          }
        }
      );
      const data = await response.json();
      invoice = data.invoices?.[0];
    }

    if (!invoice) {
      return res.status(404).json({ success: false, message: 'Invoice not found in GHL' });
    }

    // Check if this invoice was already synced (prevent duplicates)
    const invoiceRef = invoice.invoiceNumber || invoice.number || invoiceNumber;
    const existing = await Transaction.findOne({ notes: { $regex: invoiceRef, $options: 'i' } });
    if (existing) {
      return res.status(200).json({
        success: true,
        message: 'Invoice already synced',
        data: existing,
        duplicate: true
      });
    }

    // Extract invoice data
    // GHL returns amounts in cents for some endpoints, dollars for others
    let amount = invoice.total || invoice.amount || 0;
    // If amount seems to be in cents (over 10000 for what should be a rental), convert
    if (amount > 10000) {
      amount = amount / 100;
    }

    // Get customer name from invoice
    const customerName = invoice.contactName
      || invoice.contact?.name
      || invoice.contact?.firstName + ' ' + (invoice.contact?.lastName || '')
      || invoice.businessDetails?.name
      || 'Unknown Customer';

    // Get product/description
    const productName = invoice.title
      || invoice.name
      || (invoice.items?.[0]?.name)
      || (invoice.items?.[0]?.description)
      || `Invoice #${invoiceRef}`;

    // Determine status
    let status = 'Pending';
    const invoiceStatus = (invoice.status || '').toLowerCase();
    if (invoiceStatus === 'paid' || invoiceStatus === 'completed') {
      status = 'Completed';
    } else if (invoiceStatus === 'refunded' || invoiceStatus === 'void') {
      status = 'Refunded';
    }

    // Determine type from invoice items if possible
    let type = 'Rental'; // default
    const itemNames = (invoice.items || []).map(i => (i.name || i.description || '').toLowerCase()).join(' ');
    if (itemNames.includes('deposit')) type = 'Deposit';
    else if (itemNames.includes('clean')) type = 'Cleaning Fee';
    else if (itemNames.includes('late')) type = 'Late Fee';
    else if (itemNames.includes('delivery')) type = 'Delivery';

    // Create the transaction
    const tx = new Transaction({
      date: invoice.createdAt || invoice.dueDate || new Date(),
      customer: customerName.trim(),
      product: productName,
      type: type,
      amount: parseFloat(String(amount).replace(/[$,]/g, '')),
      status: status,
      notes: `Auto-synced from Invoice #${invoiceRef}`
    });

    await tx.save();

    console.log(`✅ Transaction created from Invoice #${invoiceRef}: $${tx.amount} - ${tx.customer}`);

    res.status(201).json({
      success: true,
      data: tx,
      message: `Transaction created from Invoice #${invoiceRef}`
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
