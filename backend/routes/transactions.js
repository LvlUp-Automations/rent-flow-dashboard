const express = require('express');
const router = express.Router();
const Transaction = require('../models/Transaction');

// ─── Collection-to-Category mapping ───
// Maps GHL product collection names to dashboard categories
// Update this mapping when client adds new collections
const COLLECTION_MAP = {
  'restroom trailers': 'Restroom Trailer Rental',
  'portable toilet': 'Porta Potty Rental',
  'pump services': 'Services',
  'add on services': 'Add-Ons',
  'holding tanks': 'Add-Ons'
};

// Fallback: map product names to categories by keyword
function detectCategory(productName, collectionName) {
  // First try collection mapping
  if (collectionName) {
    const key = collectionName.toLowerCase().trim();
    if (COLLECTION_MAP[key]) return COLLECTION_MAP[key];
    // Partial match
    for (const [pattern, category] of Object.entries(COLLECTION_MAP)) {
      if (key.includes(pattern) || pattern.includes(key)) return category;
    }
  }

  // Fallback: detect from product name
  if (productName) {
    const name = productName.toLowerCase();
    if (name.includes('restroom') || name.includes('stall')) return 'Restroom Trailer Rental';
    if (name.includes('porta') || name.includes('potty') || name.includes('toilet')) return 'Porta Potty Rental';
    if (name.includes('pump') || name.includes('service') || name.includes('rv pump')) return 'Services';
    if (name.includes('generator') || name.includes('water') || name.includes('delivery') || name.includes('setup') || name.includes('add')) return 'Add-Ons';
  }

  return 'Other';
}

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

// ─── Helper: Try to fetch product details from GHL to get collection ───
async function fetchProductCollection(productId) {
  const GHL_API_KEY = process.env.GHL_API_KEY;
  const LOCATION_ID = process.env.GHL_LOCATION_ID || 'nmnVdM6ftybsBH4LqJKU';

  if (!GHL_API_KEY || !productId) return null;

  try {
    console.log(`🔍 Fetching product collection for: ${productId}`);

    const response = await fetch(
      `https://services.leadconnectorhq.com/products/${productId}?locationId=${LOCATION_ID}`,
      {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${GHL_API_KEY}`,
          'Version': '2021-04-15',
          'Accept': 'application/json'
        }
      }
    );

    if (!response.ok) {
      console.log(`⚠️ Product fetch failed: ${response.status}`);
      return null;
    }

    const data = await response.json();
    const product = data.product || data;

    // Collection might be in collectionIds, collections, or category
    const collectionName = product.collectionName
      || product.category
      || (product.collections && product.collections[0]?.name)
      || null;

    console.log(`📦 Product collection: ${collectionName || 'none found'}`);
    return collectionName;
  } catch (err) {
    console.log(`⚠️ Product collection fetch error: ${err.message}`);
    return null;
  }
}

// POST /api/transactions/from-invoice - Auto-create from GHL webhook
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
      console.log('📦 Using GHL API data');
      console.log('📋 Invoice keys:', Object.keys(invoice));

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

      // Get items from invoiceItems or items
      const items = invoice.invoiceItems || invoice.items || invoice.lineItems || [];
      console.log(`📋 Invoice items (${items.length}):`, JSON.stringify(items).substring(0, 300));

      const firstItem = items[0] || {};
      const apiProduct = firstItem.name || firstItem.description || firstItem.title || firstItem.productName
        || invoice.name
        || invoice.title
        || `Invoice #${invoiceNumber}`;

      // Try to get collection/category from product
      let collectionName = null;
      if (firstItem.productId) {
        collectionName = await fetchProductCollection(firstItem.productId);
      }

      // Determine category
      const apiType = detectCategory(apiProduct, collectionName);
      console.log(`📦 Category: ${apiType} (collection: ${collectionName}, product: ${apiProduct})`);

      let apiStatus = 'Pending';
      const invStatus = (invoice.status || '').toLowerCase();
      if (invStatus === 'paid' || invStatus === 'completed') apiStatus = 'Completed';
      else if (invStatus === 'refunded' || invStatus === 'void') apiStatus = 'Refunded';

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

      const webhookType = type || detectCategory(title, null);

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

    console.log(`✅ Transaction saved: $${tx.amount} - ${tx.customer} - ${tx.product} [${tx.type}] (via ${invoice ? 'API' : 'webhook'})`);

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
