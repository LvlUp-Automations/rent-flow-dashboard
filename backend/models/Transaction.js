const mongoose = require('mongoose');

const TransactionSchema = new mongoose.Schema({
  date: {
    type: Date,
    required: true,
    default: Date.now
  },
  amount: {
    type: Number,
    required: true
  },
  type: {
    type: String,
    required: true,
    enum: ['Rental', 'Deposit', 'Cleaning Fee', 'Late Fee', 'Other']
  },
  product: {
    type: String,
    required: true
  },
  customer: {
    type: String,
    required: true
  },
  notes: {
    type: String,
    default: ''
  },
  status: {
    type: String,
    enum: ['Completed', 'Pending', 'Refunded'],
    default: 'Completed'
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('Transaction', TransactionSchema);
