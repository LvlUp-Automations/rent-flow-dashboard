const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();

// ─── MIDDLEWARE ───────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS - allow frontend to talk to backend
app.use(cors({
  origin: [
    'http://localhost:5500',
    'http://127.0.0.1:5500',
    process.env.FRONTEND_URL || '*'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// ─── DATABASE ─────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => {
    console.error('❌ MongoDB Connection Error:', err.message);
    process.exit(1);
  });

// ─── ROUTES ───────────────────────────────────────────────
app.use('/api/transactions', require('./routes/transactions'));
app.use('/api/stats', require('./routes/stats'));

// Health check route
app.get('/', (req, res) => {
  res.json({
    message: 'Rent Flow Dashboard API is running',
    status: 'healthy',
    timestamp: new Date().toISOString()
  });
});

// ─── START SERVER ─────────────────────────────────────────
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
