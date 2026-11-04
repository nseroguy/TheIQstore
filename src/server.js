require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');

const deliveryRoutes = require('./modules/delivery/delivery.routes');

const app = express();

app.enable('trust proxy');
app.use(helmet({ contentSecurityPolicy: false })); // allows Tailwind CDN & Google fonts
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

// Serve static frontend files
app.use(express.static(path.join(__dirname, '../public')));

// Health check endpoint
app.get('/healthz', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'TheIQstore', time: new Date().toISOString() });
});

// Mount Delivery Module
app.use('/api/v1/deliveries', deliveryRoutes);

// Fallback to index.html for root path
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
});