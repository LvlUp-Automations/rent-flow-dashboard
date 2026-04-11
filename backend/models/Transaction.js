const mongoose = require('mongoose');

const TransactionSchema = new mongoose.Schema({
  date: {
    type: Date,
    default: Date.now
  },
  amount: {
    type: Number,
    default: null
  },
  type: {
    type: String,
    default: null
  },
  product: {
    type: String,
    default: null
  },
  customer: {
    type: String,
    default: null
  },
  notes: {
    type: String,
    default: null
  },
  status: {
    type: String,
    default: null
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('Transaction', TransactionSchema);
