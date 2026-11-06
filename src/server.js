require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');

const authRoutes = require('./modules/auth/auth.routes');
const deliveryRoutes = require('./modules/delivery/delivery.routes');
const adminRoutes = require('./modules/admin/admin.routes');
const { requireAuth, requireRole } = require('./middleware/auth.middleware');

const app = express();

app.enable('trust proxy');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

// Static files (frontend and uploaded cake media)
app.use(express.static(path.join(__dirname, '../public')));
app.use('/uploads', express.static(path.join(__dirname, '../public/uploads')));

// Multer storage configuration for camera captures and file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, '../public/uploads'));
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, 'cake-' + Date.now() + '-' + Math.round(Math.random() * 1e4) + ext);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB maximum for high-res mobile snaps
});

// Admin Image Upload Endpoint (Camera & Files)
app.post(
  '/api/v1/admin/upload-image',
  requireAuth,
  requireRole(['admin']),
  upload.single('image'),
  (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No image file was received' });
    }
    const publicUrl = '/uploads/' + req.file.filename;
    res.json({ success: true, url: publicUrl });
  }
);

// Health check endpoint
app.get('/healthz', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'TheIQstore', time: new Date().toISOString() });
});

// API Routes
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/deliveries', deliveryRoutes);
app.use('/api/v1/admin', adminRoutes);

// Public products endpoint for store catalog
app.get('/api/v1/public/products', async (req, res) => {
  try {
    const { pool } = require('./config/db');
    const result = await pool.query('SELECT * FROM products WHERE is_available = true ORDER BY created_at DESC');
    res.json({ success: true, products: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
