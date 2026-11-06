const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { pool } = require('../../config/db');
const { requireAuth, requireRole } = require('../../middleware/auth.middleware');

const JWT_SECRET = process.env.JWT_SECRET || 'secret';

const createToken = (user) => {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, name: user.name },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
};

// 1. Customer Signup
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
      [name, email.toLowerCase().trim(), passwordHash, phone || null]
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

// Generic Role Login
async function handleRoleLogin(req, res, expectedRoles) {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const result = await pool.query(
      `SELECT id, name, email, password_hash, role, phone, vehicle_info FROM users WHERE LOWER(email) = LOWER($1)`,
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

    if (!expectedRoles.includes(user.role)) {
      return res.status(403).json({ 
        error: `Access denied. Role '${user.role}' cannot authenticate through this portal.` 
      });
    }

    const token = createToken(user);
    return res.json({
      success: true,
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        vehicle_info: user.vehicle_info || null
      }
    });
  } catch (err) {
    console.error('Role login error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}

router.post('/customer/login', (req, res) => handleRoleLogin(req, res, ['customer']));
router.post('/staff/login', (req, res) => handleRoleLogin(req, res, ['staff', 'admin']));
router.post('/rider/login', (req, res) => handleRoleLogin(req, res, ['driver']));
router.post('/admin/login', (req, res) => handleRoleLogin(req, res, ['admin']));

router.get('/me', requireAuth, (req, res) => {
  res.json({ success: true, user: req.user });
});

// Admin creates employee by specifying sudo_name only
router.post('/admin/create-employee', requireAuth, requireRole(['admin']), async (req, res) => {
  try {
    const { name, sudo_name, password, role, phone, vehicle_info } = req.body;

    if (!['staff', 'driver'].includes(role)) {
      return res.status(400).json({ error: "Only 'staff' or 'driver' accounts can be created" });
    }

    if (!name || !sudo_name || !password) {
      return res.status(400).json({ error: 'Full name, pseudo name/username, and password are required' });
    }

    // Sanitize sudo_name (e.g., "Peter Rider" -> "peter.rider")
    const cleanSudo = sudo_name.trim().toLowerCase().replace(/[^a-z0-9.]/g, '.').replace(/\.+/g, '.');
    const generatedEmail = `${cleanSudo}@theiqstore.com`;

    const passwordHash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (name, email, password_hash, role, phone, vehicle_info)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, email, role, phone, vehicle_info, created_at;`,
      [name, generatedEmail, passwordHash, role, phone || null, vehicle_info || null]
    );

    res.status(201).json({
      success: true,
      message: `${role === 'driver' ? 'Rider' : 'Staff'} registered! Sign-in email: ${generatedEmail}`,
      generated_email: generatedEmail,
      employee: result.rows[0]
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: `An account with this sudo name already exists. Choose a different pseudo name.` });
    }
    console.error('Create employee error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/riders', requireAuth, requireRole(['admin', 'staff']), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, phone, vehicle_info FROM users WHERE role = 'driver' ORDER BY name ASC`
    );
    res.json({ success: true, riders: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
