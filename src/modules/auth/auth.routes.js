const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { pool } = require('../../config/db');
const { requireAuth, requireRole } = require('../../middleware/auth.middleware');

const JWT_SECRET = process.env.JWT_SECRET || 'secret';

// Helper to sign JWT
const createToken = (user) => {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, name: user.name },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
};

// ==========================================
// 1. PUBLIC: Customer Self-Registration ONLY
// ==========================================
router.post('/customer/signup', async (req, res) => {
  try {
    const { name, email, password, phone } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password required' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (name, email, password_hash, role, phone)
       VALUES ($1, $2, $3, 'customer', $4)
       RETURNING id, name, email, role, phone;`,
      [name, email.toLowerCase().trim(), passwordHash, phone]
    );

    const user = result.rows[0];
    const token = createToken(user);
    res.status(201).json({ success: true, token, user });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'An account with this email already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 2. SEGREGATED ROLE LOGINS
// ==========================================

// Generic authentication helper validating against an expected role
async function handleRoleLogin(req, res, expectedRoles) {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  const result = await pool.query(
    `SELECT * FROM users WHERE LOWER(email) = LOWER($1) AND is_active = true`,
    [email.trim()]
  );

  if (result.rows.length === 0) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const user = result.rows[0];
  const validPassword = await bcrypt.compare(password, user.password_hash);
  if (!validPassword) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Enforce Section Gate: block users from logging into unpermitted portals
  if (!expectedRoles.includes(user.role)) {
    return res.status(403).json({ 
      error: `Access denied. You cannot log into this portal as a '${user.role}'.` 
    });
  }

  const token = createToken(user);
  res.json({
    success: true,
    token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      vehicle_info: user.vehicle_info
    }
  });
}

// Customer Portal Login
router.post('/customer/login', (req, res) => handleRoleLogin(req, res, ['customer']));

// Dispatch Desk Staff Login
router.post('/staff/login', (req, res) => handleRoleLogin(req, res, ['staff', 'admin']));

// Delivery Rider Login
router.post('/rider/login', (req, res) => handleRoleLogin(req, res, ['driver']));

// Admin Dashboard Login
router.post('/admin/login', (req, res) => handleRoleLogin(req, res, ['admin']));

// Verify Current Session Token
router.get('/me', requireAuth, (req, res) => {
  res.json({ success: true, user: req.user });
});

// ==========================================
// 3. ADMIN ONLY: Provision Staff & Riders
// ==========================================
router.post('/admin/create-employee', requireAuth, requireRole(['admin']), async (req, res) => {
  try {
    const { name, email, password, role, phone, vehicle_info } = req.body;

    // Only allow provisioning staff or drivers
    if (!['staff', 'driver'].includes(role)) {
      return res.status(400).json({ error: "Admin can only create 'staff' (Dispatch) or 'driver' (Rider) accounts" });
    }

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and temporary password are required' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (name, email, password_hash, role, phone, vehicle_info)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, email, role, phone, vehicle_info, created_at;`,
      [name, email.toLowerCase().trim(), passwordHash, role, phone, vehicle_info || null]
    );

    res.status(201).json({
      success: true,
      message: `${role === 'driver' ? 'Rider' : 'Dispatch Staff'} account created successfully`,
      employee: result.rows[0]
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'An account with this email already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

// Admin endpoint: List all active riders (used for assigning orders)
router.get('/riders', requireAuth, requireRole(['admin', 'staff']), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, phone, vehicle_info FROM users WHERE role = 'driver' AND is_active = true ORDER BY name ASC`
    );
    res.json({ success: true, riders: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;