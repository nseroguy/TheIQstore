require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');

const authRoutes = require('./modules/auth/auth.routes');
const deliveryRoutes = require('./modules/delivery/delivery.routes');

const app = express();

app.enable('trust proxy');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

// Static files (frontend)
app.use(express.static(path.join(__dirname, '../public')));

// Health check endpoint
app.get('/healthz', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'TheIQstore', time: new Date().toISOString() });
});

// API Routes
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/deliveries', deliveryRoutes);

// SPA Fallback: serve index.html for unknown frontend routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal Server Error', message: err.message });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`TheIQstore operational on port ${PORT}`);
});
